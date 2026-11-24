"""Chronological timeline built from the browser visits reported by the collectors."""
from urllib.parse import urlparse

def visit_entry(row):
    return {**row,'id':'c:'+str(row.get('fingerprint')),'origin':'chrome','kind':'web_visit','eventTime':row.get('visitTime'),
            'sortTime':row.get('visitTime') or 0,'domain':(urlparse(row.get('url') or '').hostname or '').removeprefix('www.'),
            'timeKnown':bool(row.get('visitTime'))}

def build_archive(visits):
    archive=[visit_entry(row) for row in visits]
    archive.sort(key=lambda x:(x['timeKnown'],x['sortTime'],x.get('capturedAt') or 0),reverse=True)
    return {'entries':archive,'undated':sum(not x['timeKnown'] for x in archive),
            'dated':sum(x['timeKnown'] for x in archive),'chromeCount':len(archive)}
