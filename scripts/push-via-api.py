#!/usr/bin/env python3
"""Fallback publisher: upload the committed tree of HEAD to GitHub with the Git Data API (no git transport)."""
import base64, json, os, pathlib, subprocess, sys, urllib.request
OWNER = os.environ.get('OWNER', 'shivamsahugzp'); REPO = os.environ.get('REPO', 'shredlog'); BRANCH = 'main'
TOKEN = pathlib.Path.home().joinpath('.config/github-personal/token').read_text().strip()
API = f'https://api.github.com/repos/{OWNER}/{REPO}'
def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': f'Bearer {TOKEN}', 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'})
    import time
    for attempt in range(10):
        try:
            with urllib.request.urlopen(req, timeout=120) as r: return r.status, json.loads(r.read() or b'{}')
        except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
        except (urllib.error.URLError, OSError, ConnectionError) as e:
            print(f'    network error ({e}); retry {attempt + 1}/10', flush=True); time.sleep(min(20, 2 * (attempt + 1)))
    raise SystemExit('gave up after 10 network failures')
root = pathlib.Path(__file__).resolve().parent.parent
files = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', 'HEAD'], cwd=root, text=True).split()
msg = subprocess.check_output(['git', 'log', '-1', '--pretty=%B'], cwd=root, text=True).strip()
# An empty repo rejects blob creation (409); seed it with one file through the Contents API first.
st, ref0 = call('GET', f'/git/ref/heads/{BRANCH}')
if st != 200:
    st, seeded = call('PUT', '/contents/README.md', {'message': 'Initial commit', 'content': base64.b64encode((root / 'README.md').read_bytes()).decode(), 'branch': BRANCH})
    print('seeded repo:', st, seeded.get('commit', {}).get('sha', seeded.get('message')))
tree = []
for i, f in enumerate(files, 1):
    data = (root / f).read_bytes()
    local_sha = subprocess.check_output(['git', 'hash-object', f], cwd=root, text=True).strip()
    st, _ = call('GET', f'/git/blobs/{local_sha}')
    if st == 200:
        sha = local_sha; print(f'  [{i}/{len(files)}] {f} (already there)', flush=True)
    else:
        st, blob = call('POST', '/git/blobs', {'content': base64.b64encode(data).decode(), 'encoding': 'base64'})
        if st != 201: print('blob failed', f, st, blob); sys.exit(1)
        sha = blob['sha']; print(f'  [{i}/{len(files)}] {f} uploaded', flush=True)
    tree.append({'path': f, 'mode': '100755' if os.access(root / f, os.X_OK) and f.endswith('.sh') else '100644', 'type': 'blob', 'sha': sha})
st, t = call('POST', '/git/trees', {'tree': tree});  assert st == 201, (st, t)
st, ref = call('GET', f'/git/ref/heads/{BRANCH}')
parents = [ref['object']['sha']] if st == 200 else []
st, c = call('POST', '/git/commits', {'message': msg, 'tree': t['sha'], 'parents': parents}); assert st == 201, (st, c)
if parents: st, r = call('PATCH', f'/git/refs/heads/{BRANCH}', {'sha': c['sha'], 'force': True})
else: st, r = call('POST', '/git/refs', {'ref': f'refs/heads/{BRANCH}', 'sha': c['sha']})
assert st in (200, 201), (st, r)
print('pushed commit', c['sha'][:10], 'to', BRANCH)
st, p = call('POST', '/pages', {'source': {'branch': BRANCH, 'path': '/'}})
print('pages:', st, p.get('html_url') or p.get('message'))
st, p = call('GET', '/pages'); print('pages status:', p.get('status'), p.get('html_url'))
