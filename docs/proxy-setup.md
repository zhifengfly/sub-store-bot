# 订阅反代搭建

当你的订阅链接托管在 Cloudflare（或使用 Cloudflare 代理的域名）时，Sub-Store Bot 的 Worker 出站请求会被 CF 的防护机制拦截（返回 403 "Just a moment"）。解决方案：用第三方平台（Vercel）做个无状态反代。

## 原理

```
订阅源（CF 防护） ← Vercel 反代（纯 Node.js，直透内容） ← Sub-Store Bot Worker
```

Vercel 的出口 IP 不会被 CF 当作机器人拦截，所以能正常拉取。

## 步骤

### 1. 创建 GitHub 仓库

```bash
# 在 GitHub 上建一个新仓库，比如 sub-fetch-proxy
git clone https://github.com/你的用户名/sub-fetch-proxy.git
cd sub-fetch-proxy
```

### 2. 编写反代代码

创建 `api/index.js`：

```javascript
export default async function handler(req, res) {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing url');

  try {
    const resp = await fetch(decodeURIComponent(url), {
      headers: {
        'User-Agent': 'Karing',
        'Accept': '*/*',
      },
    });
    const text = await resp.text();
    res.setHeader('Content-Type', resp.headers.get('Content-Type') || 'text/plain');
    res.status(resp.status).send(text);
  } catch (e) {
    res.status(500).send(e.message);
  }
}
```

### 3. 创建 Vercel 配置

`vercel.json`：

```json
{
  "functions": {
    "api/index.js": {
      "maxDuration": 30
    }
  }
}
```

### 4. 推送到 GitHub

```bash
git add .
git commit -m "init"
git push
```

### 5. 导入 Vercel

1. 打开 [Vercel Dashboard](https://vercel.com)
2. **Add New → Project**
3. 选择 `sub-fetch-proxy` 仓库
4. 保持默认设置（Framework = Other），点击 **Deploy**
5. 部署完成会得到一个域名如 `sub-fetch-proxy.vercel.app`

> ⚠️ **不要绑定自定义域名到 Cloudflare**：如果你的自定义域名走 CF 代理，CF Worker 调用 `${你的域名}` 仍然是 CF-to-CF 请求，依然会被拦截。请直接使用 Vercel 提供的 `*.vercel.app` 域名。

### 6. 配置 Bot 环境变量

在 Cloudflare Worker 的环境变量中添加：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `PROXY_URL` | `https://sub-fetch-proxy.vercel.app/api?url=` | 订阅链接会拼在后面作为 `url` 参数 |

## 验证

```bash
# 直连（可能 403）
curl -s -o /dev/null -w "%{http_code}" "https://example-sub.com/link"  
# → 403

# 走反代（应 200）
curl -s -o /dev/null -w "%{http_code}" "https://sub-fetch-proxy.vercel.app/api?url=https%3A%2F%2Fexample-sub.com%2Flink"
# → 200
```

## Bot 的 PROXY_URL 测试

用 Bot 的 debug 接口验证：

```bash
curl "https://你的worker域名/debug-fetch?token=你的DEBUG_TOKEN&url=https%3A%2F%2Fexample-sub.com%2Flink"
```

## 注意事项

- Vercel Serverless Function 有 10s 超时限制（Hobby 计划），大订阅可能超时
- 反代理仅对 CF 防护的订阅生效，普通订阅 Bot 仍直连
- 反代代码只做 URL 解码 + fetch + 透传，不解析/不修改内容
- Vercel Hobby 计划每月 100h 函数运行时间，个人使用绰绰有余
