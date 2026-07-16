# Sub-Store Bot ☁️

Telegram Bot — 订阅转换 + 短链分享，内置完整 Sub-Store 引擎（870KB）。

[反代教程 →](docs/proxy-setup.md)

---

## 功能

- **🌐 远程订阅** — 发订阅链接，自动 7 UA 轮询拉取（可自定义 UA 池），选格式出短链
- **📎 本地订阅** — 发节点文本或文件，自动解析转换
- **📦 多订阅合并** — 同对话内发送多条 URL/文件，内存累计自动合并去重
- **🔗 WireGuard 双链** — WG 节点自动以 Clash Meta YAML 单独输出（字段最全），侧链按钮
- **🔄 Gost Tunnel 双链** — `socks://` Gost 节点保留原始格式单独输出，侧链按钮
- **📋 13 种输出格式** — Clash Meta、URI 标准链、JSON、V2Ray、sing-box、Surfboard、Quantumult X、Shadowrocket、Surge、Loon、Stash、Egern、Base64
- **🎨 节点重命名** — 三种模式：关闭 / 去同名（`_2 _3` 后缀）/ 创意命名（GeoIP 地区码 + 主题池）
  - 内置主题池：生肖、24节气、吃货、随机 + 自定义主题
- **📏 智能去重** — 基于节点特征（server:port:type:uuid:sni:path:network）而非名称，合并来源不重复
- **⏱ 短链管理** — 查看、删除、修改时效（永久 ↔ 限时互转），短链详情页直接操作
- **⏱ 单次转换时效** — 每次转换可单独设置短链有效期，不影响主页默认
- **🌐 UA 轮询可配置** — 主页管理轮询 UA 池：启用/禁用默认 UA、添加自定义 UA、恢复默认
- **🛡 反代支持** — 通过 `PROXY_URL` 配置反代，绕过 CF-to-CF 订阅拉取拦截（[教程](docs/proxy-setup.md)）
- **🔒 安全 debug 接口** — `DEBUG_TOKEN` 鉴权的 debug-fetch 端点，用于测试订阅拉取

## 按钮说明

| 按钮 | 功能 |
|------|------|
| 🌐 远程订阅 | 输入订阅 URL，自动拉取 |
| 📎 本地订阅 | 发送节点文本/文件 |
| ⏱ 有效期 | 设置默认短链时效 |
| 🌐 UA 轮询 | 配置订阅拉取用的 User-Agent 池 |
| 🎨 重命名 | 设置节点重命名模式及主题 |
| 📋 我的短链 | 管理已生成的短链（查看详情、修改时效、删除） |
| 💾 保存结果 | 已有短链：查看详情页再操作 |

## 一键部署

1. 点这个按钮
[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Linsars/sub-store-bot)

2. 在部署页面选择你的仓库
3. 输入对应的 `ALLOWED_USERS`、`BOT_TOKEN`、`WEBHOOK_SECRET` 变量（部署后也可在 变量与密钥 页面改）

部署完成后：

1. 去 **域** 页面，打开域名路由或绑定自定义域名（可选）
2. 去 **变量与密钥** 页面，添加环境变量：
   - `CLIP_URL` = 你的 Worker 域名，如 `https://xxx.workers.dev`（**必填**，短链基础 URL）
   - `PROXY_URL` = 反代地址（如 `https://sub-fetch-proxy.vercel.app/api?url=`），用于拉取 CF 防护的订阅（[搭建教程](docs/proxy-setup.md)）
   - `DEBUG_TOKEN` = 随意设个密码，用于 debug-fetch 接口鉴权（可选）
3. 去 **描述** 页面，点 Worker 域名激活 bot
4. Telegram 里发 `/start`

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

## 目录结构

```
├── worker.mjs           # 主程序（单文件，含 Sub-Store 引擎导入）
├── proxy-utils.esm.js   # Sub-Store 引擎（870KB）
├── wrangler.toml        # Cloudflare Workers 配置
├── README.md
└── docs/
    └── proxy-setup.md   # 反代搭建教程
```

## License

MIT
