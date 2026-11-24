"""Merge derived snapshots on the same writer that handles live projections."""
import pathlib,sqlite3,time,shutil

TABLES=('entries',)
class StagedMerge:
    def __init__(self,scope,directory):
        self.scope=scope;self.directory=pathlib.Path(directory);self.db=sqlite3.connect(self.directory/'timeline.sqlite3');self.db.row_factory=sqlite3.Row
        self.state=dict(self.db.execute('SELECT * FROM scopes WHERE scope=?',(scope,)).fetchone());self.revision=self.state['revision']
        if self.state['status']!='ready':raise ValueError('Derived snapshot is not complete')
        self.phase='copy';self.table_index=0;self.rowid=0;self.position=(-1,'');self.sql={}
    def step(self,archive):
        if self.phase=='copy':
            table=TABLES[self.table_index]
            rows=self.db.execute('SELECT rowid AS snapshot_rowid,* FROM '+table+' NOT INDEXED WHERE scope=? AND rowid>? ORDER BY rowid LIMIT 25',(self.scope,self.rowid)).fetchall()
            if rows:
                columns=list(rows[0].keys())[1:]
                if table not in self.sql:
                    updates=','.join(c+'=excluded.'+c for c in columns if c not in ('scope','id'))
                    difference=' OR '.join(table+'.'+c+' IS NOT excluded.'+c for c in columns if c not in ('scope','id','revision','generation','payload'))
                    self.sql[table]='INSERT INTO '+table+' VALUES('+','.join('?' for _ in columns)+') ON CONFLICT(scope,id) DO UPDATE SET '+updates+' WHERE excluded.revision>='+table+'.revision AND ('+difference+')'
                with archive.write() as db:
                    db.executemany(self.sql[table],[tuple(row)[1:] for row in rows])
                    db.executemany('UPDATE '+table+' SET revision=?,generation=?,payload=? WHERE scope=? AND id=? AND revision<=? AND payload<>?',[(row['revision'],row['generation'],row['payload'],self.scope,row['id'],row['revision'],row['payload']) for row in rows])
                self.rowid=rows[-1]['snapshot_rowid'];return False
            self.table_index+=1;self.rowid=0
            if self.table_index==len(TABLES):self.phase='prune';self.table_index=0
            return False
        if self.phase=='prune':
            table=TABLES[self.table_index]
            with archive.connect() as db:
                rows=db.execute('SELECT id,revision FROM '+table+' INDEXED BY '+table+'_revision WHERE scope=? AND revision<=? AND (revision,id)>(?,?) ORDER BY revision,id LIMIT 100',(self.scope,self.revision,*self.position)).fetchall()
            if rows:
                keys=[row['id'] for row in rows]
                present={row[0] for row in self.db.execute('SELECT id FROM '+table+' WHERE scope=? AND id IN ('+','.join('?' for _ in keys)+')',[self.scope,*keys])}
                absent=[(self.scope,key,self.revision) for key in keys if key not in present]
                if absent:
                    with archive.write() as db:db.executemany('DELETE FROM '+table+' WHERE scope=? AND id=? AND revision<=?',absent)
                self.position=(rows[-1]['revision'],rows[-1]['id']);return False
            self.table_index+=1;self.position=(-1,'')
            if self.table_index<len(TABLES):return False
            self.phase='finish'
        with archive.write() as db:
            db.execute("UPDATE scopes SET revision=?,built=?,status='ready',summary=? WHERE scope=?",(self.revision,time.time(),self.state['summary'],self.scope))
            db.execute("UPDATE control SET value=value+1 WHERE key='stream_version'")
        self.db.close();self.db=None
        # This directory only contains a derived snapshot, never the original records.
        root=(archive.path.parent/'.staging').resolve();target=self.directory.resolve()
        if target!=root and target.is_relative_to(root):shutil.rmtree(target)
        with archive.condition:archive.condition.notify_all()
        return True

def stage_archive(live,directory):
    from persistent_archive import PersistentArchive
    directory=pathlib.Path(directory);directory.parent.mkdir(mode=0o700,parents=True,exist_ok=True);directory.mkdir(mode=0o700,exist_ok=True)
    staged=PersistentArchive(lambda:directory,None)
    with staged.connect() as db:
        db.execute('ATTACH DATABASE ? AS original',(str(live.path),))
        for table in ('control','scopes',*TABLES):db.execute('CREATE TABLE '+table+' AS SELECT * FROM original.'+table+' WHERE 0')
        db.execute('INSERT INTO control SELECT * FROM original.control');db.execute('INSERT INTO scopes SELECT * FROM original.scopes');db.commit();db.execute('DETACH DATABASE original')
        for table in TABLES:
            db.execute('CREATE UNIQUE INDEX '+table+'_keys ON '+table+'(scope,id)')
            db.execute('CREATE INDEX '+table+'_revision ON '+table+'(scope,revision,id)')
        db.execute('CREATE INDEX entries_visit ON entries(scope,origin,sort_time)')
        db.execute('PRAGMA journal_mode=WAL')
    return staged
