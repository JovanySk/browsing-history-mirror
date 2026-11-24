"""Rebuild disposable display indexes without retaining a history graph in the API."""
import os,sys,time,uuid
if os.name=='posix':
    import resource
    os.nice(10)
    resource.setrlimit(resource.RLIMIT_AS,(768*1024*1024,768*1024*1024))
import server
from persistent_archive import entry_key

def prune_derived(db,table,scope,revision,seen):
    # Read only the small revision index; scanning JSON payload pages while holding
    # the writer transaction delayed incoming live records for over a minute.
    stale=[row[0] for row in db.execute('SELECT id FROM '+table+' INDEXED BY '+table+'_revision WHERE scope=? AND revision<=? AND id NOT IN (SELECT id FROM '+seen+')',(scope,revision))]
    for offset in range(0,len(stale),100):
        with db:
            db.executemany('DELETE FROM '+table+' WHERE scope=? AND id=? AND revision<=?',[(scope,key,revision) for key in stale[offset:offset+100]])
        time.sleep(.01)

def rebuild(scope,stage_directory=None):
    archive=server.LIVE_ARCHIVE
    if stage_directory:
        from staged_merge import stage_archive
        archive=stage_archive(archive,stage_directory)
    else:archive.initialize()
    generation=uuid.uuid4().hex;started=time.monotonic()
    with archive.connect() as db:
        revision=db.execute("SELECT value FROM control WHERE key='raw_revision'").fetchone()[0]
        db.execute("UPDATE scopes SET status='building' WHERE scope=?",(scope,))
    full=server.build_archive(server.archive_rows(scope))
    with archive.connect() as db:
        db.execute('PRAGMA synchronous=NORMAL')
        db.executescript('CREATE TEMP TABLE seen_entry(id TEXT PRIMARY KEY) WITHOUT ROWID;')
        db.executemany('INSERT INTO seen_entry VALUES(?)',[(entry_key(item),) for item in full['entries']]);db.commit()
        for offset in range(0,len(full['entries']),50):
            with db:archive.save_entries(db,scope,full['entries'][offset:offset+50],revision,generation)
            time.sleep(.01)
        prune_derived(db,'entries',scope,revision,'seen_entry')
        with db:
            # The original records table is never changed by this worker.
            db.execute("UPDATE scopes SET revision=?,built=?,status='ready',summary='{}' WHERE scope=?",(revision,time.time(),scope))
            db.execute("UPDATE control SET value=value+1 WHERE key='stream_version'")
    print('Archive index ready:',scope,'rows:',len(full['entries']),'seconds:',round(time.monotonic()-started,2),flush=True)

if __name__=='__main__':rebuild(sys.argv[1],sys.argv[2] if len(sys.argv)>2 else None)
