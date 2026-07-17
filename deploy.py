#!/usr/bin/env python3
"""
Sub-Store Bot — 一键部署脚本
使用前设置环境变量:
  export CLOUDFLARE_API_TOKEN="your_cf_api_token"
  export BOT_TOKEN="your_telegram_bot_token"
  export ALLOWED_USERS="user_id_1,user_id_2"   # 可选，不设则所有人可用
  export KV_NAMESPACE_ID="your_kv_namespace_id"
  export CLIP_URL="https://your-domain.workers.dev"  # 短链域名
"""
import json, os, sys, secrets, urllib.request

ACCT_ID = os.popen("""curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['result'][0]['id'])"
""").read().strip()

TOKEN = os.environ['CLOUDFLARE_API_TOKEN']
BOT_TOKEN = os.environ['BOT_TOKEN']
ALLOWED_USERS = os.environ.get('ALLOWED_USERS', '')
KV_NS = os.environ['KV_NAMESPACE_ID']
CLIP_URL = os.environ.get('CLIP_URL', '')

WORKER_NAME = os.environ.get('WORKER_NAME', 'sub-store-bot')

CRLF = '\r\n'
boundary = f'---BOUNDARY{secrets.token_hex(8)}---'

# 替换为自己的 proxy-utils.esm.js 路径
ENGINE_PATH = os.environ.get('ENGINE_PATH', './proxy-utils.esm.js')
MAIN_PATH = os.environ.get('MAIN_PATH', './worker.mjs')

with open(ENGINE_PATH, 'rb') as f:
    proxy_utils = f.read().decode('latin-1')

with open(MAIN_PATH, 'r') as f:
    main_script = f.read()

metadata = json.dumps({
    "main_module": "worker.mjs",
    "compatibility_date": "2025-09-27",
    "compatibility_flags": ["nodejs_compat"],
    "bindings": [
        {
            "name": "KV",
            "type": "kv_namespace",
            "namespace_id": KV_NS
        }
    ] + ([
        {
            "name": "CLIP_URL",
            "type": "plain_text",
            "text": CLIP_URL
        }
    ] if CLIP_URL else [])
})

part1 = f'--{boundary}{CRLF}Content-Disposition: form-data; name="metadata"{CRLF}Content-Type: application/json{CRLF}{CRLF}{metadata}{CRLF}'
part2 = f'--{boundary}{CRLF}Content-Disposition: form-data; name="worker.mjs"; filename="worker.mjs"{CRLF}Content-Type: application/javascript+module{CRLF}{CRLF}{main_script}{CRLF}'
part3 = f'--{boundary}{CRLF}Content-Disposition: form-data; name="proxy-utils.esm.js"; filename="proxy-utils.esm.js"{CRLF}Content-Type: application/javascript+module{CRLF}{CRLF}{proxy_utils}{CRLF}'
part4 = f'--{boundary}--{CRLF}'

body = (part1 + part2 + part3 + part4).encode('utf-8')

url = f'https://api.cloudflare.com/client/v4/accounts/{ACCT_ID}/workers/services/{WORKER_NAME}/environments/production'
req = urllib.request.Request(url, data=body, method='PUT')
req.add_header('Authorization', f'Bearer {TOKEN}')
req.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')

try:
    resp = urllib.request.urlopen(req)
    result = json.loads(resp.read())
    print(f'PUT to environment: {result.get("success", False)}')
    print(f'  flags: {result.get("result", {}).get("compatibility_flags")}')
    print(f'  tag: {result.get("result", {}).get("script_tag", "?")}')
    print(f'  bindings: {len(result.get("result", {}).get("bindings", []))}')
except Exception as e:
    print(f'Deploy error: {e}')
    body_data = '' if not hasattr(e, 'read') else e.read().decode()
    if body_data:
        print(body_data[:500])
    sys.exit(1)

# 设置 Secret
print()
for name, val in [('BOT_TOKEN', BOT_TOKEN), ('ALLOWED_USERS', ALLOWED_USERS)]:
    if not val: continue
    secret_url = f'https://api.cloudflare.com/client/v4/accounts/{ACCT_ID}/workers/services/{WORKER_NAME}/environments/production/secrets'
    sreq = urllib.request.Request(secret_url, data=json.dumps({"name": name, "text": val, "type": "secret_text"}).encode(), method='POST')
    sreq.add_header('Authorization', f'Bearer {TOKEN}')
    sreq.add_header('Content-Type', 'application/json')
    try:
        sresp = urllib.request.urlopen(sreq)
        sresult = json.loads(sresp.read())
        print(f'{name}: {sresult.get("success", False)}')
    except Exception as e:
        print(f'{name}: Error: {e}')
