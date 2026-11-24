"""Consolidate durable WAL files away from request and live projection commits."""
import os,pathlib,sqlite3,sys,time
if os.name=='posix':os.nice(15)
base=pathlib.Path(sys.argv[1])
while True:
    time.sleep(5)
    for name in ('mirror.sqlite3','timeline.sqlite3'):
        db=None
        try:
            db=sqlite3.connect(base/name,timeout=2)
            db.execute('PRAGMA busy_timeout=2000');db.execute('PRAGMA wal_autocheckpoint=0');db.execute('PRAGMA cache_size=-4096')
            db.execute('PRAGMA wal_checkpoint(PASSIVE)').fetchone()
        except sqlite3.Error as error:print('Checkpoint will retry:',name,str(error),flush=True)
        finally:
            if db is not None:db.close()
