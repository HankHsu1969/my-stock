import * as api from './lib/api.js';
import * as pf from './lib/portfolio.js';
import * as store from './lib/store.js';

const DEFAULT_SETTINGS = { theme: 'system', refreshSec: 10, colorMode: 'tw', includeCost: false, feeDiscount: 1, minFee: 20 };
const SEED = [
  { code: '2330', name: '台積電', market: 'tse' },
  { code: '2454', name: '聯發科', market: 'tse' },
  { code: '0050', name: '元大台灣50', market: 'tse' },
];
const INDEX_TTL = 3 * 86400e3; // 股票清單每 3 天更新
const INDEX_RETRY = 3600e3; // 清單抓不完整時，1 小時後再試
const CHART_TTL = 60e3; // 走勢圖每分鐘更新
const IDLE_REFRESH = 5 * 60e3; // 非交易時段每 5 分鐘更新一次報價
const DEFAULT_GROUPS = 7;
const MAX_GROUPS = 12;
const MASK = '＊＊＊';
const MARKET_LABEL = { tse: '上市', otc: '上櫃' };

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

const params = new URLSearchParams(location.search);
const isTab = params.get('view') === 'tab';

const state = {
  groups: [], // [{ id, name, items: [{ code, name, alias, market, lots, cost }] }]
  active: null, // 目前分組的 id
  settings: { ...DEFAULT_SETTINGS },
  privacy: false,
  quotes: new Map(),
  charts: new Map(),
  flashes: new Map(),
  index: [], // [{ c, n, m }]
  indexLoading: false,
  lastFetch: 0,
  lastChart: 0,
  error: null,
  busy: false,
  timer: null,
  toastTimer: null,
  dragCode: null,
  pendingRender: false,
  highlight: null,
  editing: null,
  editingGroup: null,
  lastTabs: '',
  suggest: [],
  suggestIdx: 0,
};

const newId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const cur = () => state.groups.find((g) => g.id === state.active) ?? state.groups[0];
const items = () => cur().items;
const find = (code) => items().find((it) => it.code === code);
const displayName = (it) => it.alias || it.name || '';
const money = (s) => (state.privacy ? MASK : s);
const saveList = () => store.save({ groups: state.groups });
const selfUrl = (query) => new URL(`popup.html?${query}`, location.href).href;

function openUrl(url) {
  if (globalThis.chrome?.tabs?.create) chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener');
}

// ---------------------------------------------------------------- 啟動

async function init() {
  document.body.classList.toggle('tab-mode', isTab);
  const saved = await store.load(['groups', 'activeGroup', 'watchlist', 'settings', 'privacy', 'stockIndex']);
  if (Array.isArray(saved.groups) && saved.groups.length) {
    state.groups = saved.groups;
  } else {
    // 1.0 版只有一份清單（watchlist），搬到第 1 組；全新安裝則放幾檔範例
    const first = Array.isArray(saved.watchlist) ? saved.watchlist : SEED.map((s) => ({ ...s, alias: '', lots: 0, cost: 0 }));
    state.groups = Array.from({ length: DEFAULT_GROUPS }, (_, i) => ({ id: newId(), name: String(i + 1), items: i ? [] : first }));
    saveList();
  }
  state.active = state.groups.some((g) => g.id === saved.activeGroup) ? saved.activeGroup : state.groups[0].id;
  const { cash: legacyCash, ...settings } = saved.settings || {};
  state.settings = { ...DEFAULT_SETTINGS, ...settings };
  if (legacyCash > 0) {
    // 1.0 版的現金是全域設定，改成各分組自己的現金部位，搬到第 1 組
    state.groups[0].cash = legacyCash;
    store.save({ groups: state.groups, settings: state.settings });
  }
  state.privacy = !!saved.privacy;
  state.index = saved.stockIndex?.list || [];

  applySettings();
  bindEvents();
  render();

  await refreshQuotes();
  refreshCharts(true);
  if (!saved.stockIndex || Date.now() > saved.stockIndex.expires) loadIndex();
  schedule();
  if (params.has('import')) openImport();

  store.onChange((changes) => {
    const next = changes.groups?.newValue;
    if (!next?.length || JSON.stringify(next) === JSON.stringify(state.groups)) return;
    state.groups = next;
    if (!next.some((g) => g.id === state.active)) state.active = next[0].id;
    render();
    refreshQuotes();
    refreshCharts();
  });
}

function applySettings() {
  const { theme } = state.settings;
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem('theme', theme); // 給 theme.js 下次開啟時提早套用
  } catch {
    // 只影響開啟瞬間，不影響功能
  }
  document.body.classList.toggle('green-up', state.settings.colorMode === 'us');
  document.body.classList.toggle('privacy', state.privacy);
}

function schedule() {
  clearInterval(state.timer);
  state.timer = setInterval(tick, state.settings.refreshSec * 1000);
}

function tick() {
  if (document.hidden) return;
  const phase = api.marketPhase();
  if (phase !== 'closed' || Date.now() - state.lastFetch >= IDLE_REFRESH) refreshQuotes();
  if (phase !== 'closed' && Date.now() - state.lastChart >= CHART_TTL) refreshCharts();
}

// ---------------------------------------------------------------- 資料

// 只抓目前分組的報價；切換分組時再抓新分組的
async function refreshQuotes() {
  if (!items().length) {
    render();
    return;
  }
  setBusy(true);
  try {
    const quotes = await api.fetchQuotes(items());
    for (const [code, q] of quotes) {
      const old = state.quotes.get(code);
      // 這一輪剛好沒抓到成交價時，沿用上一筆，避免價格跳回昨收
      if (!q.traded && old?.traded && old.date === q.date) {
        Object.assign(q, { price: old.price, change: old.change, changePct: old.changePct, traded: true });
      }
      if (old && old.price !== q.price) state.flashes.set(code, q.price > old.price ? 'up' : 'down');
      state.quotes.set(code, q);
    }
    // 名稱、市場以報價為準，同一檔在其他分組也一起更新
    let dirty = false;
    for (const item of state.groups.flatMap((g) => g.items)) {
      const q = quotes.get(item.code);
      if (q && (item.market !== q.market || item.name !== q.name)) {
        item.market = q.market;
        item.name = q.name;
        dirty = true;
      }
    }
    if (dirty) saveList();
    state.error = null;
  } catch (err) {
    state.error = `報價更新失敗：${err.message}`;
  } finally {
    state.lastFetch = Date.now();
    setBusy(false);
    render();
  }
}

async function refreshCharts(force = false) {
  state.lastChart = Date.now();
  const due = items().filter((it) => {
    const c = state.charts.get(it.code);
    return force || !c || Date.now() - c.fetchedAt >= CHART_TTL;
  });
  if (!due.length) return;
  const charts = await api.fetchIntraday(due);
  for (const [code, chart] of charts) state.charts.set(code, chart);
  render();
}

async function loadIndex() {
  if (state.indexLoading) return;
  state.indexLoading = true;
  try {
    const { list, complete } = await api.fetchStockList();
    state.index = list;
    store.save({ stockIndex: { list, expires: Date.now() + (complete ? INDEX_TTL : INDEX_RETRY) } });
    return true;
  } catch {
    return false;
  } finally {
    state.indexLoading = false;
    if ($('#search').value.trim()) updateSuggest();
  }
}

function setBusy(on) {
  state.busy = on;
  $('#btnRefresh').classList.toggle('busy', on);
}

// ---------------------------------------------------------------- 畫面

function render() {
  if (state.dragCode) {
    state.pendingRender = true;
    return;
  }
  const rows = items().map((item) => {
    const quote = state.quotes.get(item.code);
    return { item, quote, calc: pf.evaluate(item, quote, state.settings) };
  });
  renderTabs();
  renderSummary(pf.summarize(rows.map((r) => r.calc)));
  $('#rows').innerHTML = rows.map(rowHTML).join('');
  $('#empty').hidden = rows.length > 0;
  renderStatus();
  state.flashes.clear();

  if (state.highlight) {
    const tr = document.querySelector(`tr[data-code="${state.highlight}"]`);
    tr?.scrollIntoView({ block: 'nearest' });
    state.highlight = null;
  }
}

// 只在分組有變動時重畫分頁列，避免每次報價更新打斷雙擊改名
function renderTabs() {
  const html =
    state.groups
      .map(
        (g) =>
          `<button type="button" class="tab ${g.id === state.active ? 'active' : ''}" data-group="${g.id}" title="${esc(g.name)}・${g.items.length} 檔（雙擊可改名）">${esc(g.name)}</button>`,
      )
      .join('') +
    (state.groups.length < MAX_GROUPS ? '<button type="button" class="tab-add" data-group-add title="新增分組">＋</button>' : '');
  if (html === state.lastTabs) return;
  state.lastTabs = html;
  $('#groupTabs').innerHTML = html;
}

function setMoney(el, value, { signed = false, colored = false } = {}) {
  el.textContent = value == null ? '—' : money(signed ? pf.fmtSigned(value) : pf.fmtInt(value));
  el.className = `money ${colored && value != null ? pf.trend(Math.round(value)) : ''}`;
}

function renderSummary(t) {
  const box = $('#summary');
  box.classList.toggle('no-hold', t.held === 0);
  if (t.held === 0) return;

  const cash = Number(cur().cash) || 0;
  const priced = t.priced > 0;
  setMoney($('#sumAsset'), priced ? t.mv + cash : null);
  $('#sumAssetSub').textContent = !priced
    ? '報價載入中…'
    : cash > 0
      ? `股票 ${money(pf.fmtInt(t.mv))}＋現金 ${money(pf.fmtInt(cash))}`
      : '股票市值';
  setMoney($('#sumCost'), t.costAll);
  $('#sumCount').textContent = t.priced < t.held ? `${t.held} 檔（${t.held - t.priced} 檔報價載入中）` : `共 ${t.held} 檔持股`;
  setMoney($('#sumPnl'), priced ? t.pnl : null, { signed: true, colored: true });
  $('#sumPnlPct').textContent = state.settings.includeCost ? `${pf.fmtPct(t.pnlPct)}・已扣費稅` : `報酬率 ${pf.fmtPct(t.pnlPct)}`;
  $('#sumPnlPct').className = pf.trend(t.pnl);
  setMoney($('#sumDay'), priced ? t.day : null, { signed: true, colored: true });
  $('#sumDayPct').textContent = pf.fmtPct(t.dayPct);
  $('#sumDayPct').className = pf.trend(t.day);
}

function rowHTML({ item, quote: q, calc }) {
  const code = esc(item.code);
  const dir = q?.traded ? pf.trend(q.change) : 'flat';
  const limit =
    q?.traded && q.limitUp != null && q.price >= q.limitUp
      ? 'limit-up'
      : q?.traded && q.limitDown != null && q.price <= q.limitDown
        ? 'limit-down'
        : '';
  const flash = state.flashes.has(item.code) ? `flash-${state.flashes.get(item.code)}` : '';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '';
  const hl = (v) => (q && v != null && q.prevClose != null ? pf.trend(v - q.prevClose) : '');
  const pnlDir = calc.pnl == null ? '' : pf.trend(Math.round(calc.pnl));
  const dayDir = calc.dayPnl == null ? '' : pf.trend(Math.round(calc.dayPnl));

  const hold = calc.held
    ? `<b>${money(pf.fmtLots(item.lots))}</b> 張<br><span class="muted">均 ${money(pf.fmtPrice(Number(item.cost) || 0))}</span>`
    : '<span class="add-hold">＋持股</span>';
  const pnl = calc.held
    ? `<span class="${pnlDir}">${money(pf.fmtSigned(calc.pnl))}<br>${pf.fmtPct(calc.pnlPct)}</span>`
    : '<span class="muted">—</span>';

  return `<tr data-code="${code}" class="${state.highlight === item.code ? 'highlight' : ''}">
    <td class="handle" title="拖曳排序">⋮⋮</td>
    <td class="stock" title="${esc(q?.fullName || displayName(item))}｜點擊開啟 Yahoo 股市">
      <a class="code" href="${api.yahooUrl(item.code, item.market)}" target="_blank" rel="noopener">${code}</a>
      <div class="name">${esc(displayName(item)) || '&nbsp;'}</div>
    </td>
    <td class="num price ${dir} ${limit} ${flash}"><span>${q ? pf.fmtPrice(q.price) : '…'}</span></td>
    <td class="num chg ${dir}">${q?.traded ? `${arrow} ${pf.fmtPrice(Math.abs(q.change))}<br>${pf.fmtPct(Math.abs(q.changePct), false)}` : '—'}</td>
    <td class="num hl"><span class="${hl(q?.high)}">${pf.fmtPrice(q?.high)}</span><span class="${hl(q?.low)}">${pf.fmtPrice(q?.low)}</span></td>
    <td class="spark">${sparkline(item.code, state.charts.get(item.code), q)}</td>
    <td class="num wide">${q?.volume != null ? pf.fmtInt(q.volume) : '—'}</td>
    <td class="num hold" data-act="edit" title="編輯持股">${hold}</td>
    <td class="num wide">${calc.mv != null ? money(pf.fmtInt(calc.mv)) : '—'}</td>
    <td class="num wide daypnl ${dayDir}">${calc.dayPnl != null ? money(pf.fmtSigned(calc.dayPnl)) : '—'}</td>
    <td class="num pnl" data-act="edit" title="編輯持股">${pnl}</td>
    <td class="num wide muted">${esc(q?.time || '—')}</td>
    <td class="act"><button data-act="edit" title="編輯">✎</button><button data-act="del" title="移除">✕</button></td>
  </tr>`;
}

function sparkline(code, chart, quote) {
  const W = 96;
  const H = 32;
  const P = 3;
  if (!chart?.points.length) {
    return `<svg viewBox="0 0 ${W} ${H}"><line class="base" x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}"/></svg>`;
  }
  let pts = chart.points;
  // 報價比走勢資料新時，把最新成交價接在最後
  const qt = quote?.traded ? api.quoteEpoch(quote) : null;
  if (qt && qt > pts.at(-1)[0] && qt >= chart.start && qt <= chart.end + 600) {
    pts = [...pts, [Math.min(qt, chart.end), quote.price]];
  }
  const base = chart.base ?? pts[0][1];
  let lo = Math.min(base, ...pts.map((p) => p[1]));
  let hi = Math.max(base, ...pts.map((p) => p[1]));
  const minSpan = base * 0.004; // 波動很小時不要放大成劇烈起伏
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  const x = (t) => Math.max(0, Math.min(W, ((t - chart.start) / (chart.end - chart.start)) * W));
  const y = (v) => P + (1 - (v - lo) / (hi - lo)) * (H - 2 * P);
  const by = y(base).toFixed(1);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const lastX = x(pts.at(-1)[0]).toFixed(1);
  const lastY = y(pts.at(-1)[1]).toFixed(1);
  const area = `${line}L${lastX},${by}L${x(pts[0][0]).toFixed(1)},${by}Z`;
  const id = `sp-${code}`;
  const dot = pf.trend(pts.at(-1)[1] - base);
  return `<svg viewBox="0 0 ${W} ${H}">
    <defs>
      <clipPath id="${id}-u"><rect x="0" y="-2" width="${W}" height="${+by + 2}"/></clipPath>
      <clipPath id="${id}-d"><rect x="0" y="${by}" width="${W}" height="${H - by + 2}"/></clipPath>
    </defs>
    <line class="base" x1="0" x2="${W}" y1="${by}" y2="${by}"/>
    <g class="sp-up" clip-path="url(#${id}-u)"><path class="fill" d="${area}"/><path class="stroke" d="${line}"/></g>
    <g class="sp-down" clip-path="url(#${id}-d)"><path class="fill" d="${area}"/><path class="stroke" d="${line}"/></g>
    <circle class="dot-${dot}" cx="${lastX}" cy="${lastY}" r="2"/>
  </svg>`;
}

function renderStatus() {
  const el = $('#status');
  if (state.error) {
    el.className = 'status error';
    el.innerHTML = `<i class="dot"></i>${esc(state.error)}`;
    return;
  }
  let latest = null;
  for (const q of state.quotes.values()) {
    if (!latest || `${q.date}${q.time}` > `${latest.date}${latest.time}`) latest = q;
  }
  if (!latest) {
    el.className = 'status';
    el.innerHTML = `<i class="dot"></i>${items().length ? '報價載入中…' : '尚未加入自選股'}`;
    return;
  }
  const phase = api.marketPhase();
  const today = api.taipeiClock().ymd;
  const holiday = phase !== 'closed' && latest.date !== today;
  const label = holiday ? '今日休市' : { open: '盤中', pre: '盤前試撮', closed: '已收盤' }[phase];
  const day = latest.date !== today ? `${+latest.date.slice(4, 6)}/${+latest.date.slice(6)} ` : '';
  el.className = `status ${phase === 'open' && !holiday ? 'live' : ''}`;
  el.innerHTML = `<i class="dot"></i>${label}・資料時間 ${esc(day + latest.time)}・每 ${state.settings.refreshSec} 秒更新`;
}

function toast(msg, actionLabel, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
  el.hidden = false;
  if (action) {
    el.querySelector('button').onclick = () => {
      el.hidden = true;
      action();
    };
  }
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => (el.hidden = true), 5000);
}

// ---------------------------------------------------------------- 清單操作

async function addStock(rawCode, name, market) {
  const code = rawCode.trim().toUpperCase();
  const group = cur(); // 查代號期間切換分組，仍加到原本的分組
  if (group.items.some((it) => it.code === code)) {
    state.highlight = code;
    render();
    toast(`${code} 已經在「${group.name}」中`);
    return;
  }
  if (!name) {
    if (!api.CODE_RE.test(code)) {
      toast('請輸入正確的股票代號');
      return;
    }
    setBusy(true);
    try {
      const q = (await api.fetchQuotes([{ code }])).get(code);
      if (!q) {
        toast(`找不到代號 ${code}`);
        return;
      }
      state.quotes.set(code, q);
      name = q.name;
      market = q.market;
    } catch (err) {
      toast(`查詢失敗：${err.message}`);
      return;
    } finally {
      setBusy(false);
    }
  }
  if (group.items.some((it) => it.code === code)) return;
  group.items.push({ code, name, alias: '', market, lots: 0, cost: 0 });
  state.highlight = code;
  saveList();
  render();
  refreshQuotes();
  refreshCharts();
}

function removeItem(code) {
  const group = cur();
  const idx = group.items.findIndex((it) => it.code === code);
  if (idx < 0) return;
  const [item] = group.items.splice(idx, 1);
  saveList();
  render();
  toast(`已移除 ${item.code} ${displayName(item)}`, '復原', () => {
    if (!state.groups.includes(group) || group.items.some((it) => it.code === item.code)) return;
    group.items.splice(Math.min(idx, group.items.length), 0, item);
    saveList();
    render();
  });
}

function moveItem(code, targetId) {
  const from = cur();
  const to = state.groups.find((g) => g.id === targetId);
  const idx = from.items.findIndex((it) => it.code === code);
  if (!to || to === from || idx < 0) return;
  if (to.items.some((it) => it.code === code)) {
    toast(`「${to.name}」已經有 ${code}`);
    return;
  }
  const [item] = from.items.splice(idx, 1);
  to.items.push(item);
  saveList();
  render();
  toast(`已把 ${code} ${displayName(item)} 移到「${to.name}」`);
}

// ---------------------------------------------------------------- 分組

function switchGroup(id) {
  if (id === state.active || !state.groups.some((g) => g.id === id)) return;
  state.active = id;
  store.save({ activeGroup: id });
  render();
  refreshQuotes();
  refreshCharts();
}

function nextGroupName() {
  const names = new Set(state.groups.map((g) => g.name));
  let n = state.groups.length + 1;
  while (names.has(String(n))) n++;
  return String(n);
}

function addGroup() {
  if (state.groups.length >= MAX_GROUPS) {
    toast(`最多 ${MAX_GROUPS} 個分組`);
    return;
  }
  const group = { id: newId(), name: nextGroupName(), items: [] };
  state.groups.push(group);
  saveList();
  switchGroup(group.id);
  openGroup(group.id);
}

function openGroup(id) {
  const group = state.groups.find((g) => g.id === id);
  if (!group) return;
  state.editingGroup = id;
  $('#gName').value = group.name;
  $('#gCash').value = group.cash || '';
  $('#gInfo').textContent = `共 ${group.items.length} 檔股票。也可以把個股左側的 ⋮⋮ 拖到下方分頁來移動。`;
  $('#btnDeleteGroup').disabled = state.groups.length <= 1;
  $('#dlgGroup').showModal();
  $('#gName').select();
}

function saveGroup(e) {
  e.preventDefault();
  const group = state.groups.find((g) => g.id === state.editingGroup);
  const name = $('#gName').value.trim();
  if (group && name) {
    group.name = name;
    group.cash = Math.max(0, num($('#gCash').value) ?? 0);
    saveList();
    render();
  }
  $('#dlgGroup').close();
}

function deleteGroup(id) {
  const idx = state.groups.findIndex((g) => g.id === id);
  if (idx < 0 || state.groups.length <= 1) return;
  const [group] = state.groups.splice(idx, 1);
  if (state.active === id) state.active = state.groups[Math.min(idx, state.groups.length - 1)].id;
  store.save({ groups: state.groups, activeGroup: state.active });
  render();
  refreshQuotes();
  refreshCharts();
  toast(`已刪除分組「${group.name}」`, '復原', () => {
    if (state.groups.includes(group)) return;
    state.groups.splice(Math.min(idx, state.groups.length), 0, group);
    state.active = group.id;
    store.save({ groups: state.groups, activeGroup: state.active });
    render();
    refreshQuotes();
    refreshCharts();
  });
}

// ---------------------------------------------------------------- 搜尋

function searchIndex(text) {
  const q = text.toUpperCase();
  const hits = [];
  for (const s of state.index) {
    const name = s.n.toUpperCase();
    const score =
      s.c === q || name === q ? 0 : s.c.startsWith(q) ? 1 : name.startsWith(q) ? 2 : name.includes(q) ? 3 : -1;
    if (score >= 0) hits.push([score, s]);
  }
  hits.sort((a, b) => a[0] - b[0] || a[1].c.length - b[1].c.length || a[1].c.localeCompare(b[1].c));
  return hits.slice(0, 8).map((h) => h[1]);
}

function updateSuggest() {
  const text = $('#search').value.trim();
  const ul = $('#suggest');
  if (!text) {
    ul.hidden = true;
    return;
  }
  state.suggest = searchIndex(text);
  state.suggestIdx = 0;
  if (state.suggest.length) {
    ul.innerHTML = state.suggest
      .map(
        (s, i) => `<li data-i="${i}" class="${i === 0 ? 'active' : ''}">
          <b>${esc(s.c)}</b><span>${esc(s.n)}</span>
          ${find(s.c) ? '<i>已加入</i>' : `<em>${MARKET_LABEL[s.m] || ''}</em>`}
        </li>`,
      )
      .join('');
  } else {
    const code = text.toUpperCase();
    const hint = api.CODE_RE.test(code)
      ? `按 Enter 查詢並加入 ${code}`
      : state.indexLoading || !state.index.length
        ? '股票清單載入中，可先直接輸入代號'
        : '找不到符合的股票';
    ul.innerHTML = `<li class="hint">${esc(hint)}</li>`;
  }
  ul.hidden = false;
}

function moveSuggest(step) {
  if (!state.suggest.length) return;
  state.suggestIdx = (state.suggestIdx + step + state.suggest.length) % state.suggest.length;
  document.querySelectorAll('#suggest li[data-i]').forEach((li) => {
    li.classList.toggle('active', +li.dataset.i === state.suggestIdx);
  });
  document.querySelector('#suggest li.active')?.scrollIntoView({ block: 'nearest' });
}

function pickSuggest(i) {
  const s = state.suggest[i];
  if (!s) return;
  clearSearch();
  addStock(s.c, s.n, s.m);
}

function clearSearch() {
  $('#search').value = '';
  $('#suggest').hidden = true;
  state.suggest = [];
}

function onSearchKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveSuggest(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (state.suggest.length) pickSuggest(state.suggestIdx);
    else if ($('#search').value.trim()) {
      const code = $('#search').value;
      clearSearch();
      addStock(code);
    }
  } else if (e.key === 'Escape' && $('#search').value) {
    e.preventDefault();
    clearSearch();
  }
}

// ---------------------------------------------------------------- 編輯持股

function openEdit(code) {
  const item = find(code);
  if (!item) return;
  state.editing = code;
  $('#editTitle').textContent = `${item.code} ${item.name || ''}`;
  $('#fName').value = displayName(item);
  $('#fName').placeholder = item.name || '';
  $('#fLots').value = item.lots || '';
  $('#fCost').value = item.cost || '';
  $('#btnUsePrice').hidden = state.quotes.get(code)?.price == null;
  $('#fGroup').innerHTML = state.groups
    .map((g) => `<option value="${g.id}" ${g.id === state.active ? 'selected' : ''}>${esc(g.name)}</option>`)
    .join('');
  updateEditPreview();
  $('#dlgEdit').showModal();
  $('#fLots').focus();
  $('#fLots').select();
}

function editDraft() {
  return { ...find(state.editing), lots: num($('#fLots').value) ?? 0, cost: num($('#fCost').value) ?? 0 };
}

function updateEditPreview() {
  const draft = editDraft();
  const calc = pf.evaluate(draft, state.quotes.get(draft.code), state.settings);
  $('#lotsHint').textContent = calc.shares ? `= ${calc.shares.toLocaleString('en-US')} 股` : '';
  const pnlDir = calc.pnl == null ? '' : pf.trend(Math.round(calc.pnl));
  $('#editPreview').innerHTML = `
    <div><label>投入成本</label><b>${pf.fmtInt(calc.costTotal)}</b></div>
    <div><label>目前市值</label><b>${calc.mv != null ? pf.fmtInt(calc.mv) : '—'}</b></div>
    <div><label>損益</label><b class="${pnlDir}">${pf.fmtSigned(calc.pnl)}<small> ${calc.pnlPct != null ? pf.fmtPct(calc.pnlPct) : ''}</small></b></div>`;
}

function saveEdit(e) {
  e.preventDefault();
  const item = find(state.editing);
  if (!item) return $('#dlgEdit').close();
  const lots = num($('#fLots').value) ?? 0;
  const cost = num($('#fCost').value) ?? 0;
  if (lots < 0 || cost < 0) {
    toast('張數與均價不能是負數');
    return;
  }
  const name = $('#fName').value.trim();
  item.alias = name && name !== item.name ? name : '';
  item.lots = lots;
  item.cost = cost;
  $('#dlgEdit').close();
  saveList();
  render();
  const target = $('#fGroup').value;
  if (target !== state.active) moveItem(item.code, target);
}

// ---------------------------------------------------------------- 設定

function openSettings() {
  const s = state.settings;
  $('#sTheme').value = s.theme;
  $('#sRefresh').value = String(s.refreshSec);
  $('#sColor').value = s.colorMode;
  $('#sIncludeCost').checked = s.includeCost;
  $('#sDiscount').value = +(s.feeDiscount * 10).toFixed(2);
  $('#sMinFee').value = s.minFee;
  $('#feeRow').classList.toggle('disabled', !s.includeCost);
  $('#dlgSettings').showModal();
}

function readSettings() {
  const discount = num($('#sDiscount').value);
  const next = {
    theme: $('#sTheme').value,
    refreshSec: +$('#sRefresh').value,
    colorMode: $('#sColor').value,
    includeCost: $('#sIncludeCost').checked,
    feeDiscount: discount && discount > 0 ? Math.min(discount, 10) / 10 : 1,
    minFee: Math.max(0, num($('#sMinFee').value) ?? 20),
  };
  const refreshChanged = next.refreshSec !== state.settings.refreshSec;
  state.settings = next;
  $('#feeRow').classList.toggle('disabled', !next.includeCost);
  store.save({ settings: next });
  applySettings();
  if (refreshChanged) schedule();
  render();
}

// ---------------------------------------------------------------- 匯出

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function download(filename, text, mime) {
  // 用 data URL 而不是 blob：彈出視窗關閉時下載也不會中斷
  const a = document.createElement('a');
  a.href = `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
}

const fileSafe = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '_');

function snapshotRows() {
  return items().map((item) => {
    const q = state.quotes.get(item.code);
    return { item, q, c: pf.evaluate(item, q, state.settings) };
  });
}

const r0 = (n) => (n == null ? '' : Math.round(n));
const r2 = (n) => (n == null ? '' : Math.round(n * 100) / 100);

function exportCSV() {
  const rows = [['代號', '名稱', '市場', '張數', '股數', '均價', '現價', '漲跌', '漲跌幅(%)', '市值', '投入成本', '未實現損益', '報酬率(%)', '今日損益']];
  const data = snapshotRows();
  for (const { item, q, c } of data) {
    rows.push([
      `="${item.code}"`, // 讓 Excel 保留 0050 這類代號開頭的 0
      displayName(item),
      MARKET_LABEL[item.market] || '',
      item.lots || 0,
      c.shares,
      item.cost || 0,
      q?.price ?? '',
      q?.traded ? q.change : '',
      q?.traded ? q.changePct : '',
      r0(c.mv),
      c.held ? r0(c.costTotal) : '',
      r0(c.pnl),
      r2(c.pnlPct),
      r0(c.dayPnl),
    ]);
  }
  const t = pf.summarize(data.map((d) => d.c));
  if (t.held) {
    const priced = (v) => (t.priced ? v : ''); // 報價還沒到時不要寫出 0
    rows.push(['合計', '', '', '', '', '', '', '', '', priced(r0(t.mv)), r0(t.costAll), priced(r0(t.pnl)), r2(t.pnlPct), priced(r0(t.day))]);
  }
  const cell = (v) => {
    const s = String(v);
    return /^="/.test(s) || !/[",\r\n]/.test(s) ? s : `"${s.replace(/"/g, '""')}"`;
  };
  const csv = rows.map((r) => r.map(cell).join(',')).join('\r\n');
  download(`my-stock-${fileSafe(cur().name)}-${stamp()}.csv`, `﻿${csv}`, 'text/csv');
}

function exportJSON() {
  const data = {
    app: 'my-stock',
    version: 2,
    exportedAt: new Date().toISOString(),
    groups: state.groups.map((g) => ({
      name: g.name,
      cash: g.cash || 0,
      items: g.items.map(({ code, name, alias, market, lots, cost }) => ({ code, name, alias, market, lots, cost })),
    })),
    settings: state.settings,
  };
  download(`my-stock-${stamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
}

async function copyList() {
  const lines = [['代號', '名稱', '張數', '均價', '現價', '漲跌幅(%)', '市值', '未實現損益', '報酬率(%)'].join('\t')];
  for (const { item, q, c } of snapshotRows()) {
    lines.push(
      [item.code, displayName(item), item.lots || 0, item.cost || 0, q?.price ?? '', q?.traded ? q.changePct : '', r0(c.mv), r0(c.pnl), r2(c.pnlPct)].join('\t'),
    );
  }
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    toast('已複製，可以直接貼到 Excel 或 Google 試算表');
  } catch {
    toast('複製失敗，請改用匯出 CSV');
  }
}

// ---------------------------------------------------------------- 匯入

function openImport() {
  $('#importText').value = '';
  $('#importError').textContent = '';
  $('#importFileName').textContent = isTab ? '' : '（會在新分頁開啟）';
  $('#dlgImport').showModal();
  $('#importText').focus();
}

function normCode(v) {
  const s = String(v ?? '')
    .replace(/^=?"?|"$/g, '')
    .trim()
    .toUpperCase()
    .replace(/\.TWO?$/, '');
  return api.CODE_RE.test(s) ? s : null;
}

function splitCSVLine(line, delim) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field.replace(/^=/, '') === '') {
      quoted = true;
      field = '';
    } else if (ch === delim) {
      out.push(field.trim());
      field = '';
    } else field += ch;
  }
  out.push(field.trim());
  return out;
}

const entryOf = (x) =>
  typeof x === 'string' || typeof x === 'number'
    ? { code: x }
    : { code: x.code ?? x['代號'] ?? x.symbol, name: x.name ?? x['名稱'], alias: x.alias, lots: x.lots ?? x['張數'], cost: x.cost ?? x['均價'] };

// 完整備份檔回傳 { groups: [{ name, entries }] }，其他格式回傳 { entries }
// entries: [{ code, name?, alias?, lots?, cost? }]
function parseImport(raw) {
  const text = raw.replace(/^﻿/, '').trim();
  if (!text) return { entries: [] };

  if (/^[[{]/.test(text)) {
    const data = JSON.parse(text);
    if (Array.isArray(data?.groups)) {
      return {
        groups: data.groups.map((g, i) => ({
          name: String(g.name ?? i + 1).trim().slice(0, 12) || String(i + 1),
          cash: num(g.cash),
          entries: (Array.isArray(g.items) ? g.items : []).map(entryOf),
        })),
      };
    }
    const arr = Array.isArray(data) ? data : data.watchlist;
    if (!Array.isArray(arr)) throw new Error('JSON 內容裡找不到自選清單');
    return { entries: arr.map(entryOf) };
  }

  return { entries: parseTable(text) };
}

function parseTable(text) {
  // 純代號清單：2330 0050、2454
  const tokens = text.split(/[\s,，、;；]+/).filter(Boolean);
  if (tokens.every(normCode)) return tokens.map((code) => ({ code }));

  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const rows = lines.map((l) => splitCSVLine(l, delim));
  const head = rows[0].map((h) => h.toLowerCase());
  if (normCode(rows[0][0])) {
    return rows.map((r) => ({ code: r[0], name: r[1], lots: r[2], cost: r[3] }));
  }
  const col = (...names) => head.findIndex((h) => names.some((n) => h.includes(n)));
  const ci = col('代號', 'code', 'symbol');
  const ni = col('名稱', 'name');
  const li = col('張數', 'lots');
  const si = col('股數', 'shares');
  const pi = col('均價', 'avg', 'cost');
  if (ci < 0) throw new Error('CSV 第一列需要有「代號」欄位');
  return rows.slice(1).map((r) => {
    const shares = si >= 0 ? num(r[si]) : null;
    return {
      code: r[ci],
      name: ni >= 0 ? r[ni] : undefined,
      lots: li >= 0 ? r[li] : shares != null ? shares / pf.LOT : undefined,
      cost: pi >= 0 ? r[pi] : undefined,
    };
  });
}

function cleanEntries(entries) {
  const seen = new Set();
  const clean = [];
  for (const e of entries) {
    const code = normCode(e.code);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const known = state.index.find((s) => s.c === code);
    const name = e.name ? String(e.name).trim() : '';
    clean.push({
      code,
      name: known?.n || name,
      // CSV 只有一個名稱欄，跟官方名稱不同時視為自訂名稱
      alias: e.alias ? String(e.alias).trim() : known && name && name !== known.n ? name : '',
      market: known?.m,
      lots: num(e.lots),
      cost: num(e.cost),
    });
  }
  return clean;
}

function mergeInto(group, clean, replace) {
  const fresh = (e) => ({ ...e, lots: e.lots ?? 0, cost: e.cost ?? 0 });
  if (replace) {
    group.items = clean.map(fresh);
    return;
  }
  for (const e of clean) {
    const existing = group.items.find((it) => it.code === e.code);
    if (!existing) {
      group.items.push(fresh(e));
      continue;
    }
    if (e.lots != null) existing.lots = e.lots;
    if (e.cost != null) existing.cost = e.cost;
    if (e.alias) existing.alias = e.alias;
  }
}

// 完整備份：取代＝整個還原所有分組，合併＝依分組名稱併入（沒有的就新增）
// 其他格式：只匯入目前分組
function applyImport(data, mode) {
  const replace = mode === 'replace';
  let count = 0;
  if (data.groups) {
    if (!data.groups.length) throw new Error('備份檔裡沒有任何分組');
    const groups = replace ? [] : state.groups;
    for (const g of data.groups) {
      const clean = cleanEntries(g.entries);
      count += clean.length;
      let target = groups.find((x) => x.name === g.name);
      if (!target) {
        target = { id: newId(), name: g.name, items: [] };
        groups.push(target);
      }
      if (g.cash != null) target.cash = g.cash;
      mergeInto(target, clean, false);
    }
    state.groups = groups;
    if (!groups.some((g) => g.id === state.active)) state.active = groups[0].id;
  } else {
    const clean = cleanEntries(data.entries);
    if (!clean.length) throw new Error('沒有找到有效的股票代號');
    mergeInto(cur(), clean, replace);
    count = clean.length;
  }
  store.save({ groups: state.groups, activeGroup: state.active });
  render();
  refreshQuotes();
  refreshCharts();
  return { count, groups: data.groups?.length };
}

function submitImport(e) {
  e.preventDefault();
  try {
    const mode = document.querySelector('input[name="importMode"]:checked').value;
    const { count, groups } = applyImport(parseImport($('#importText').value), mode);
    $('#dlgImport').close();
    toast(groups ? `已匯入 ${groups} 個分組、共 ${count} 檔股票` : `已匯入 ${count} 檔股票到「${cur().name}」`);
  } catch (err) {
    $('#importError').textContent = err instanceof SyntaxError ? 'JSON 格式有誤，請確認內容完整' : err.message;
  }
}

async function readImportFile() {
  const file = $('#importFile').files[0];
  if (!file) return;
  $('#importFileName').textContent = file.name;
  $('#importText').value = await file.text();
  $('#importFile').value = '';
}

// ---------------------------------------------------------------- 拖曳排序、拖到分頁移動

function bindDrag(tbody, tabs) {
  tbody.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.handle');
    if (handle) handle.parentElement.draggable = true;
  });
  document.addEventListener('pointerup', () => {
    if (!state.dragCode) tbody.querySelectorAll('tr[draggable="true"]').forEach((tr) => (tr.draggable = false));
  });
  tbody.addEventListener('dragstart', (e) => {
    const tr = e.target.closest('tr[data-code]');
    state.dragCode = tr.dataset.code;
    tr.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tr.dataset.code);
  });
  tbody.addEventListener('dragover', (e) => {
    if (!state.dragCode) return;
    e.preventDefault();
    const over = e.target.closest('tr[data-code]');
    const dragging = tbody.querySelector('tr.dragging');
    if (!over || !dragging || over === dragging) return;
    const rect = over.getBoundingClientRect();
    tbody.insertBefore(dragging, e.clientY > rect.top + rect.height / 2 ? over.nextSibling : over);
  });
  tbody.addEventListener('drop', (e) => e.preventDefault());
  tbody.addEventListener('dragend', () => {
    // 若已拖到其他分頁，那一檔已經不在目前分組，排序時自然略過
    const order = [...tbody.children].map((tr) => tr.dataset.code);
    items().sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
    state.dragCode = null;
    tabs.querySelectorAll('.drop-target').forEach((t) => t.classList.remove('drop-target'));
    saveList();
    state.pendingRender = false;
    render();
  });

  const targetTab = (e) => {
    const tab = e.target.closest('.tab[data-group]');
    return state.dragCode && tab && tab.dataset.group !== state.active ? tab : null;
  };
  tabs.addEventListener('dragover', (e) => {
    const tab = targetTab(e);
    if (!tab) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    tabs.querySelectorAll('.drop-target').forEach((t) => t !== tab && t.classList.remove('drop-target'));
    tab.classList.add('drop-target');
  });
  tabs.addEventListener('dragleave', (e) => e.target.closest('.tab')?.classList.remove('drop-target'));
  tabs.addEventListener('drop', (e) => {
    const tab = targetTab(e);
    if (!tab) return;
    e.preventDefault();
    moveItem(state.dragCode, tab.dataset.group);
  });
}

// ---------------------------------------------------------------- 事件

function bindEvents() {
  const search = $('#search');
  search.addEventListener('input', updateSuggest);
  search.addEventListener('keydown', onSearchKey);
  search.addEventListener('focus', updateSuggest);
  search.addEventListener('blur', () => setTimeout(() => ($('#suggest').hidden = true), 120));
  $('#suggest').addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    e.preventDefault();
    if (li) pickSuggest(+li.dataset.i);
  });

  $('#btnRefresh').addEventListener('click', () => {
    refreshQuotes();
    refreshCharts(true);
  });
  $('#btnExpand').addEventListener('click', () => openUrl(selfUrl('view=tab')));
  $('#btnPrivacy').addEventListener('click', () => {
    state.privacy = !state.privacy;
    store.save({ privacy: state.privacy });
    applySettings();
    render();
  });

  const tbody = $('#rows');
  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-code]');
    if (!tr || e.target.closest('.handle')) return;
    const code = tr.dataset.code;
    const act = e.target.closest('[data-act]')?.dataset.act;
    e.preventDefault();
    if (act === 'edit') openEdit(code);
    else if (act === 'del') removeItem(code);
    else openUrl(api.yahooUrl(code, find(code)?.market));
  });

  // 分組分頁：點一下切換、雙擊改名、＋ 新增
  const tabs = $('#groupTabs');
  tabs.addEventListener('click', (e) => {
    if (e.target.closest('[data-group-add]')) return addGroup();
    const tab = e.target.closest('.tab[data-group]');
    if (tab) switchGroup(tab.dataset.group);
  });
  tabs.addEventListener('dblclick', (e) => {
    const tab = e.target.closest('.tab[data-group]');
    if (tab) openGroup(tab.dataset.group);
  });
  $('#btnEditGroup').addEventListener('click', () => openGroup(state.active));
  $('#formGroup').addEventListener('submit', saveGroup);
  $('#btnDeleteGroup').addEventListener('click', () => {
    $('#dlgGroup').close();
    deleteGroup(state.editingGroup);
  });
  bindDrag(tbody, tabs);

  // 匯出選單
  const menu = $('#exportMenu');
  $('#btnExport').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', () => (menu.hidden = true));
  menu.addEventListener('click', (e) => {
    const kind = e.target.closest('[data-export]')?.dataset.export;
    if (kind === 'csv') exportCSV();
    else if (kind === 'json') exportJSON();
    else if (kind === 'copy') copyList();
  });

  // 對話框：點背景或「取消」關閉
  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
    });
  });

  $('#formEdit').addEventListener('submit', saveEdit);
  $('#formEdit').addEventListener('input', updateEditPreview);
  $('#btnUsePrice').addEventListener('click', () => {
    const q = state.quotes.get(state.editing);
    if (q?.price != null) $('#fCost').value = q.price;
    updateEditPreview();
  });
  $('#btnDelete').addEventListener('click', () => {
    $('#dlgEdit').close();
    removeItem(state.editing);
  });

  $('#btnSettings').addEventListener('click', openSettings);
  $('#formSettings').addEventListener('change', readSettings);
  $('#formSettings').addEventListener('submit', (e) => {
    e.preventDefault();
    readSettings();
    $('#dlgSettings').close();
  });
  $('#btnReloadIndex').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '下載中…';
    const ok = await loadIndex();
    btn.disabled = false;
    btn.textContent = '重新下載股票清單';
    toast(ok ? `股票清單已更新，共 ${state.index.length} 檔` : '股票清單下載失敗，請稍後再試');
  });

  $('#btnImport').addEventListener('click', openImport);
  $('#formImport').addEventListener('submit', submitImport);
  $('#btnPickFile').addEventListener('click', () => {
    // 彈出視窗開檔案選擇器時可能被瀏覽器關掉，改到分頁裡選檔
    if (isTab) $('#importFile').click();
    else openUrl(selfUrl('view=tab&import=1'));
  });
  $('#importFile').addEventListener('change', readImportFile);
}

init();
