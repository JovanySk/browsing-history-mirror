"""Bound concurrent timeline reads; return the last completed page during refresh."""
import concurrent.futures,hashlib,json,pathlib,threading,time
from collections import OrderedDict

class PageCache:
    def __init__(self,directory,ttl=2,timeout=8,maximum=48):
        self.directory=directory;self.ttl=ttl;self.timeout=timeout;self.maximum=maximum
        self.lock=threading.RLock();self.values=OrderedDict();self.jobs={};self.pool=concurrent.futures.ThreadPoolExecutor(max_workers=2,thread_name_prefix='page-refresh')
    def path(self,key):return pathlib.Path(self.directory())/'page-cache'/(hashlib.sha256(key.encode()).hexdigest()+'.json')
    def get(self,identity,loader,persist=False,minimum_revision=None):
        key=json.dumps(identity,sort_keys=True,separators=(',',':'))
        with self.lock:
            value=self.values.get(key)
            if value is None and persist:
                try:
                    saved=json.loads(self.path(key).read_text(encoding='utf-8'));value=(0,saved);self.values[key]=value
                except (OSError,ValueError):pass
            if value:self.values.move_to_end(key)
            stale=value is not None and minimum_revision is not None and value[1].get('revision',-1)<minimum_revision
            if not value or stale or time.monotonic()-value[0]>=self.ttl:
                future=self.jobs.get(key)
                if future is None:
                    future=self.pool.submit(loader);self.jobs[key]=future
                    def completed(job):
                        try:
                            result={**job.result(),'dataSnapshotAt':time.time()*1000}
                            with self.lock:
                                self.values[key]=(time.monotonic(),result)
                                while len(self.values)>self.maximum:self.values.popitem(last=False)
                            if persist:
                                path=self.path(key);path.parent.mkdir(exist_ok=True);pending=path.with_suffix('.pending');pending.write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')),encoding='utf-8');pending.replace(path)
                        except Exception:pass
                        finally:
                            with self.lock:self.jobs.pop(key,None)
                    future.add_done_callback(completed)
            else:future=None
            previous=dict(value[1]) if value else None
        if previous is not None:
            if stale and future is not None:
                try:future.result(timeout=.25)
                except Exception:pass
                with self.lock:
                    current=self.values.get(key)
                    if current:previous=dict(current[1])
                if previous.get('revision',-1)<minimum_revision:previous['refreshPending']=True
            return previous
        # Only a first visit to a new filter waits; ordinary refreshes never queue behind it.
        result=future.result(timeout=self.timeout)
        with self.lock:cached=self.values.get(key)
        return dict(cached[1]) if cached else {**result,'dataSnapshotAt':time.time()*1000}
