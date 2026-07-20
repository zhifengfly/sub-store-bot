# Sub-Store Bot ☁️

Telegram Bot — 订阅转换 + 短链分享，内置完整 Sub-Store 引擎。

引擎由 GitHub Actions 从 [sub-store-org/Sub-Store](https://github.com/sub-store-org/Sub-Store) 同步构建，支持 ECH、sing-box、Surge cert-verify-name 等上游最新特性。

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
| | 访问次数限制 | 独立 IP 计数（CAS 原子写入），达到上限自动销毁 |
| | 阅后即焚 🔥 | 首次访问即销毁链接（配合梅开二度效果更佳） |
| | 梅开二度 🌀 | 落地页反向代理，伪装订阅端点，保留地址栏不变 |
| | 短链管理 | 查看详情、修改时效/次数、删除 |
| ⚙️ **设置** | 用户配置持久化 | `_burn`、`_landing`、默认时效/次数写入 KV，Worker 重启不丢 |
| | UA 轮询配置 | 启用/禁用默认 UA、添加自定义 UA、恢复默认 |
| | 反代支持 | 配置 `PROXY_URL` 绕过 CF-to-CF 订阅拉取拦截 |
| 🔐 **安全** | Webhook 校验 | `WEBHOOK_SECRET` 请求头验证，防未授权调用 |
| | TG 限流 | 未设 `ALLOWED_USERS` 时自动限制 30 秒 5 次 |
| | SSRF 防护 | `LANDING_HTML_URL` 限 `github.com` / `raw.githubusercontent.com` |
| 🌐 **落地页** | 梅开二度落地页 | 赛博风格 HTML 反向代理（0 1 脉冲特效），可自定义 HTML 地址 |

## 一键部署

点击按钮
[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Linsars/sub-store-bot)

部署完成后：

1. 去 **域** 页面，打开域名路由或绑定自定义域名（可选）
2. 去 **变量与密钥** 页面，添加环境变量：
   - `BOT_TOKEN` = Telegram Bot Token（**必填**，文本类型）
   - `CLIP_URL` = Worker 域名，如 `https://xxx.workers.dev`（**必填**）
   - `ALLOWED_USERS` = 白名单用户 ID（逗号分隔），不设则公开使用 + 自动启用限流防护
   - `WEBHOOK_SECRET` = 域名防呆（可选）
   - `PROXY_URL` = 反代地址，绕过 CF 拦截（可选，[搭建教程](docs/proxy-setup.md)）
   - `DEBUG_TOKEN` = debug-fetch 接口鉴权（可选）
   - `LANDING_HTML_URL` = 自定义落地页 HTML（可选，默认从本仓库拉取，仅允许 GitHub 域名）
3. 去 **兼容性标志** 页面，添加 **`nodejs_compat`** 标志
4. 访问 Worker 域名自动激活 webhook，然后填 `CLIP_URL`
5. Telegram 发 `/start`

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
| `LANDING_HTML_URL` | 自定义落地页 HTML 地址（仅限 GitHub 域名），默认从本仓库拉取 | ❌ |

## 目录结构

```
├── worker.mjs              # 主程序（~2300 行）
├── proxy-utils.esm.js      # Sub-Store 引擎（由 workflow 构建）
├── wrangler.toml
├── README.md
├── landing/
│   └── index.html          # 落地页 HTML（KV 缓存 24h）
├── tools/
│   ├── proxy-utils-src/    # Sub-Store 引擎源码（从上游同步）
│   │   ├── sync-proxy-utils.js   # 同步 parsers/producers/preprocessors
│   │   ├── build-proxy-utils.js  # PEG 预编译 + esbuild 打包
│   │   ├── buffer_shim.js        # CF Workers buffer 兼容 shim
│   │   └── package.json
│   └── substorebot-deploy-code.py  # 纯代码部署工具（不碰变量）
├── .github/workflows/
│   ├── sync-proxy-utils.yml  # 手动/每周自动：同步上游 + 构建引擎
│   └── deploy.yml            # 手动触发部署 sub-store-bot
└── docs/
    └── proxy-setup.md        # 反代搭建教程
```

## 引擎构建

引擎代码从 [sub-store-org/Sub-Store](https://github.com/sub-store-org/Sub-Store) 同步并自行打包，免于依赖第三方 fork。

- **触发方式**：手动运行 workflow 或每周日凌晨 6 点自动同步
- **构建输出**：`proxy-utils.esm.js`，850KB，CF Workers 可直接加载
- **兼容性**：jsrsasign 11.1.1（锁定版本防 RNG 初始化违规）、buffer global shim、require process shim

如需本地一键部署到自己的 Worker，使用：
```
python3 tools/substorebot-deploy-code.py
```
前提：设置 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`、`CF_WORKER_NAME` 环境变量。

## License

MIT
