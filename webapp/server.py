#!/usr/bin/env python3
"""Authenticated by Caddy for the UI; collectors use scoped bearer tokens."""
import http.client,socket,logging,base64, hashlib, hmac, html, json, os, pathlib, re, secrets, sqlite3, threading, time, uuid
from http.cookies import SimpleCookie, CookieError
from contextlib import contextmanager
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from activity_timeline import build_archive
from live_archive import ArchiveWarming
from persistent_archive import PersistentArchive
from response_cache import PageCache

ROOT = pathlib.Path(__file__).resolve().parent
DATA = pathlib.Path(os.environ.get('HISTORIAL_DATA', '/var/lib/historial-espejo-web'))
DB = DATA / 'mirror.sqlite3'
PAGE_CACHE=PageCache(lambda:DB.parent)
DOMAIN = os.environ.get('MIRROR_DOMAIN', 'localhost')
STORES = {'visits', 'events'}
TOKENS = {}
ACCESS = {}
SESSION_COOKIE='__Host-historial_session'
LOGOUT_COOKIE='__Host-historial_logout'
SESSION_LIFETIME=365*24*60*60
AUTH_ATTEMPTS={}
LOCK = threading.RLock()
META_LOCK=threading.Lock()
META_CACHE={}
SESSION_CACHE = {}
SESSION_LOCK = threading.RLock()

def metadata_url(url):
    # Page titles reported by open tabs are matched to visits without the fragment.
    try:return urlparse(url)._replace(fragment='').geturl()
    except ValueError:return url

@contextmanager
def connect():
    con = sqlite3.connect(DB, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA busy_timeout=30000');con.execute('PRAGMA wal_autocheckpoint=0')
    con.create_function('metadata_url',1,metadata_url,deterministic=True)
    try:
        with con: yield con
    finally: con.close()

def open_wal_anchor(path):
    anchor=sqlite3.connect(path)
    anchor.execute('PRAGMA wal_autocheckpoint=0')
    # A completed read joins WAL without keeping a transaction open.
    anchor.execute('SELECT 1 FROM sessions LIMIT 1').fetchall()
    return anchor

def initialize():
    DATA.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS records (
          source TEXT NOT NULL, store TEXT NOT NULL, item_key TEXT NOT NULL,
          canonical TEXT NOT NULL, event_time REAL NOT NULL, state TEXT,
          title TEXT, url TEXT, stamp REAL NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY(source,store,item_key));
        CREATE INDEX IF NOT EXISTS records_time ON records(store,event_time DESC);
        CREATE INDEX IF NOT EXISTS records_dedupe ON records(store,canonical,stamp DESC);
        CREATE INDEX IF NOT EXISTS records_preferred ON records(store,source,canonical);
        CREATE INDEX IF NOT EXISTS records_page ON records(source,store,url,event_time DESC);
        CREATE INDEX IF NOT EXISTS records_counts ON records(store,state,source,canonical);
        CREATE TABLE IF NOT EXISTS projection_queue(source TEXT NOT NULL,store TEXT NOT NULL,item_key TEXT NOT NULL,queued INTEGER NOT NULL,PRIMARY KEY(source,store,item_key));
        CREATE INDEX IF NOT EXISTS projection_pending ON projection_queue(queued);
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,label TEXT NOT NULL,last_seen REAL NOT NULL,
          state TEXT NOT NULL DEFAULT '{}',counts TEXT NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,target TEXT NOT NULL,created REAL NOT NULL,
          status TEXT NOT NULL,command TEXT NOT NULL,result TEXT);
        CREATE TABLE IF NOT EXISTS icons (
          host TEXT PRIMARY KEY,mime TEXT NOT NULL,data BLOB NOT NULL,updated REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS page_metadata (
          source TEXT NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL,
          audible INTEGER NOT NULL DEFAULT 0,last_seen REAL NOT NULL,
          PRIMARY KEY(source,url));
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,created REAL NOT NULL,expires REAL NOT NULL);
        ''')
        if 'priority' not in {row[1] for row in db.execute('PRAGMA table_info(projection_queue)')}:
            db.execute('ALTER TABLE projection_queue ADD COLUMN priority INTEGER NOT NULL DEFAULT 0')
            db.execute("UPDATE projection_queue SET priority=coalesce((SELECT CASE WHEN r.event_time>=? THEN 2 WHEN r.state='deleted' THEN 1 ELSE 0 END FROM records r WHERE r.source=projection_queue.source AND r.store=projection_queue.store AND r.item_key=projection_queue.item_key),0)",(time.time()*1000-3*86400000,))
        db.execute('CREATE INDEX IF NOT EXISTS projection_priority ON projection_queue(priority DESC,queued)')
    LIVE_ARCHIVE.initialize()
    # Load persisted sessions once; checking a valid login must not wait for history writes.
    with connect() as db:
        sessions = dict(db.execute('SELECT token_hash,expires FROM sessions'))
    with SESSION_LOCK:
        SESSION_CACHE.clear();SESSION_CACHE.update(sessions)

def password_ok(username,password):
    if not ACCESS or not isinstance(password,str) or len(password)>2048:return False
    if not hmac.compare_digest(str(username).encode(),str(ACCESS.get('username','admin')).encode()):return False
    digest=hashlib.scrypt(password.encode(),salt=bytes.fromhex(ACCESS['salt']),n=32768,r=8,p=1,maxmem=128*1024*1024).hex()
    return hmac.compare_digest(digest,ACCESS['password_hash'])

def activation_ok(token):
    if not ACCESS or not isinstance(token,str) or len(token)>256:return False
    return hmac.compare_digest(hashlib.sha256(token.encode()).hexdigest(),ACCESS.get('activation_hash',''))

def new_session():
    raw=secrets.token_urlsafe(32);now=time.time()
    with connect() as db:
        db.execute('DELETE FROM sessions WHERE expires<?',(now,))
        db.execute('INSERT INTO sessions VALUES(?,?,?)',(hashlib.sha256(raw.encode()).hexdigest(),now,now+SESSION_LIFETIME))
    with SESSION_LOCK:
        SESSION_CACHE[hashlib.sha256(raw.encode()).hexdigest()] = now + SESSION_LIFETIME
    return raw

def session_ok(raw):
    if not raw or len(raw)>128:return False
    key=hashlib.sha256(raw.encode()).hexdigest()
    with SESSION_LOCK:
        return SESSION_CACHE.get(key,0)>time.time()

def revoke_session(raw):
    if raw:
        key=hashlib.sha256(raw.encode()).hexdigest()
        with connect() as db:db.execute('DELETE FROM sessions WHERE token_hash=?',(key,))
        with SESSION_LOCK:SESSION_CACHE.pop(key,None)

def icon_host(value):
    host=str(value or '').strip().lower().removeprefix('www.')
    if not host or len(host)>253 or not re.fullmatch(r'[a-z0-9.-]+',host):raise ValueError('Dominio no valido')
    return host

def icon_mime(raw):
    if raw.startswith(b'\x89PNG\r\n\x1a\n'):return 'image/png'
    if raw.startswith(b'\xff\xd8\xff'):return 'image/jpeg'
    if raw.startswith(b'GIF8'):return 'image/gif'
    if raw.startswith(b'RIFF') and raw[8:12]==b'WEBP':return 'image/webp'
    if raw.startswith(b'\x00\x00\x01\x00'):return 'image/x-icon'
    raise ValueError('Formato de icono no valido')

def generic_title(title,url=''):
    text=re.sub(r'^\s*\(\d+\)\s*','',str(title or '')).strip().casefold()
    host=(urlparse(url).hostname or '').removeprefix('www.')
    return not text or text in {'(sin título)','untitled',host,host.split('.')[0]}

def enrich_rows(db, rows):
    if not rows:return []
    urls=list({url for row in rows if row['url'] for url in [row['url'],metadata_url(row['url'])]})
    pages={}
    for start in range(0,len(urls),800):
        part=urls[start:start+800]
        for source in sorted({row['source'] for row in rows}):
            for page in db.execute('SELECT * FROM page_metadata WHERE source=? AND url IN ('+','.join('?' for _ in part)+')',[source,*part]):
                pages[(page['source'],page['url'])]=page
    now=time.time()*1000;out=[]
    for stored in rows:
        row=json.loads(stored['payload']);row['captureDevice']=stored['source'];page=pages.get((stored['source'],metadata_url(stored['url']))) or pages.get((stored['source'],stored['url']))
        if page:
            recent=0<=page['last_seen']-float(row.get('visitTime') or 0)<=300000
            if page['title'] and not generic_title(page['title'],row.get('url','')) and (recent or generic_title(row.get('title'),row.get('url',''))):
                if row.get('title')!=page['title']:row['originalTitle']=row.get('title') or '';row['title']=page['title']
            if page['audible'] and now-page['last_seen']<90000:row['playingAudio']=True
        out.append(row)
    return out

def projection_content(row):
    # Observation timestamps remain in the original backup. They do not change
    # the displayed timeline or justify rebuilding its index entry every refresh.
    return {key:value for key,value in row.items() if key not in ('lastSeenAt','lastVerifiedAt')}

def display_priority(row):
    now=time.time()*1000;event=float(row.get('visitTime') or row.get('eventTime') or row.get('time') or row.get('capturedAt') or 0)
    return int(min(event,now+60000)//60000)+10 if event>=now-2*86400000 else 0

def harmonize_visit_aliases(db,source,row):
    visit_id=row.get('visitId');event=float(row.get('visitTime') or 0)
    if not event or row.get('chromeState') not in ('present','deleted'):return row,[]
    siblings=[]
    for stored in db.execute("SELECT item_key,payload,stamp FROM records INDEXED BY records_time WHERE store='visits' AND event_time BETWEEN ? AND ? AND source=?",(event-1,event+1,source)):
        value=json.loads(stored['payload'])
        other_id=value.get('visitId')
        same=visit_id is not None and other_id is not None and str(other_id)==str(visit_id)
        if same:siblings.append((stored,value))
    evidence=max([row,*[value for _,value in siblings]],key=lambda value:(float(value.get('lastVerifiedAt') or 0),value.get('chromeState')=='deleted'))
    row={**row,'chromeState':evidence['chromeState'],'deletedAt':evidence.get('deletedAt') if evidence['chromeState']=='deleted' else None,'lastVerifiedAt':evidence.get('lastVerifiedAt') or row.get('lastVerifiedAt') or 0}
    changed=[]
    for stored,value in siblings:
        if stored['item_key']==str(row.get('fingerprint')):continue
        if value.get('chromeState')==row['chromeState'] and value.get('deletedAt')==row.get('deletedAt'):continue
        value.update(chromeState=row['chromeState'],deletedAt=row.get('deletedAt'),lastVerifiedAt=row['lastVerifiedAt'])
        db.execute("UPDATE records SET state=?,stamp=?,payload=? WHERE source=? AND store='visits' AND item_key=?",(value['chromeState'],max(stored['stamp'],float(row['lastVerifiedAt'])),json.dumps(value,ensure_ascii=False,separators=(',',':')),source,stored['item_key']))
        changed.append(value)
    return row,changed

def ingest(source, body):
    now = time.time() * 1000
    label = str(body.get('label') or source)[:100]
    inserted = 0;metadata_changed=False;metadata_visits=[];dirty={}
    with LOCK, connect() as db:
        prior_records={};durable=False
        for store,rows in body.get('stores',{}).items():
            if store!='visits':
                durable=durable or bool(rows);continue
            if not isinstance(rows,list) or len(rows)>1000:raise ValueError('Lote no valido')
            for row in rows:
                if not isinstance(row,dict):raise ValueError('Registro no valido')
                key=str(row.get('fingerprint'));previous_row=db.execute('SELECT payload FROM records WHERE source=? AND store=? AND item_key=?',(source,store,key)).fetchone()
                prior_records[(store,key)]=previous_row
                if not previous_row or projection_content(json.loads(previous_row['payload']))!=projection_content(row):durable=True
        # FULL durability is retained for original event content. Heartbeats and
        # repeat observations can be recovered from the next signal; they must
        # not hold the original-record writer behind a filesystem flush.
        if not durable:db.execute('PRAGMA synchronous=NORMAL')
        previous = db.execute('SELECT state,counts FROM devices WHERE id=?',(source,)).fetchone()
        state = body.get('state') if isinstance(body.get('state'),dict) else json.loads(previous['state']) if previous else {}
        counts = body.get('counts') if isinstance(body.get('counts'),dict) else json.loads(previous['counts']) if previous else {}
        db.execute('INSERT INTO devices VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,last_seen=excluded.last_seen,state=excluded.state,counts=excluded.counts',
                   (source,label,now,json.dumps(state,ensure_ascii=False),json.dumps(counts)))
        icons=body.get('icons',[])
        if not isinstance(icons,list) or len(icons)>300:raise ValueError('Lote de iconos no valido')
        for icon in icons:
            host=icon_host(icon.get('host'))
            raw=base64.b64decode(icon.get('data',''),validate=True)
            if not raw or len(raw)>131072:raise ValueError('Icono demasiado grande')
            mime=icon_mime(raw)
            db.execute('INSERT INTO icons VALUES(?,?,?,?) ON CONFLICT(host) DO UPDATE SET mime=excluded.mime,data=excluded.data,updated=excluded.updated',(host,mime,raw,now))
        pages=body.get('pages',[])
        if not isinstance(pages,list) or len(pages)>300:raise ValueError('Lote de paginas no valido')
        for page in pages:
            url=metadata_url(str(page.get('url') or ''))
            if urlparse(url).scheme not in ('http','https') or len(url)>32768:continue
            title=str(page.get('title') or '')[:8192]
            previous_page=db.execute('SELECT title,audible FROM page_metadata WHERE source=? AND url=?',(source,url)).fetchone()
            if previous_page and generic_title(title,url) and not generic_title(previous_page['title'],url):title=previous_page['title']
            changed_page=not previous_page or title!=previous_page['title'] or bool(page.get('audible'))!=bool(previous_page['audible'])
            if changed_page:
                metadata_changed=True
                metadata_visits.extend(json.loads(row['payload']) for row in db.execute("SELECT payload FROM records WHERE source=? AND store='visits' AND (url=? OR url LIKE ?) ORDER BY event_time DESC LIMIT 30",(source,url,url+'&%')))
            db.execute('INSERT INTO page_metadata VALUES(?,?,?,?,?) ON CONFLICT(source,url) DO UPDATE SET title=excluded.title,audible=excluded.audible,last_seen=excluded.last_seen',(source,url,title,int(bool(page.get('audible'))),now))
        for store, rows in body.get('stores',{}).items():
            if store not in STORES or not isinstance(rows,list) or len(rows)>1000:
                raise ValueError('Lote no valido')
            for row in rows:
                if not isinstance(row,dict): raise ValueError('Registro no valido')
                if store=='visits':
                    row,aliases=harmonize_visit_aliases(db,source,row)
                    for alias in aliases:
                        dirty.setdefault('visits',[]).append(alias)
                        db.execute('INSERT INTO projection_queue(source,store,item_key,queued,priority) VALUES(?,?,?,?,?) ON CONFLICT(source,store,item_key) DO UPDATE SET queued=excluded.queued,priority=max(projection_queue.priority,excluded.priority)',(source,'visits',str(alias['fingerprint']),time.time_ns(),display_priority(alias)))
                raw=json.dumps(row,ensure_ascii=False,separators=(',',':'))
                item=str(row.get('fingerprint') if store=='visits' else row.get('id') or hashlib.sha256(raw.encode()).hexdigest())
                if item=='None': raise ValueError('Falta identificador')
                event=float(row.get('visitTime') or row.get('eventTime') or row.get('time') or row.get('capturedAt') or 0)
                stamp=max(float(row.get(x) or 0) for x in ('lastSeenAt','lastVerifiedAt','capturedAt','time'))
                if store=='visits':
                    canonical=str(round(event))+'|'+str(row.get('url') or '')
                else:
                    comparable={k:v for k,v in row.items() if k!='id'}
                    canonical=hashlib.sha256(json.dumps(comparable,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
                previous_record=prior_records.get((store,item))
                display_changed=not previous_record or projection_content(json.loads(previous_record['payload']))!=projection_content(row)
                before=db.total_changes
                db.execute('''INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?)
                  ON CONFLICT(source,store,item_key) DO UPDATE SET canonical=excluded.canonical,
                  event_time=excluded.event_time,state=excluded.state,title=excluded.title,url=excluded.url,
                  stamp=excluded.stamp,payload=excluded.payload WHERE excluded.stamp>=records.stamp AND excluded.payload<>records.payload''',
                  (source,store,item,canonical,event,row.get('chromeState'),str(row.get('title') or ''),str(row.get('url') or ''),stamp,raw))
                inserted+=1
                if db.total_changes>before and display_changed:
                    dirty.setdefault(store,[]).append(row)
                    if store=='visits':
                        priority=display_priority(row)
                        db.execute('INSERT INTO projection_queue(source,store,item_key,queued,priority) VALUES(?,?,?,?,?) ON CONFLICT(source,store,item_key) DO UPDATE SET queued=excluded.queued,priority=max(projection_queue.priority,excluded.priority)',(source,store,item,time.time_ns(),priority))
        if metadata_visits:
            db.executemany('INSERT INTO projection_queue(source,store,item_key,queued,priority) VALUES(?,?,?,?,?) ON CONFLICT(source,store,item_key) DO UPDATE SET queued=excluded.queued,priority=max(projection_queue.priority,excluded.priority)',[(source,'visits',str(row['fingerprint']),time.time_ns(),int(now//60000)+12) for row in metadata_visits])
    if dirty or metadata_changed:
        if metadata_visits:dirty.setdefault('visits',[]).extend(metadata_visits)
        if not LIVE_ARCHIVE.enabled:LIVE_ARCHIVE.changed(source,dirty,pages=metadata_changed)
    return {'ok':True,'accepted':inserted,'serverTime':now}

def selection(db, store, source, sequential=False):
    table='records'+(' NOT INDEXED' if sequential else '')
    if source and source!='all':
        return 'SELECT *,1 AS rn FROM '+table+' WHERE store=? AND source=?',[store,source]
    # Preserve every original laptop record, including distinct visit IDs at the same timestamp.
    # A second device only contributes records that are absent from that laptop snapshot.
    return '''SELECT r.*,1 AS rn FROM records r '''+('NOT INDEXED ' if sequential else '')+'''WHERE r.store=? AND
      (r.source='laptop' OR NOT EXISTS (
        SELECT 1 FROM records preferred WHERE preferred.store=r.store
        AND preferred.canonical=r.canonical AND preferred.source='laptop'))''',[store]

def db_operation(op, args, source='all'):
    store={'queryVisits':'visits','getAggregationSample':'visits','getRecentEvents':'events'}.get(op)
    if op=='countStore': store=args.get('store')
    if store not in STORES: raise ValueError('Operacion no valida')
    with connect() as db:
        sql,params=selection(db,store,source)
        where=[]
        if op=='countStore':
            if args.get('index')=='chromeState':
                where.append('state=?');params.append(str(args.get('key')))
            params=[store]
            predicate='r.store=?'
            if source!='all':predicate+=' AND r.source=?';params.append(source)
            else:predicate+=" AND (r.source='laptop' OR NOT EXISTS (SELECT 1 FROM records p INDEXED BY records_preferred WHERE p.store=r.store AND p.source='laptop' AND p.canonical=r.canonical))"
            if args.get('index')=='chromeState':predicate+=' AND r.state=?';params.append(str(args.get('key')))
            return db.execute('SELECT count(*) FROM records r INDEXED BY records_counts WHERE '+predicate,params).fetchone()[0]
        if op=='queryVisits':
            if args.get('q'):
                where.append("(lower(title) LIKE ? OR lower(url) LIKE ? OR EXISTS (SELECT 1 FROM page_metadata m WHERE m.source=selected.source AND m.url IN (selected.url,metadata_url(selected.url)) AND lower(m.title) LIKE ?))")
                needle='%'+str(args['q']).lower()+'%';params.extend([needle,needle,needle])
            if args.get('from') is not None: where.append('event_time>=?');params.append(float(args['from']))
            if args.get('to') is not None: where.append('event_time<=?');params.append(float(args['to']))
            if args.get('deletedOnly'): where.append("state='deleted'")
        limit=max(1,min(int(args.get('limit') or 100),100000))
        query='SELECT payload,source,url FROM ('+sql+') selected'+(' WHERE '+' AND '.join(where) if where else '')+' ORDER BY event_time DESC LIMIT ?'
        params.append(limit)
        rows=db.execute(query,params).fetchall()
        return enrich_rows(db,rows) if store=='visits' else [json.loads(x['payload']) for x in rows]

META_REFRESHING=set();META_ATTEMPTS={};META_FILE_LOCK=threading.Lock()
def calculate_counts(source):
    counts={store:db_operation('countStore',{'store':store},source) for store in STORES}
    counts['deleted']=db_operation('countStore',{'store':'visits','index':'chromeState','key':'deleted'},source)
    return counts

def save_counts(source,counts):
    key=(str(DB),source)
    with META_LOCK:META_CACHE[key]=(time.monotonic(),counts,time.time()*1000)
    with META_FILE_LOCK:
        with META_LOCK:data={name:value[1] for (database,name),value in META_CACHE.items() if database==str(DB)}
        path=DB.parent/'meta-counts.json';pending=path.with_suffix('.pending');pending.write_text(json.dumps(data),encoding='utf-8');os.chmod(pending,0o600);pending.replace(path)

def refresh_counts(source,key):
    try:save_counts(source,calculate_counts(source))
    except Exception:logging.exception('Count refresh will retry; last count snapshot retained')
    finally:
        with META_LOCK:META_REFRESHING.discard(key)

def cached_counts(source):
    key=(str(DB),source)
    if not LIVE_ARCHIVE.enabled:
        counts=calculate_counts(source);return counts,time.time()*1000
    with META_LOCK:
        cached=META_CACHE.get(key)
        if not cached:
            try:
                saved=json.loads((DB.parent/'meta-counts.json').read_text(encoding='utf-8'))
                if source in saved:cached=(0,saved[source],0);META_CACHE[key]=cached
            except (OSError,ValueError):pass
        if cached:
            if time.monotonic()-cached[0]>30 and key not in META_REFRESHING and time.monotonic()-META_ATTEMPTS.get(key,0)>30:
                META_REFRESHING.add(key);META_ATTEMPTS[key]=time.monotonic();threading.Thread(target=refresh_counts,args=(source,key),daemon=True).start()
            return cached[1],cached[2]
    counts=calculate_counts(source);save_counts(source,counts);return counts,time.time()*1000

def metadata(source='all'):
    with connect() as db:
        devices=[dict(x) for x in db.execute('SELECT id,label,last_seen FROM devices ORDER BY id')]
        latest=db.execute('SELECT max(last_seen) FROM devices').fetchone()[0] or 0
    counts,updated=cached_counts(source)
    return {'devices':devices,'lastUpdated':latest,'now':time.time()*1000,'revision':LIVE_ARCHIVE.version,'counts':counts,'countsUpdatedAt':updated}

def chosen_device(source='all'):
    with connect() as db:
        if source!='all':
            return db.execute('SELECT * FROM devices WHERE id=?',(source,)).fetchone()
        now=time.time()*1000
        return db.execute("SELECT * FROM devices ORDER BY (last_seen>?) DESC,(id='laptop') DESC,last_seen DESC LIMIT 1",(now-90000,)).fetchone()

def archive_rows(source,keys=None):
    store='visits'
    with connect() as db:
        if keys is None:
            # The index sorts after combining sources. Read the table in disk order
            # here; sorting its index first caused thousands of random payload reads.
            sql,params=selection(None,store,source,sequential=True)
            rows=db.execute('SELECT payload,source,url,event_time FROM ('+sql+')',params).fetchall()
        else:
            wanted={(key[0],key[2]) for key in keys if key[1]==store and (source=='all' or key[0]==source)}
            db.execute('CREATE TEMP TABLE wanted(source TEXT,item_key TEXT,PRIMARY KEY(source,item_key)) WITHOUT ROWID')
            db.executemany('INSERT INTO wanted VALUES (?,?)',wanted)
            # Look up changed records by their primary key once. Repeated scans for
            # each 400-key batch made a bulk deletion stall every live request.
            rows=db.execute('''SELECT r.payload,r.source,r.url,r.event_time
              FROM wanted w CROSS JOIN records r ON r.source=w.source AND r.store=? AND r.item_key=w.item_key
              WHERE (?<>'all' OR r.source='laptop' OR NOT EXISTS (
                SELECT 1 FROM records preferred WHERE preferred.store=r.store
                AND preferred.source='laptop' AND preferred.canonical=r.canonical))
              ORDER BY r.event_time DESC LIMIT 200''',(store,source)).fetchall()
        return enrich_rows(db,rows)

def projection_fetch():
    with connect() as db:return [dict(row) for row in db.execute('SELECT * FROM projection_queue ORDER BY priority DESC,queued LIMIT 40')]

def projection_ack(rows):
    with LOCK,connect() as db:
        # A lost acknowledgement only repeats an idempotent projection. It must
        # not request a FULL disk flush or delay the next original capture.
        db.execute('PRAGMA synchronous=NORMAL')
        db.executemany('DELETE FROM projection_queue WHERE source=? AND store=? AND item_key=? AND queued=?',[(row['source'],row['store'],row['item_key'],row['queued']) for row in rows])

LIVE_ARCHIVE=PersistentArchive(lambda:DB.parent,archive_rows)
LIVE_ARCHIVE.queue_fetch=projection_fetch
LIVE_ARCHIVE.queue_ack=projection_ack

def complete_activity(source,options):
    return LIVE_ARCHIVE.timeline(source,options)

class Handler(BaseHTTPRequestHandler):
    server_version='HistorialEspejo'
    def log_message(self,*args): pass
    def reply(self,status,data,kind='application/json; charset=utf-8',cache=None):
        body=json.dumps(data,ensure_ascii=False).encode() if kind.startswith('application/json') else data if isinstance(data,bytes) else data.encode()
        self.send_response(status)
        self.send_header('Content-Type',kind)
        self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control',cache or ('no-store' if self.path.startswith('/api/') else 'no-cache'))
        self.send_header('X-Content-Type-Options','nosniff')
        for value in getattr(self,'_session_cookies',[]):self.send_header('Set-Cookie',value)
        self._session_cookies=[]
        origin=self.headers.get('Origin','')
        if self.path.startswith('/api/collector/') and origin in self.collector_origins():
            self.send_header('Access-Control-Allow-Origin',origin)
            self.send_header('Vary','Origin')
        try:self.end_headers();self.wfile.write(body)
        except (BrokenPipeError,ConnectionResetError):pass
    def collector_origins(self):
        # Comma-separated extension origins allowed to call the collector API from a page,
        # e.g. MIRROR_COLLECTOR_ORIGINS=chrome-extension://<your-extension-id>
        return {x.strip() for x in os.environ.get('MIRROR_COLLECTOR_ORIGINS','').split(',') if x.strip()}
    def live_stream(self):
        self.send_response(200)
        self.send_header('Content-Type','text/event-stream; charset=utf-8')
        self.send_header('Cache-Control','no-cache, no-store')
        self.send_header('X-Accel-Buffering','no')
        self.end_headers();self.close_connection=True
        version=-1;deadline=time.monotonic()+50
        try:
            while time.monotonic()<deadline:
                current=LIVE_ARCHIVE.wait(version,timeout=10)
                if current!=version:
                    self.wfile.write(('event: changed\ndata: '+json.dumps({'revision':current})+'\n\n').encode());version=current
                else:self.wfile.write(b': keepalive\n\n')
                self.wfile.flush()
        except (BrokenPipeError,ConnectionResetError,TimeoutError):pass
    def do_OPTIONS(self):
        if not self.path.startswith('/api/collector/') or self.headers.get('Origin') not in self.collector_origins():
            return self.reply(403,{'error':'Origen no autorizado'})
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin',self.headers['Origin'])
        self.send_header('Access-Control-Allow-Methods','GET,POST,OPTIONS')
        self.send_header('Access-Control-Allow-Headers','Authorization,Content-Type')
        self.send_header('Access-Control-Max-Age','600')
        self.end_headers()
    def parse(self):
        p=urlparse(self.path);return p.path,parse_qs(p.query)
    def cookies(self):
        try:
            result=SimpleCookie();result.load(self.headers.get('Cookie',''));return result
        except CookieError:return SimpleCookie()
    def issue_session(self):
        token=new_session()
        self._session_cookies=[f'{SESSION_COOKIE}={token}; Path=/; Max-Age={SESSION_LIFETIME}; Secure; HttpOnly; SameSite=Lax',
                               f'{LOGOUT_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax']
    def authenticated(self):
        cookies=self.cookies();current=cookies.get(SESSION_COOKIE)
        if current and session_ok(current.value):return True
        # Upgrade a browser's already-cached HTTP credentials once, without another popup.
        header=self.headers.get('Authorization','')
        if LOGOUT_COOKIE not in cookies and header.startswith('Basic '):
            try:
                user,password=base64.b64decode(header[6:],validate=True).decode('utf-8').split(':',1)
                if password_ok(user,password):self.issue_session();return True
            except (ValueError,UnicodeError):pass
        return False
    def require_session(self,path):
        if self.authenticated():return True
        if path in ('/','/index.html','/viewer.html','/auth/login'):
            self.reply(200,(ROOT/'static/login.html').read_bytes(),'text/html; charset=utf-8',cache='no-store')
        else:self.reply(401,{'error':'Abre tu enlace personal para conectar este navegador.','loginRequired':True})
        return False
    def auth_post(self,path):
        if path not in ('/auth/activate','/auth/login','/auth/logout'):return False
        origin=self.headers.get('Origin')
        if origin and origin!='https://'+DOMAIN:
            self.reply(403,{'error':'Origen no autorizado'});return True
        body=self.body()
        if path=='/auth/logout':
            current=self.cookies().get(SESSION_COOKIE)
            if current:revoke_session(current.value)
            self._session_cookies=[f'{SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
                                   f'{LOGOUT_COOKIE}=1; Path=/; Max-Age={SESSION_LIFETIME}; Secure; HttpOnly; SameSite=Lax']
            self.reply(200,{'ok':True});return True
        client_ip=self.headers.get('X-Forwarded-For',self.client_address[0]).split(',')[-1].strip()
        now=time.time()
        with LOCK:
            attempts=[stamp for stamp in AUTH_ATTEMPTS.get(client_ip,[]) if now-stamp<600]
            AUTH_ATTEMPTS[client_ip]=attempts
        if len(attempts)>=15:self.reply(429,{'error':'Espera unos minutos y vuelve a abrir tu enlace personal.'});return True
        valid=activation_ok(body.get('token')) if path=='/auth/activate' else password_ok(body.get('username','admin'),body.get('password'))
        if valid:
            with LOCK:AUTH_ATTEMPTS.pop(client_ip,None)
            self.issue_session();self.reply(200,{'ok':True});return True
        with LOCK:AUTH_ATTEMPTS.setdefault(client_ip,[]).append(now)
        self.reply(401,{'error':'El enlace o la contraseÃ±a no son vÃ¡lidos.'});return True
    def collector(self):
        token=self.headers.get('Authorization','').removeprefix('Bearer ')
        for device,value in TOKENS.items():
            if token and hmac.compare_digest(token,value): return device
        return None
    def body(self):
        if not self.headers.get('Content-Type','').startswith('application/json'): raise ValueError('Se requiere JSON')
        size=int(self.headers.get('Content-Length','0'))
        if size<0 or size>20*1024*1024: raise ValueError('Peticion demasiado grande')
        return json.loads(self.rfile.read(size) or b'{}')
    def do_GET(self):
        try:
            path,qs=self.parse();source=qs.get('source',['all'])[0]
            if path=='/healthz':return self.reply(200,{'ok':True})
            if path=='/vnc.html':
                self.send_response(302);self.send_header('Location','/');self.send_header('Cache-Control','no-store');self.end_headers();return
            if path.startswith('/api/collector/'):
                device=self.collector()
                if not device: return self.reply(401,{'error':'No autorizado'})
                if path=='/api/collector/commands':
                    with LOCK,connect() as db:
                        db.execute('PRAGMA synchronous=NORMAL');db.execute('BEGIN IMMEDIATE')
                        jobs=[dict(x) for x in db.execute("SELECT id,command FROM jobs WHERE target=? AND status='pending' AND created>? ORDER BY created LIMIT 4",(device,time.time()*1000-90000))]
                        for job in jobs:
                            job['command']=json.loads(job['command'])
                            db.execute("UPDATE jobs SET status='running' WHERE id=?",(job['id'],))
                        known=db.execute('SELECT 1 FROM devices WHERE id=?',(device,)).fetchone() is not None
                    return self.reply(200,{'jobs':jobs,'known':known})
                return self.reply(404,{'error':'Ruta no encontrada'})
            if path=='/auth/login.js':return self.reply(200,(ROOT/'static/login.js').read_bytes(),'text/javascript; charset=utf-8',cache='no-store')
            if path in ('/favicon.svg','/favicon.ico'):
                return self.reply(200,'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="16" fill="#b4a5fa"/><text x="16" y="23" text-anchor="middle" font-family="Arial" font-size="23" font-weight="bold" fill="#202124">H</text></svg>','image/svg+xml',cache='private, max-age=3600')
            if path=='/auth/status':
                connected=self.authenticated();return self.reply(200 if connected else 401,{'connected':connected})
            if not self.require_session(path):return
            if path=='/api/live':return self.live_stream()
            if path=='/api/meta': return self.reply(200,metadata(source))
            if path=='/api/timeline':
                def value(key,default):return qs.get(key,[default])[0]
                options={'q':value('q','')[:500],
                  'start':float(value('from','0')) if 'from' in qs else None,'end':float(value('to','0')) if 'to' in qs else None,
                  'offset':max(0,int(value('offset','0'))),'limit':max(1,min(500,int(value('limit','100')))),
                  'asof':float(value('asof','0')) if 'asof' in qs else None}
                return self.reply(200,PAGE_CACHE.get(('timeline',source,options),lambda:complete_activity(source,options),persist=options['offset']==0 and options['limit']==100 and not options['q'] and options['start'] is None and options['end'] is None and options['asof'] is None,minimum_revision=LIVE_ARCHIVE.version))
            if path=='/api/state':
                device=chosen_device(source)
                result=json.loads(device['state']) if device else {'local':{},'sync':{}}
                result['device']={'id':device['id'],'label':device['label'],'lastSeen':device['last_seen']} if device else None
                return self.reply(200,result)
            if path.startswith('/api/jobs/'):
                with connect() as db:
                    row=db.execute('SELECT status,result FROM jobs WHERE id=?',(path.rsplit('/',1)[1],)).fetchone()
                    return self.reply(200,{'status':row['status'],'result':json.loads(row['result'] or '{}')} if row else {'status':'missing'})
            if path=='/api/favicon':
                host=urlparse(qs.get('url',[''])[0]).hostname or '?'
                with connect() as db:
                    icon=db.execute('SELECT mime,data FROM icons WHERE host=?',(host.lower().removeprefix('www.'),)).fetchone()
                if icon:return self.reply(200,bytes(icon['data']),icon['mime'],cache='private, max-age=3600')
                return self.reply(200,'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="11" fill="none" stroke="#9aa0a6" stroke-width="2"/><ellipse cx="16" cy="16" rx="5" ry="11" fill="none" stroke="#9aa0a6" stroke-width="2"/><path d="M5 16h22" stroke="#9aa0a6" stroke-width="2"/></svg>','image/svg+xml')
            if path in ('/favicon.svg','/favicon.ico'):
                return self.reply(200,'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="16" fill="#b4a5fa"/><text x="16" y="23" text-anchor="middle" font-family="Arial" font-size="23" font-weight="bold" fill="#202124">H</text></svg>','image/svg+xml',cache='private, max-age=3600')
            files={'/':'index.html','/viewer.html':'index.html','/index.html':'index.html','/viewer.js':'viewer.js','/web-db.js':'web-db.js','/web-runtime.js':'web-runtime.js','/mobile.css':'mobile.css'}
            if path not in files: return self.reply(404,{'error':'No encontrado'})
            file=ROOT/'static'/files[path]
            kind={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[file.suffix]
            return self.reply(200,file.read_bytes(),kind)
        except TimeoutError:self.reply(503,{'error':'La consulta sigue en preparaciÃ³n; se conserva la Ãºltima lista guardada.','retryAfter':2})
        except ArchiveWarming as e:self.reply(503,{'error':str(e),'retryAfter':2})
        except (ValueError,TypeError) as e: self.reply(400,{'error':str(e)})
        except Exception:
            logging.exception('API request failed')
            self.reply(500,{'error':'No se pudo procesar la solicitud'})
    def do_POST(self):
        try:
            path,qs=self.parse();source=qs.get('source',['all'])[0]
            if path.startswith('/api/collector/'):
                device=self.collector()
                if not device: return self.reply(401,{'error':'No autorizado'})
                body=self.body()
                if path=='/api/collector/sync': return self.reply(200,ingest(device,body))
                if path=='/api/collector/result':
                    with LOCK,connect() as db:
                        db.execute('PRAGMA synchronous=NORMAL')
                        db.execute("UPDATE jobs SET status=?,result=? WHERE id=? AND target=?",('error' if body.get('error') else 'done',json.dumps(body),str(body.get('id')),device))
                    return self.reply(200,{'ok':True})
                return self.reply(404,{'error':'Ruta no encontrada'})
            if self.auth_post(path):return
            if not self.require_session(path):return
            origin=self.headers.get('Origin')
            if origin and origin!='https://'+DOMAIN and not origin.startswith('http://127.0.0.1:'):
                return self.reply(403,{'error':'Origen no autorizado'})
            body=self.body()
            if path=='/api/db': return self.reply(200,{'result':db_operation(body.get('op'),body.get('args') or {},source)})
            if path=='/api/commands':
                allowed={'verify_urls','import_chrome','presence_enable','presence_disable','reconcile_history'}
                if body.get('type') not in allowed: raise ValueError('Comando no valido')
                device=chosen_device(source)
                if not device or time.time()*1000-device['last_seen']>90000:
                    return self.reply(409,{'error':'El dispositivo de captura no esta conectado. Los datos guardados siguen disponibles.'})
                job=uuid.uuid4().hex
                with LOCK,connect() as db:
                    db.execute('PRAGMA synchronous=NORMAL')
                    db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,NULL)',(job,device['id'],time.time()*1000,'pending',json.dumps(body)))
                return self.reply(202,{'id':job,'device':device['label']})
            return self.reply(404,{'error':'Ruta no encontrada'})
        except (ValueError,TypeError) as e: self.reply(400,{'error':str(e)})
        except Exception:
            logging.exception('API request failed')
            self.reply(500,{'error':'No se pudo procesar la solicitud'})

if __name__=='__main__':
    if os.name=='posix':
        import faulthandler,signal
        faulthandler.register(signal.SIGUSR1,all_threads=True)
    TOKENS=json.loads((DATA/'tokens.json').read_text())
    ACCESS=json.loads((DATA/'access.json').read_text())
    initialize()
    # Keep a connection open so closing a short request cannot implicitly run a
    # final WAL checkpoint on that request's thread. The backup remains FULL sync.
    RAW_ANCHOR=open_wal_anchor(DB)
    LIVE_ARCHIVE.start()
    class PanelServer(ThreadingHTTPServer):
        request_queue_size=128
        daemon_threads=True
    httpd=PanelServer(('127.0.0.1',6082),Handler)
    def notify(message):
        address=os.environ.get('NOTIFY_SOCKET')
        if not address:return
        if address.startswith('@'):address='\0'+address[1:]
        with socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM) as channel:channel.sendto(message.encode(),address)
    def watchdog():
        notify('READY=1')
        while True:
            time.sleep(20)
            try:
                connection=http.client.HTTPConnection('127.0.0.1',6082,timeout=3)
                try:
                    connection.request('GET','/healthz')
                    if connection.getresponse().status==200:notify('WATCHDOG=1')
                finally:connection.close()
            except Exception:logging.exception('API health check failed')
    if os.environ.get('NOTIFY_SOCKET'):threading.Thread(target=watchdog,daemon=True).start()
    httpd.serve_forever()
