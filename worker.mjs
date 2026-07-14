/**
 * Sub-Store Bot — Telegram 剪贴板 + 订阅转换
 * 
 * 依赖:
 *   - proxy-utils.js (Sub-Store 引擎)
 *   - Cloudflare Workers KV — 短链存储
 *   - BOT_TOKEN — Telegram Bot Token
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

async function tg(method, token, body) {
  const r = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

function escapeHTML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
        { text: '\u{23F1} 有效期', callback_data: 'ttl_menu' },
      ],
      [
        { text: '\u{1F4CB} 我的短链', callback_data: 'my_links_0' },
      ],
    ],
  };
}

const FORMAT_OPTIONS = [
  { id: 'clashmeta', label: 'Clash Meta' },
  { id: 'qx', label: 'Quantumult X' },
  { id: 'surge', label: 'Surge' },
  { id: 'shadowrocket', label: 'Shadowrocket' },
  { id: 'singbox', label: 'sing-box' },
  { id: 'v2ray', label: 'V2Ray' },
  { id: 'loon', label: 'Loon' },
  { id: 'stash', label: 'Stash' },
  { id: 'surfboard', label: 'Surfboard' },
  { id: 'egern', label: 'Egern' },
  { id: 'uri', label: 'URI 列表' },
  { id: 'json', label: 'JSON' },
];

// Gost Tunnel 仅支持的格式
const GOST_FORMATS = ['shadowrocket', 'uri'];

function fmtKb(allowed, convTtl, ttlDefault) {
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
  rows.push([{ text: '\u23F1 \u6642\u6548: ' + ttlLabel, callback_data: 'conv_ttl_menu' }]);
  rows.push([{ text: '\u2190 返回', callback_data: 'menu' }]);
  return { inline_keyboard: rows };
}

function ttlKb(current, prefix) {
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
    row.push({ text: o.l, callback_data: cbPrefix + o.s });
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  rows.push([{ text: '\u2190 返回', callback_data: 'menu' }]);
  return { inline_keyboard: rows };
}

function backKb() {
  return { inline_keyboard: [[{ text: '\u2190 返回', callback_data: 'menu' }]] };
}

function resultKb(url) {
  return {
    inline_keyboard: [
      [
        { text: '\u{1F4E5} \u4E0B\u8F7D\u7ED3\u679C', callback_data: 'dl_result' },
        { text: '\u{1F517} \u6253\u5F00', url: url },
      ],
      [
        { text: '\u{1F4E4} \u5206\u4EAB', url: 'https://t.me/share/url?url=' + encodeURIComponent(url) },
      ],
      [
        { text: '\u{1F3E0} \u4E3B\u9875', callback_data: 'menu' },
      ],
    ],
  };
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
  if (!stateMap.has(uid)) stateMap.set(uid, { _uid: uid });
  return stateMap.get(uid);
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
        key = p.server + ':' + p.port + ':' + p.type + ':' + p.uuid;
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

// ==================== KV 累计状态（跨实例共享） ====================

async function getAccState(uid, env) {
  try {
    const raw = await env.KV.get('acc:' + uid, { type: 'json' });
    return raw || null;
  } catch { return null; }
}

async function saveAccState(uid, env, data) {
  await env.KV.put('acc:' + uid, JSON.stringify(data), { expirationTtl: 300 });
}

async function clearAccState(uid, env) {
  await env.KV.delete('acc:' + uid);
}

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

function getEffectiveTtl(u) {
  return u._convTtl !== undefined && u._convTtl !== null ? u._convTtl : (u.ttl !== undefined ? u.ttl : 0);
}

// ==================== 保存到短链 ====================

async function saveToClip(text, ttl, env) {
  const id = genId();
  const kvOpts = {};
  if (ttl > 0) kvOpts.expirationTtl = ttl < 60 ? 60 : ttl;
  await env.KV.put('share_' + id, JSON.stringify({ text }), kvOpts);
  return id;
}

// 保存短链并记录到用户索引
async function saveToClipAndTrack(text, ttl, env, uid, extra) {
  const id = await saveToClip(text, ttl, env);
  const clipUrl = (env.CLIP_URL || '') + '/share/' + id;
  const entry = {
    id,
    ...extra,
    ttl: ttl,
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
    await clearAccState(uid, env);
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

  // 获取输入内容
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
        u._lastFetchUa = subResult.ua;
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
    if (u._lastStats) {
      u._lastStats.dupNodes = before - proxies.length;
      u._lastStats.actualNodes = proxies.length;
    }
  }
  }

  // 读取 KV 累计状态
  let accState = isRemote ? null : (await getAccState(uid, env));

  // 每次新内容重置（远程/本地都清）
  await clearAccState(uid, env);
  u._lastStats = null;
  u._lastUrlCount = null;

  // 混合内容：标准节点 + Gost
  const isMixed = gostLines.length > 0 && proxies && proxies.length > 0;

  // 纯 Gost（无标准节点）
  if (gostLines.length > 0 && (!proxies || proxies.length === 0)) {
    u._lastSubInput = subText; // 已去掉 Gost 行，存标准部分
    u._gostInput = gostLines.join('\n');
    u._lastProxies = [];
    u._isGost = true;
    u._gostCount = gostLines.length;
    return replyOrEdit(u, cid, env, {
      text:
        '\u{1F504} <b>\u68C0\u6D4B\u5230\u8BA2\u9605\u5185\u5BB9</b>\n\n' +
        '\u{1F4CA} \u8282\u70B9\u6570: <b>' + gostLines.length + '</b>\n' +
        '\u{1F4CD} Gost Tunnel: ' + gostLines.length + '\n' +
        '\u26A0\uFE0F \u4EC5 Shadowrocket / URI \u5217\u8868\u652F\u6301 Gost Tunnel\n\n' +
        '\u8BF7\u9009\u62E9\u8F93\u51FA\u683C\u5F0F:',
      parse_mode: 'HTML',
      reply_markup: fmtKb(FORMAT_OPTIONS.filter(f => GOST_FORMATS.includes(f.id)), u._convTtl, u.ttl),
    });
  }

  if (!proxies || proxies.length === 0) {
    // 纯文本：保存为短链
    try {
      const preview = subText.length > 50 ? subText.slice(0, 50) + '...' : subText;
      const { id, url: clipUrl } = await saveToClipAndTrack(subText, ttl, env, uid, {
        preview: '\u{1F4C4} ' + preview,
        nodeCount: 0,
        source: 'text',
      });
      const previewShow = subText.length > 150 ? subText.slice(0, 150) + '...' : subText;
      const ttlT = ttl === 0 ? '\u6C38\u4E0D\u8FC7\u671F' : ttl < 3600 ? Math.round(ttl / 60) + '\u5206\u949F' : Math.round(ttl / 3600) + '\u5C0F\u65F6';
      u._lastContent = subText;
      u._lastSubInput = subText;
      return replyOrEdit(u, cid, env, {
        text:
          '\u2705 <b>\u5DF2\u4FDD\u5B58</b>\n\n' +
          '\u{1F517} <code>' + clipUrl + '</code>\n\n' +
          '\u{1F4CB} \u9884\u89C8:\n<code>' + escapeHTML(previewShow) + '</code>\n\n' +
          '\u23F1 ' + ttlT,
        parse_mode: 'HTML',
        reply_markup: resultKb(clipUrl),
      });
    } catch (e) {
      return replyOrEdit(u, cid, env, {
        text: '\u274C \u4FDD\u5B58\u5931\u8D25: ' + e.message,
      });
    }
  }

  // 有节点 — 统计类型，弹出格式选择
  const types = {};
  for (const p of proxies) {
    types[p.type] = (types[p.type] || 0) + 1;
  }
  let typeStr = Object.entries(types)
    .map(([k, v]) => k + ': ' + v)
    .join(', ');

  u._lastSubInput = subText;
  u._lastProxies = proxies;

  if (gostLines.length > 0) {
    u._gostInput = gostLines.join('\n');
    u._isGost = true;
    u._gostCount = gostLines.length;
    typeStr += '\nGost Tunnel: ' + gostLines.length + ' (\u9644\u52A0\u539F\u59CB\u683C\u5F0F)';
  } else {
    u._isGost = false;
    u._gostInput = null;
    u._gostCount = 0;
  }

  const gostHint = gostLines.length > 0
    ? '\n\u26A0\uFE0F ' + gostLines.length + ' \u4E2A Gost Tunnel \u8282\u70B9\u5C06\u4EE5\u539F\u59CB\u683C\u5F0F\u9644\u52A0\u5728\u8F6C\u6362\u7ED3\u679C\u672B\u5C3E\uFF0C\u4EC5 Shadowrocket \u53EF\u7528\n'
    : '';

  const accHint = accState && accState.proxies && accState.proxies.length > 0
    ? '\n\u{1F504} <b>\u7D2F\u8BA1\u6A21\u5F0F</b> \u2014 \u53D1\u9001\u66F4\u591A\u8BA2\u9605\u5185\u5BB9\u5C06\u81EA\u52A8\u5408\u5E76\uFF0C\u70B9\u51FB\u683C\u5F0F\u6309\u94AE\u5F00\u59CB\u8F6C\u6362\n'
    : '';

  const sourceInfo = u._lastUrlCount
    ? '\n\u{1F517} ' + (typeof u._lastUrlCount === 'number'
        ? u._lastUrlCount + ' \u4E2A\u8BA2\u9605\u6E90'
        : u._lastUrlCount + ' \u4E2A\u8BA2\u9605\u6E90')
    : '';
  const uaInfo = u._lastFetchUa
    ? '\n\u{1F916} ' + escapeHTML(u._lastFetchUa)
    : '';

  const statsLine = u._lastStats
    ? '\n\u{1F4CA} <b>' + u._lastStats.actualNodes + '</b> \u5B9E\u9645' +
      ' (\u603B: ' + u._lastStats.totalNodes +
      (u._lastStats.dupUrls > 0 ? ', \u53BB\u91CD\u94FE\u63A5: ' + u._lastStats.dupUrls : '') +
      (u._lastStats.dupSubs > 0 ? ', \u91CD\u590D\u8BA2\u9605: ' + u._lastStats.dupSubs : '') +
      (u._lastStats.dupNodes > 0 ? ', \u91CD\u590D\u8282\u70B9: ' + u._lastStats.dupNodes : '') + ')'
    : '';

  if (!isRemote && accState && accState.fmtMsg && accState.fmtMsg.id) {
    await tg('editMessageText', env.BOT_TOKEN, {
      chat_id: accState.fmtMsg.cid,
      message_id: accState.fmtMsg.id,
      text:
        '\u{1F504} <b>\u68C0\u6D4B\u5230\u8BA2\u9605\u5185\u5BB9</b>\n\n' +
        (statsLine ? '' : '\u{1F4CA} \u8282\u70B9\u6570: <b>' + proxies.length + '</b>\n') +
        statsLine + '\n' +
        '\u{1F4CD} ' + typeStr + '\n' +
        sourceInfo + uaInfo + '\n' +
        gostHint +
        accHint +
        '\u8BF7\u9009\u62E9\u8F93\u51FA\u683C\u5F0F:',
      parse_mode: 'HTML',
      reply_markup: fmtKb(null, u._convTtl, u.ttl),
    });
    if (!isRemote) await saveAccState(uid, env, { proxies, fmtMsg: accState.fmtMsg });
  } else {
    const sent = await replyOrEdit(u, cid, env, {
      text:
        '\u{1F504} <b>\u68C0\u6D4B\u5230\u8BA2\u9605\u5185\u5BB9</b>\n\n' +
        (statsLine ? '' : '\u{1F4CA} \u8282\u70B9\u6570: <b>' + proxies.length + '</b>\n') +
        statsLine + '\n' +
        '\u{1F4CD} ' + typeStr + '\n' +
        sourceInfo + uaInfo + '\n' +
        gostHint +
        accHint +
        '\u8BF7\u9009\u62E9\u8F93\u51FA\u683C\u5F0F:',
      parse_mode: 'HTML',
      reply_markup: fmtKb(null, u._convTtl, u.ttl),
    });
    const msgId = sent?.result?.message_id || (sent?.from_edit ? u.promptMid : null);
    if (!isRemote) await saveAccState(uid, env, {
      proxies,
      fmtMsg: msgId ? { cid: cid, id: msgId } : null,
    });
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

  if (d === 'menu') {
    await clearAccState(uid, env);
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: mainPageText(),
      parse_mode: 'HTML',
      reply_markup: mainKb(),
    });
  }

  if (d === 'input_url') {
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

  if (d === 'input_file') {
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

  if (d === 'ua_menu') {
    return showUaSettings(cid, mid, uid, env);
  }

  if (d.startsWith('ua_toggle:')) {
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

  if (d.startsWith('ua_del:')) {
    const ci = parseInt(d.split(':')[1]);
    const cfg = await getUaConfig(uid, env);
    if (ci >= 0 && ci < (cfg.custom || []).length) {
      (cfg.custom || []).splice(ci, 1);
      await saveUaConfig(uid, env, cfg);
    }
    return showUaSettings(cid, mid, uid, env);
  }

  if (d === 'ua_reset') {
    await saveUaConfig(uid, env, { custom: [], disabled: [] });
    return showUaSettings(cid, mid, uid, env);
  }

  if (d === 'ua_add') {
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

  if (d === 'ttl_menu') {
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u{23F1} \u5F53\u524D: ' + (u.ttl === 0 ? '\u6C38\u4E0D\u8FC7\u671F' : u.ttl ? (u.ttl < 3600 ? Math.round(u.ttl / 60) + '\u5206\u949F' : Math.round(u.ttl / 3600) + '\u5C0F\u65F6') : '\u9ED8\u8BA4'),
      parse_mode: 'HTML',
      reply_markup: ttlKb(),
    });
  }

  if (d.startsWith('ttl_set:')) {
    u.ttl = parseInt(d.split(':')[1]);
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u2705 \u5DF2\u8BBE\u7F6E: ' + (u.ttl === 0 ? '\u6C38\u4E0D\u8FC7\u671F' : u.ttl < 3600 ? Math.round(u.ttl / 60) + '\u5206\u949F' : Math.round(u.ttl / 3600) + '\u5C0F\u65F6'),
      parse_mode: 'HTML',
      reply_markup: mainKb(),
    });
  }

  // ====== 我的短链 ======

  if (d.startsWith('my_links_')) {
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
      const icon = linkStatusIcon(l);
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

  // ====== 短\u94FE\u8BE6\u60C5 ======

  if (d.startsWith('link_')) {
    const linkId = d.replace('link_', '');
    const links = await getUserLinks(uid, env);
    const l = links.find(x => x.id === linkId);
    if (!l) {
      return tg('editMessageText', env.BOT_TOKEN, {
        chat_id: cid,
        message_id: mid,
        text: '\u274C \u77ED\u94FE\u5DF2\u4E0D\u5B58\u5728',
        parse_mode: 'HTML',
        reply_markup: mainKb(),
      });
    }
    const clipUrl = (env.CLIP_URL || '') + '/share/' + l.id;
    const statusIcon = linkStatusIcon(l);
    let statusText;
    if (l.ttl === 0) statusText = '\u{1F535} \u6C38\u4E45\u6709\u6548';
    else if (l.expiresAt && Date.now() > l.expiresAt) statusText = '\u26AB \u5DF2\u8FC7\u671F';
    else {
      const remain = Math.round((l.expiresAt - Date.now()) / 1000);
      statusText = '\u{1F7E0} \u5269 ' + (remain < 3600 ? Math.round(remain / 60) + '\u5206\u949F' : Math.round(remain / 3600) + '\u5C0F\u65F6');
    }
    let text = '\u{1F4CB} <b>\u77ED\u94FE\u8BE6\u60C5</b>\n\n';
    text += statusIcon + ' <b>' + escapeHTML(l.preview) + '</b>\n';
    text += '\u{1F4CA} ' + (l.nodeCount || 0) + ' \u8282\u70B9  \u00B7 ' + statusText + '\n\n';
    text += '\u{1F517} <code>' + escapeHTML(clipUrl) + '</code>';
    
    const isExpired = l.ttl > 0 && l.expiresAt && Date.now() > l.expiresAt;
    const ttlRow = isExpired
      ? [{ text: '\u26AB \u5DF2\u8FC7\u671F\uFF0C\u65E0\u6CD5\u4FEE\u6539', callback_data: 'noop' }]
      : [{ text: '\u23F1 \u4FEE\u6539\u6642\u6548', callback_data: 'mod_ttl_' + l.id }];

    const rows = [
      [
        { text: '\u{1F4CB} \u590D\u5236\u94FE\u63A5', copy_text: { text: clipUrl } },
        { text: '\u{1F517} \u6253\u5F00', url: clipUrl },
      ],
      ttlRow,
      [
        { text: '\u{1F5D1} \u5220\u9664\u77ED\u94FE', callback_data: 'del_confirm_' + l.id },
      ],
      [
        { text: '\u2190 \u8FD4\u56DE\u5217\u8868', callback_data: 'my_links_0' },
      ],
    ];
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows },
    });
  }

  // ====== 删\u9664\u786E\u8BA4 ======

  if (d.startsWith('del_confirm_')) {
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

  // ====== 执\u884C\u5220\u9664 ======

  if (d.startsWith('do_del_')) {
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

  // ====== 修改短链时效 ======

  if (d.startsWith('mod_ttl_')) {
    const linkId = d.replace('mod_ttl_', '');
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u23F1 <b>\u4FEE\u6539\u77ED\u94FE\u6642\u6548</b>\n\n\u9009\u62E9\u65B0\u7684\u6642\u6548\uFF0C\u5DF2\u8FC7\u671F\u7684\u77ED\u94FE\u65E0\u6CD5\u6062\u590D\u3002',
      parse_mode: 'HTML',
      reply_markup: ttlKb('chg_ttl_' + linkId + ':'),
    });
  }

  if (d.startsWith('chg_ttl_')) {
    const rest = d.replace('chg_ttl_', '');
    const colonIdx = rest.lastIndexOf(':');
    const linkId = rest.slice(0, colonIdx);
    const newTtl = parseInt(rest.slice(colonIdx + 1));
    try {
      const data = await env.KV.get('share_' + linkId, 'json');
      if (data && data.text) {
        const kvOpts = newTtl > 0 ? { expirationTtl: newTtl } : {};
        await env.KV.put('share_' + linkId, JSON.stringify({ text: data.text }), kvOpts);
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
      await env.KV.put('user_links:' + uid, JSON.stringify(links));
    }
    const l = links.find(x => x.id === linkId);
    if (l) {
      const clipUrl = (env.CLIP_URL || '') + '/share/' + l.id;
      const statusText = l.ttl === 0 ? '\u{1F535} \u6C38\u4E45\u6709\u6548'
        : l.expiresAt && Date.now() > l.expiresAt ? '\u26AB \u5DF2\u8FC7\u671F'
        : '\u{1F7E0} \u5269 ' + Math.round((l.expiresAt - Date.now()) / 60000) + '\u5206\u949F';
      let text = '\u{1F4CB} <b>\u77ED\u94FE\u8BE6\u60C5</b>\n\n';
      text += linkStatusIcon(l) + ' <b>' + escapeHTML(l.preview) + '</b>\n';
      text += '\u{1F4CA} ' + (l.nodeCount || 0) + ' \u8282\u70B9  \u00B7 ' + statusText + '\n\n';
      text += '\u{1F517} <code>' + escapeHTML(clipUrl) + '</code>';
      return tg('editMessageText', env.BOT_TOKEN, {
        chat_id: cid,
        message_id: mid,
        text: text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '\u{1F4CB} \u590D\u5236\u94FE\u63A5', copy_text: { text: clipUrl } },
             { text: '\u{1F517} \u6253\u5F00', url: clipUrl }],
            [{ text: '\u23F1 \u4FEE\u6539\u6642\u6548', callback_data: 'mod_ttl_' + l.id }],
            [{ text: '\u{1F5D1} \u5220\u9664\u77ED\u94FE', callback_data: 'del_confirm_' + l.id }],
            [{ text: '\u2190 \u8FD4\u56DE\u5217\u8868', callback_data: 'my_links_0' }],
          ],
        },
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

  // ====== 格式选择页面的时效设置 ======

  if (d === 'conv_ttl_menu') {
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u23F1 <b>\u8BBE\u7F6E\u5F53\u524D\u8F6C\u6362\u7684\u6642\u6548</b>\n\n\u4EC5\u5F71\u54CD\u672C\u6B21\u8F6C\u6362\uFF0C\u4E0D\u4F1A\u6539\u53D8\u4E3B\u9875\u7684\u9ED8\u8BA4\u6642\u6548\u3002',
      parse_mode: 'HTML',
      reply_markup: ttlKb('conv_'),
    });
  }

  if (d.startsWith('conv_ttl_set:')) {
    const ttlVal = parseInt(d.split(':')[1]);
    u._convTtl = ttlVal;
    const isGost = u._isGost && (!u._lastProxies || u._lastProxies.length === 0);
    const formats = isGost ? FORMAT_OPTIONS.filter(f => GOST_FORMATS.includes(f.id)) : null;
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u2705 \u5DF2\u8BBE\u7F6E\u5F53\u524D\u6642\u6548: ' + (ttlVal === 0 ? '\u6C38\u4E0D\u8FC7\u671F' : ttlVal < 3600 ? Math.round(ttlVal / 60) + '\u5206\u949F' : Math.round(ttlVal / 3600) + '\u5C0F\u65F6'),
      parse_mode: 'HTML',
      reply_markup: fmtKb(formats, u._convTtl, u.ttl),
    });
  }

  // ====== 格式转换 ======

  if (d.startsWith('conv_fmt:')) {
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
          reply_markup: fmtKb(FORMAT_OPTIONS.filter(f => GOST_FORMATS.includes(f.id)), u._convTtl, u.ttl),
        });
      }
      const rawText = u._gostInput || u._lastSubInput || '';
      try {
        const { id, url: clipUrl } = await saveToClipAndTrack(rawText, getEffectiveTtl(u), env, uid, {
          preview: fmtLabel + ' \u00B7 ' + (u._gostCount || '?') + ' \u8282\u70B9 (Gost)',
          nodeCount: u._gostCount || 0,
          source: 'gost',
        });
        u._lastContent = rawText;
        const effTtl = getEffectiveTtl(u);
        u._convTtl = null;
        const ttlT = effTtl === 0 ? '\u6C38\u4E0D\u8FC7\u671F' : effTtl < 3600 ? Math.round(effTtl / 60) + '\u5206\u949F' : Math.round(effTtl / 3600) + '\u5C0F\u65F6';
        await tg('editMessageText', env.BOT_TOKEN, {
          chat_id: cid,
          message_id: mid,
          text:
            '\u2705 <b>\u8F6C\u6362\u5B8C\u6210</b>\n' +
            '\u{1F4CA} ' + (u._gostCount || '?') + ' Gost \u8282\u70B9 \u2192 <b>' + fmtLabel + '</b>\n\n' +
            '\u{1F517} <code>' + clipUrl + '</code>\n\n' +
            '\u23F1 ' + ttlT,
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

    let output;
    try {
      output = ProxyUtils.produce(u._lastProxies, fmt);
    } catch (e) {
      return tg('editMessageText', env.BOT_TOKEN, {
        chat_id: cid,
        message_id: mid,
        text: '\u274C \u8F6C\u6362\u5931\u8D25: ' + e.message,
        parse_mode: 'HTML',
        reply_markup: fmtKb(null, u._convTtl, u.ttl),
      });
    }

    if (!output) {
      return tg('editMessageText', env.BOT_TOKEN, {
        chat_id: cid,
        message_id: mid,
        text: '\u274C \u8F6C\u6362\u7ED3\u679C\u4E3A\u7A7A',
        parse_mode: 'HTML',
        reply_markup: fmtKb(null, u._convTtl, u.ttl),
      });
    }

    // 混合内容：追加 Gost 行到转换结果末尾
    if (u._isGost && u._gostInput && u._lastProxies?.length) {
      const sep = fmt === 'uri' ? '\n' : '\n\n# Gost Tunnel \u8282\u70B9\uFF08\u4EC5 Shadowrocket \u53EF\u7528\uFF09\n';
      output = String(output).trimEnd() + sep + u._gostInput;
    }

    await tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u{1F504} \u8F6C\u6362\u4E2D... (' + fmtLabel + ')',
      parse_mode: 'HTML',
    });

    try {
      const { id, url: clipUrl } = await saveToClipAndTrack(String(output), getEffectiveTtl(u), env, uid, {
        preview: fmtLabel + ' \u00B7 ' + u._lastProxies.length + ' \u8282\u70B9',
        nodeCount: u._lastProxies.length,
        source: 'convert',
      });
      u._lastContent = String(output);
      const effTtl2 = getEffectiveTtl(u);
      u._convTtl = null;
      const ttlT = effTtl2 === 0 ? '\u6C38\u4E0D\u8FC7\u671F' : effTtl2 < 3600 ? Math.round(effTtl2 / 60) + '\u5206\u949F' : Math.round(effTtl2 / 3600) + '\u5C0F\u65F6';
      await tg('editMessageText', env.BOT_TOKEN, {
        chat_id: cid,
        message_id: mid,
        text:
          '\u2705 <b>\u8F6C\u6362\u5B8C\u6210</b>\n' +
          '\u{1F4CA} ' + u._lastProxies.length + ' \u8282\u70B9 \u2192 <b>' + fmtLabel + '</b>\n\n' +
          '\u{1F517} <code>' + clipUrl + '</code>\n\n' +
          '\u23F1 ' + ttlT,
        parse_mode: 'HTML',
        reply_markup: resultKb(clipUrl),
      });
    } catch (e) {
      const preview = String(output).length > 300 ? String(output).slice(0, 300) + '...' : String(output);
      await tg('editMessageText', env.BOT_TOKEN, {
        chat_id: cid,
        message_id: mid,
        text: '\u{1F504} <b>' + fmtLabel + '</b>\n\n<code>' + escapeHTML(preview) + '</code>',
        parse_mode: 'HTML',
        reply_markup: mainKb(),
      });
    }
    return;
  }
}

  // ==================== Worker 入口 ====================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

    if (request.method === 'OPTIONS') return new Response('', { headers: cors });

    // API: 文本保存 (jtb-clip 兼容)
    if (path === '/save' && request.method === 'POST') {
      try {
        const body = await request.text();
        const id = await saveToClip(body, 86400, env);
        const clipUrl = (env.CLIP_URL || '') + '/share/' + id;
        return new Response(JSON.stringify({ success: true, id, url: clipUrl }), { headers: { 'Content-Type': 'application/json', ...cors } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...cors } });
      }
    }

    // API: 短链读取
    if (path.startsWith('/share/')) {
      const id = path.replace('/share/', '');
      const raw = await env.KV.get('share_' + id, { type: 'json' });
      if (!raw) return new Response('Not found', { status: 404 });
      return new Response(raw.text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    // Telegram Webhook
    if (path === '/webhook' && request.method === 'POST') {
      const body = await request.json();
      if (!body) return new Response('ok');

      if (env.WEBHOOK_SECRET && env.WEBHOOK_SECRET !== url.searchParams.get('secret')) {
        return new Response('unauthorized', { status: 401 });
      }

      ctx.waitUntil(
        (async () => {
          try {
            if (body.message) await onMsg(body.message, env);
            else if (body.callback_query) await onCb(body.callback_query, env);
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

    // Health
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