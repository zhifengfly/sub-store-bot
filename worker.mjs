/**
 * Sub-Store Bot — Telegram 剪贴板 + 订阅转换
 * 
 * 依赖:
 *   - proxy-utils.js (Sub-Store 引擎)
 *   - Cloudflare Workers KV — 短链存储
 *   - BOT_TOKEN — Telegram Bot Token
 * 
 * 部署格式: ES Module Worker
 * 需要 CF 兼容性的标志: nodejs_compat
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
        { text: '\u{1F3A8} 重命名', callback_data: 'rn_menu' },
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
  // 重命名状态
  const rnMode = u?._renameMode || 'off';
  const rnLabels = { off: '关', dedup: '去同名', creative: '创意' };
  const rnStatus = rnLabels[rnMode] || '关';
  rows.push([{ text: '\u23F1 \u6642\u6548: ' + ttlLabel, callback_data: 'conv_ttl_menu' }]);
  rows.push([{ text: '\u{1F3A8} \u91CD\u547D\u540D: ' + rnStatus, callback_data: 'conv_rn_menu' }]);
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
  const backCb = prefix && prefix.startsWith('chg_ttl_') ? 'link_' + prefix.slice(8, -1) : 'menu';
  rows.push([{ text: '\u2190 \u8FD4\u56DE', callback_data: backCb }]);
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
    stateMap.set(uid, { _uid: uid, _renameMode: 'off', _renamePool: 0, _renamePrefix: '', _renameSuffix: '', _regionCache: {} });
  }
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

// ==================== 重命名配置（KV 持久化） ====================

async function getRenameConfig(uid, env) {
  try {
    const raw = await env.KV.get('rn:' + uid, { type: 'json' });
    return raw || { mode: 'off', pool: 0, prefix: '', suffix: '' };
  } catch { return { mode: 'off', pool: 0, prefix: '', suffix: '' }; }
}

async function saveRenameConfig(uid, env, cfg) {
  await env.KV.put('rn:' + uid, JSON.stringify(cfg));
}

// ==================== 重命名 ====================

// 内置主题模版（type: 1=主轮换+兜底, 2=单数组）
const RENAME_POOLS = [
  { id: 'zodiac', label: '生肖', type: 1, primary: ['子鼠','丑牛','寅虎','卯兔','辰龙','巳蛇','午马','未羊','申猴','酉鸡','戌狗','亥猪'], fallback: ['乾','兑','离','震','巽','坎','艮','坤'] },
  { id: 'solar', label: '节气', type: 1, primary: ['立春','雨水','惊蛰','春分','清明','谷雨','立夏','小满','芒种','夏至','小暑','大暑','立秋','处暑','白露','秋分','寒露','霜降','立冬','小雪','大雪','冬至','小寒','大寒'], fallback: ['宰相','尚书','侍郎','郎中','员外郎','御史','太守','刺史','县令','主簿','司空','司徒','司马','太尉','中书令','门下侍中','尚书令','给事中','谏议大夫','大夫','卿','将军','校尉','都督'] },
  { id: 'chihuo', label: '吃货', type: 1, primary: ['凤凰趴窝','龙肝凤髓','红烧麒麟面','红梅珠香','宫保野兔','祥龙双飞','爆炒田鸡','芫爆仔鸽','金丝烧麦','佛手金卷','龙凤柔情','明珠豆腐','砂锅煨鹿筋','红烧猴头蘑','鸡丝银耳','桂花鱼条','八宝兔酱','玉笋蕨菜','罗汉大虾','花菇鸭掌','五彩牛柳','挂炉走油鸡','麻辣牛肉','红烧鲍鱼','清蒸鳜鱼','松鼠鳜鱼','翠玉豆糕','栗子糕','双色豆糕','如意卷','绣球乾贝','炒珍珠鸡','奶汁鱼片','干连福海参','花菇鲟龙鱼','龙舟镢鱼','滑溜贝球','酱焖鹌鹑','蟹肉双笋丝','砂锅鱼翅','红烧鸡棕菌','牡丹银耳汤','清汤燕窝','凤尾鱼翅','金蟾玉鲍','一品鲍鱼羹','龙井竹荪','玉掌献寿','鸡枞菌汤','草菇西兰花','杏仁豆腐','挂炉烤鸭','燕窝八珍汤','桂花糕','荷花酥','莲子糕','杏仁露','冰糖银耳','拔丝苹果','一品官燕','奶汤蒲菜','御膳八珍','红烧肘子','清蒸龙虾'], fallback: ['天命','天聪','崇德','顺治','康熙','雍正','乾隆','嘉庆','道光','咸丰','同治','光绪','宣统','努尔哈赤','皇太极','多尔衮','孝庄','康熙帝','雍正帝','乾隆帝','和珅','嘉庆帝','道光帝','咸丰帝','慈禧','同治帝','光绪帝','溥仪'] },
  { id: 'random', label: '随机', type: 3, primary: [] },
];

// ====== 主题模版 KV 持久化 ======
async function getThemes(uid, env) {
  try {
    const raw = await env.KV.get('rn_themes:' + uid, { type: 'json' });
    return raw || { themes: [] };
  } catch { return { themes: [] }; }
}

async function saveThemes(uid, env, themes) {
  await env.KV.put('rn_themes:' + uid, JSON.stringify(themes));
}

// 根据 poolIdx 返回当前使用的名字数组
// poolIdx < RENAME_POOLS.length 时为内置，否则为自定义
async function getPoolNames(poolIdx, uid, env) {
  if (poolIdx >= 0 && poolIdx < RENAME_POOLS.length) {
    const pool = RENAME_POOLS[poolIdx];
    if (pool.type === 2) return pool.primary || [];
    return (pool.primary || []).concat(pool.fallback || []);
  }
  // 自定义主题
  const t = await getThemes(uid, env);
  const theme = t.themes[poolIdx - RENAME_POOLS.length];
  if (!theme) return [];
  if (theme.type === 2) return theme.primary || [];
  return (theme.primary || []).concat(theme.fallback || []);
}

function applyRenameDedup(proxies, prefix, suffix) {
  const result = [];
  const nameCount = {};
  for (const p of proxies) {
    const base = p.name || '';
    nameCount[base] = (nameCount[base] || 0) + 1;
    const idx = nameCount[base];
    const newName = idx === 1 ? base : base + '_' + idx;
    result.push({ ...p, name: prefix + (newName || '') + suffix });
  }
  return result;
}

async function applyRenameCreative(proxies, poolIdx, prefix, suffix, uid, env, regionCache) {
  if (!proxies || proxies.length === 0) return proxies;

  // GeoIP 查询（唯一 host）
  const hosts = [...new Set(proxies.map(p => p.server).filter(Boolean))];
  const cache = regionCache || {};
  const newCache = { ...cache };
  const uncached = hosts.filter(h => !newCache[h]);
  for (const host of uncached) {
    try {
      const r = await fetch('http://ip-api.com/json/' + encodeURIComponent(host) + '?fields=countryCode,city&lang=zh-CN', { timeout: 3000 });
      const d = await r.json();
      if (d && d.countryCode) {
        newCache[host] = d.countryCode === 'CN' && d.city ? d.city : d.countryCode;
      } else {
        newCache[host] = 'XX';
      }
    } catch { newCache[host] = 'XX'; }
  }

  const groups = {};
  for (const p of proxies) {
    const label = newCache[p.server] || 'XX';
    if (!groups[label]) groups[label] = [];
    groups[label].push(p);
  }

  const pool = await getPoolNames(poolIdx, uid, env);
  if (pool.length === 0) return proxies;

  const result = [];
  let globalIdx = 0;
  for (const [label, group] of Object.entries(groups)) {
    for (const p of group) {
      const name = pool[globalIdx % pool.length];
      const cycle = Math.floor(globalIdx / pool.length);
      const finalName = cycle > 0 ? name + '_' + (cycle + 1) : name;
      result.push({ ...p, name: prefix + (label !== 'XX' ? label + '｜' : '') + finalName + suffix });
      globalIdx++;
    }
  }
  return result;
}

function renameKb(mode, poolIdx, prefix, suffix, uid, env) {
  const modeLabels = { off: '关闭', dedup: '去同名', creative: '创意' };
  const status = modeLabels[mode] || '关闭';
  let poolLabel = '-';
  if (mode === 'creative') {
    if (poolIdx >= 0 && poolIdx < RENAME_POOLS.length) {
      poolLabel = RENAME_POOLS[poolIdx].label;
    } else {
      // 自定义主题
      const idx = poolIdx - RENAME_POOLS.length;
      // 同步读取，简化显示（实际值从 KV 取，这里用索引显示）
      poolLabel = '自定义#' + (idx + 1);
    }
  }
  const pfx = prefix || '(无)';
  const sfx = suffix || '(无)';
  return {
    inline_keyboard: [
      [
        { text: mode === 'off' ? '✅ 关闭' : '⬜ 关闭', callback_data: 'rn_mode:off' },
        { text: mode === 'dedup' ? '✅ 去同名' : '⬜ 去同名', callback_data: 'rn_mode:dedup' },
        { text: mode === 'creative' ? '✅ 创意' : '⬜ 创意', callback_data: 'rn_mode:creative' },
      ],
      [
        { text: '🎨 主题: ' + poolLabel, callback_data: 'rn_pool_menu' },
        { text: '➕ 扩增主题', callback_data: 'rn_theme_type' },
      ],
      [
        { text: '🔤 前缀: ' + pfx, callback_data: 'rn_prefix' },
        { text: '🔤 后缀: ' + sfx, callback_data: 'rn_suffix' },
      ],
      [
        { text: '📋 当前: ' + status, callback_data: 'noop' },
      ],
      [
        { text: '\u2190 返回', callback_data: 'menu' },
      ],
    ],
  };
}

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
  const clipUrl = ((env.CLIP_URL || '').replace(/\/+$/, '')) + '/share/' + id;
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

  // 重命名前缀/后缀输入模式
  if (u.state === 'RN_PREFIX') {
    const val = (msg.text || '').trim();
    u._renamePrefix = val === '-' ? '' : val;
    u.state = null;
    saveRenameConfig(uid, env, { mode: u._renameMode || 'off', pool: u._renamePool || 0, prefix: u._renamePrefix, suffix: u._renameSuffix || '' }).catch(() => {});
    return replyOrEdit(u, cid, env, {
      text: '\u2705 \u524D\u7F00: ' + (u._renamePrefix || '\uFF08\u65E0\uFF09'),
      parse_mode: 'HTML',
      reply_markup: mainKb(),
    });
  }

  if (u.state === 'RN_SUFFIX') {
    const val = (msg.text || '').trim();
    u._renameSuffix = val === '-' ? '' : val;
    u.state = null;
    saveRenameConfig(uid, env, { mode: u._renameMode || 'off', pool: u._renamePool || 0, prefix: u._renamePrefix || '', suffix: u._renameSuffix }).catch(() => {});
    return replyOrEdit(u, cid, env, {
      text: '\u2705 \u540E\u7F00: ' + (u._renameSuffix || '\uFF08\u65E0\uFF09'),
      parse_mode: 'HTML',
      reply_markup: mainKb(),
    });
  }

  // 自定义主题输入
  if (u.state && u.state.startsWith('RN_THEME_')) {
    const fmt = u.state.split('_')[2];
    const val = (msg.text || '').trim();
    u.state = null;

    const lines = val.split(/\n+/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) {
      return replyOrEdit(u, cid, env, {
        text: '\u274C \u8F93\u5165\u4E0D\u5B8C\u6574\uff0c\u81F3\u5C11\u9700\u8981\u4E3B\u9898\u540D + \u8F6E\u6362\u5217\u8868\u4E24\u884C',
        parse_mode: 'HTML',
        reply_markup: mainKb(),
      });
    }

    const label = lines[0];
    const primary = lines[1].split(/[,\uff0c]/).map(s => s.trim()).filter(Boolean);
    let fallback = [];
    if (lines[2]) fallback = lines[2].split(/[,\uff0c]/).map(s => s.trim()).filter(Boolean);

    if (primary.length === 0) {
      return replyOrEdit(u, cid, env, {
        text: '\u274C \u8F6E\u6362\u5217\u8868\u4E3A\u7A7A\uff0c\u8BF7\u91CD\u53D1',
        parse_mode: 'HTML',
        reply_markup: mainKb(),
      });
    }

    const themes = await getThemes(uid, env);
    let type;
    if (fmt === '1') type = 1;
    else if (fmt === '2') type = 2;
    else if (fmt === '3') type = 3;
    else type = 1;

    themes.themes.push({ label, type, primary, fallback });
    await saveThemes(uid, env, themes);

    const preview = primary.slice(0, 5).join('\u3001') + (primary.length > 5 ? '\u2026' : '') +
      (fallback.length ? '\uff0b' + fallback.slice(0, 3).join('\u3001') : '');

    return replyOrEdit(u, cid, env, {
      text: '\u2705 \u4E3B\u9898\u5DF2\u6DFB\u52A0\uff1a' + label + '\n\n' + label + '\n' + primary.join('\uff0c') + (fallback.length ? '\n' + fallback.join('\uff0c') : ''),
      parse_mode: 'HTML',
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
      });
      const previewShow = subText.length > 150 ? subText.slice(0, 150) + '...' : subText;
      const ttlT = ttl === 0 ? '\u6C38\u4E0D\u8FC7\u671F' : ttl < 3600 ? Math.round(ttl / 60) + '\u5206\u949F' : Math.round(ttl / 3600) + '\u5C0F\u65F6';
      u._lastContent = subText;
      u._lastRawContent = subText;
      u._lastSubInput = subText;
      return replyOrEdit(u, cid, env, {
        text: '\u2705 <b>\u5DF2\u4FDD\u5B58</b>\n\n\u{1F517} <code>' + clipUrl + '</code>\n\n\u{1F4CB} \u9884\u89C8:\n<code>' + escapeHTML(previewShow) + '</code>\n\n\u23F1 ' + ttlT,
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

  // 从 KV 加载重命名配置
  const rc = await getRenameConfig(uid, env);
  u._renameMode = rc.mode || 'off';
  u._renamePool = rc.pool || 0;
  u._renamePrefix = rc.prefix || '';
  u._renameSuffix = rc.suffix || '';

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
  } else {
    const sent = await replyOrEdit(u, cid, env, {
      text: fmtText, parse_mode: 'HTML',
      reply_markup: fmtKb(null, u._convTtl, u.ttl, u),
    });
    if (!isRemote) {
      const msgId = sent?.result?.message_id || (sent?.from_edit ? u.promptMid : null);
      u._fmtMsg = msgId ? { cid: cid, id: msgId } : null;
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

  if (d === 'menu') {
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

  // ====== 重命名设置 ======

  if (d === 'rn_menu') {
    const rc = await getRenameConfig(uid, env);
    u._renameMode = rc.mode || 'off';
    u._renamePool = rc.pool || 0;
    u._renamePrefix = rc.prefix || '';
    u._renameSuffix = rc.suffix || '';
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u{1F3A8} <b>\u91CD\u547D\u540D\u8BBE\u7F6E</b>\n\n\u9009\u62E9\u91CD\u547D\u540D\u6A21\u5F0F\uFF0C\u4F1A\u5F71\u54CD\u540E\u7EED\u6240\u6709\u8F6C\u6362\u3002',
      parse_mode: 'HTML',
      reply_markup: renameKb(rc.mode || 'off', rc.pool || 0, rc.prefix || '', rc.suffix || '', uid, env),
    });
  }

  if (d === 'conv_rn_menu') {
    const rc = await getRenameConfig(uid, env);
    u._renameMode = rc.mode || 'off';
    u._renamePool = rc.pool || 0;
    u._renamePrefix = rc.prefix || '';
    u._renameSuffix = rc.suffix || '';
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: '\u{1F3A8} <b>\u8F6C\u6362\u91CD\u547D\u540D</b>\n\n\u5F53\u524D\u914D\u7F6E\u4F1A\u5E94\u7528\u4E8E\u672C\u6B21\u8F6C\u6362\u3002',
      parse_mode: 'HTML',
      reply_markup: renameKb(rc.mode || 'off', rc.pool || 0, rc.prefix || '', rc.suffix || '', uid, env),
    });
  }

  if (d === 'conv_rn_menu') {
    const mode = u._renameMode || 'off';
    const poolIdx = u._renamePool || 0;
    const pfx = u._renamePrefix || '';
    const sfx = u._renameSuffix || '';
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid,
      message_id: mid,
      text: '\u{1F3A8} <b>\u8F6C\u6362\u91CD\u547D\u540D</b>\n\n\u5F53\u524D\u914D\u7F6E\u4F1A\u5E94\u7528\u4E8E\u672C\u6B21\u8F6C\u6362\u3002',
      parse_mode: 'HTML',
      reply_markup: renameKb(mode, poolIdx, pfx, sfx, uid, env),
    });
  }

  if (d.startsWith('rn_mode:')) {
    u._renameMode = d.split(':')[1];
    saveRenameConfig(uid, env, { mode: u._renameMode, pool: u._renamePool || 0, prefix: u._renamePrefix || '', suffix: u._renameSuffix || '' }).catch(() => {});
    const mode = u._renameMode;
    const poolIdx = u._renamePool || 0;
    const pfx = u._renamePrefix || '';
    const sfx = u._renameSuffix || '';
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: '\u2705 \u5DF2\u8BBE\u7F6E: ' + (mode === 'off' ? '\u5173\u95ED' : mode === 'dedup' ? '\u53BB\u540C\u540D' : '\u521B\u610F\u547D\u540D'),
      parse_mode: 'HTML',
      reply_markup: renameKb(mode, poolIdx, pfx, sfx, uid, env),
    });
  }

  if (d === 'rn_pool_menu') {
    const rows = [];
    let row = [];
    for (let i = 0; i < RENAME_POOLS.length; i++) {
      const selected = (u._renamePool || 0) === i ? '\u2705 ' : '';
      row.push({ text: selected + RENAME_POOLS[i].label, callback_data: 'rn_pool:' + i });
      if (row.length === 2) { rows.push(row); row = []; }
    }
    if (row.length) rows.push(row);

    const themes = await getThemes(uid, env);
    for (let i = 0; i < themes.themes.length; i++) {
      const idx = RENAME_POOLS.length + i;
      const selected = (u._renamePool || 0) === idx ? '\u2705 ' : '';
      row.push({ text: selected + themes.themes[i].label + ' \u{1F5D1}', callback_data: 'rn_pool:' + idx });
      if (row.length === 2) { rows.push(row); row = []; }
    }
    if (row.length) rows.push(row);

    rows.push([{ text: '\u{1F5D1} 管理主题', callback_data: 'rn_themes' }]);
    rows.push([{ text: '\u{2190} \u8FD4\u56DE', callback_data: 'rn_menu' }]);
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: '\u{1F4E6} <b>\u9009\u62E9\u547D\u540D\u4E3B\u9898</b>\n\n\u70B9\u51FB\u4E3B\u9898\u9009\u62E9\uff0c\u81EA\u5B9A\u4E49\u4E3B\u9898\u53EF\u5220\u9664\u3002',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows },
    });
  }

  if (d.startsWith('rn_pool:')) {
    u._renamePool = parseInt(d.split(':')[1]);
    saveRenameConfig(uid, env, { mode: u._renameMode || 'off', pool: u._renamePool, prefix: u._renamePrefix || '', suffix: u._renameSuffix || '' }).catch(() => {});
    const mode = u._renameMode || 'off';
    const poolIdx = u._renamePool || 0;
    const pfx = u._renamePrefix || '';
    const sfx = u._renameSuffix || '';
    let label = '未知';
    if (poolIdx >= 0 && poolIdx < RENAME_POOLS.length) label = RENAME_POOLS[poolIdx].label;
    else { const t = await getThemes(uid, env); const th = t.themes[poolIdx - RENAME_POOLS.length]; if (th) label = th.label; }
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: '\u2705 \u5DF2\u9009\u62E9: ' + label,
      parse_mode: 'HTML',
      reply_markup: renameKb(mode, poolIdx, pfx, sfx, uid, env),
    });
  }

  // ====== 主题管理页 ======
  if (d === 'rn_themes') {
    const themes = await getThemes(uid, env);
    const rows = [];
    if (themes.themes.length === 0) {
      rows.push([{ text: '\u{1F4ED} \u6682\u65E0\u81EA\u5B9A\u4E49\u4E3B\u9898', callback_data: 'noop' }]);
    } else {
      let row = [];
      for (let i = 0; i < themes.themes.length; i++) {
        row.push({ text: '\u{1F5D1} ' + themes.themes[i].label, callback_data: 'rn_theme_del:' + i });
        if (row.length === 2) { rows.push(row); row = []; }
      }
      if (row.length) rows.push(row);
    }
    rows.push([{ text: '\u{2190} \u8FD4\u56DE', callback_data: 'rn_pool_menu' }]);
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: '\u{1F5D1} <b>\u4E3B\u9898\u7BA1\u7406</b>\n\n\u70B9\u51FB\u5220\u9664\u81EA\u5B9A\u4E49\u4E3B\u9898\u3002',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows },
    });
  }

  if (d.startsWith('rn_theme_del:')) {
    const idx = parseInt(d.split(':')[1]);
    const themes = await getThemes(uid, env);
    if (idx >= 0 && idx < themes.themes.length) {
      themes.themes.splice(idx, 1);
      await saveThemes(uid, env, themes);
    }
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: '\u2705 \u5DF2\u5220\u9664',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '\u{2190} \u8FD4\u56DE', callback_data: 'rn_themes' }]] },
    });
  }

  // ====== 扩增主题：选择格式 ======
  if (d === 'rn_theme_type') {
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: '\u{1F3A8} <b>\u6269\u589E\u4E3B\u9898\u6A21\u5F0F</b>\n\n\u8BF7\u9009\u62E9\u4E3B\u9898\u683C\u5F0F\uff1a\n\n\u2460 \u4E3B\u8F6E\u6362+\u5151\u5E95\uff08\u5982\uFF1A\u751F\u8096+\u516B\u5366\uff09\n\u2461 \u5355\u6570\u7EC4\uff08\u5982\uFF1A\u8282\u6C14\u3001\u5403\u8D27\u5217\u8868\uff09\n\u2462 \u968F\u673A\uff08\u6309\u5730\u533A\u667A\u80FD\u5206\u914D\uff09',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '\u2460 \u4E3B+\u5151\u5E95', callback_data: 'rn_theme_fmt:1' }],
        [{ text: '\u2461 \u5355\u6570\u7EC4', callback_data: 'rn_theme_fmt:2' }],
        [{ text: '\u2462 \u968F\u673A\u540D\u79F0', callback_data: 'rn_theme_fmt:3' }],
        [{ text: '\u{2190} \u8FD4\u56DE', callback_data: 'rn_menu' }],
      ] },
    });
  }

  if (d.startsWith('rn_theme_fmt:')) {
    const fmt = d.split(':')[1];
    u.state = 'RN_THEME_' + fmt;
    u.promptCid = cid;
    u.promptMid = mid;
    const templates = {
      '1': '\u8BF7\u53D1\u9001\u4E09\u884C\uff08\u4E00\u884C\u4E00\u4E2A\u53C2\u6570\uff09\uff1a\n\n\u4E3B\u9898\u540D\n\u8F6E\u6362\u8BCD1\uff0c\u8F6E\u6362\u8BCD2\uff0c\u8F6E\u6362\u8BCD3\n\u5151\u5E95\u8BCD1\uff0c\u5151\u5E95\u8BCD2',
      '2': '\u8BF7\u53D1\u9001\u4E24\u884C\uff08\u4E00\u884C\u4E00\u4E2A\u53C2\u6570\uff09\uff1a\n\n\u4E3B\u9898\u540D\n\u8F6E\u6362\u8BCD1\uff0c\u8F6E\u6362\u8BCD2\uff0c\u8F6E\u6362\u8BCD3',
      '3': '\u8BF7\u53D1\u9001\u4E24\u884C\uff1a\n\n\u4E3B\u9898\u540D\n\u968F\u673A\u8BCD1\uff0c\u968F\u673A\u8BCD2\uff0c\u968F\u673A\u8BCD3',
    };
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: templates[fmt] || '\u{1F4A4}',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '\u{2190} \u53D6\u6D88', callback_data: 'rn_menu' }]] },
    });
  }

  if (d === 'rn_prefix') {
    u.state = 'RN_PREFIX';
    u.promptCid = cid;
    u.promptMid = mid;
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: '\u{1F524} \u8BF7\u53D1\u9001\u524D\u7F00\uFF08\u53D1\u9001 \u201C-\u201D \u6E05\u7A7A\uFF09',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '\u2190 \u53D6\u6D88', callback_data: 'rn_menu' }]] },
    });
  }

  if (d === 'rn_suffix') {
    u.state = 'RN_SUFFIX';
    u.promptCid = cid;
    u.promptMid = mid;
    return tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: '\u{1F524} \u8BF7\u53D1\u9001\u540E\u7F00\uFF08\u53D1\u9001 \u201C-\u201D \u6E05\u7A7A\uFF09',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '\u2190 \u53D6\u6D88', callback_data: 'rn_menu' }]] },
    });
  }

  // ====== 格式选择页面处理前缀/后缀输入 ======
  if (d.startsWith('conv_rn_prefix_') || d.startsWith('conv_rn_suffix_')) {
    // 格式选择页面待实现
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
    const clipUrl = ((env.CLIP_URL || '').replace(/\/+$/, '')) + '/share/' + l.id;
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
      reply_markup: ttlKb(0, 'chg_ttl_' + linkId + ':'),
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
      await env.KV.put('ulinks:' + uid, JSON.stringify(links));
    }
    const l = links.find(x => x.id === linkId);
    if (l) {
      const clipUrl = ((env.CLIP_URL || '').replace(/\/+$/, '')) + '/share/' + l.id;
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
      reply_markup: ttlKb(u.ttl || 0, 'conv_ttl_set:'),
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
      reply_markup: fmtKb(formats, u._convTtl, u.ttl, u),
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
          reply_markup: fmtKb(FORMAT_OPTIONS.filter(f => GOST_FORMATS.includes(f.id)), u._convTtl, u.ttl, u),
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

    // 非 gost 格式的标准节点转换
    // 从 KV 加载重命名配置
    const rc2 = await getRenameConfig(uid, env);
    u._renameMode = rc2.mode || 'off';
    u._renamePool = rc2.pool || 0;
    u._renamePrefix = rc2.prefix || '';
    u._renameSuffix = rc2.suffix || '';
    let proxiesForConvert = u._lastProxies;
    const rnMode = u._renameMode || 'off';
    if (rnMode !== 'off') {
      const pfx = u._renamePrefix || '';
      const sfx = u._renameSuffix || '';
      if (rnMode === 'dedup') {
        proxiesForConvert = applyRenameDedup(u._lastProxies, pfx, sfx);
      } else if (rnMode === 'creative') {
        proxiesForConvert = await applyRenameCreative(u._lastProxies, u._renamePool || 0, pfx, sfx, uid, env, u._regionCache || {});
      }
    }
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

    await tg('editMessageText', env.BOT_TOKEN, {
      chat_id: cid, message_id: mid,
      text: '\u{1F504} \u8F6C\u6362\u4E2D... (' + fmtLabel + ')', parse_mode: 'HTML',
    });

    try {
      const extraUrls = [];
      const { id, url: clipUrl } = await saveToClipAndTrack(String(output), getEffectiveTtl(u), env, uid, {
        preview: fmtLabel + ' \u00B7 ' + u._lastProxies.length + ' \u8282\u70B9',
        nodeCount: u._lastProxies.length, source: 'convert',
      });
      u._lastContent = String(output);

      // WG 侧链
      const wg = u._wgProxies || [];
      if (wg.length > 0) {
        const wgOut = ProxyUtils.produce(wg, 'clashmeta');
        if (wgOut) {
          const { url: wgUrl } = await saveToClipAndTrack(String(wgOut), getEffectiveTtl(u), env, uid, {
            preview: 'WireGuard \u00D7 ' + wg.length + ' (Clash Meta)', nodeCount: wg.length, source: 'wg',
          });
          extraUrls.push({ text: '\u26A1 WireGuard', url: wgUrl });
        }
      }

      // Gost 侧链
      if (u._gostInput) {
        const { url: gostUrl } = await saveToClipAndTrack(u._gostInput, getEffectiveTtl(u), env, uid, {
          preview: 'Gost Tunnel \u00D7 ' + u._gostCount, nodeCount: u._gostCount, source: 'gost',
        });
        extraUrls.push({ text: '\u{1F504} Gost', url: gostUrl });
      }

      const effTtl2 = getEffectiveTtl(u);
      u._convTtl = null;
      const ttlT = effTtl2 === 0 ? '\u6C38\u4E0D\u8FC7\u671F' : effTtl2 < 3600 ? Math.round(effTtl2 / 60) + '\u5206\u949F' : Math.round(effTtl2 / 3600) + '\u5C0F\u65F6';
      let resText = '\u2705 <b>\u8F6C\u6362\u5B8C\u6210</b>\n\n\u{1F4CA} ' + u._lastProxies.length + ' \u8282\u70B9 \u2192 <b>' + fmtLabel + '</b>\n\n\u{1F517} <code>' + clipUrl + '</code>\n';
      for (const e of extraUrls) resText += '\n' + e.text + '\n<code>' + e.url + '</code>\n';
      resText += '\n\n\u23F1 ' + ttlT;
      await tg('editMessageText', env.BOT_TOKEN, {
        chat_id: cid, message_id: mid,
        text: resText, parse_mode: 'HTML',
        reply_markup: multiResultKb(clipUrl, extraUrls),
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

      // 验证 X-Telegram-Bot-Api-Secret-Token
      if (env.WEBHOOK_SECRET && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
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

    // 根路由：自动激活 webhook + 注册命令（参考 glados-discourse-bot）
    if (url.pathname === '/' || url.pathname === '/setup') {
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
