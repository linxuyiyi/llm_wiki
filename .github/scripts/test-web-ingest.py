#!/usr/bin/env python3
"""Exercise the packaged pipeline over HTTP with a deterministic model fixture.
No browser, no model credentials, no mocked filesystem or Rust commands.
"""
import json, os, re, subprocess, sys, tempfile, threading, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(tempfile.mkdtemp(prefix='llm-wiki-ingest-'))
PROJECT = DATA / 'projects' / 'test'
for directory in ['raw/sources', 'wiki', '.llm-wiki']:
    (PROJECT / directory).mkdir(parents=True, exist_ok=True)
(PROJECT / 'purpose.md').write_text('# Purpose\nA research wiki.', encoding='utf8')
(PROJECT / 'schema.md').write_text('# Schema\nwiki/sources/ contains source summaries. wiki/concepts/ contains concepts.', encoding='utf8')
(PROJECT / 'wiki/index.md').write_text('# Index\n', encoding='utf8')
(PROJECT / '.llm-wiki/project.json').write_text(json.dumps({'id': 'test'}))
project = {'id': 'test', 'name': 'Test', 'path': str(PROJECT)}
settings = {
    'recentProjects': [project], 'lastProject': project,
    'llmConfig': {'provider': 'custom', 'model': 'fixture', 'apiKey': '', 'customEndpoint': 'http://127.0.0.1:19000/v1', 'ollamaUrl': '', 'maxContextSize': 32000, 'streamingEnabled': False},
    'apiConfig': {'token': 'integration-token', 'enabled': True},
}
(DATA / 'app-state.json').write_text(json.dumps(settings))
state = {'calls': 0, 'fail': False}
class Model(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        state['calls'] += 1
        if state['fail']:
            self.send_response(503); self.end_headers(); self.wfile.write(b'{"error":{"message":"fixture model unavailable"}}'); return
        prompt = str(body.get('messages'))
        user = body['messages'][-1]['content']
        if 'Analyze this source document:' in user:
            content = '## Key concepts\nRotary position embedding encodes positions by rotating query and key vectors.'
        elif 'Source document to process:' in user:
            identity = re.search(r'Source document to process: \*\*(.*?)\*\*', user)[1]
            summary = re.search(r'wiki/sources/[\w./-]+\.md', prompt)
            summary = summary[0] if summary else 'wiki/sources/' + Path(identity).stem + '.md'
            slug = Path(identity).stem
            content = f'---FILE: wiki/concepts/{slug}.md---\n---\ntitle: {slug}\nsources: ["{identity}"]\n---\n\n# {slug}\n\nRotary position embedding rotates query and key vectors.\n---END FILE---\n---FILE: {summary}---\n---\ntitle: "Source: {identity}"\nsources: ["{identity}"]\n---\n\n# Source\n\nRotary position embedding encodes relative position through rotations.\n---END FILE---'
        else:
            content = ''
        time.sleep(.1)
        payload = json.dumps({'choices': [{'message': {'role': 'assistant', 'content': content}, 'finish_reason': 'stop'}]}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(payload))); self.end_headers(); self.wfile.write(payload)
    def log_message(self, *_): pass
model = ThreadingHTTPServer(('127.0.0.1', 19000), Model)
threading.Thread(target=model.serve_forever, daemon=True).start()
backend_command = json.loads(os.environ['TEST_BACKEND_COMMAND'])
backend = subprocess.Popen(backend_command + ['--host','127.0.0.1','--port','19829','--data-dir',str(DATA),'--web-dir',str(ROOT/'dist-web')], stdout=subprocess.DEVNULL, stderr=open(DATA/'backend.log','w'))
gateway = None
checks = []
def http(path, method='GET', data=None, token=True, port=18080):
    headers = {'Content-Type': 'application/json'}
    if token: headers['Authorization'] = 'Bearer integration-token'
    req = Request(f'http://127.0.0.1:{port}{path}', headers=headers, method=method, data=json.dumps(data).encode() if data is not None else None)
    try:
        with urlopen(req, timeout=30) as response: return response.status, json.loads(response.read())
    except HTTPError as error: return error.code, json.loads(error.read())
def ready(port):
    for _ in range(100):
        try: http('/api/v1/health', port=port); return
        except Exception: time.sleep(.1)
    raise AssertionError(f'Service on {port} did not start')
def wait(job):
    for _ in range(300):
        _, payload = http('/api/v1/ingest-jobs/' + job['id'])
        result = payload['job']
        if result['status'] in ['succeeded','failed']: return result
        time.sleep(.1)
    raise AssertionError('Ingest did not finish')
def success(job):
    result = wait(job)
    assert result['status'] == 'succeeded', result
    assert result['filesWritten'], result
    for file in result['filesWritten']: assert (PROJECT / file).is_file(), file
    return result
try:
    ready(19829)
    gateway = subprocess.Popen(['node',str(ROOT/'mcp-server/dist/src/web-gateway.js'),'--host','127.0.0.1','--port','18080','--backend','http://127.0.0.1:19829','--web-dir',str(ROOT/'dist-web')], stdout=open(DATA/'gateway.log','w'), stderr=subprocess.STDOUT)
    ready(18080)
    (PROJECT/'raw/sources/manual.txt').write_text('Rotary Position Embedding rotates query and key vectors to encode relative positions.')
    code, payload = http('/api/v1/projects/test/sources/ingest','POST',{'path':'raw/sources/manual.txt'},False)
    assert code == 401; checks.append('API token required')
    code, payload = http('/api/v1/projects/test/sources/ingest','POST',{'path':'../purpose.md'})
    assert code == 400; checks.append('Path traversal rejected')
    outside = DATA/'outside.txt'; outside.write_text('untouched')
    (PROJECT/'raw/sources/escape.txt').symlink_to(outside)
    code, payload = http('/api/v1/projects/test/sources/file?ingest=true','PUT',{'path':'escape.txt','content':'overwritten'})
    assert code == 400 and outside.read_text() == 'untouched'; checks.append('Symlink escape rejected before upload writes')
    code, payload = http('/api/v1/projects/test/sources/ingest','POST',{'path':'raw/sources/manual.txt'})
    assert code == 202, payload
    _, duplicate = http('/api/v1/projects/test/sources/ingest','POST',{'path':'raw/sources/manual.txt'})
    assert payload['job']['id'] == duplicate['job']['id']; checks.append('Repeated active request deduplicated')
    success(payload['job']); checks.append('Existing single source creates actual Wiki files')
    calls = state['calls']
    _, cached = http('/api/v1/projects/test/sources/ingest','POST',{'path':'manual.txt'})
    success(cached['job']); assert calls == state['calls']; checks.append('Unchanged source uses native ingest cache')
    _, uploaded = http('/api/v1/projects/test/sources/file?ingest=true','PUT',{'path':'uploaded.txt','content':'Rotary Position Embedding is a relative position encoding technique.'})
    success(uploaded['job']); checks.append('Upload and automatic single-file ingest')
    inbox = DATA/'inbox'; inbox.mkdir(); (inbox/'scan.txt').write_text('RoPE applies rotations to query and key vectors.')
    _, scan = http('/api/web/projects/test/scheduled-import/scan','POST',{'path':str(inbox)},False)
    success(scan['job']); assert (PROJECT/'raw/sources/scheduled-import/scan.txt').is_file(); checks.append('Scan Now copies and extracts Wiki')
    _, invalid = http('/api/web/projects/test/scheduled-import/scan','POST',{'path':str(DATA/'missing')},False)
    assert wait(invalid['job'])['status'] == 'failed'; checks.append('Missing directory reports failed scan')
    state['fail'] = True
    (PROJECT/'raw/sources/failed.txt').write_text('RoPE combines rotations with attention for relative positions.')
    _, failed = http('/api/v1/projects/test/sources/ingest','POST',{'path':'failed.txt'})
    assert wait(failed['job'])['status'] == 'failed'; checks.append('Model failure is not reported as successful ingest')
    state['fail'] = False
    _, retry = http('/api/v1/projects/test/sources/ingest','POST',{'path':'failed.txt'})
    success(retry['job']); checks.append('Failed source can be retried')
    (inbox/'timer.txt').write_text('Rotary position encoding supports variable sequence lengths.')
    _, payload = http('/api/web/store','POST',{'name':'app-state.json','op':'set','key':f'scheduledImportConfig:{PROJECT}','value':{'enabled':True,'path':str(inbox),'interval':1,'lastScan':None}},False)
    for _ in range(300):
        journal = json.loads((DATA/'web-ingest-jobs.json').read_text())
        timer_jobs = [job for job in journal if job['action']=='scan' and job['createdAt'] > retry['job']['createdAt']]
        if timer_jobs and timer_jobs[-1]['status']=='succeeded': break
        time.sleep(.1)
    else: raise AssertionError('Scheduled import did not complete without browser')
    assert (PROJECT/'raw/sources/scheduled-import/timer.txt').is_file()
    assert any('timer' in p for p in timer_jobs[-1]['filesWritten']); checks.append('Scheduled import runs without browser')
    gateway.terminate(); gateway.wait(timeout=10)
    recovered = json.loads((DATA/'web-ingest-jobs.json').read_text())
    recovered[0]['status'] = 'running'
    (DATA/'web-ingest-jobs.json').write_text(json.dumps(recovered))
    gateway = subprocess.Popen(['node',str(ROOT/'mcp-server/dist/src/web-gateway.js'),'--host','127.0.0.1','--port','18080','--backend','http://127.0.0.1:19829','--web-dir',str(ROOT/'dist-web')], stdout=open(DATA/'gateway-restart.log','w'), stderr=subprocess.STDOUT)
    ready(18080)
    success(recovered[0]); checks.append('Interrupted job recovers after gateway restart')
    print(json.dumps({'checks':checks,'modelFixture':True,'dataDir':str(DATA),'wikiFiles':[str(p.relative_to(PROJECT)) for p in (PROJECT/'wiki').rglob('*.md')]},indent=2))
except Exception:
    print((DATA/'gateway.log').read_text() if (DATA/'gateway.log').exists() else '',file=sys.stderr)
    print((DATA/'backend.log').read_text(),file=sys.stderr)
    raise
finally:
    if gateway: gateway.terminate(); gateway.wait(timeout=10)
    backend.terminate(); backend.wait(timeout=10)
    model.shutdown()
