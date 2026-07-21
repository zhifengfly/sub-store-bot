/**
 * Sub-Store Bot — Telegram 剪贴板 + 订阅转换
 * 
 * 依赖:
 *   - proxy-utils.esm.js (Sub-Store 引擎 — 由 sync-proxy-utils.yml 从 sub-store-org/Sub-Store 同步构建)
 *   - Cloudflare Workers KV — 短链存储
 *   - BOT_TOKEN — Telegram Bot Token
 * 
 * 引擎版本: 同步自 sub-store-org/Sub-Store，通过 tools/proxy-utils-src/ 构建
 * 
 * 部署格式: ES Module Worker
 * 需要 CF 兼容性标志: nodejs_compat
 */

import { ProxyUtils } from './proxy-utils.esm.js';

// ==================== 工具函数 ====================

function genId(len = 7) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// 上标数字（去同名用：节点² 节点³）
function superscriptNum(n) {
  const sup = '\u2070\u00B9\u00B2\u00B3\u2074\u2075\u2076\u2077\u2078\u2079';
  return String(n).split('').map(d => sup[parseInt(d)]).join('');
}

async function tg(method, token, body) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('json')) return await r.json();
    // TG API 返回非 JSON（如 502 HTML 页）→ 静默失败
    return { ok: false, error_code: r.status, description: await r.text().catch(() => '') };
  } catch (e) {
    return { ok: false, error_code: 0, description: e.message };
  }
}

function escapeHTML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Atomic IP counting + access limit (PR #1, burn handled at route level)
async function atomicTrackIP(env, id, clientIP, maxIPs, ttl) {
  const key = 'share_' + id;
  for (let i = 0; i < 5; i++) {
    let data;
    try {
      data = await env.KV.getWithMetadata(key, { type: 'json' });
    } catch { return { consumed: false, isNewIP: false, error: 'kv_read' }; }
    if (!data || !data.value) return { consumed: false, isNewIP: false, error: 'not_found' };
    const raw = data.value || {};
    if (raw.consumed) return { consumed: true, isNewIP: false };
    const ips = Array.isArray(raw.accessedIPs) ? raw.accessedIPs : [];
    if (!ips.includes(clientIP)) {
      const next = [...ips, clientIP];
      const updated = { ...raw, accessedIPs: next };
      const opts = {};
      if (ttl && ttl > 0) opts.expirationTtl = ttl;
      if (data.metadata && data.metadata.version !== undefined) opts.ifVersion = data.metadata.version;
      try {
        await env.KV.put(key, JSON.stringify(updated), opts);
        return { consumed: false, isNewIP: true, count: next.length, exceeded: maxIPs > 0 && next.length > maxIPs };
      } catch { continue; }
    } else {
      return { consumed: false, isNewIP: false, count: ips.length, exceeded: maxIPs > 0 && ips.length >= maxIPs };
    }
  }
  return { consumed: false, isNewIP: false, error: 'max_retries' };
}

// ==================== 按钮布局 ====================

function mainKb() {
  return {
    inline_keyboard: [
      [
        { text: '\u{1F310} 远程订阅', callback_data: 'input_url' },
        { text: '\u{1F4CE} 本地订阅', callback_data: 'input_file' },
      ],
      [
        { text: '\u{1F310} UA 轮询', callback_data: 'ua_menu' },
        { text: '\u{23F1} \u77ED\u94FE\u65F6\u9650', callback_data: 'limit_menu' },
      ],
      [
        { text: '\u{1F4CB} 我的短链', callback_data: 'my_links_0' },
      ],
    ],
  };
}

const FORMAT_OPTIONS = [
  { id: 'clashmeta', label: 'Clash Meta' },
  { id: 'uri', label: 'URI 标准链' },
  { id: 'json', label: 'JSON' },
  { id: 'v2ray', label: 'V2Ray' },
  { id: 'singbox', label: 'sing-box' },
  { id: 'surfboard', label: 'Surfboard' },
  { id: 'qx', label: 'Quantumult X' },
  { id: 'shadowrocket', label: 'Shadowrocket' },
  { id: 'surge', label: 'Surge' },
  { id: 'Loon', label: 'Loon' },
  { id: 'stash', label: 'Stash' },
  { id: 'egern', label: 'Egern' },
  { id: 'b64', label: 'Base64' },
];

// Gost Tunnel 仅支持的格式
const GOST_FORMATS = ['shadowrocket', 'uri'];

function fmtKb(allowed, convTtl, ttlDefault, u) {
  const formats = allowed || FORMAT_OPTIONS;
  const rows = [];
  let row = [];
  for (const f of formats) {
    row.push({ text: f.label, callback_data: 'conv_fmt:' + f.id });
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  const ttlVal = convTtl !== undefined && convTtl !== null ? convTtl : (ttlDefault !== undefined ? ttlDefault : 0);
  const ttlLabel = ttlVal === 0 ? '\u6C38\u4E0D\u8FC7\u671F' : ttlVal < 3600 ? Math.round(ttlVal / 60) + '\u5206\u949F' : Math.round(ttlVal / 3600) + '\u5C0F\u65F6';
  const effAcc = u?._convAccessLimit != null ? u._convAccessLimit : (u?._accessLimit != null ? u._accessLimit : 0);
  const accLabel = effAcc === 0 ? '\u4E0D\u9650' : effAcc + ' IP';
  rows.push([{ text: '\u{23F1} \u672C\u6B21\u65F6\u9650: ' + ttlLabel + ' / ' + accLabel, callback_data: 'conv_limit_menu' }]);
  rows.push([{ text: (u?._burn ? '\u2705 ' : '') + '\u{1F525} \u9605\u540E\u5373\u711A', callback_data: 'conv_toggle_burn' }]);
  rows.push([{ text: (u?._landing ? '\u2705 ' : '') + '\u{1F504} \u6885\u5F00\u4E8C\u5EA6', callback_data: 'conv_toggle_landing' }]);
  rows.push([{ text: '\u2190 返回', callback_data: 'menu' }]);
  return { inline_keyboard: rows };
}

function ttlKb(current, prefix, backCb) {
  const cbPrefix = prefix || 'ttl_set:';
  const opts = [
    { s: 0, l: '\u6C38\u4E0D\u8FC7\u671F' },
    { s: 300, l: '5\u5206\u949F' },
    { s: 900, l: '15\u5206\u949F' },
    { s: 3600, l: '1\u5C0F\u65F6' },
    { s: 21600, l: '6\u5C0F\u65F6' },
    { s: 86400, l: '1\u5929' },
    { s: 604800, l: '7\u5929' },
    { s: 2592000, l: '30\u5929' },
  ];
  const rows = [];
  let row = [];
  for (const o of opts) {
    const selected = o.s === current;
    const icon = selected ? '\u2705 ' : '';
    row.push({ text: icon + o.l, callback_data: cbPrefix + o.s });
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  // 返回按钮：优先使用传入的 backCb
  let backBtn;
  if (backCb) {
    backBtn = backCb;
  } else if (prefix && prefix.startsWith('chg_ttl_')) {
    backBtn = 'link_' + prefix.slice(8, -1);
  } else if (prefix && prefix.startsWith('conv_ttl_set:')) {
    backBtn = 'conv_back';
  } else {
    backBtn = 'menu';
  }
  rows.push([{ text: '\u2190 \u8FD4\u56DE', callback_data: backBtn }]);
  return { inline_keyboard: rows };
}

function accKb(current, prefix, backCb) {
  const opts = [
    { v: 0, l: '\u4E0D\u9650' },
    { v: 10, l: '10 IP' },
    { v: 50, l: '50 IP' },
    { v: 100, l: '100 IP' },
    { v: 500, l: '500 IP' },
    { v: 1000, l: '1000 IP' },
    { v: 10000, l: '10000 IP' },
  ];
  const cbPrefix = prefix || 'acc_set:';
  const rows = [];
  let row = [];
  for (const o of opts) {
    const selected = o.v === current;
    row.push({ text: (selected ? '\u2705 ' : '') + o.l, callback_data: cbPrefix + o.v });
    if (row.length === 2) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  // 返回按钮：优先使用传入的 backCb
  let backBtn;
  if (backCb) {
    backBtn = backCb;
  } else if (prefix && prefix.startsWith('chg_acc_')) {
    backBtn = 'link_' + prefix.slice(8, -1);
  } else if (prefix && prefix.startsWith('conv_acc_set:')) {
    backBtn = 'conv_back';
  } else {
    backBtn = 'menu';
  }
  rows.push([{ text: '\u2190 \u8FD4\u56DE', callback_data: backBtn }]);
  return { inline_keyboard: rows };
}

function backKb() {
  return { inline_keyboard: [[{ text: '\u2190 返回', callback_data: 'menu' }]] };
}

function resultKb(url) {
  return {
    inline_keyboard: [
      [
        { text: '\u{1F517} \u4E3B\u94FE', url: url },
        { text: '\u{1F4E4} \u5206\u4EAB', url: 'https://t.me/share/url?url=' + encodeURIComponent(url) },
      ],
      [
        { text: '\u{1F3E0} \u4E3B\u9875', callback_data: 'menu' },
      ],
    ],
  };
}

function multiResultKb(mainUrl, extraUrls) {
  const kb = [
    [
      { text: '\u{1F517} \u4E3B\u94FE', url: mainUrl },
      { text: '\u{1F4E4} \u5206\u4EAB', url: 'https://t.me/share/url?url=' + encodeURIComponent(mainUrl) },
    ],
  ];
  for (const ext of (extraUrls || [])) {
    kb.push([
      ext,
      { text: '\u{1F4E4} \u5206\u4EAB', url: 'https://t.me/share/url?url=' + encodeURIComponent(ext.url) },
    ]);
  }
  kb.push([
    { text: '\u{1F3E0} \u4E3B\u9875', callback_data: 'menu' },
  ]);
  return { inline_keyboard: kb };
}

// ==================== 主页文字 ====================

function mainPageText() {
  return '<b>\u{1F916} Sub-Store Bot</b>\n\n' +
    '\u{1F310} <b>\u8FDC\u7A0B\u8BA2\u9605</b> \u2014 \u53D1\u94FE\u63A5\uFF0C\u81EA\u52A8\u62C9\u53D6\u8F6C\u6362\n' +
    '\u{1F4CE} <b>\u672C\u5730\u8BA2\u9605</b> \u2014 \u53D1\u8282\u70B9/\u6587\u4EF6\uFF0C\u81EA\u52A8\u89E3\u6790\u8F6C\u6362\n' +
    '\u2705 \u666E\u901A\u6587\u672C \u2014 \u81EA\u52A8\u4FDD\u5B58\u4E3A\u77ED\u94FE\n\n' +
    '\u{1F4E6} <b>\u8F93\u51FA\u683C\u5F0F (12\u79CD)</b>\n' +
    'Clash Meta / QX / Surge / Shadowrocket\n' +
    'sing-box / V2Ray / Loon / Stash\n' +
    'Surfboard / Egern / URI / JSON\n\n' +
    '\u{1F517} \u8F6C\u6362\u7ED3\u679C\u4EE5\u77ED\u94FE\u5F62\u5F0F\u8FD4\u56DE';
}

// ==================== 用户状态管理 ====================

const stateMap = new Map();

function getState(uid) {
  if (!stateMap.has(uid)) {
    if (stateMap.size >= 100) {
      const first = stateMap.keys().next().value;
      stateMap.delete(first);
    }
    stateMap.set(uid, { _uid: uid, _regionCache: {} });
  }
  return stateMap.get(uid);
}

// ==================== 用户配置持久化（KV 存储） ====================

async function loadUserConfig(uid, env) {
  try {
    const raw = await env.KV.get('cfgu:' + uid, { type: 'json' });
    return raw || {};
  } catch { return {}; }
}

async function saveUserConfig(uid, env, state) {
  const cfg = {};
  // 只持久化主页「有效期」的默认设置，不持久化格式选择页的临时覆盖
  if (state.ttl != null) cfg.ttl = state.ttl;
  if (state._accessLimit != null) cfg._accessLimit = state._accessLimit;
  await env.KV.put('cfgu:' + uid, JSON.stringify(cfg)).catch(() => {});
}

// ==================== TG 请求限流 ====================

const rateLimitMap = new Map();

function applyRateLimit(uid, allowedUsers) {
  // 有 ALLOWED_USERS（部署者单人用）→ 不限流
  if (allowedUsers) return false;
  const now = Date.now();
  // 定期清理过期条目（每 100 次请求清理一次）
  if (rateLimitMap.size > 0 && rateLimitMap.size % 100 === 0) {
    const cutoff = now - 60000; // 保留 60 秒内的记录
    for (const [k, v] of rateLimitMap) {
      if (now - v.start > 60000) rateLimitMap.delete(k);
    }
  }
  const key = uid;
  const entry = rateLimitMap.get(key);
  if (!entry) {
    rateLimitMap.set(key, { count: 1, start: now });
    if (rateLimitMap.size > 1000) {
      const first = rateLimitMap.keys().next().value;
      rateLimitMap.delete(first);
    }
    return false;
  }
  if (now - entry.start > 30000) {
    // 超过 30 秒窗口 → 重置
    entry.count = 1;
    entry.start = now;
    return false;
  }
  entry.count++;
  return entry.count > 5; // 30 秒内超过 5 次 → 限流
}

// ==================== 订阅拉取（多 UA 轮询，支持用户自定义） ====================

const FETCH_UAS = [
  'Karing', 'FLClash', 'clash-verge', 'sing-box', 'clashmeta', 'shadowrocket', 'surge',
];

// 获取用户 UA 配置
async function getUaConfig(uid, env) {
  try {
    const raw = await env.KV.get('ua:' + uid, { type: 'json' });
    return raw || { custom: [], disabled: [] };
  } catch { return { custom: [], disabled: [] }; }
}

async function saveUaConfig(uid, env, cfg) {
  await env.KV.put('ua:' + uid, JSON.stringify(cfg));
}

function showUaSettings(cid, mid, uid, env) {
  return getUaConfig(uid, env).then(async (cfg) => {
    let text = '<b>\u{1F310} UA \u8F6E\u8BE2 \u8BBE\u7F6E</b>\n\n';
    text += '\u{1F504} \u5F53\u524D <b>' + (cfg.custom || []).length + '</b> \u4E2A\u81EA\u5B9A\u4E49\u3001<b>' + (FETCH_UAS.length - (cfg.disabled || []).length) + '</b>/' + FETCH_UAS.length + ' \u4E2A\u9ED8\u8BA4\n\n';
    const rows = [];
    // 默认 UA — 两列
    let row = [];
    for (let i = 0; i < FETCH_UAS.length; i++) {
      const enabled = !(cfg.disabled || []).includes(i);
      const icon = enabled ? '\u2705' : '\u274C';
      const ua = FETCH_UAS[i];
      const short = ua.length > 14 ? ua.slice(0, 12) + '..' : ua;
      row.push({ text: icon + ' ' + short, callback_data: 'ua_toggle:' + i });
      if (row.length === 2) {
        rows.push(row);
        row = [];
      }
    }
    if (row.length) rows.push(row);
    // 自定义 UA — 每行一个，右侧带删除
    for (let ci = 0; ci < (cfg.custom || []).length; ci++) {
      const ua = cfg.custom[ci];
      const short = ua.length > 20 ? ua.slice(0, 18) + '..' : ua;
      rows.push([
        { text: '\u{1F4DD} ' + escapeHTML(short), callback_data: 'noop' },
        { text: '\u{1F5D1}', callback_data: 'ua_del:' + ci },
      ]);
    }
    rows.push([
      { text: '\u2795 \u6DFB\u52A0\u81EA\u5B9A\u4E49', callback_data: 'ua_add' },
      { text: '\u21A9 \u6062\u590D\u9ED8\u8BA4', callback_data: 'ua_reset' },
    ]);
    rows.push([{ text: '\u2190 \u8FD4\u56DE', callback_data: 'menu' }]);
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows },
    });
  });
}

// 构建有效 UA 列表（自定义 UA 与默认 UA 不区分大小写去重）
async function getUaList(uid, env) {
  const cfg = await getUaConfig(uid, env);
  const disabledSet = new Set(cfg.disabled || []);
  const list = [];
  const seen = new Set();
  for (let i = 0; i < FETCH_UAS.length; i++) {
    if (!disabledSet.has(i)) {
      const ua = FETCH_UAS[i];
      list.push(ua);
      seen.add(ua.toLowerCase());
    }
  }
  for (const ua of (cfg.custom || [])) {
    if (!seen.has(ua.toLowerCase())) {
      list.push(ua);
      seen.add(ua.toLowerCase());
    }
  }
  return list;
}

async function fetchSub(url, uid, env) {
  const uaList = await getUaList(uid, env);
  if (uaList.length === 0) uaList.push(FETCH_UAS[0]);
  const seen = new Set();
  let bestText = '';
  let bestUa = '';
  let bestCount = 0;
  let bestParsed = null;
  const BATCH_SIZE = 5;
  for (let batchStart = 0; batchStart < uaList.length; batchStart += BATCH_SIZE) {
    const batch = uaList.slice(batchStart, batchStart + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (ua) => {
        try {
          const text = await Promise.race([
            fetch(url, { headers: { 'User-Agent': ua } }).then(r => r.text()),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
          ]);
          return { text, ua };
        } catch { return { text: '', ua }; }
      })
    );
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const text = r.value.text;
      if (!text || text.length < 50) continue;
      if (text.includes('访问被拒绝') || text.includes('不支持浏览器') || text.includes('<html') || text.includes('<HTML') || text.includes('<!DOC')) continue;
      const key = text.slice(0, 200);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const parsed = ProxyUtils.parse(text);
        const count = parsed?.length || 0;
        if (count > bestCount) {
          bestCount = count;
          bestText = text;
          bestUa = r.value.ua;
          bestParsed = parsed;
        }
      } catch { /* parse fail, skip */ }
    }
  }
  // 直连全失败 → 走反代（绕过 CF Worker 被 CF 防护拦截）
  if (!bestText && env.PROXY_URL) {
    try {
      const proxyUrl = env.PROXY_URL + encodeURIComponent(url);
      const proxyText = await Promise.race([
        fetch(proxyUrl).then(r => r.text()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('proxy timeout')), 15000)),
      ]);
      if (proxyText && proxyText.length >= 50 && !proxyText.includes('<html') && !proxyText.includes('Just a moment')) {
        try {
          const parsed = ProxyUtils.parse(proxyText);
          const count = parsed?.length || 0;
          if (count > 0) {
            bestText = proxyText;
            bestUa = 'proxy';
            bestCount = count;
            bestParsed = parsed;
          }
        } catch { /* parse fail */ }
      }
    } catch { /* proxy fail, ignore */ }
  }
  return { text: bestText, ua: bestUa, count: bestCount, proxies: bestParsed };
}

// ==================== Gost Tunnel 检测 ====================

function isGostSocksContent(text) {
  const lines = text.split(/\n/);
  let socksCount = 0;
  let gostCount = 0;
  for (const line of lines) {
    const s = line.trim();
    if (!s.startsWith('socks://')) continue;
    socksCount++;
    if (s.includes('gost=')) gostCount++;
  }
  return socksCount > 0 && gostCount > 0 ? { total: socksCount, gostCount } : null;
}

// 从文本中提取 Gost 行，返回 { gostLines, otherLines }
function splitGostLines(text) {
  const lines = text.split(/\n/);
  const gostLines = [];
  const otherLines = [];
  for (const line of lines) {
    const s = line.trim();
    if (s.startsWith('socks://') && s.includes('gost=')) {
      gostLines.push(s);
    } else {
      otherLines.push(line);
    }
  }
  return { gostLines, otherLines: otherLines.join('\n') };
}

// ==================== 节点去重（按特征而非节点名） ====================

function deduplicateProxies(proxies) {
  const seen = new Set();
  return proxies.filter(p => {
    let key;
    switch (p.type) {
      case 'vmess':
      case 'vless':
        key = p.server + ':' + p.port + ':' + p.type + ':' + (p.uuid || '') + ':' + (p.sni || '') + ':' + ((p['ws-opts']?.path || p.path || '')) + ':' + (p.network || '');
        break;
      case 'ss':
        key = p.server + ':' + p.port + ':' + p.type + ':' + p.password + ':' + p.cipher;
        break;
      case 'trojan':
        key = p.server + ':' + p.port + ':' + p.type + ':' + p.password;
        break;
      case 'hysteria2':
      case 'hy2':
        key = p.server + ':' + p.port + ':' + p.type + ':' + (p.password || p.auth || '');
        break;
      default:
        key = p.server + ':' + p.port + ':' + p.type;
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ==================== 脚本相关功能已移除 ====================

// ==================== KV 累计状态（跨实例共享） ====================

// ==================== 编辑提示消息或发新消息 ====================

async function replyOrEdit(u, cid, env, opts) {
  let pCid = u.promptCid;
  let pMid = u.promptMid;
  if (!pCid && !pMid) {
    try {
      const raw = await env.KV.get('prompt:' + (u._uid || ''), { type: 'json' });
      if (raw && raw.cid && raw.mid) { pCid = raw.cid; pMid = raw.mid; }
    } catch {}
  }
  if (pCid && pMid) {
    const r = await tg('editMessageText', env.BOT_TOKEN, {
      chat_id: pCid, message_id: pMid,
      text: opts.text, parse_mode: opts.parse_mode, reply_markup: opts.reply_markup,
    });
    if (r && r.ok) {
      if (u._uid) env.KV.put('prompt:' + u._uid, JSON.stringify({ cid: pCid, mid: pMid })).catch(() => {});
      return { ...r, message_id: pMid, from_edit: true };
    }
  }
  const sent = await tg('sendMessage', env.BOT_TOKEN, {
    chat_id: cid, text: opts.text, parse_mode: opts.parse_mode, reply_markup: opts.reply_markup,
  });
  if (sent && sent.ok && sent.result && sent.result.message_id) {
    u.promptCid = cid;
    u.promptMid = sent.result.message_id;
    if (u._uid) env.KV.put('prompt:' + u._uid, JSON.stringify({ cid, mid: sent.result.message_id })).catch(() => {});
  }
  return sent;
}

// ==================== 用户短链索引 ====================

async function getUserLinks(uid, env) {
  try {
    const raw = await env.KV.get('ulinks:' + uid, { type: 'json' });
    return raw || [];
  } catch { return []; }
}

async function addUserLink(uid, env, entry) {
  const links = await getUserLinks(uid, env);
  links.unshift(entry);
  if (links.length > 50) links.length = 50;
  await env.KV.put('ulinks:' + uid, JSON.stringify(links));
}

async function removeUserLink(uid, env, id) {
  const links = await getUserLinks(uid, env);
  const idx = links.findIndex(l => l.id === id);
  if (idx === -1) return false;
  links.splice(idx, 1);
  await env.KV.put('ulinks:' + uid, JSON.stringify(links));
  // 同时删除 KV 中的短链内容
  await env.KV.delete('share_' + id);
  return true;
}

function linkStatusIcon(entry) {
  if (entry.ttl === 0) return '\u{1F535}';  // 🔵 永久
  if (!entry.expiresAt) return '\u{1F535}'; // 安全兜底
  const now = Date.now();
  if (now >= entry.expiresAt) return '\u{26AB}'; // ⚫ 已过期
  const remain = Math.round((entry.expiresAt - now) / 60000);
  if (remain < 60) return '\u{1F7E0} ' + remain + 'm'; // 🟠 <1h
  return '\u{1F7E0} ' + Math.round(remain / 60) + 'h'; // 🟠
}

function formatRemaining(expiresAt) {
  const remain = Math.round((expiresAt - Date.now()) / 1000);
  if (remain <= 0) return '\u26AB \u5DF2\u8FC7\u671F';
  if (remain < 60) return '\u{1F7E0} ' + remain + '\u79D2';
  if (remain < 3600) return '\u{1F7E0} ' + Math.round(remain / 60) + '\u5206\u949F';
  if (remain < 86400) {
    const h = Math.floor(remain / 3600);
    const m = Math.round((remain % 3600) / 60);
    return '\u{1F7E0} ' + h + '\u5C0F\u65F6' + (m > 0 ? m + '\u5206' : '');
  }
  const d = Math.floor(remain / 86400);
  const h = Math.round((remain % 86400) / 3600);
  return '\u{1F7E0} ' + d + '\u5929' + (h > 0 ? h + '\u5C0F\u65F6' : '');
}

function getEffectiveTtl(u) {
  return u._convTtl !== undefined && u._convTtl !== null ? u._convTtl : (u.ttl !== undefined ? u.ttl : 0);
}

function getEffectiveMaxAccess(u) {
  // conv 临时覆盖优先，其次主页默认，最后 0（不限）
  return u._convAccessLimit != null ? u._convAccessLimit : (u._accessLimit != null ? u._accessLimit : 0);
}

// ==================== 保存到短链 ====================

async function saveToClip(text, ttl, env, maxAccess, extra = {}) {
  const id = genId();
  const data = JSON.stringify({
    text,
    maxAccess: maxAccess || 0,
    accessedIPs: [],
    ttl: ttl || 0,
    burn: extra.burn || false,
    landing: extra.landing || false,
    nodeCount: extra.nodeCount || 0,
    _createdAt: Date.now(),
    subInfo: extra.subInfo || null,
  });
  const kvOpts = {};
  if (ttl > 0) kvOpts.expirationTtl = ttl < 60 ? 60 : ttl;
  await env.KV.put('share_' + id, data, kvOpts);
  return id;
}

// 保存短链并记录到用户索引
async function saveToClipAndTrack(text, ttl, env, uid, extra, maxAccess) {
  const id = await saveToClip(text, ttl, env, maxAccess, extra);
  const clipUrl = ((env.CLIP_URL || '').replace(/\/+$/, '')) + '/share/' + id;
  const entry = {
    id,
    ...extra,
    ttl: ttl,
    maxAccess: maxAccess || 0,
    createdAt: Date.now(),
    expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : null,
  };
  await addUserLink(uid, env, entry);
  return { id, url: clipUrl };
}

// ==================== 用户白名单 ====================

function isAllowed(uid, env) {
  const adminId = env.ADMIN_ID;
  const allowedRaw = env.ALLOWED_USERS;
  if (!adminId && !allowedRaw) return true;
  if (adminId && uid === adminId.trim()) return true;
  if (allowedRaw) {
    const list = allowedRaw.split(',').map((s) => s.trim());
    if (list.includes(uid)) return true;
  }
  return false;
}

// ==================== 消息处理 ====================

async function onMsg(msg, env) {
  const cid = msg.chat.id;
  const uid = String(msg.from.id);
  if (!isAllowed(uid, env)) return;
  const u = getState(uid);

  // /start
  if (msg.text && msg.text.trim() === '/start') {
    return tg('sendMessage', env.BOT_TOKEN, {
      chat_id: cid,
      text: mainPageText(),
      parse_mode: 'HTML',
      reply_markup: mainKb(),
    });
  }

  // UA 添加模式
  if (u.state === 'UA_ADD') {
    const uaStr = (msg.text || msg.caption || '').trim();
    if (!uaStr) {
      return tg('sendMessage', env.BOT_TOKEN, {
        chat_id: cid,
        text: '\u274C \u8BF7\u53D1\u9001\u6709\u6548\u7684 User-Agent',
      });
    }
    const cfg = await getUaConfig(uid, env);
    if (!cfg.custom) cfg.custom = [];
    cfg.custom.push(uaStr);
    await saveUaConfig(uid, env, cfg);
    u.state = null;
    if (u.promptCid && u.promptMid) {
      return showUaSettings(u.promptCid, u.promptMid, uid, env);
    }
    return tg('sendMessage', env.BOT_TOKEN, {
      chat_id: cid,
      text: '\u2705 \u5DF2\u6DFB\u52A0\u81EA\u5B9A\u4E49 UA: ' + escapeHTML(uaStr),
      reply_markup: mainKb(),
    });
  }

    // 获取输入内容  // 获取输入内容
  let content = '';
  let isRemote = false;

  if (msg.text) {
    content = msg.text.trim();
    if (content.startsWith('http://') || content.startsWith('https://')) {
      isRemote = true;
    }
  } else if (msg.document) {
    const f = await tg('getFile', env.BOT_TOKEN, {
      file_id: msg.document.file_id,
    });
    if (!f.ok) return;
    const r = await fetch(
      'https://api.telegram.org/file/bot' +
        env.BOT_TOKEN +
        '/' +
        f.result.file_path
    );
    content = await r.text();
  } else {
    return;
  }

  if (!content) return;

  const ttl = u.ttl !== undefined ? u.ttl : 0;

  // 远程订阅：拉取内容
  let subText = content;
  let gostLines, proxies;
  if (isRemote) {
    const inputUrls = content.split(/\n/).map(s => s.trim()).filter(s => s.startsWith('http://') || s.startsWith('https://'));
    const urlDupCount = new Map();
    for (const u of inputUrls) urlDupCount.set(u, (urlDupCount.get(u) || 0) + 1);
    const urls = [...new Set(inputUrls)];
    const totalInputUrls = inputUrls.length;

    if (urls.length === 0) {
      return replyOrEdit(u, cid, env, {
        text: '\u274C \u672A\u68C0\u6D4B\u5230\u6709\u6548\u8BA2\u9605\u94FE\u63A5',
      });
    }

    if (urls.length === 1) {
      try {
        await replyOrEdit(u, cid, env, {
          text: '\u{1F504} \u6B63\u5728\u62C9\u53D6\u8BA2\u9605...',
        });
        const subResult = await fetchSub(urls[0], uid, env);
        subText = subResult.text;
        u._lastUrlCount = 1;
        u._lastFetchUa = subResult.ua === 'proxy' ? '反代 (Karing)' : subResult.ua;
      } catch (e) {
        return replyOrEdit(u, cid, env, {
          text: '\u274C \u62C9\u53D6\u5931\u8D25: ' + e.message,
        });
      }
    } else {
      await replyOrEdit(u, cid, env, {
        text: '\u{1F504} \u6B63\u5728\u62C9\u53D6 ' + urls.length + ' \u4E2A\u8BA2\u9605...',
      });

      // 多 URL
      let allProxies = [];
      let allGost = [];
      let rawTexts = [];
      const usedUas = [];
      const errors = [];
      let dupSubCount = 0;

      if (urls.length >= 4) {
        // 4 条以上：首选 Karing 单 UA 拉取，拉不出再换别的
        const allUas = await getUaList(uid, env);
        const primary = allUas[0] || FETCH_UAS[0];
        const fallbacks = allUas.slice(1);
        const contentSeen = new Map(); // contentKey → { url, index }
        for (const u of urls) {
          let text = '';
          let usedUa = primary;
          try {
            text = await Promise.race([
              fetch(u, { headers: { 'User-Agent': primary } }).then(r => r.text()),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
            ]);
          } catch { text = ''; }
          if (!text || text.length < 50 || text.includes('访问被拒绝') || text.includes('不支持浏览器') || text.includes('<html') || text.includes('<HTML') || text.includes('<!DOC')) {
            // 主 UA 拉不出，挨个试备用 UA
            text = '';
            for (const fb of fallbacks) {
              try {
                text = await Promise.race([
                  fetch(u, { headers: { 'User-Agent': fb } }).then(r => r.text()),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
                ]);
                if (text && text.length >= 50 && !text.includes('<html') && !text.includes('<!DOC')) {
                  usedUa = fb;
                  break;
                }
              } catch { continue; }
            }
          }
          if (!text || text.length < 50) {
            const dupNote = inputUrls.filter(x => x === u).length > 1 ? ' \u26A0\uFE0F\u91CD\u590D\u5171' + inputUrls.filter(x => x === u).length + '\u6761' : '';
            usedUas.push(u + ' \u2192 \u274C \u65E0\u6570\u636E' + dupNote);
            errors.push('\u2022 ' + u + ': \u65E0\u6570\u636E');
            continue;
          }
          // 检查是否内容重复
          const contentKey = text.slice(0, 200).replace(/\d+/g, '');
          if (contentSeen.has(contentKey)) {
            // 在第一条的显示里追加重复标记，跳过本条
            const first = contentSeen.get(contentKey);
            usedUas[first.index] = first.entry + '\n    \u26A0\uFE0F \u91CD\u590D: ' + u;
            dupSubCount++;
            continue;
          }
          // 记录第一条的索引，等会再追加重复标记
          const entryIndex = usedUas.length;  // 还没 push，先记住索引
          rawTexts.push(text);
          const gi = isGostSocksContent(text);
          let pt = text;
          if (gi) {
            const sp = splitGostLines(text);
            allGost = allGost.concat(sp.gostLines);
            pt = sp.otherLines;
          }
          let parsed = null;
          try { parsed = ProxyUtils.parse(pt); } catch { parsed = null; }
          if (parsed && parsed.length > 0) {
            allProxies = allProxies.concat(parsed);
            const types = {};
            for (const p of parsed) types[p.type] = (types[p.type] || 0) + 1;
            const ts = Object.entries(types).map(([k,v]) => k + ':' + v).join(', ');
            const dupNote = inputUrls.filter(x => x === u).length > 1 ? ' \u26A0\uFE0F\u91CD\u590D\u5171' + inputUrls.filter(x => x === u).length + '\u6761' : '';
            const entryText = u + ' \u2192 ' + usedUa + ' \u2192 ' + parsed.length + ' (' + ts + ')' + dupNote;
            contentSeen.set(contentKey, { url: u, index: entryIndex, entry: entryText });
            usedUas.push(entryText);
          } else {
            const dupNote = inputUrls.filter(x => x === u).length > 1 ? ' \u26A0\uFE0F\u91CD\u590D\u5171' + inputUrls.filter(x => x === u).length + '\u6761' : '';
            const entryText = u + ' \u2192 ' + usedUa + ' \u2192 0' + dupNote;
            contentSeen.set(contentKey, { url: u, index: entryIndex, entry: entryText });
            usedUas.push(entryText);
            errors.push('\u2022 ' + u + ': \u65E0\u6709\u6548\u8282\u70B9');
          }
        }
      } else {
        const contentSeen = new Map();
        for (const u of urls) {
        const uaList = await getUaList(uid, env);
        if (uaList.length === 0) uaList.push(FETCH_UAS[0]);
        let bestText = '';
        let bestUa = '';
        let bestCount = 0;
        let bestParsed = null;
        const seen = new Set();
        const BATCH_SIZE = 5;
        for (let batchStart = 0; batchStart < uaList.length; batchStart += BATCH_SIZE) {
          const batch = uaList.slice(batchStart, batchStart + BATCH_SIZE);
          const results = await Promise.allSettled(
            batch.map(async (ua) => {
              try {
                const text = await Promise.race([
                  fetch(u, { headers: { 'User-Agent': ua } }).then(r => r.text()),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
                ]);
                return { text, ua };
              } catch { return { text: '', ua }; }
            })
          );
          for (const r of results) {
            if (r.status !== 'fulfilled') continue;
            const text = r.value.text;
            if (!text || text.length < 50) continue;
            if (text.includes('访问被拒绝') || text.includes('不支持浏览器') || text.includes('<html') || text.includes('<HTML') || text.includes('<!DOC')) continue;
            const key = text.slice(0, 200);
            if (seen.has(key)) continue;
            seen.add(key);
            try {
              const parsed = ProxyUtils.parse(text);
              const count = parsed?.length || 0;
              if (count > bestCount) {
                bestCount = count;
                bestText = text;
                bestUa = r.value.ua;
                bestParsed = parsed;
              }
            } catch { /* parse fail, skip */ }
          }
        }
        if (!bestText) {
          const dupNote = inputUrls.filter(x => x === u).length > 1 ? ' \u26A0\uFE0F\u91CD\u590D\u5171' + inputUrls.filter(x => x === u).length + '\u6761' : '';
          usedUas.push(u + ' \u2192 \u274C \u65E0\u6570\u636E' + dupNote);
          errors.push('\u2022 ' + u + ': \u65E0\u6570\u636E');
          continue;
        }
        // 检查是否内容重复
        const contentKey = bestText.slice(0, 200).replace(/\d+/g, '');
        if (contentSeen.has(contentKey)) {
          const first = contentSeen.get(contentKey);
          usedUas[first.index] = first.entry + '\n    \u26A0\uFE0F \u91CD\u590D: ' + u;
          dupSubCount++;
          continue;
        }
        rawTexts.push(bestText);
        const gi = isGostSocksContent(bestText);
        let pt = bestText;
        if (gi) {
          const sp = splitGostLines(bestText);
          allGost = allGost.concat(sp.gostLines);
          pt = sp.otherLines;
        }
        // bestParsed 来自轮询阶段的解析；如有 Gost 需重新解析去掉 Gost 行
        let parsed = bestParsed;
        if (gi) {
          try { parsed = ProxyUtils.parse(pt); } catch { parsed = null; }
        }
        if (parsed && parsed.length > 0) {
          allProxies = allProxies.concat(parsed);
          const types = {};
          for (const p of parsed) types[p.type] = (types[p.type] || 0) + 1;
          const ts = Object.entries(types).map(([k,v]) => k + ':' + v).join(', ');
          const entryIndex = usedUas.length;
          const dupNote = inputUrls.filter(x => x === u).length > 1 ? ' \u26A0\uFE0F\u91CD\u590D\u5171' + inputUrls.filter(x => x === u).length + '\u6761' : '';
          const entryText = u + ' \u2192 ' + bestUa + ' \u2192 ' + parsed.length + ' (' + ts + ')' + dupNote;
          contentSeen.set(contentKey, { url: u, index: entryIndex, entry: entryText });
          usedUas.push(entryText);
        } else {
          const entryIndex = usedUas.length;
          const dupNote = inputUrls.filter(x => x === u).length > 1 ? ' \u26A0\uFE0F\u91CD\u590D\u5171' + inputUrls.filter(x => x === u).length + '\u6761' : '';
          const entryText = u + ' \u2192 ' + bestUa + ' \u2192 0' + dupNote;
          contentSeen.set(contentKey, { url: u, index: entryIndex, entry: entryText });
          usedUas.push(entryText);
          errors.push('\u2022 ' + u + ': \u65E0\u6709\u6548\u8282\u70B9');
        }
      }
      }

      allProxies = deduplicateProxies(allProxies);

      if (allProxies.length === 0 && allGost.length === 0) {
        return replyOrEdit(u, cid, env, {
          text: '\u274C \u6240\u6709\u8BA2\u9605\u90FD\u62C9\u53D6\u5931\u8D25:\n' + errors.join('\n'),
        });
      }

      let report = '\u2705 \u5408\u5E76 ' + allProxies.length + ' \u4E2A\u8282\u70B9';
      if (allGost.length > 0) report += ' + ' + allGost.length + ' Gost';
      report += ' \u6765\u81EA ' + rawTexts.length + '/' + urls.length + ' \u4E2A\u6E90';
      if (errors.length > 0) report += '\n\n\u26A0\uFE0F \u5931\u8D25:\n' + errors.join('\n');
      await replyOrEdit(u, cid, env, { text: report });

      // 直接用合并好的 proxies，跳过后面的大文本解析
      proxies = allProxies;
      gostLines = allGost;
      subText = rawTexts.join('\n');
      // 统计信息
      const totalNodes = allProxies.length;
      const dupUrlCount = totalInputUrls - urls.length;
      if (proxies && proxies.length > 0) {
        const before = proxies.length;
        proxies = deduplicateProxies(proxies);
        u._lastStats = {
          totalNodes: totalNodes,
          actualNodes: proxies.length,
          subSources: rawTexts.length + '/' + totalInputUrls,
          dupSubs: dupSubCount,
          dupUrls: dupUrlCount,
          dupNodes: before - proxies.length,
        };
      } else {
        u._lastStats = {
          totalNodes: totalNodes,
          actualNodes: 0,
          subSources: rawTexts.length + '/' + totalInputUrls,
          dupSubs: dupSubCount,
          dupUrls: dupUrlCount,
          dupNodes: 0,
        };
      }
      u._lastUrlCount = rawTexts.length + '/' + totalInputUrls;
      u._lastFetchUa = usedUas.length > 0 ? usedUas.join('\n') : null;
    }
  }

  if (proxies === undefined) {
  // 检查是否包含 Gost Tunnel
  const gostInfo = isGostSocksContent(subText);
  gostLines = [];

  if (gostInfo) {
    const split = splitGostLines(subText);
    gostLines = split.gostLines;
    subText = split.otherLines;
  }

  // 解析节点
  try {
    proxies = ProxyUtils.parse(subText);
  } catch (e) {
    proxies = null;
  }

  // 去重
  if (proxies && proxies.length > 0) {
    const before = proxies.length;
    proxies = deduplicateProxies(proxies);
    const deduped = before - proxies.length;
    if (u._lastStats) {
      u._lastStats.dupNodes = deduped;
      u._lastStats.actualNodes = proxies.length;
    }
    u._lastDedupCount = deduped;
  }
  }

  // 分离当前文件节点类型
  const currentWg = proxies ? proxies.filter(p => p.type === 'wireguard') : [];
  const currentStd = proxies ? proxies.filter(p => p.type !== 'wireguard') : [];

  // 与内存累计合并（同实例内多文件追加）
  if (!isRemote) {
    if (u._accProxies && u._accProxies.length > 0) {
      currentStd.unshift(...u._accProxies);
    }
    if (u._accWgProxies && u._accWgProxies.length > 0) {
      currentWg.unshift(...u._accWgProxies);
    }
  }

  // dedup
  const mergedStd = deduplicateProxies(currentStd);
  const mergedWg = deduplicateProxies(currentWg);
  const mergedGost = u._accGostInput
    ? u._accGostInput + '\n' + (gostLines.length > 0 ? gostLines.join('\n') : '')
    : (gostLines.length > 0 ? gostLines.join('\n') : '');
  const hasStd = mergedStd.length > 0;
  const hasWg = mergedWg.length > 0;
  const hasGost = mergedGost.length > 0;

  // 存回内存累计
  u._accProxies = mergedStd;
  u._accWgProxies = mergedWg;
  u._accGostInput = mergedGost;
  // 累计原始文本（用于原生格式输出）
  if (content) {
    u._accRawText = u._accRawText ? u._accRawText + '\n' + content : content;
  }

  // 远程 → 清累计
  if (isRemote) {
    u._accProxies = null;
    u._accWgProxies = null;
    u._accGostInput = null;
    u._accRawText = null;
    u._fmtMsg = null;
  }

  // 每次新输入清内存残留统计
  u._lastStats = null;
  u._lastUrlCount = null;

  // 纯 Gost（无任何节点）
  if (hasGost && !hasStd && !hasWg) {
    u._lastSubInput = subText;
    u._lastRawContent = subText;
    u._lastProxies = [];
    u._wgProxies = null;
    u._isGost = true;
    u._gostCount = mergedGost.split('\n').filter(Boolean).length;
    u._gostInput = mergedGost;
    return replyOrEdit(u, cid, env, {
      text: '\u{1F504} <b>\u68C0\u6D4B\u5230\u8BA2\u9605\u5185\u5BB9</b>\n\n\u{1F4CA} \u8282\u70B9\u6570: <b>' + u._gostCount + '</b>\n\u{1F4CD} Gost Tunnel: ' + u._gostCount + '\n\u26A0\uFE0F \u4EC5 Shadowrocket / URI \u5217\u8868\u652F\u6301 Gost Tunnel\n\n\u8BF7\u9009\u62E9\u8F93\u51FA\u683C\u5F0F:',
      parse_mode: 'HTML',
      reply_markup: fmtKb(FORMAT_OPTIONS.filter(f => GOST_FORMATS.includes(f.id)), u._convTtl, u.ttl, u),
    });
  }

  // 没有任何节点
  if (!hasStd && !hasWg && !hasGost) {
    // 防御：subText 为空或太短（fetch 失败）时不存空短链
    if (!subText || subText.trim().length < 10) {
      return replyOrEdit(u, cid, env, {
        text: '\u274C \u8BA2\u9605\u62C9\u53D6\u5931\u8D25\u6216\u5185\u5BB9\u4E3A\u7A7A\u3002\n\n\u76F4\u8FDE\u4E0E\u53CD\u4EE3\u5747\u5931\u8D25\uFF0C\u8BE5\u8BA2\u9605\u53EF\u80FD\u5F00\u542F\u4E86\u4E25\u683C\u9632\u6293\u3002\n\n\u8BF7\u5C06\u8BA2\u9605\u5185\u5BB9\uff08base64 \u6216 URI \u5217\u8868\uff09\u76F4\u63A5\u53D1\u7ED9\u672C\u7FFB\u8BD1\u673A\u5668\u4EBA\uFF0C\u5373\u53EF\u6B63\u5E38\u8F6C\u6362\u3002',
      });
    }
    try {
      const preview = subText.length > 50 ? subText.slice(0, 50) + '...' : subText;
      const { id, url: clipUrl } = await saveToClipAndTrack(subText, ttl, env, uid, {
        preview: '\u{1F4C4} ' + preview, nodeCount: 0, source: 'text',
        burn: u?._burn || false,
        landing: u?._landing || false,
      }, getEffectiveMaxAccess(u));
      const previewShow = subText.length > 150 ? subText.slice(0, 150) + '...' : subText;
      const ttlT = ttl === 0 ? '\u6C38\u4E0D\u8FC7\u671F' : ttl < 3600 ? Math.round(ttl / 60) + '\u5206\u949F' : Math.round(ttl / 3600) + '\u5C0F\u65F6';
      const accT = getEffectiveMaxAccess(u) === 0 ? '' : '\n\u{1F4CA} ' + getEffectiveMaxAccess(u) + ' IP';
      u._lastContent = subText;
      u._lastRawContent = subText;
      u._lastSubInput = subText;
      return replyOrEdit(u, cid, env, {
        text: '\u2705 <b>\u5DF2\u4FDD\u5B58</b>\n\n\u{1F517} <code>' + clipUrl + '</code>\n\n\u{1F4CB} \u9884\u89C8:\n<code>' + escapeHTML(previewShow) + '</code>\n\n\u23F1 ' + ttlT + accT,
        parse_mode: 'HTML', reply_markup: resultKb(clipUrl),
      });
    } catch (e) {
      return replyOrEdit(u, cid, env, { text: '\u274C \u4FDD\u5B58\u5931\u8D25: ' + e.message });
    }
  }

  // 设置状态（供回调使用）
  u._lastProxies = mergedStd;
  u._wgProxies = mergedWg.length > 0 ? mergedWg : null;
  u._lastSubInput = subText;
  u._isGost = hasGost;
  u._gostInput = mergedGost;
  u._gostCount = mergedGost.split('\n').filter(Boolean).length;

  // 统计类型
  const types = {};
  for (const p of mergedStd) { types[p.type] = (types[p.type] || 0) + 1; }
  let typeStr = Object.entries(types).map(([k, v]) => k + ': ' + v).join(', ');
  if (hasWg) typeStr += '\n\u26A1 WireGuard: ' + mergedWg.length + ' \u00B7 Clash Meta YAML \u5355\u72EC\u8F93\u51FA';
  if (hasGost) typeStr += '\n\u{1F504} Gost Tunnel: ' + u._gostCount + ' \u00B7 \u539F\u59CB\u683C\u5F0F\u5355\u72EC\u8F93\u51FA';

  const gostHint = hasGost ? '\n\u{1F504} Gost Tunnel \u00D7 ' + u._gostCount + ' \u2014 \u4FDD\u7559\u539F\u59CB\u683C\u5F0F\u5355\u72EC\u8F93\u51FA\n' : '';
  const wgHint = hasWg ? '\n\u26A1 WireGuard \u00D7 ' + mergedWg.length + ' \u2014 \u9ED8\u8BA4 Clash Meta YAML \u5355\u72EC\u8F93\u51FA\n' : '';
  const accHint = '';

  const sourceInfo = u._lastUrlCount
    ? '\n\u{1F517} ' + (typeof u._lastUrlCount === 'number' ? u._lastUrlCount + ' \u4E2A\u8BA2\u9605\u6E90' : u._lastUrlCount + ' \u4E2A\u8BA2\u9605\u6E90')
    : '';
  const uaInfo = u._lastFetchUa ? '\n\u{1F916} ' + escapeHTML(u._lastFetchUa) : '';

  const statsLine = u._lastStats
    ? '\n\u{1F4CA} <b>' + u._lastStats.actualNodes + '</b> \u5B9E\u9645 (\u603B: ' + u._lastStats.totalNodes +
      (u._lastStats.dupUrls > 0 ? ', \u53BB\u91CD\u94FE\u63A5: ' + u._lastStats.dupUrls : '') +
      (u._lastStats.dupSubs > 0 ? ', \u91CD\u590D\u8BA2\u9605: ' + u._lastStats.dupSubs : '') +
      (u._lastStats.dupNodes > 0 ? ', \u91CD\u590D\u8282\u70B9: ' + u._lastStats.dupNodes : '') + ')'
    : '';

  // 格式选择消息
  const fmtText =
    '\u{1F504} <b>\u68C0\u6D4B\u5230\u8BA2\u9605\u5185\u5BB9</b>\n\n' +
    (statsLine ? '' : '\u{1F4CA} \u8282\u70B9\u6570: <b>' + mergedStd.length + '</b>' + (u._lastDedupCount > 0 ? '\u3001\u53BB\u91CD: ' + u._lastDedupCount : '') + '\n') +
    statsLine + '\n' +
    '\u{1F4CD} ' + typeStr + '\n' +
    sourceInfo + uaInfo + '\n' +
    gostHint + wgHint + accHint +
    '\u8BF7\u9009\u62E9\u8F93\u51FA\u683C\u5F0F:';

  if (!isRemote && u._fmtMsg && u._fmtMsg.id) {
    await tg('editMessageText', env.BOT_TOKEN, {
      chat_id: u._fmtMsg.cid, message_id: u._fmtMsg.id,
      text: fmtText, parse_mode: 'HTML',
      reply_markup: fmtKb(null, u._convTtl, u.ttl, u),
    });
    u._fmtText = fmtText;
  } else {
    const sent = await replyOrEdit(u, cid, env, {
      text: fmtText, parse_mode: 'HTML',
      reply_markup: fmtKb(null, u._convTtl, u.ttl, u),
    });
    if (!isRemote) {
      const msgId = sent?.result?.message_id || (sent?.from_edit ? u.promptMid : null);
      u._fmtMsg = msgId ? { cid: cid, id: msgId } : null;
      u._fmtText = fmtText;
    }
  }
}

// ==================== 回调处理 ====================


async function onCb(q, env) {
  const uid = String(q.from.id);
  if (!isAllowed(uid, env)) return;
  const cid = q.message.chat.id;
  const mid = q.message.message_id;
  const u = getState(uid);
  const d = q.data;

  await tg('answerCallbackQuery', env.BOT_TOKEN, {
    callback_query_id: q.id,
  });

  // === dispatch ===
  if (d === 'menu') return cb_menu(env, uid, cid, mid, u, d, q);
  if (d === 'input_url') return cb_input_url(env, uid, cid, mid, u, d, q);
  if (d === 'input_file') return cb_input_file(env, uid, cid, mid, u, d, q);
  if (d === 'ua_menu') return cb_ua_menu(env, uid, cid, mid, u, d, q);
  if (d.startsWith('ua_toggle:')) return cb_ua_toggle(env, uid, cid, mid, u, d, q);
  if (d.startsWith('ua_del:')) return cb_ua_del(env, uid, cid, mid, u, d, q);
  if (d === 'ua_reset') return cb_ua_reset(env, uid, cid, mid, u, d, q);
  if (d === 'ua_add') return cb_ua_add(env, uid, cid, mid, u, d, q);
  if (d.startsWith('my_links_')) return cb_my_links(env, uid, cid, mid, u, d, q);
  if (d.startsWith('link_')) return cb_link(env, uid, cid, mid, u, d, q);
  if (d.startsWith('del_confirm_')) return cb_del_confirm(env, uid, cid, mid, u, d, q);
  if (d.startsWith('do_del_')) return cb_do_del(env, uid, cid, mid, u, d, q);
  if (d.startsWith('mod_ttl_')) return cb_mod_ttl(env, uid, cid, mid, u, d, q);
  if (d.startsWith('chg_ttl_')) return cb_chg_ttl(env, uid, cid, mid, u, d, q);
  if (d.startsWith('mod_acc_')) return cb_mod_acc(env, uid, cid, mid, u, d, q);
  if (d.startsWith('chg_acc_')) return cb_chg_acc(env, uid, cid, mid, u, d, q);
  if (d === 'limit_menu') return cb_limit_menu(env, uid, cid, mid, u, d, q);
  if (d === 'ttl_menu') return cb_ttl_menu(env, uid, cid, mid, u, d, q);
  if (d.startsWith('ttl_set:')) return cb_ttl_set(env, uid, cid, mid, u, d, q);
  if (d === 'acc_menu') return cb_acc_menu(env, uid, cid, mid, u, d, q);
  if (d.startsWith('acc_set:')) return cb_acc_set(env, uid, cid, mid, u, d, q);
  if (d === 'conv_toggle_burn') return cb_conv_toggle_burn(env, uid, cid, mid, u, d, q);
  if (d === 'conv_toggle_landing') return cb_conv_toggle_landing(env, uid, cid, mid, u, d, q);
  if (d === 'conv_back') return cb_conv_back(env, uid, cid, mid, u, d, q);
  if (d === 'conv_limit_menu') return cb_conv_limit_menu(env, uid, cid, mid, u, d, q);
  if (d === 'conv_ttl_menu') return cb_conv_ttl_menu(env, uid, cid, mid, u, d, q);
  if (d.startsWith('conv_ttl_set:')) return cb_conv_ttl_set(env, uid, cid, mid, u, d, q);
  if (d === 'conv_acc_menu') return cb_conv_acc_menu(env, uid, cid, mid, u, d, q);
  if (d.startsWith('conv_acc_set:')) return cb_conv_acc_set(env, uid, cid, mid, u, d, q);
  if (d.startsWith('conv_fmt:')) return cb_conv_fmt(env, uid, cid, mid, u, d, q);
}


// ==================== onCb 路由处理函数 ====================

async function cb_menu(env, uid, cid, mid, u, d, q) {
  return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: mainPageText(),
      parse_mode: 'HTML',
      reply_markup: mainKb(),
    });
}

async function cb_input_url(env, uid, cid, mid, u, d, q) {
  u.state = 'URL';
    u.promptCid = cid;
    u.promptMid = mid;
    await env.KV.put('prompt:' + uid, JSON.stringify({ cid, mid }));
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: '\u{1F310} \u8BF7\u53D1\u9001\u8BA2\u9605\u94FE\u63A5',
      parse_mode: 'HTML', reply_markup: backKb(),
    });
}

async function cb_input_file(env, uid, cid, mid, u, d, q) {
  u.state = 'FILE';
    u.promptCid = cid;
    u.promptMid = mid;
    await env.KV.put('prompt:' + uid, JSON.stringify({ cid, mid }));
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: '\u{1F4CE} \u8BF7\u53D1\u9001\u8282\u70B9\u6587\u4EF6\u6216\u7C98\u8D34\u5185\u5BB9',
      parse_mode: 'HTML', reply_markup: backKb(),
    });
}

async function cb_ua_menu(env, uid, cid, mid, u, d, q) {
  return showUaSettings(cid, mid, uid, env);
}

async function cb_ua_toggle(env, uid, cid, mid, u, d, q) {
  const idx = parseInt(d.split(':')[1]);
    const cfg = await getUaConfig(uid, env);
    const dis = cfg.disabled || [];
    const pos = dis.indexOf(idx);
    if (pos >= 0) {
      dis.splice(pos, 1);
    } else {
      dis.push(idx);
    }
    cfg.disabled = dis;
    await saveUaConfig(uid, env, cfg);
    return showUaSettings(cid, mid, uid, env);
}

async function cb_ua_del(env, uid, cid, mid, u, d, q) {
  const ci = parseInt(d.split(':')[1]);
    const cfg = await getUaConfig(uid, env);
    if (ci >= 0 && ci < (cfg.custom || []).length) {
      (cfg.custom || []).splice(ci, 1);
      await saveUaConfig(uid, env, cfg);
    }
    return showUaSettings(cid, mid, uid, env);
}

async function cb_ua_reset(env, uid, cid, mid, u, d, q) {
  await saveUaConfig(uid, env, { custom: [], disabled: [] });
    return showUaSettings(cid, mid, uid, env);
}

async function cb_ua_add(env, uid, cid, mid, u, d, q) {
  u.state = 'UA_ADD';
    u.promptCid = cid;
    u.promptMid = mid;
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u{1F310} \u8BF7\u53D1\u9001\u81EA\u5B9A\u4E49 User-Agent \u5B57\u7B26\u4E32\n\n\u8F93\u5165\u540E\u6211\u5C06\u628A\u5B83\u52A0\u5230 UA \u8F6E\u8BE2\u6C60\u4E2D\u3002',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '\u2190 \u53D6\u6D88', callback_data: 'ua_menu' }]] },
    });
}

async function cb_my_links(env, uid, cid, mid, u, d, q) {
  const page = parseInt(d.split('_')[2]) || 0;
    const links = await getUserLinks(uid, env);
    if (links.length === 0) {
      return tg('editMessageText', env.BOT_TOKEN, {
        chat_id: cid,
        message_id: mid,
        text: '\u{1F4CB} <b>\u6211\u7684\u77ED\u94FE</b>\n\n\u{1F4A4} \u8FD8\u6CA1\u6709\u77ED\u94FE\n\u8F6C\u6362\u8BA2\u9605\u6216\u4FDD\u5B58\u6587\u672C\u540E\uFF0C\u77ED\u94FE\u4F1A\u81EA\u52A8\u8BB0\u5F55\u5728\u8FD9\u91CC\u3002',
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '\u2190 \u8FD4\u56DE', callback_data: 'menu' }]] },
      });
    }
    const pageSize = 5;
    const totalPages = Math.ceil(links.length / pageSize);
    const start = page * pageSize;
    const pageLinks = links.slice(start, start + pageSize);
    const rows = [];
    for (const l of pageLinks) {
      let icon = linkStatusIcon(l);
      // 读 KV 确认生死（阅后即焚 / IP 超限已删）
      if (icon !== '\u26AB') {
        try {
          const raw = await env.KV.get('share_' + l.id, { type: 'json' });
          if (!raw) icon = '\u26AB';
        } catch {}
      }
      rows.push([{ text: icon + ' ' + escapeHTML(l.preview), callback_data: 'link_' + l.id }]);
    }
    const navRow = [];
    if (page > 0) navRow.push({ text: '\u25C0 \u4E0A\u4E00\u9875', callback_data: 'my_links_' + (page - 1) });
    if (page < totalPages - 1) navRow.push({ text: '\u4E0B\u4E00\u9875 \u25B6', callback_data: 'my_links_' + (page + 1) });
    if (navRow.length) rows.push(navRow);
    rows.push([{ text: '\u2190 \u8FD4\u56DE', callback_data: 'menu' }]);
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u{1F4CB} <b>\u6211\u7684\u77ED\u94FE</b>  <i>' + links.length + '\u6761</i>\n\n\u70B9\u51FB\u67E5\u770B\u8BE6\u60C5:',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows },
    });
}

async function cb_link(env, uid, cid, mid, u, d, q) {
  const linkId = d.replace('link_', '');
    const links = await getUserLinks(uid, env);
    const l = links.find(x => x.id === linkId);
    if (!l) {
      return tg('editMessageText', env.BOT_TOKEN, {
        chat_id: cid, message_id: mid,
        text: '\u274C \u77ED\u94FE\u5DF2\u4E0D\u5B58\u5728',
        parse_mode: 'HTML',
        reply_markup: mainKb(),
      });
    }
    const clipUrl = ((env.CLIP_URL || '').replace(/\/+$/, '')) + '/share/' + l.id;

    // 读 KV 判断链接实际状态
    let kvAlive = false;
    let accessedCount = 0;
    let accessedLimit = l.maxAccess || 0;
    try {
      const raw = await env.KV.get('share_' + l.id, { type: 'json' });
      if (raw) {
        kvAlive = true;
        accessedCount = Array.isArray(raw.accessedIPs) ? raw.accessedIPs.length : 0;
        accessedLimit = raw.maxAccess || l.maxAccess || 0;
      }
    } catch {}

    // 确定生死：KV 被删 = 已消耗阅后即焚/超限
    const isConsumed = !kvAlive && (l.maxAccess > 0 || l.burn);
    const isExpired = l.ttl > 0 && l.expiresAt && Date.now() > l.expiresAt;
    const isDead = isExpired || isConsumed || (!kvAlive && l.ttl > 0);

    let statusIcon, statusText;
    if (isDead) {
      statusIcon = '\u26AB';
      statusText = isConsumed ? '\u26AB \u5DF2\u6D88\u8017' : '\u26AB \u5DF2\u8FC7\u671F';
    } else if (l.ttl === 0) {
      statusIcon = '\u{1F535}';
      statusText = '\u{1F535} \u6C38\u4E45\u6709\u6548';
    } else if (l.burn) {
      statusIcon = '\u{1F525}';
      statusText = '\u{1F525} \u9605\u540E\u5373\u711A';
    } else {
      statusIcon = '\u{1F7E0}';
      statusText = formatRemaining(l.expiresAt);
    }

    let text = '\u{1F4CB} <b>\u77ED\u94FE\u8BE6\u60C5</b>\n\n';
    text += statusIcon + ' <b>' + escapeHTML(l.preview) + '</b>\n';
    text += '\u{1F4CA} ' + (l.nodeCount || 0) + ' \u8282\u70B9  \u00B7 ' + statusText + '\n';
    if (kvAlive) {
      text += '\u{1F4F1} \u8BBF\u95EE: ' + accessedCount + ' \u8BBE\u5907';
      if (accessedLimit > 0) text += ' / ' + accessedLimit + ' IP';
      text += '\n';
    } else if (l.maxAccess > 0 && !isConsumed) {
      // KV 不存在但还没过期（例如刚创建还没人访问过——这种情况不可能，KV 创建就有）
    }
    text += '\n\u{1F517} <code>' + escapeHTML(clipUrl) + '</code>';
    
    const ttlRow = isDead
      ? [{ text: '\u26AB \u5DF2\u6D88\u8017/\u8FC7\u671F', callback_data: 'noop' }]
      : [{ text: '\u23F1 \u4FEE\u6539\u6642\u6548', callback_data: 'mod_ttl_' + l.id }];

    const rows = [
      [
        { text: '\u{1F4CB} \u590D\u5236\u94FE\u63A5', copy_text: { text: clipUrl } },
        { text: '\u{1F517} \u6253\u5F00', url: clipUrl },
      ],
      ttlRow,
    ];
    if (!isDead) rows.push([{ text: '\u{1F4CA} \u4FEE\u6539\u6B21\u6570', callback_data: 'mod_acc_' + l.id }]);
    rows.push(
      [{ text: '\u{1F5D1} \u5220\u9664\u77ED\u94FE', callback_data: 'del_confirm_' + l.id }],
      [{ text: '\u2190 \u8FD4\u56DE\u5217\u8868', callback_data: 'my_links_0' }],
    );
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows },
    });
}

async function cb_del_confirm(env, uid, cid, mid, u, d, q) {
  const linkId = d.replace('del_confirm_', '');
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u{2757} \u786E\u5B9A\u5220\u9664\u8FD9\u6761\u77ED\u94FE\uFF1F\n\n\u5220\u9664\u540E\u94FE\u63A5\u5C06\u5B8C\u5168\u5931\u6548\uFF0C\u65E0\u6CD5\u6062\u590D\u3002',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '\u2705 \u786E\u5B9A\u5220\u9664', callback_data: 'do_del_' + linkId }],
          [{ text: '\u2190 \u53D6\u6D88', callback_data: 'link_' + linkId }],
        ],
      },
    });
}

async function cb_do_del(env, uid, cid, mid, u, d, q) {
  const linkId = d.replace('do_del_', '');
    try { await env.KV.delete('share_' + linkId); } catch (e) { /* ignore */ }
    const ok = await removeUserLink(uid, env, linkId);
    const links = await getUserLinks(uid, env);
    if (links.length === 0) {
      return tg('editMessageText', env.BOT_TOKEN, {
        chat_id: cid,
        message_id: mid,
        text: '\u{1F4CB} <b>\u6211\u7684\u77ED\u94FE</b>\n\n\u{1F4A4} \u8FD8\u6CA1\u6709\u77ED\u94FE',
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '\u2190 \u8FD4\u56DE', callback_data: 'menu' }]] },
      });
    }
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u{1F4CB} <b>\u6211\u7684\u77ED\u94FE</b>  <i>' + links.length + '\u6761</i>\n\n\u70B9\u51FB\u67E5\u770B\u8BE6\u60C5:',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: linkStatusIcon(links[0]) + ' ' + escapeHTML(links[0].preview), callback_data: 'link_' + links[0].id }],
          [{ text: '\u2190 \u8FD4\u56DE', callback_data: 'menu' }],
        ],
      },
    });
}

async function cb_mod_ttl(env, uid, cid, mid, u, d, q) {
  const linkId = d.replace('mod_ttl_', '');
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u23F1 <b>\u4FEE\u6539\u77ED\u94FE\u6642\u6548</b>\n\n\u9009\u62E9\u65B0\u7684\u6642\u6548\uFF0C\u5DF2\u8FC7\u671F\u7684\u77ED\u94FE\u65E0\u6CD5\u6062\u590D\u3002',
      parse_mode: 'HTML',
      reply_markup: ttlKb(0, 'chg_ttl_' + linkId + ':'),
    });
}

async function cb_chg_ttl(env, uid, cid, mid, u, d, q) {
  const rest = d.replace('chg_ttl_', '');
    const colonIdx = rest.lastIndexOf(':');
    const linkId = rest.slice(0, colonIdx);
    const newTtl = parseInt(rest.slice(colonIdx + 1));
    try {
      const data = await env.KV.get('share_' + linkId, 'json');
      if (data && data.text) {
        const kvOpts = newTtl > 0 ? { expirationTtl: newTtl } : {};
        await env.KV.put('share_' + linkId, JSON.stringify({ ...data, ttl: newTtl }), kvOpts);
      } else {
        return tg('editMessageText', env.BOT_TOKEN, {
          chat_id: cid,
          message_id: mid,
          text: '\u274C \u77ED\u94FE\u5DF2\u8FC7\u671F\uFF0C\u65E0\u6CD5\u4FEE\u6539\n\n\u5DF2\u8FC7\u671F\u7684\u77ED\u94FE\u65E0\u6CD5\u6062\u590D\uFF0C\u8BF7\u8FD4\u56DE\u5217\u8868\u5220\u9664\u3002',
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '\u2190 \u8FD4\u56DE\u5217\u8868', callback_data: 'my_links_0' }]] },
        });
      }
    } catch (e) { /* ignore */ }
    const links = await getUserLinks(uid, env);
    const idx = links.findIndex(x => x.id === linkId);
    if (idx >= 0) {
      links[idx].ttl = newTtl;
      links[idx].expiresAt = newTtl > 0 ? Date.now() + newTtl * 1000 : null;
      await env.KV.put('ulinks:' + uid, JSON.stringify(links));
    }
    const l = links.find(x => x.id === linkId);
    if (l) {
      const clipUrl = ((env.CLIP_URL || '').replace(/\/+$/, '')) + '/share/' + l.id;
      const statusText = l.ttl === 0 ? '\u{1F535} \u6C38\u4E45\u6709\u6548'
        : l.expiresAt && Date.now() > l.expiresAt ? '\u26AB \u5DF2\u8FC7\u671F'
        : formatRemaining(l.expiresAt);
      let text = '\u{1F4CB} <b>\u77ED\u94FE\u8BE6\u60C5</b>\n\n';
      text += linkStatusIcon(l) + ' <b>' + escapeHTML(l.preview) + '</b>\n';
      text += '\u{1F4CA} ' + (l.nodeCount || 0) + ' \u8282\u70B9  \u00B7 ' + statusText + '\n\n';
      text += '\u{1F517} <code>' + escapeHTML(clipUrl) + '</code>';
      return tg('editMessageText', env.BOT_TOKEN, {
        chat_id: cid,
        message_id: mid,
        text: text,
        parse_mode: 'HTML',
        reply_markup: (() => {
          const isExpired = l.ttl > 0 && l.expiresAt && Date.now() > l.expiresAt;
          const ttlRow = isExpired
            ? [{ text: '\u26AB \u5DF2\u8FC7\u671F\uFF0C\u65E0\u6CD5\u4FEE\u6539', callback_data: 'noop' }]
            : [{ text: '\u23F1 \u4FEE\u6539\u6642\u6548', callback_data: 'mod_ttl_' + l.id }];
          const rows = [
            [{ text: '\u{1F4CB} \u590D\u5236\u94FE\u63A5', copy_text: { text: clipUrl } },
             { text: '\u{1F517} \u4E3B\u94FE', url: clipUrl },
             { text: '\u{1F4E4} \u5206\u4EAB', url: 'https://t.me/share/url?url=' + encodeURIComponent(clipUrl) }],
            ttlRow,
          ];
          if (!isExpired) rows.push([{ text: '\u{1F4CA} \u4FEE\u6539\u6B21\u6570', callback_data: 'mod_acc_' + l.id }]);
          rows.push(
            [{ text: '\u{1F5D1} \u5220\u9664\u77ED\u94FE', callback_data: 'del_confirm_' + l.id }],
            [{ text: '\u2190 \u8FD4\u56DE\u5217\u8868', callback_data: 'my_links_0' }],
          );
          return { inline_keyboard: rows };
        })(),
      });
    }
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u2705 \u5DF2\u4FEE\u6539',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '\u2190 \u8FD4\u56DE\u5217\u8868', callback_data: 'my_links_0' }]] },
    });
}

async function cb_mod_acc(env, uid, cid, mid, u, d, q) {
  const linkId = d.replace('mod_acc_', '');
    const links = await getUserLinks(uid, env);
    const l = links.find(x => x.id === linkId);
    if (!l) {
      return tg('editMessageText', env.BOT_TOKEN, {
        chat_id: cid, message_id: mid,
        text: '\u274C \u77ED\u94FE\u5DF2\u4E0D\u5B58\u5728',
        parse_mode: 'HTML',
        reply_markup: mainKb(),
      });
    }
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: '\u{1F4CA} <b>\u4FEE\u6539\u8BBF\u95EE\u6B21\u6570\u9650\u5236</b>',
      parse_mode: 'HTML',
      reply_markup: accKb(l.maxAccess || 0, 'chg_acc_' + linkId + ':', 'link_' + linkId),
    });
}

async function cb_chg_acc(env, uid, cid, mid, u, d, q) {
  const rest = d.replace('chg_acc_', '');
    const colonIdx = rest.lastIndexOf(':');
    const linkId = rest.slice(0, colonIdx);
    const newAcc = parseInt(rest.slice(colonIdx + 1));
    // 更新 KV 中 maxAccess
    try {
      const data = await env.KV.get('share_' + linkId, 'json');
      if (data && data.text) {
        const updated = { ...data, maxAccess: newAcc };
        const ttl = data.ttl || 0;
        const kvOpts = ttl > 0 ? { expirationTtl: ttl < 60 ? 60 : ttl } : {};
        await env.KV.put('share_' + linkId, JSON.stringify(updated), kvOpts);
      }
    } catch (e) { /* ignore */ }
    // 更新用户索引
    const links = await getUserLinks(uid, env);
    const idx = links.findIndex(x => x.id === linkId);
    if (idx >= 0) {
      links[idx].maxAccess = newAcc;
      await env.KV.put('ulinks:' + uid, JSON.stringify(links));
    }
    const l = links.find(x => x.id === linkId);
    if (l) {
      const clipUrl = ((env.CLIP_URL || '').replace(/\/+$/, '')) + '/share/' + l.id;
      const statusText = l.ttl === 0 ? '\u{1F535} \u6C38\u4E45\u6709\u6548'
        : l.expiresAt && Date.now() > l.expiresAt ? '\u26AB \u5DF2\u8FC7\u671F'
        : formatRemaining(l.expiresAt);
      let text = '\u{1F4CB} <b>\u77ED\u94FE\u8BE6\u60C5</b>\n\n';
      text += linkStatusIcon(l) + ' <b>' + escapeHTML(l.preview) + '</b>\n';
      text += '\u{1F4CA} ' + (l.nodeCount || 0) + ' \u8282\u70B9  \u00B7 ' + statusText + '\n\n';
      text += '\u{1F517} <code>' + escapeHTML(clipUrl) + '</code>';
      return tg('editMessageText', env.BOT_TOKEN, {
        chat_id: cid, message_id: mid,
        text: text,
        parse_mode: 'HTML',
        reply_markup: (() => {
          const isExpired = l.ttl > 0 && l.expiresAt && Date.now() > l.expiresAt;
          const ttlRow = isExpired
            ? [{ text: '\u26AB \u5DF2\u8FC7\u671F\uFF0C\u65E0\u6CD5\u4FEE\u6539', callback_data: 'noop' }]
            : [{ text: '\u23F1 \u4FEE\u6539\u6642\u6548', callback_data: 'mod_ttl_' + l.id }];
          const rows = [
            [{ text: '\u{1F4CB} \u590D\u5236\u94FE\u63A5', copy_text: { text: clipUrl } },
             { text: '\u{1F517} \u4E3B\u94FE', url: clipUrl },
             { text: '\u{1F4E4} \u5206\u4EAB', url: 'https://t.me/share/url?url=' + encodeURIComponent(clipUrl) }],
            ttlRow,
          ];
          if (!isExpired) rows.push([{ text: '\u{1F4CA} \u4FEE\u6539\u6B21\u6570', callback_data: 'mod_acc_' + l.id }]);
          rows.push(
            [{ text: '\u{1F5D1} \u5220\u9664\u77ED\u94FE', callback_data: 'del_confirm_' + l.id }],
            [{ text: '\u2190 \u8FD4\u56DE\u5217\u8868', callback_data: 'my_links_0' }],
          );
          return { inline_keyboard: rows };
        })(),
      });
    }
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: '\u2705 \u5DF2\u4FEE\u6539',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '\u2190 \u8FD4\u56DE\u5217\u8868', callback_data: 'my_links_0' }]] },
    });
}

async function cb_limit_menu(env, uid, cid, mid, u, d, q) {
  const defTtl = u.ttl !== undefined ? u.ttl : 0;
    const defAcc = u._accessLimit !== undefined ? u._accessLimit : 0;
    const ttlLabel = defTtl === 0 ? '\u6C38\u4E0D\u8FC7\u671F' : defTtl < 3600 ? Math.round(defTtl / 60) + '\u5206\u949F' : Math.round(defTtl / 3600) + '\u5C0F\u65F6';
    const accLabel = defAcc === 0 ? '\u4E0D\u9650' : defAcc + ' IP';
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: '\u23F1 <b>\u77ED\u94FE\u65F6\u9650</b>\n\n\u2022 \u23F1 \u6642\u6548: ' + ttlLabel + '\n\u2022 \u{1F4CA} \u6B21\u6570: ' + accLabel + '\n\n\u4E24\u8005\u5171\u540C\u751F\u6548\uFF0C\u5148\u5230\u5148\u5931\u6548\u3002',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '\u23F1 \u6642\u6548', callback_data: 'ttl_menu' }],
          [{ text: '\u{1F4CA} \u6B21\u6570', callback_data: 'acc_menu' }],
          [{ text: '\u2190 \u8FD4\u56DE', callback_data: 'menu' }],
        ],
      },
    });
}

async function cb_ttl_menu(env, uid, cid, mid, u, d, q) {
  const curTtl = u.ttl || 0;
    const curLabel = curTtl === 0 ? '\u6C38\u4E0D\u8FC7\u671F' : curTtl < 3600 ? Math.round(curTtl / 60) + '\u5206\u949F' : Math.round(curTtl / 3600) + '\u5C0F\u65F6';
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u23F1 <b>\u9ED8\u8BA4\u6642\u6548</b>\n\n\u4F60\u53D1\u9001\u7ED9\u5217\u8868\u7684\u94FE\u63A5\u5C06\u4F7F\u7528\u8BE5\u65F6\u6548\u3002\n\u2705 \u5F53\u524D\u8BBE\u7F6E: <b>' + curLabel + '</b>',
      parse_mode: 'HTML',
      reply_markup: ttlKb(curTtl, '', 'limit_menu'),
    });
}

async function cb_ttl_set(env, uid, cid, mid, u, d, q) {
  const ttlVal = parseInt(d.split(':')[1]);
    u.ttl = ttlVal;
    saveUserConfig(uid, env, u);
    u._lastTtlSet = Date.now();
    const ttlLabel = ttlVal === 0 ? '\u6C38\u4E0D\u8FC7\u671F' : ttlVal < 3600 ? Math.round(ttlVal / 60) + '\u5206\u949F' : Math.round(ttlVal / 3600) + '\u5C0F\u65F6';
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u23F1 <b>\u9ED8\u8BA4\u6642\u6548</b>\n\n\u4F60\u53D1\u9001\u7ED9\u5217\u8868\u7684\u94FE\u63A5\u5C06\u4F7F\u7528\u8BE5\u65F6\u6548\u3002\n\u2705 \u5F53\u524D\u8BBE\u7F6E: <b>' + ttlLabel + '</b>',
      parse_mode: 'HTML',
      reply_markup: ttlKb(u.ttl || 0, '', 'limit_menu'),
    });
}

async function cb_acc_menu(env, uid, cid, mid, u, d, q) {
  const curAcc = u._accessLimit !== undefined ? u._accessLimit : 0;
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: '\u{1F4CA} <b>\u6B21\u6570\u8BBE\u7F6E</b>\n\n\u5F53\u524D\u9ED8\u8BA4\u8BBF\u95EE\u6B21\u6570\u9650\u5236\u3002',
      parse_mode: 'HTML',
      reply_markup: accKb(curAcc, '', 'limit_menu'),
    });
}

async function cb_acc_set(env, uid, cid, mid, u, d, q) {
  const accVal = parseInt(d.split(':')[1]);
    u._accessLimit = accVal;
    saveUserConfig(uid, env, u);
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: '\u2705 \u5DF2\u8BBE\u7F6E\u9ED8\u8BA4\u8BBF\u95EE\u6B21\u6570: ' + (accVal === 0 ? '\u4E0D\u9650' : accVal + ' IP'),
      parse_mode: 'HTML',
      reply_markup: accKb(accVal, '', 'limit_menu'),
    });
}

async function cb_conv_toggle_burn(env, uid, cid, mid, u, d, q) {
  u._burn = !u._burn;
    const formats = u._isGost && (!u._lastProxies || u._lastProxies.length === 0)
      ? FORMAT_OPTIONS.filter(f => GOST_FORMATS.includes(f.id)) : null;
    return tg('editMessageReplyMarkup', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      reply_markup: fmtKb(formats, u._convTtl, u.ttl, u),
    });
}

async function cb_conv_toggle_landing(env, uid, cid, mid, u, d, q) {
  u._landing = !u._landing;
    const formats = u._isGost && (!u._lastProxies || u._lastProxies.length === 0)
      ? FORMAT_OPTIONS.filter(f => GOST_FORMATS.includes(f.id)) : null;
    return tg('editMessageReplyMarkup', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      reply_markup: fmtKb(formats, u._convTtl, u.ttl, u),
    });
}

async function cb_conv_back(env, uid, cid, mid, u, d, q) {
  const isGost = u._isGost && (!u._lastProxies || u._lastProxies.length === 0);
    const formats = isGost ? FORMAT_OPTIONS.filter(f => GOST_FORMATS.includes(f.id)) : null;
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: u._fmtText || '\u8BF7\u9009\u62E9\u8F93\u51FA\u683C\u5F0F:',
      parse_mode: 'HTML',
      reply_markup: fmtKb(formats, u._convTtl, u.ttl, u),
    });
}

async function cb_conv_limit_menu(env, uid, cid, mid, u, d, q) {
  const effConvTtl = u._convTtl !== undefined ? u._convTtl : (u.ttl || 0);
    const ttlLabel = effConvTtl === 0 ? '\u6C38\u4E0D\u8FC7\u671F' : effConvTtl < 3600 ? Math.round(effConvTtl / 60) + '\u5206\u949F' : Math.round(effConvTtl / 3600) + '\u5C0F\u65F6';
    const effConvAcc = u._convAccessLimit != null ? u._convAccessLimit : (u._accessLimit != null ? u._accessLimit : 0);
    const accLabel = effConvAcc === 0 ? '\u4E0D\u9650' : effConvAcc + ' IP';
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u23F1 <b>\u672C\u6B21\u65F6\u9650</b>\n\n\u2022 \u23F1 \u6642\u6548: ' + ttlLabel + '\n\u2022 \u{1F4CA} \u6B21\u6570: ' + accLabel + '\n\n\u4EC5\u5F71\u54CD\u672C\u6B21\u8F6C\u6362\uFF0C\u4E0D\u4F1A\u6539\u53D8\u4E3B\u9875\u7684\u9ED8\u8BA4\u503C\u3002',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '\u23F1 \u672C\u6B21\u6642\u6548', callback_data: 'conv_ttl_menu' }],
          [{ text: '\u{1F4CA} \u672C\u6B21\u6B21\u6570', callback_data: 'conv_acc_menu' }],
          [{ text: '\u2190 \u8FD4\u56DE', callback_data: 'conv_back' }],
        ],
      },
    });
}

async function cb_conv_ttl_menu(env, uid, cid, mid, u, d, q) {
  return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u23F1 <b>\u8BBE\u7F6E\u5F53\u524D\u8F6C\u6362\u7684\u6642\u6548</b>\n\n\u4EC5\u5F71\u54CD\u672C\u6B21\u8F6C\u6362\u3002',
      parse_mode: 'HTML',
      reply_markup: ttlKb(u._convTtl !== undefined ? u._convTtl : (u.ttl || 0), 'conv_ttl_set:', 'conv_limit_menu'),
    });
}

async function cb_conv_ttl_set(env, uid, cid, mid, u, d, q) {
  const ttlVal = parseInt(d.split(':')[1]);
    u._convTtl = ttlVal;
    const isGost = u._isGost && (!u._lastProxies || u._lastProxies.length === 0);
    const formats = isGost ? FORMAT_OPTIONS.filter(f => GOST_FORMATS.includes(f.id)) : null;
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u2705 \u5DF2\u8BBE\u7F6E\u5F53\u524D\u6642\u6548: ' + (ttlVal === 0 ? '\u6C38\u4E0D\u8FC7\u671F' : ttlVal < 3600 ? Math.round(ttlVal / 60) + '\u5206\u949F' : Math.round(ttlVal / 3600) + '\u5C0F\u65F6'),
      parse_mode: 'HTML',
      reply_markup: fmtKb(formats, u._convTtl, u.ttl, u),
    });
}

async function cb_conv_acc_menu(env, uid, cid, mid, u, d, q) {
  const current = u._convAccessLimit != null ? u._convAccessLimit : (u._accessLimit != null ? u._accessLimit : 0);
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u{1F4CA} <b>\u8BBE\u7F6E\u5F53\u524D\u8F6C\u6362\u7684\u8BBF\u95EE\u6B21\u6570\u9650\u5236</b>\n\n\u8D85\u8FC7\u8BBF\u95EE\u6B21\u6570\u540E\u77ED\u94FE\u81EA\u52A8\u5931\u6548\u3002',
      parse_mode: 'HTML',
      reply_markup: accKb(current, 'conv_acc_set:', 'conv_limit_menu'),
    });
}

async function cb_conv_acc_set(env, uid, cid, mid, u, d, q) {
  const accVal = parseInt(d.split(':')[1]);
    u._convAccessLimit = accVal;
    const isGost = u._isGost && (!u._lastProxies || u._lastProxies.length === 0);
    const formats = isGost ? FORMAT_OPTIONS.filter(f => GOST_FORMATS.includes(f.id)) : null;
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u2705 \u5DF2\u8BBE\u7F6E\u5F53\u524D\u8BBF\u95EE\u6B21\u6570: ' + (accVal === 0 ? '\u4E0D\u9650' : accVal + ' IP'),
      parse_mode: 'HTML',
      reply_markup: fmtKb(formats, u._convTtl, u.ttl, u),
    });
}

async function cb_conv_fmt(env, uid, cid, mid, u, d, q) {
  const fmt = d.split(':')[1];
    const fmtLabel = FORMAT_OPTIONS.find((f) => f.id === fmt)?.label || fmt;

    // 纯 Gost（无标准节点）：直接输出原始内容
    if (u._isGost && (!u._lastProxies || u._lastProxies.length === 0)) {
      if (!GOST_FORMATS.includes(fmt)) {
        return tg('editMessageText', env.BOT_TOKEN, {
          chat_id: cid,
          message_id: mid,
          text: '\u274C Gost Tunnel \u4E0D\u652F\u6301\u8BE5\u683C\u5F0F',
          parse_mode: 'HTML',
          reply_markup: fmtKb(FORMAT_OPTIONS.filter(f => GOST_FORMATS.includes(f.id)), u._convTtl, u.ttl, u),
        });
      }
      const rawText = u._gostInput || u._lastSubInput || '';
      try {
        const { id, url: clipUrl } = await saveToClipAndTrack(rawText, getEffectiveTtl(u), env, uid, {
          preview: fmtLabel + ' · ' + (u._gostCount || '?') + ' 节点 (Gost)',
          nodeCount: u._gostCount || 0,
          source: 'gost',
          burn: u?._burn || false,
          landing: u?._landing || false,
        }, getEffectiveMaxAccess(u));
        u._lastContent = rawText;
        const effTtl = getEffectiveTtl(u);
        const effAcc = getEffectiveMaxAccess(u);
        u._convTtl = null;
        u._convAccessLimit = null;
        const ttlT = effTtl === 0 ? '\u6C38\u4E0D\u8FC7\u671F' : effTtl < 3600 ? Math.round(effTtl / 60) + '\u5206\u949F' : Math.round(effTtl / 3600) + '\u5C0F\u65F6';
        const accT = effAcc === 0 ? '' : '\n\u{1F4CA} ' + effAcc + ' IP';
        await tg('editMessageText', env.BOT_TOKEN, {
          chat_id: cid,
          message_id: mid,
          text:
            '\u2705 <b>\u8F6C\u6362\u5B8C\u6210</b>\n' +
            '\u{1F4CA} ' + (u._gostCount || '?') + ' Gost \u8282\u70B9 \u2192 <b>' + fmtLabel + '</b>\n\n' +
            '\u{1F517} <code>' + clipUrl + '</code>\n\n' +
            '\u23F1 ' + ttlT + accT,
          parse_mode: 'HTML',
          reply_markup: resultKb(clipUrl),
        });
        return;
      } catch (e) {
        return tg('editMessageText', env.BOT_TOKEN, {
          chat_id: cid,
          message_id: mid,
          text: '\u274C \u4FDD\u5B58\u5931\u8D25: ' + e.message,
          parse_mode: 'HTML',
          reply_markup: mainKb(),
        });
      }
    }

    if (!u._lastProxies || u._lastProxies.length === 0) {
      return tg('editMessageText', env.BOT_TOKEN, {
        chat_id: cid,
        message_id: mid,
        text: '\u274C \u6CA1\u6709\u53EF\u8F6C\u6362\u7684\u8282\u70B9\uFF0C\u8BF7\u91CD\u65B0\u53D1\u9001',
        parse_mode: 'HTML',
        reply_markup: mainKb(),
      });
    }

    // 非 gost 格式的标准节点转换
    let proxiesForConvert = u._lastProxies || [];
    // 默认去同名：重复节点名加 _2 _3 后缀
    const nameCount = {};
    proxiesForConvert = proxiesForConvert.map(p => {
      const base = p.name || '';
      nameCount[base] = (nameCount[base] || 0) + 1;
      const idx = nameCount[base];
      const dupCount = idx - 1;
      const renamed = dupCount > 0 ? { ...p, name: base + superscriptNum(dupCount) } : p;
      if (dupCount > 0) console.log('[DEDUP] ' + base + ' -> ' + base + superscriptNum(dupCount));
      return renamed;
    });
    let output;
    if (fmt === 'b64') {
      // Base64 输出：取原始订阅内容（已是 base64 base64 或可截取
      // 优先用原始文本（直连或反代拿到的最初内容）
      let rawText = u._lastRawContent || '';
      // 如果原始内容不是 base64（是 URI 列表），先转 base64
      if (rawText && !/^[A-Za-z0-9+/=\s\r\n]+$/.test(rawText.trim())) {
        rawText = btoa(unescape(encodeURIComponent(rawText)));
      }
      if (!rawText) {
        // 兜底：从 parsed proxies 拼接
        let std = '';
        try { std = ProxyUtils.produce(proxiesForConvert, 'uri'); } catch {}
        const wgList = u._accWgProxies || u._wgProxies || [];
        let wgOut = '';
        if (wgList.length > 0) { try { wgOut = ProxyUtils.produce(wgList, 'clashmeta'); } catch {} }
        const gostRaw = u._accGostInput || u._gostInput || '';
        rawText = btoa(unescape(encodeURIComponent([std, wgOut, gostRaw].filter(Boolean).join('\n'))));
      }
      output = rawText;
    } else {
      try {
        output = ProxyUtils.produce(proxiesForConvert, fmt);
      } catch (e) {
        return tg('editMessageText', env.BOT_TOKEN, {
          chat_id: cid, message_id: mid,
          text: '\u274C \u8F6C\u6362\u5931\u8D25: ' + e.message,
          parse_mode: 'HTML', reply_markup: fmtKb(null, u._convTtl, u.ttl, u),
        });
      }
    }

    if (!output) {
      return tg('editMessageText', env.BOT_TOKEN, {
        chat_id: cid, message_id: mid,
        text: '\u274C \u8F6C\u6362\u7ED3\u679C\u4E3A\u7A7A',
        parse_mode: 'HTML', reply_markup: fmtKb(null, u._convTtl, u.ttl, u),
      });
    }

    tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: '\u{1F504} \u8F6C\u6362\u4E2D... (' + fmtLabel + ')', parse_mode: 'HTML',
    });

    try {
      const extraUrls = [];
      const { id, url: clipUrl } = await saveToClipAndTrack(String(output), getEffectiveTtl(u), env, uid, {
        preview: fmtLabel + ' · ' + u._lastProxies.length + ' 节点',
        nodeCount: u._lastProxies.length, source: 'convert',
        burn: u?._burn || false,
        landing: u?._landing || false,
      }, getEffectiveMaxAccess(u));
      u._lastContent = String(output);

      // WG 侧链
      const wg = u._wgProxies || [];
      if (wg.length > 0) {
        const wgOut = ProxyUtils.produce(wg, 'clashmeta');
        if (wgOut) {
          const { url: wgUrl } = await saveToClipAndTrack(String(wgOut), getEffectiveTtl(u), env, uid, {
            preview: 'WireGuard × ' + wg.length + ' (Clash Meta)', nodeCount: wg.length, source: 'wg',
            burn: u?._burn || false,
            landing: u?._landing || false,
          }, getEffectiveMaxAccess(u));
          extraUrls.push({ text: '⚡ WireGuard', url: wgUrl });
        }
      }

      // Gost 侧链
      if (u._gostInput) {
        const { url: gostUrl } = await saveToClipAndTrack(u._gostInput, getEffectiveTtl(u), env, uid, {
          preview: 'Gost Tunnel × ' + u._gostCount, nodeCount: u._gostCount, source: 'gost',
          burn: u?._burn || false,
          landing: u?._landing || false,
        }, getEffectiveMaxAccess(u));
        extraUrls.push({ text: '🔄 Gost', url: gostUrl });
      }

      const effTtl2 = getEffectiveTtl(u);
      const effAcc = getEffectiveMaxAccess(u);
      u._convTtl = null;
      u._convAccessLimit = null;
      const ttlT = effTtl2 === 0 ? '\u6C38\u4E0D\u8FC7\u671F' : effTtl2 < 3600 ? Math.round(effTtl2 / 60) + '\u5206\u949F' : Math.round(effTtl2 / 3600) + '\u5C0F\u65F6';
      const accT = effAcc === 0 ? '' : '\n\u{1F4CA} ' + effAcc + ' IP';
      let resText = '\u2705 <b>\u8F6C\u6362\u5B8C\u6210</b>\n\n\u{1F4CA} ' + u._lastProxies.length + ' \u8282\u70B9 \u2192 <b>' + fmtLabel + '</b>\n\n\u{1F517} <code>' + clipUrl + '</code>\n';
      for (const e of extraUrls) resText += '\n' + e.text + '\n<code>' + e.url + '</code>\n';
      resText += '\n\n\u23F1 ' + ttlT + accT;
      await tg('editMessageText', env.BOT_TOKEN, {
        chat_id: cid, message_id: mid,
        text: resText, parse_mode: 'HTML',
        reply_markup: multiResultKb(clipUrl, extraUrls),
      }).catch(() => {});
    } catch (e) {
      const preview = String(output).length > 300 ? String(output).slice(0, 300) + '...' : String(output);
      await tg('editMessageText', env.BOT_TOKEN, {
        chat_id: cid, message_id: mid,
        text: '\u274C \u9519\u8BEF: ' + escapeHTML(e.message || e.toString()) + '\n\n<code>' + escapeHTML(preview) + '</code>',
        parse_mode: 'HTML',
        reply_markup: mainKb(),
      });
    }
    return;
}



  // ==================== Worker 入口 ====================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

    if (request.method === 'OPTIONS') return new Response('', { headers: cors });

    // 调试路由（需设置 DEBUG_TOKEN 环境变量）
    if (path === '/debug-fetch') {
      if (!env.DEBUG_TOKEN || url.searchParams.get('token') !== env.DEBUG_TOKEN) return new Response('', { status: 403 });
      const target = url.searchParams.get('url');
      if (!target) return new Response('missing url', { status: 400 });
      const r = await fetch(target, { headers: { 'User-Agent': 'Karing' } });
      const text = await r.text();
      let count = 0;
      try { const parsed = ProxyUtils.parse(text); count = parsed?.length || 0; } catch {}
      return new Response(JSON.stringify({ status: r.status, len: text.length, count }), { headers: { 'Content-Type': 'application/json', ...cors } });
    }

    // API: 文本保存 (jtb-clip 兼容)
    if (path === '/save' && request.method === 'POST') {
      try {
        const body = await request.text();
        const id = await saveToClip(body, 86400, env);
        const clipUrl = ((env.CLIP_URL || '').replace(/\/+$/, '')) + '/share/' + id;
        return new Response(JSON.stringify({ success: true, id, url: clipUrl }), { headers: { 'Content-Type': 'application/json', ...cors } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...cors } });
      }
    }

    // API: 链接状态查询（落地页使用）
    if (path.startsWith('/api/link-status/')) {
      const id = path.replace('/api/link-status/', '');
      const raw = await env.KV.get('share_' + id, { type: 'json' });
      if (!raw) {
        return new Response(JSON.stringify({ alive: false }), { headers: { 'Content-Type': 'application/json', ...cors } });
      }
      const consumed = raw.consumed || false;
      const accessedIPs = Array.isArray(raw.accessedIPs) ? raw.accessedIPs : [];
      const nodeCount = raw.nodeCount || 0;
      return new Response(JSON.stringify({
        alive: !consumed,
        consumed,
        nodeCount,
        maxAccess: raw.maxAccess || 0,
        accessCount: accessedIPs.length,
        ttl: raw.ttl || 0,
        createdAt: raw._createdAt || 0,
      }), { headers: { 'Content-Type': 'application/json', ...cors } });
    }

    // API: 短链读取（支持 落地页/阅后即焚/独立IP按次/伪装流量）
    if (path.startsWith('/share/')) {
      const id = path.replace('/share/', '').replace(/\?raw.*$/, '');
      const isRaw = url.searchParams.has('raw');
      const raw = await env.KV.get('share_' + id, { type: 'json' });
      if (!raw) {
        return Response.redirect('https://www.google.com', 302);
      }
      const teaming = raw.landing || false;
      const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
      const burn = raw.burn || false;
      const maxIPs = raw.maxAccess || 0;
      const accessedIPs = Array.isArray(raw.accessedIPs) ? raw.accessedIPs : [];
      const ttl = raw.ttl || 0;

      // ===== 落地页模式（landing + 非 ?raw 请求） =====
      if (teaming && !isRaw) {
        let consumed = raw.consumed || false;

        // 阅后即焚：落地页首次访问展示真链并标记消耗
        if (burn) {
          const ipResult = await atomicTrackIP(env, id, clientIP, 0, ttl);
          if (!ipResult.error && !ipResult.consumed) {
            await env.KV.put('share_' + id, JSON.stringify({ ...raw, consumed: true }), ttl > 0 ? { expirationTtl: ttl < 60 ? 60 : ttl } : {});
          } else if (ipResult.consumed) {
            consumed = true;
          }
        }

        // 独立 IP 上限
        if (!consumed && maxIPs > 0) {
          const ipResult = await atomicTrackIP(env, id, clientIP, maxIPs, ttl);
          if (ipResult.consumed) {
            consumed = true;
            await env.KV.put('share_' + id, JSON.stringify({ ...raw, consumed: true }), ttl > 0 ? { expirationTtl: ttl < 60 ? 60 : ttl } : {});
          }
        }

        // 普通访问：记 IP
        if (!consumed && !burn) {
          await atomicTrackIP(env, id, clientIP, 0, ttl);
        }

        // 获取落地页 HTML（从 GitHub 拉取，KV 缓存 24h）
        // 从 KV 读缓存的落地页 HTML（含版本号，改版时递增）
        let html = await env.KV.get('_landing_v1');
        if (!html) {
          const LANDING_HTML_URL = env.LANDING_HTML_URL ||
            'https://raw.githubusercontent.com/Linsars/sub-store-bot/main/landing/index.html';
          // SSRF 防护：只允许从 GitHub 拉取落地页
          const allowedHosts = ['raw.githubusercontent.com', 'github.com', 'github.githubassets.com'];
          let urlOk = false;
          try {
            const u = new URL(LANDING_HTML_URL);
            urlOk = allowedHosts.includes(u.hostname);
          } catch {}
          if (!urlOk) {
            html = '<html><body><h1>Invalid landing page URL</h1></body></html>';
          } else {
            try {
              const ghResp = await fetch(LANDING_HTML_URL);
              if (ghResp.ok) {
                html = await ghResp.text();
                await env.KV.put('_landing_v1', html, { expirationTtl: 86400 });
              }
            } catch {}
          }
        }
        if (!html) {
          // 兜底：如果拉取失败，返回原始文本
          const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
          if (raw.subInfo) headers['Subscription-Userinfo'] =
            `upload=${raw.subInfo.up}; download=${raw.subInfo.down}; total=${raw.subInfo.total}; expire=${raw.subInfo.expire}`;
          return new Response(raw.text, { headers });
        }

        // 替换占位符
        html = html.replace(/__ID__/g, id).replace(/__STATUS__/g, consumed ? 'consumed' : 'alive');
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      // ===== 非落地页模式（或 ?raw 请求）= 原始行为 =====
      // 阅后即焚：首次访问即销毁
      if (burn) {
        ctx.waitUntil(env.KV.delete('share_' + id).catch(() => {}));
        const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
        if (raw.subInfo) headers['Subscription-Userinfo'] =
          `upload=${raw.subInfo.up}; download=${raw.subInfo.down}; total=${raw.subInfo.total}; expire=${raw.subInfo.expire}`;
        return new Response(raw.text, { headers });
      }

      // 独立 IP 上限
      if (maxIPs > 0 && accessedIPs.length >= maxIPs) {
        ctx.waitUntil(env.KV.delete('share_' + id).catch(() => {}));
        return Response.redirect('https://www.google.com', 302);
      }

      // 新 IP 才加入列表
      const isNewIP = !accessedIPs.includes(clientIP);
      const kvOpts = ttl > 0 ? { expirationTtl: ttl < 60 ? 60 : ttl } : {};
      if (isNewIP || maxIPs > 0) {
        ctx.waitUntil(env.KV.put('share_' + id,
          JSON.stringify({ ...raw, accessedIPs: isNewIP ? [...accessedIPs, clientIP] : accessedIPs }),
          kvOpts
        ).catch(() => {}));
      }

      // 伪装流量头
      const respHeaders = { 'Content-Type': 'text/plain; charset=utf-8' };
      if (raw.subInfo) respHeaders['Subscription-Userinfo'] =
        `upload=${raw.subInfo.up}; download=${raw.subInfo.down}; total=${raw.subInfo.total}; expire=${raw.subInfo.expire}`;
      return new Response(raw.text, { headers: respHeaders });
    }

    // Telegram Webhook
    if (path === '/webhook' && request.method === 'POST') {
      const body = await request.json();
      if (!body) return new Response('ok');

      // 验证 X-Telegram-Bot-Api-Secret-Token
      if (env.WEBHOOK_SECRET && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('unauthorized', { status: 401 });
      }

      ctx.waitUntil(
        (async () => {
          try {
            if (body.message) {
              const uid = String(body.message.from?.id || '');
              if (applyRateLimit(uid, env.ALLOWED_USERS)) {
                await tg('sendMessage', env.BOT_TOKEN, {
                  chat_id: String(body.message.chat?.id || uid),
                  text: '\u26A0\uFE0F \u8BF7\u52FF\u9891\u7E41\u8BF7\u6C42\uFF0C\u6BCF 30 \u79D2\u6700\u591A 5 \u6B21',
                });
                return;
              }
              // 加载持久化配置到 stateMap
              const cfg = await loadUserConfig(uid, env);
              if (Object.keys(cfg).length > 0) {
                const s = getState(uid);
                Object.assign(s, cfg);
              }
              await onMsg(body.message, env);
            } else if (body.callback_query) {
              const uid = String(body.callback_query.from?.id || '');
              if (applyRateLimit(uid, env.ALLOWED_USERS)) {
                await tg('answerCallbackQuery', env.BOT_TOKEN, {
                  callback_query_id: body.callback_query.id,
                  text: '\u26A0\uFE0F \u8BF7\u52FF\u9891\u7E41\u64CD\u4F5C',
                });
                return;
              }
              // 加载持久化配置到 stateMap
              const cfg = await loadUserConfig(uid, env);
              if (Object.keys(cfg).length > 0) {
                const s = getState(uid);
                Object.assign(s, cfg);
              }
              await onCb(body.callback_query, env);
            }
          } catch (e) {
            await tg('sendMessage', env.BOT_TOKEN, {
              chat_id: String(body.message?.from?.id || body.callback_query?.from?.id || ''),
              text: '\u274C \u62A5\u9519: ' + e.message,
            });
          }
        })()
      );
      return new Response('ok');
    }

    // API: 订阅转换 (给外部调)
    if (path === '/api/convert' && request.method === 'POST') {
      try {
        const body = await request.json();
        const input = body.input;
        const target = body.target || 'clashmeta';
        if (!input) {
          return new Response(JSON.stringify({ error: 'input required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...cors },
          });
        }
        let proxies;
        try {
          proxies = ProxyUtils.parse(input);
        } catch (e) {
          proxies = null;
        }

        if (!proxies || proxies.length === 0) {
          return new Response(
            JSON.stringify({ success: false, count: 0, output: '' }),
            { headers: { 'Content-Type': 'application/json', ...cors } }
          );
        }
        const output = ProxyUtils.produce(proxies, target);
        return new Response(
          JSON.stringify({ success: true, count: proxies.length, output: String(output), target }),
          { headers: { 'Content-Type': 'application/json', ...cors } }
        );
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
    }

    // 根路由：设了 CLIP_URL → 跳 google 防泄露
    // 不设 CLIP_URL → 自动激活 webhook + 显示状态（参考 glados-discourse-bot）
    if (url.pathname === '/') {
      if (env.CLIP_URL) return Response.redirect('https://www.google.com', 302);
      const setupResult = { webhook: false, commands: false };
      if (env.BOT_TOKEN) {
        try {
          const wh = `${url.protocol}//${url.hostname}/webhook`;
          const params = { url: wh };
          if (env.WEBHOOK_SECRET) params.secret_token = env.WEBHOOK_SECRET;
          const r1 = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
          });
          setupResult.webhook = (await r1.json()).ok === true;
          const r2 = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setMyCommands`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commands: [{ command: 'start', description: '启动 / 主页' }] }),
          });
          setupResult.commands = (await r2.json()).ok === true;
        } catch (e) { setupResult.error = e.message; }
      }
      return new Response(JSON.stringify({
        service: 'sub-store-bot', version: '3.0',
        bot: typeof env.BOT_TOKEN !== 'undefined',
        clipUrl: env.CLIP_URL || '',
        webhook: setupResult.webhook ? '✅ 已激活' : '❌ 未激活',
        commands: setupResult.commands ? '✅ 已注册' : '⚠️ 未注册',
        setupError: setupResult.error || null,
      }, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    // /setup: 自动激活 webhook + 注册命令（给部署者用）
    if (url.pathname === '/setup') {
      const setupResult = { webhook: false, commands: false };
      if (env.BOT_TOKEN) {
        try {
          const wh = `${url.protocol}//${url.hostname}/webhook`;
          const whParams = { url: wh };
          if (env.WEBHOOK_SECRET) whParams.secret_token = env.WEBHOOK_SECRET;
          const r1 = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(whParams),
          });
          setupResult.webhook = (await r1.json()).ok === true;

          const r2 = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setMyCommands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              commands: [
                { command: 'start', description: '启动 / 主页' },
              ],
            }),
          });
          setupResult.commands = (await r2.json()).ok === true;
        } catch (e) { setupResult.error = e.message; }
      }
      return new Response(
        JSON.stringify({
          service: 'sub-store-bot',
          version: '3.0',
          bot: typeof env.BOT_TOKEN !== 'undefined',
          clipUrl: env.CLIP_URL || '',
          engine: 'Sub-Store',
          formats: FORMAT_OPTIONS.map(f => f.id),
          webhook: setupResult.webhook ? '✅ 已激活' : '❌ 未激活',
          commands: setupResult.commands ? '✅ 已注册' : '⚠️ 未注册',
          setupError: setupResult.error || null,
        }),
        { headers: { 'Content-Type': 'application/json', ...cors } }
      );
    }

    // Health (fallback)
    return new Response(
      JSON.stringify({
        service: 'sub-store-bot',
        version: '3.0',
        bot: typeof env.BOT_TOKEN !== 'undefined',
        clipUrl: env.CLIP_URL || '',
        engine: 'Sub-Store',
        formats: FORMAT_OPTIONS.map(f => f.id),
      }),
      { headers: { 'Content-Type': 'application/json', ...cors } }
    );
  },
};