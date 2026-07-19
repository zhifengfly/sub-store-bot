import os, requests, json, sys

ACCOUNT = os.environ['CLOUDFLARE_ACCOUNT_ID']
TOKEN = os.environ['CLOUDFLARE_API_TOKEN']
BOT = os.environ['BOT_TOKEN']
NAME = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('CF_WORKER_NAME', '')
KV_ID = os.environ['KV_NAMESPACE_ID']
DIR = os.path.dirname(os.path.abspath(__file__))

if not ACCOUNT or not TOKEN or not BOT or not NAME or not KV_ID:
    print('Missing required env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, BOT_TOKEN, KV_NAMESPACE_ID, CF_WORKER_NAME')
    sys.exit(1)

BASE = f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/scripts/{NAME}'
CLIP_URL = f'https://{NAME}.{ACCOUNT.split("-")[0] if "-" in ACCOUNT else ACCOUNT}.workers.dev/'

meta = json.dumps({
    'main_module': 'worker.mjs',
    'bindings': [
        {'name': 'KV', 'type': 'kv_namespace', 'namespace_id': KV_ID},
        {'name': 'CLIP_URL', 'type': 'plain_text', 'text': CLIP_URL},
    ]
})
files = (
    ('metadata', ('meta.json', meta, 'application/json')),
    ('worker.mjs', ('worker.mjs', open(f'{DIR}/worker.mjs', 'rb'), 'application/javascript+module')),
    ('proxy-utils.esm.js', ('proxy-utils.esm.js', open(f'{DIR}/proxy-utils.esm.js', 'rb'), 'application/javascript+module')),
)
r = requests.put(f'{BASE}/content', files=files, headers={'Authorization': f'Bearer {TOKEN}'})
if not r.json().get('success'):
    print('Deploy code FAILED:', json.dumps(r.json().get('errors', ''), indent=2)[:300])
    sys.exit(1)
print('Deploy code: OK')

r2 = requests.put(f'{BASE}/secrets', headers={
    'Authorization': f'Bearer {TOKEN}',
    'Content-Type': 'application/json',
}, json={'name': 'BOT_TOKEN', 'text': BOT, 'type': 'secret_text'})
if r2.json().get('success'):
    print('Set BOT_TOKEN: OK')
else:
    print('Set BOT_TOKEN FAILED:', json.dumps(r2.json().get('errors', ''), indent=2)[:200])
