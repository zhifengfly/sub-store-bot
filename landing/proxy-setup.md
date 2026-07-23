# 反代搭建教程

## 为什么要搞这个？

你的订阅链接可能托管在 Cloudflare 上。问题来了：Bot 本身也跑在 Cloudflare Workers 上，**Cloudflare 调用 Cloudflare** 会被当成机器人拦截，返回 403。

解决办法：在 Vercel 上搭一个没有防护的中间人，Bot 先找 Vercel 要数据，Vercel 再去取你的订阅，绕开 CF 的拦截。

```
你的订阅（CF 防护） ← Vercel（无防护） ← Bot Worker（CF）
```

## 你需要什么

- 一个 GitHub 账号
- 一个 Vercel 账号（用 GitHub 登录就行）
- 你的 Bot Worker 能访问的环境变量配置

---

## 一步一步来

### 第一步：GitHub 上建个新仓库

1. 打开 https://github.com/new
2. 仓库名填 `sub-fetch-proxy`（或者你喜欢的名字）
3. 公开/私有都行，点 **Create repository**
4. 创建后你会看到一个快速设置页面，先放着

### 第二步：写反代代码

在你的电脑上（或者 GitHub 网页也行）：

**方法 A：直接在 GitHub 网页上操作（最简单）**

1. 在你刚建好的仓库页面，点 **Add file → Create new file**
2. 文件路径填 `api/index.js`
3. 内容粘贴下面这段：

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

4. 拉到页面底部，点 **Commit new file**

**方法 B：用命令行**

```bash
# 克隆你的仓库
git clone https://github.com/你的用户名/sub-fetch-proxy.git
cd sub-fetch-proxy

# 创建目录和文件
mkdir api
```

把上面的代码保存为 `api/index.js`，然后：

```bash
git add .
git commit -m "init"
git push
```

### 第三步：部署到 Vercel

1. 打开 https://vercel.com 并用 GitHub 登录
2. 点 **Add New → Project**
3. 在列表里找到你刚建的 `sub-fetch-proxy`，点 **Import**
4. Framework Preset 选 **Other**（默认就行），直接点 **Deploy**
5. 等十几秒，部署完成会显示 🎉 **Completed**
6. 你得到一个域名，类似 `sub-fetch-proxy.vercel.app`

> ⚠️ **重要**：不要给这个域名套 Cloudflare CDN。如果你有自定义域名想绑，确保 DNS 解析不走 CF 代理（橙色云朵关掉），否则又回到 CF-to-CF 的老问题。

### 第四步：告诉 Bot 这个反代的存在

回到你的 Cloudflare Worker 页面：

1. 进入 **sub-store-bot1** → **设置** → **变量与密钥**
2. 添加环境变量：
   - **变量名**：`PROXY_URL`
   - **值**：`https://你的项目名.vercel.app/api?url=`
   （把 `你的项目名.vercel.app` 换成第三步得到的域名）
3. 点 **保存并部署**

### 第五步：验证

发一条之前拉取失败的订阅到 Bot，应该能正常出结果了。

---

## 怎么确认反代在工作？

```bash
# 直连你原来的订阅（应该 403）
curl -s -o /dev/null -w "%{http_code}" "https://你的订阅链接.com/xxx"
# → 403

# 走反代（应该 200）
curl -s -o /dev/null -w "%{http_code}" "https://你的项目名.vercel.app/api?url=https%3A%2F%2F你的订阅链接.com%2Fxxx"
# → 200
```

或者用 Bot 的 debug 接口：

```bash
curl "https://你的worker域名/debug-fetch?token=你的DEBUG_TOKEN&url=你的订阅链接（需要URL编码）"
```

## 注意事项

- Vercel Hobby 计划免费额度每月 100h 运行时间 + 10 秒函数超时，个人用绝对够
- 太大会超时的订阅（10秒以上），考虑换其他平台（比如 Deno Deploy）
- 反代只对 CF 防护的订阅生效，普通订阅 Bot 仍直连
- 反代只透传内容，不做任何解析或修改
