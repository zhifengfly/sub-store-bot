# Sub-Store Bot ☁️

Telegram Bot — 订阅转换 + 短链分享，内置完整 Sub-Store 引擎。

---

## 功能

| 类别 | 功能 | 说明 |
|------|------|------|
| **输入** | 远程订阅 / 本地订阅 / 多订阅合并 / 反代 | 发 URL 或文件，7 种 UA 轮询拉取（可自定义），PROXY_URL 绕过 CF 拉取拦截，同对话多条自动去重合并 |
| **输出** | 13 种格式 + Snell + 双链 | Clash Meta、URI、JSON、V2Ray、sing-box、Surfboard、QX、Shadowrocket、Surge、Loon、Stash、Egern、Base64；Snell 节点完整支持（Surge 格式 parser 增强）；WG 节点和 Gost 节点独立侧链输出 |
| **处理** | 去同名上标 + 智能去重 | 同名节点自动上标（²³…），基于 server:port:type:uuid:sni:path:network 特征去重 |
| **短链** | 有效期 / 阅后即焚 / 梅开二度 / 管理 | IP 独立计数访问限制，过期/焚毁自动销毁；落地页反向代理可自定义 HTML |
| **安全** | SSRF 防护 / TG 限流 / 配置持久化 / 调试 | SSRF 防护（LANDING_HTML_URL 仅 GitHub）；TG 限流 30s/5 次；Webhook 校验；配置落 KV 升级不丢；DEBUG_TOKEN 鉴权端点 |

---

## 一键部署

点击这个屎黄色按钮
[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Linsars/sub-store-bot)

部署完成后：

1. 去 **域** 页面，打开域名路由或绑定自定义域名（可选）
2. 去 **变量与密钥** 页面，添加环境变量：
   - `ALLOWED_USERS` = 白名单ID（可选，逗号分隔），不设则公开使用，也可以只设自己的TGid
   - `BOT_TOKEN` = Telegram Bot Token（必须是文本类型，**必填**，在执行步骤3激活之前填）
   - `CLIP_URL` = 你的 Worker 域名或其他可路由到此worker的域名，如 `https://xxx.workers.dev`（**必填**，在执行步骤3激活之后填）
   - `WEBHOOK_SECRET` = 域名防呆（可选，随便设置个密码）
   - `PROXY_URL` = 反代地址，绕过 CF 拦截（可选，[搭建教程](docs/proxy-setup.md)）
   - `DEBUG_TOKEN` = 随意设个密码，用于 debug-fetch 接口鉴权（可选）
   - `LANDING_HTML_URL` = 自定义落地页 HTML，不设则用默认（可选）
4. 去 **描述** 页面，点 Worker 域名激活 bot，然后复制此域名去填CLIP_URL
5. Telegram 里发 `/start`

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
├── worker.mjs              # 主程序
├── proxy-utils.esm.js      # Sub-Store 引擎（构建产物）
├── wrangler.toml           # CF Workers 配置
├── README.md
├── landing/
│   └── index.html          # 默认落地页
├── docs/
│   ├── proxy-setup.md      # 反代搭建教程
├── _workflows/
│   └── fork-sync.yml       # 同步模板（fork 用）
├── tools/
│   └── proxy-utils-src/    # 引擎源码 + 构建脚本（sync-proxy-utils.js / build-proxy-utils.js / buffer_shim.js）
└── .github/
    └── workflows/
        ├── sync-proxy-utils.yml  # Sub-Store 引擎自动同步
        └── deploy.yml            # 纯代码部署
```

## Sub-Store 引擎

`proxy-utils.esm.js` 由 `tools/proxy-utils-src/` 从 [`sub-store-org/Sub-Store`](https://github.com/sub-store-org/Sub-Store) 上游同步构建：
- `sync-proxy-utils.js` — 同步 parsers / preprocessors / producers
- `build-proxy-utils.js` — PEG 预编译 + esbuild 打包（`format: esm`，`platform: node`）
- `buffer_shim.js` — `Buffer` 全局兼容（CF Workers 不支导入 `buffer` 模块）
- 工作流 `.github/workflows/sync-proxy-utils.yml` 每周自动运行，也可手动触发

## License

MIT

