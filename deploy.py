import os, json, requests

ACCOUNT = os.environ["CF_ACCOUNT_ID"]
TOKEN = os.environ["CF_API_TOKEN"]
NAME = os.getenv("CF_WORKER_NAME", "sub-store-bot")

BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/scripts/{NAME}"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}

# 先读文件
worker_code = open("worker.mjs", "rb").read()
proxy_code = open("proxy-utils.esm.js", "rb").read()

# 用 multipart 上传到全量端点（保留 bindings）
meta = json.dumps({
    "main_module": "worker.mjs",
    "keep_bindings": ["kv_namespaces", "vars", "secrets", "services"],
})
parts = (
    ("metadata", ("metadata.json", meta, "application/json")),
    ("worker.mjs", ("worker.mjs", worker_code, "application/javascript+module")),
    ("proxy-utils.esm.js", ("proxy-utils.esm.js", proxy_code, "application/javascript+module")),
)

# PUT /workers/scripts/{name} (全量端点，支持 keep_bindings)
r = requests.put(BASE, files=parts, headers=HEADERS)
result = r.json()
if not result.get("success"):
    print("FAILED:", json.dumps(result.get("errors", ""), indent=2)[:500])
    exit(1)
print("✅ Deployed:", result.get("success"))
