"""Small SQL pages for the UI; the full index is rebuilt in a separate process."""
import contextlib,json,os,pathlib,shutil,signal,sqlite3,subprocess,sys,threading,time,uuid
from activity_timeline import build_archive
from staged_merge import StagedMerge

SCOPES=('all','laptop','vps')
def entry_key(item):
    return item['id']

class PersistentArchive:
    def __init__(self,directory,delta_load):
        self.queue_fetch=None;self.queue_ack=None;self.last_content_change=time.monotonic()
        self._writer=None;self._writer_thread=None;self._conn_local=threading.local();self.busy_until=0;self.process_paused_at=None;self.checkpointer=None
        self.directory=directory;self.delta_load=delta_load;self.condition=threading.Condition();self.enabled=False;self.process=None;self.process_scope=None;self.process_started=0;self.requested={};self.ready_stage=None;self.merger=None;self.retry_after={};self.process_stage=None
    @property
    def path(self):return pathlib.Path(self.directory())/'timeline.sqlite3'
    @contextlib.contextmanager
    def connect(self):
        pooled=threading.current_thread().name.startswith('page-refresh')
        db=getattr(self._conn_local,'db',None) if pooled else None
        if db is None:
            db=sqlite3.connect(self.path,timeout=10);db.row_factory=sqlite3.Row;db.execute('PRAGMA wal_autocheckpoint=0')
            if pooled:
                db.execute('PRAGMA cache_size=-16384');self._conn_local.db=db
        try:
            with db:yield db
        finally:
            if not pooled:db.close()
    @contextlib.contextmanager
    def write(self):
        if self._writer is not None and self._writer_thread==threading.get_ident():
            with self._writer:yield self._writer
            return
        with self.connect() as db:
            db.execute('PRAGMA synchronous=NORMAL')
            yield db
    def initialize(self):
        self.path.parent.mkdir(parents=True,exist_ok=True)
        with self.connect() as db:
            db.executescript('''PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS control(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
            INSERT OR IGNORE INTO control VALUES('raw_revision',0),('stream_version',0);
            CREATE TABLE IF NOT EXISTS scopes(scope TEXT PRIMARY KEY,requested REAL NOT NULL DEFAULT 0,built REAL NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT -1,status TEXT NOT NULL DEFAULT 'pending',summary TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE IF NOT EXISTS entries(scope TEXT NOT NULL,id TEXT NOT NULL,origin TEXT NOT NULL,kind TEXT NOT NULL,domain TEXT NOT NULL,dated INTEGER NOT NULL,sort_time REAL NOT NULL,captured REAL NOT NULL,search TEXT NOT NULL,revision INTEGER NOT NULL,generation TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,id));
            CREATE INDEX IF NOT EXISTS entries_page ON entries(scope,dated DESC,sort_time DESC,captured DESC,id);
            CREATE INDEX IF NOT EXISTS entries_visit ON entries(scope,origin,sort_time);
            CREATE INDEX IF NOT EXISTS entries_stats ON entries(scope,origin,dated);
            CREATE INDEX IF NOT EXISTS entries_count ON entries(scope,captured);
            CREATE INDEX IF NOT EXISTS entries_search ON entries(scope,search,dated,sort_time,captured,domain,id);
            CREATE INDEX IF NOT EXISTS entries_revision ON entries(scope,revision,id);
            CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(search,tokenize='trigram');
            INSERT OR IGNORE INTO control VALUES('search_ready',0);
            CREATE TRIGGER IF NOT EXISTS entries_search_insert AFTER INSERT ON entries BEGIN INSERT OR REPLACE INTO entries_fts(rowid,search) VALUES(new.rowid,new.search); END;
            CREATE TRIGGER IF NOT EXISTS entries_search_delete AFTER DELETE ON entries BEGIN DELETE FROM entries_fts WHERE rowid=old.rowid; END;
            CREATE TRIGGER IF NOT EXISTS entries_search_update AFTER UPDATE OF search ON entries WHEN old.search<>new.search BEGIN DELETE FROM entries_fts WHERE rowid=old.rowid;INSERT INTO entries_fts(rowid,search) VALUES(new.rowid,new.search); END;
            ''')
            db.executemany('INSERT OR IGNORE INTO scopes(scope) VALUES(?)',[(scope,) for scope in SCOPES])
    def build_search_index(self):
        deadline=time.monotonic()+900
        with self.connect() as db:
            if db.execute("SELECT value FROM control WHERE key='search_ready'").fetchone()[0]:return
            db.execute('PRAGMA synchronous=NORMAL');db.execute('PRAGMA busy_timeout=2000')
            maximum=db.execute('SELECT max(rowid) FROM entries').fetchone()[0] or 0
            missing=db.execute('SELECT e.rowid FROM entries e LEFT JOIN entries_fts_docsize f ON f.id=e.rowid WHERE f.id IS NULL ORDER BY e.rowid LIMIT 1').fetchone()
            first=missing[0]-1 if missing else maximum
            for start in range(first,maximum+1,50):
                while True:
                    try:
                        with db:db.execute('INSERT OR REPLACE INTO entries_fts(rowid,search) SELECT rowid,search FROM entries WHERE rowid>? AND rowid<=?',(start,start+50))
                        break
                    except sqlite3.OperationalError as error:
                        if 'locked' not in str(error) or time.monotonic()>deadline:raise
                        time.sleep(.1)
                time.sleep(.01)
            with db:db.execute("UPDATE control SET value=1 WHERE key='search_ready'")
        print('Direct substring search index ready',flush=True)
    def _ensure_search(self):
        while self.enabled:
            try:self.build_search_index();return
            except Exception:
                import logging;logging.exception('Search index preparation will retry');time.sleep(2)
    @property
    def version(self):
        with self.connect() as db:return db.execute("SELECT value FROM control WHERE key='stream_version'").fetchone()[0]
    def request(self,scope):
        if scope not in SCOPES:raise ValueError('Dispositivo no vÃ¡lido')
        self.requested[scope]=time.time()
    def changed(self,source,stores=None,pages=False):
        started=time.monotonic();self.last_content_change=started
        keys=[(source,store,str(row.get('fingerprint'))) for store,rows in (stores or {}).items() if store=='visits' for row in rows]
        if not keys and not pages:return
        with self.write() as db:
            db.execute("UPDATE control SET value=value+1 WHERE key='raw_revision'")
            revision=db.execute("SELECT value FROM control WHERE key='raw_revision'").fetchone()[0]
        for scope in dict.fromkeys([source,'all']):
            mini=build_archive(self.delta_load(scope,keys))
            with self.write() as db:self.save_entries(db,scope,mini['entries'],revision,'live')
        with self.write() as db:db.execute("UPDATE control SET value=value+1 WHERE key='stream_version'")
        with self.condition:self.condition.notify_all()
        if time.monotonic()-started>3:
            import logging;logging.warning('Slow live projection source=%s rows=%s seconds=%.2f',source,len(keys),time.monotonic()-started)
    def save_entries(self,db,scope,items,revision,generation):
        rows=[]
        for original in items:
            item=dict(original);key=entry_key(item)
            if scope=='all' and item.get('captureDevice')=='laptop':
                db.execute("DELETE FROM entries WHERE scope='all' AND sort_time=? AND json_extract(payload,'$.url')=? AND json_extract(payload,'$.captureDevice')='vps'",(item['sortTime'],item.get('url')))
            search=' '.join(str(item.get(k) or '') for k in ('title','url','domain')).casefold()
            rows.append((scope,key,item['origin'],item['kind'],item.get('domain') or '',int(item['timeKnown']),item['sortTime'],float(item.get('capturedAt') or 0),search,revision,generation,json.dumps(item,ensure_ascii=False,separators=(',',':'))))
        primitives=('origin','kind','domain','dated','sort_time','captured','search')
        difference=' OR '.join('entries.'+name+' IS NOT excluded.'+name for name in primitives)
        db.executemany('''INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET origin=excluded.origin,kind=excluded.kind,domain=excluded.domain,dated=excluded.dated,sort_time=excluded.sort_time,captured=excluded.captured,search=excluded.search,revision=excluded.revision,generation=excluded.generation,payload=excluded.payload WHERE excluded.revision>=entries.revision AND ('''+difference+')',rows)
        db.executemany('UPDATE entries SET revision=?,generation=?,payload=? WHERE scope=? AND id=? AND revision<=? AND payload<>?',[(row[9],row[10],row[11],scope,row[1],row[9],row[11]) for row in rows])
    def timeline(self,scope,options):
        self.busy_until=max(self.busy_until,time.monotonic()+.5);self._pause_snapshot()
        self.request(scope);where=['scope=?'];args=[scope]
        if options.get('start') is not None or options.get('end') is not None:where.append('dated=1')
        for name,operator in [('start','>='),('end','<=')]:
            if options.get(name) is not None:where.append('sort_time'+operator+'?');args.append(options[name])
        if options.get('asof') is not None:where.append('captured<=?');args.append(options['asof'])
        if options.get('q'):where.append('instr(search,?)>0');args.append(options['q'].casefold())
        offset=options.get('offset',0);limit=options.get('limit',100);clause=' AND '.join(where)
        table='entries INDEXED BY '+('entries_search' if options.get('q') else 'entries_page')
        with self.connect() as db:
            snapshot_revision=db.execute("SELECT value FROM control WHERE key='stream_version'").fetchone()[0]
            if len(options.get('q') or '')>=3 and db.execute("SELECT value FROM control WHERE key='search_ready'").fetchone()[0]:
                clause+=' AND rowid IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?)'
                args.append('"'+options['q'].casefold().replace('"','""')+'"');table='entries NOT INDEXED'
            count_table=table
            if not any(options.get(k) for k in ('start','end','q','asof')):count_table='entries INDEXED BY entries_count'
            total=db.execute('SELECT count(*) FROM '+count_table+' WHERE '+clause,args).fetchone()[0]
            entries=[json.loads(r[0]) for r in db.execute('SELECT payload FROM '+table+' WHERE '+clause+' ORDER BY dated DESC,sort_time DESC,captured DESC,id LIMIT ? OFFSET ?',args+[limit,offset])]
            stats=db.execute("SELECT count(*),coalesce(sum(dated),0),coalesce(sum(origin='chrome'),0) FROM entries INDEXED BY entries_stats WHERE scope=?",(scope,)).fetchone()
            state=db.execute('SELECT * FROM scopes WHERE scope=?',(scope,)).fetchone()
        return {'entries':entries,'total':total,'offset':offset,'hasMore':offset+limit<total,'undated':stats[0]-stats[1],'dated':stats[1],'chromeCount':stats[2],'revision':snapshot_revision,'indexing':state['built']==0}
    def start(self):
        if self.enabled:return
        self.enabled=True;self.request('all');threading.Thread(target=self._ensure_search,daemon=True).start();threading.Thread(target=self._scheduler,name='snapshot-scheduler',daemon=True).start()
        if self.queue_fetch:threading.Thread(target=self._project,name='live-projection',daemon=True).start()
    def _project(self):
        self._writer=sqlite3.connect(self.path,timeout=10);self._writer.row_factory=sqlite3.Row;self._writer_thread=threading.get_ident()
        self._writer.execute('PRAGMA synchronous=NORMAL');self._writer.execute('PRAGMA cache_size=-32768');self._writer.execute('PRAGMA wal_autocheckpoint=0')
        while self.enabled:
            try:
                batch=self.queue_fetch()
                if batch:
                    self.busy_until=max(self.busy_until,time.monotonic()+.5);self._pause_snapshot()
                groups={}
                for row in batch:groups.setdefault(row['source'],{}).setdefault(row['store'],[]).append({'fingerprint':row['item_key']})
                for source,stores in groups.items():
                    self.changed(source,stores)
                    self.queue_ack([row for row in batch if row['source']==source])
                # Current activity takes precedence over derived snapshots.
                if batch:continue
                if self.ready_stage and not self.merger:
                    scope,directory=self.ready_stage;self.merger=StagedMerge(scope,directory);self.ready_stage=None
                if self.merger:
                    if self.merger.step(self):self.merger=None
                    time.sleep(.025)
                elif not batch:time.sleep(.2)
            except Exception:
                import logging;logging.exception('Durable projection will retry');time.sleep(2)
        self._writer.close();self._writer=None;self._writer_thread=None
    def _pause_snapshot(self):
        process=self.process
        if os.name=='posix' and process and process.poll() is None and self.process_paused_at is None:
            try:
                process.send_signal(signal.SIGSTOP);self.process_paused_at=time.monotonic()
            except ProcessLookupError:pass
    def _resume_snapshot(self):
        process=self.process
        if self.process_paused_at is not None:
            if process and process.poll() is None:
                try:process.send_signal(signal.SIGCONT)
                except ProcessLookupError:pass
                self.process_started+=time.monotonic()-self.process_paused_at
            self.process_paused_at=None
    def _scheduler(self):
        while self.enabled:
            try:
                if self.checkpointer is None or self.checkpointer.poll() is not None:
                    command=[sys.executable,str(pathlib.Path(__file__).with_name('checkpoint_worker.py')),str(self.path.parent)]
                    if os.name=='posix' and shutil.which('ionice'):command=['ionice','-c','3','-t',*command]
                    with open(self.path.parent/'checkpoint-worker.log','ab') as log:self.checkpointer=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT)
                if self.process:
                    result=self.process.poll()
                    if result is None:
                        if time.monotonic()<self.busy_until:self._pause_snapshot()
                        else:self._resume_snapshot()
                        if self.process_paused_at is None and time.monotonic()-self.process_started>600:self.process.kill()
                        time.sleep(.5);continue
                    if result==0:self.ready_stage=(self.process_scope,self.process_stage)
                    else:
                        self.retry_after[self.process_scope]=time.monotonic()+15
                        if self.process_stage:
                            root=(self.path.parent/'.staging').resolve();target=self.process_stage.resolve()
                            if target!=root and target.is_relative_to(root):shutil.rmtree(target,ignore_errors=True)
                    self.process=None;self.process_stage=None;self.process_paused_at=None
                if self.ready_stage or self.merger:time.sleep(2);continue
                with self.connect() as db:
                    revision=db.execute("SELECT value FROM control WHERE key='raw_revision'").fetchone()[0]
                    search_ready=db.execute("SELECT value FROM control WHERE key='search_ready'").fetchone()[0]
                    states=db.execute('SELECT scope,built,revision FROM scopes').fetchall() if search_ready else []
                candidates=[row for row in states if row['revision']<revision and self.requested.get(row['scope'],0)>time.time()-180 and row['built']<time.time()-60 and self.retry_after.get(row['scope'],0)<time.monotonic()]
                if candidates and time.monotonic()>=self.busy_until and time.monotonic()-self.last_content_change>600:
                    todo=min(candidates,key=lambda row:(row['built']!=0,-self.requested.get(row['scope'],0)))
                    self.process_scope=todo['scope'];self.process_started=time.monotonic()
                    self.process_stage=self.path.parent/'.staging'/uuid.uuid4().hex
                    env={**os.environ,'HISTORIAL_DATA':str(self.path.parent)}
                    with open(self.path.parent/'archive-worker.log','ab') as log:
                        command=[sys.executable,str(pathlib.Path(__file__).with_name('archive_worker.py')),todo['scope'],str(self.process_stage)]
                        if os.name=='posix' and shutil.which('ionice'):command=['ionice','-c','3','-t',*command]
                        self.process=subprocess.Popen(command,env=env,stdout=log,stderr=subprocess.STDOUT)
            except Exception:
                import traceback;traceback.print_exc()
            time.sleep(2)
    def wait(self,after,timeout=15):
        deadline=time.monotonic()+timeout
        while True:
            version=self.version
            if version>after or time.monotonic()>=deadline:return version
            with self.condition:self.condition.wait(min(2,max(0,deadline-time.monotonic())))
