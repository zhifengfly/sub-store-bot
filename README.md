# Sub-Store Bot ☁️

Telegram Bot — 订阅转换 + 短链分享，内置完整 Sub-Store 引擎（870KB）。

---

## 功能

| 类别 | 功能 | 说明 |
|------|------|------|
| 📥 **输入** | 远程订阅 | 发订阅 URL，自动 7 种 UA 轮询拉取（可自定义 UA 池） |
| | 本地订阅 | 发节点文本或文件，自动解析 |
| | 多订阅合并 | 同对话发多条 URL/文件，内存累计自动去重合并 |
| 🔄 **输出** | 13 种格式 | Clash Meta、URI、JSON、V2Ray、sing-box、Surfboard、Quantumult X、Shadowrocket、Surge、Loon、Stash、Egern、Base64 |
| | WireGuard 双链 | WG 节点自动以 Clash Meta YAML 独立输出，侧链可分享 |
| | Gost 双链 | `socks://` Gost 节点保留原始格式独立输出，侧链可分享 |
| 🎨 **处理** | 去同名上标 | 同名节点自动加数字上标（² ³），第一次出现保持原名 |
| | 智能去重 | 基于节点特征（`server:port:type:uuid:sni:path:network`）去重 |
| ⏱ **短链** | 有效期 | 从不限 / 5分 / 15分 / 1时 / 6时 / 1天 / 7天 / 30天 中选 |
| | 访问次数限制 | 独立 IP 计数，达到上限自动销毁 |
| | 阅后即焚 🔥 | 首次访问即销毁链接（配合梅开二度效果更佳） |
| | 梅开二度 🌀 | 落地页反向代理，伪装订阅端点，保留地址栏不变 |
| | 短链管理 | 查看详情、复制、删除、修改时效 |
| ⚙️ **设置** | UA 轮询配置 | 启用/禁用默认 UA、添加自定义 UA、恢复默认 |
| | 反代支持 | 配置 `PROXY_URL` 绕过 CF-to-CF 订阅拉取拦截 |
| | Debug 接口 | `DEBUG_TOKEN` 鉴权的 debug-fetch 端点 |
| 🌐 **落地页** | 梅开二度 | 赛博风格 HTML 反向代理，可自定义 HTML 地址 |
| 🔐 **安全** | Webhook 校验 | `WEBHOOK_SECRET` 请求头验证，防未授权调用 |



## 一键部署

点击这个屎黄色按钮
[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Linsars/sub-store-bot)

部署完成后：

1. 去 **域** 页面，打开域名路由或绑定自定义域名（可选）
2. 去 **变量与密钥** 页面，添加环境变量：
   - `BOT_TOKEN` = Telegram Bot Token（**必填**，在执行步骤3激活之前填）
   - `CLIP_URL` = 你的 Worker 域名或其他可路由到此worker的域名，如 `https://xxx.workers.dev`（**必填**，在执行步骤3激活之后填）
   - `ALLOWED_USERS` = 白名单ID（逗号分隔），不设则全部
   - `WEBHOOK_SECRET` = 域名防呆，随便设置个密码
   - `PROXY_URL` = 反代地址，绕过 CF 拦截（可选，[搭建教程](docs/proxy-setup.md)）
   - `DEBUG_TOKEN` = 随意设个密码，用于 debug-fetch 接口鉴权（可选）
   - `LANDING_HTML_URL` = 自定义落地页 HTML，不设则用默认（可选）
4. 去 **描述** 页面，点 Worker 域名激活 bot，然后复制此域名去填CLIP_URL
5. Telegram 里发 `/start`

### 同步更新推送

以后此仓库更新（应该是不会了）了，想自动更新同步拉取可以按以下步骤：

1. 打开你的 GitHub 仓库
2. **Add file → Create new file**
3. 路径填  `.github/workflows/fork-sync.yml`  → 把 [_workflows](docs/_workflows/fork-sync.yml) 的内容粘贴进你新建的yml文件  → **Commit**
4. 点 **More** → **Settings** → **Secrets and variables** → **Actions** → **New repository secret** 添加两个变量：
   - Name： `CF_ACCOUNT_ID`
   - Secret： 你的CFID，如登录cf后打开主页地址栏https://dash.cloudflare.com/你的CFID就是这串/home
   - Name： `CF_API_TOKEN`
   - Secret： 你的CF操作令牌。CF首页点左上角三杠最下面 **管理账户** → **账户API令牌** 创建一个
5. 去 **Actions** 页面 → 轻点 **Allworkers** → 点 **Fork Sync** → 猛击 **Run workflow** → 小圆点变绿自动部署激活

## 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `BOT_TOKEN` | Telegram Bot Token | ✅ |
| `CLIP_URL` | 短链基础 URL（如 `https://xxx.workers.dev`） | ✅ |
| `KV` | KV Namespace 绑定名（一键部署自动创建） | ✅ |
| `ALLOWED_USERS` | 允许的用户 ID（逗号分隔），不设则全部开放 | ❌ |
| `WEBHOOK_SECRET` | Webhook 请求头校验，防域名探测 | ❌ |
| `PROXY_URL` | 反代基础 URL，绕过 CF-to-CF 拉取拦截 | ❌ |
| `DEBUG_TOKEN` | debug-fetch 接口鉴权 Token | ❌ |
| `LANDING_HTML_URL` | 自定义落地页 HTML 地址，默认从本仓库拉取 | ❌ |

## 目录结构

```
├── worker.mjs           # 主程序
├── proxy-utils.esm.js   # Sub-Store 引擎（870KB）
├── wrangler.toml        # Cloudflare Workers 配置
├── README.md
├── landing/
│   └── index.html       # 落地页 HTML（GitHub 拉取，KV 缓存 24h）
├── docs/
│   └── proxy-setup.md   # 反代搭建教程
└── _workflows/
    └── fork-sync.yml    # 同步更新工作流（重命名为 .github/workflows/ 后启用）
```

## License

MIT
