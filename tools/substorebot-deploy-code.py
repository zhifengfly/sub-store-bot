import os, requests, json, sys

ACCOUNT = os.environ['CLOUDFLARE_ACCOUNT_ID']
TOKEN = os.environ['CLOUDFLARE_API_TOKEN']
NAME = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('CF_WORKER_NAME', 'jtb-clip')
DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

if not ACCOUNT or not TOKEN or not NAME:
    print('Missing: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN')
    sys.exit(1)

BASE = f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/scripts/{NAME}'

meta = json.dumps({
    'main_module': 'worker.mjs',
    'keep_bindings': ['kv_namespace', 'plain_text', 'secret_text', 'service'],
})
files = (
    ('metadata', ('meta.json', meta, 'application/json')),
    ('worker.mjs', ('worker.mjs', open(f'{DIR}/worker.mjs', 'rb'), 'application/javascript+module')),
    ('proxy-utils.esm.js', ('proxy-utils.esm.js', open(f'{DIR}/proxy-utils.esm.js', 'rb'), 'application/javascript+module')),
)
r = requests.put(f'{BASE}/content', files=files, headers={'Authorization': f'Bearer {TOKEN}'})
result = r.json()
if result.get('success'):
    print('Deploy OK — 代码已更新，变量已保留')
else:
    print('FAILED:', json.dumps(result.get('errors', ''), indent=2)[:500])
    sys.exit(1)
