import os, requests, json, sys

ACCOUNT = os.environ['CLOUDFLARE_ACCOUNT_ID']
TOKEN = os.environ['CLOUDFLARE_API_TOKEN']
NAME = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('CF_WORKER_NAME', 'jtb-clip')
DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

if not ACCOUNT or not TOKEN or not NAME:
    print('Missing: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN')
    sys.exit(1)

BASE = f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/scripts/{NAME}'
HEADERS = {'Authorization': f'Bearer {TOKEN}'}

# 1) GET 当前 bindings（变量/密钥/服务绑定等）
bindings = []
compat_date = ''
compat_flags = []
try:
    r = requests.get(BASE, headers=HEADERS)
    if r.status_code == 200 and r.text.strip():
        existing = r.json().get('result', {})
        bindings = existing.get('bindings', [])
        compat_date = existing.get('compatibility_date', '')
        compat_flags = existing.get('compatibility_flags', [])
        print(f'Found {len(bindings)} existing binding(s)')
    else:
        print(f'No existing script (HTTP {r.status_code}), fresh deploy')
except Exception as e:
    print(f'Warning: could not fetch existing bindings: {e}')

# 2) 构建 metadata — 保留 bindings
meta = {'main_module': 'worker.mjs'}
if bindings:
    meta['bindings'] = bindings
if compat_date:
    meta['compatibility_date'] = compat_date
if compat_flags:
    meta['compatibility_flags'] = compat_flags

files = (
    ('metadata', ('meta.json', json.dumps(meta), 'application/json')),
    ('worker.mjs', ('worker.mjs', open(f'{DIR}/worker.mjs', 'rb'), 'application/javascript+module')),
    ('proxy-utils.esm.js', ('proxy-utils.esm.js', open(f'{DIR}/proxy-utils.esm.js', 'rb'), 'application/javascript+module')),
)
r = requests.put(f'{BASE}/content', files=files, headers=HEADERS)
result = r.json()
if result.get('success'):
    print(f'Deploy OK — 代码已更新，{len(bindings)} 个 binding 保留')
else:
    print('FAILED:', json.dumps(result.get('errors', ''), indent=2)[:500])
    sys.exit(1)
