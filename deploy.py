import os, json, requests

ACCOUNT = os.environ["CF_ACCOUNT_ID"]
TOKEN = os.environ["CF_API_TOKEN"]
NAME = os.getenv("CF_WORKER_NAME", "sub-store-bot")

BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/scripts/{NAME}"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}

# 1) GET 当前 bindings（变量/密钥/服务绑定等）
bindings = []
compat_date = ""
compat_flags = []
try:
    r = requests.get(BASE, headers=HEADERS)
    if r.status_code == 200 and r.text.strip():
        existing = r.json().get("result", {})
        bindings = existing.get("bindings", [])
        compat_date = existing.get("compatibility_date", "")
        compat_flags = existing.get("compatibility_flags", [])
        print(f"Found {len(bindings)} existing binding(s)")
    else:
        print(f"No existing script (HTTP {r.status_code}), fresh deploy")
except Exception as e:
    print(f"Warning: could not fetch existing bindings: {e}")

# 2) 构建 metadata — 保留 bindings
meta = {"main_module": "worker.mjs"}
if bindings:
    meta["bindings"] = bindings
if compat_date:
    meta["compatibility_date"] = compat_date
if compat_flags:
    meta["compatibility_flags"] = compat_flags

parts = (
    ("metadata", ("metadata.json", json.dumps(meta), "application/json")),
    ("worker.mjs", ("worker.mjs", open("worker.mjs", "rb"), "application/javascript+module")),
    ("proxy-utils.esm.js", ("proxy-utils.esm.js", open("proxy-utils.esm.js", "rb"), "application/javascript+module")),
)

r = requests.put(f"{BASE}/content", files=parts, headers=HEADERS)
r.raise_for_status()
result = r.json()
print(f"✅ Deployed: {result.get('success')} — {len(bindings)} binding(s) preserved")
