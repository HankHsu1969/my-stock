// 行情資料來源
//   即時報價：臺灣證券交易所「基本市況報導」MIS API（上市、上櫃、ETF）
//   當日走勢：Yahoo 奇摩股市 1 分鐘線，失敗時改用 Yahoo Finance 國際版
//   股票清單：證交所、櫃買中心 OpenAPI（名稱搜尋用）

const MIS_API = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';
const MIS_HOME = 'https://mis.twse.com.tw/stock/index.jsp';
const TW_CHART = 'https://tw.stock.yahoo.com/_td-stock/api/resource/FinanceChartService.ApacLibraCharts';
const CHART_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const TWSE_LIST = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
const TPEX_LIST = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes';

const MARKETS = ['tse', 'otc'];
const TPE_OFFSET = 8 * 3600; // 台北時間 UTC+8，沒有日光節約

// 台股代號：4～6 碼數字，可帶一個英文字尾（00631L、00687B、2881A）
export const CODE_RE = /^[0-9]{4,6}[A-Z]?$/;

const toNum = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const firstLevel = (s) => toNum(String(s ?? '').split('_')[0]);

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function getJSON(url, { timeout = 10000, credentials = 'omit' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store', credentials });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('連線逾時');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function parseMisQuote(m) {
  const prevClose = toNum(m.y);
  // z 是最近一筆成交價；盤中常為 "-"，這時改用 trade.z（最後一筆成交）
  const last = toNum(m.z) ?? toNum(m.trade?.z) ?? toNum(m.pz);
  const traded = last != null;
  const change = traded && prevClose ? round(last - prevClose) : 0;
  return {
    code: m.c,
    market: m.ex,
    name: m.n,
    fullName: m.nf || m.n,
    price: traded ? last : prevClose,
    traded,
    prevClose,
    change,
    changePct: traded && prevClose ? round((change / prevClose) * 100) : 0,
    open: toNum(m.o),
    high: toNum(m.h),
    low: toNum(m.l),
    limitUp: toNum(m.u),
    limitDown: toNum(m.w),
    volume: toNum(m.v),
    bid: firstLevel(m.b),
    ask: firstLevel(m.a),
    date: m.d || '',
    time: m.t || m['%'] || '',
  };
}

async function misRequest(channels, retried = false) {
  const url = `${MIS_API}?ex_ch=${encodeURIComponent(channels.join('|'))}&json=1&delay=0&_=${Date.now()}`;
  let data = null;
  try {
    data = await getJSON(url, { credentials: 'include' });
  } catch (err) {
    if (retried) throw err;
  }
  if (!data || !Array.isArray(data.msgArray)) {
    if (retried) throw new Error(data?.rtmessage || '證交所報價服務沒有回應');
    // 證交所偶爾要求先取得 session cookie，先開一次首頁再重試
    await fetch(MIS_HOME, { credentials: 'include', cache: 'no-store' }).catch(() => {});
    return misRequest(channels, true);
  }
  return data.msgArray.filter((m) => m && m.c).map(parseMisQuote);
}

// items: [{ code, market? }]，market 未知時上市、上櫃都查
export async function fetchQuotes(items) {
  const quotes = new Map();
  const channels = (code, markets) => markets.map((m) => `${m}_${code}.tw`);
  const query = async (list) => {
    for (const part of chunk(list, 40)) {
      for (const q of await misRequest(part)) quotes.set(q.code, q);
    }
  };

  await query(items.flatMap((it) => channels(it.code, MARKETS.includes(it.market) ? [it.market] : MARKETS)));

  // 記錄的市場查不到（例如上櫃轉上市），改查另一個市場
  const moved = items.filter((it) => !quotes.has(it.code) && MARKETS.includes(it.market));
  if (moved.length) {
    await query(moved.flatMap((it) => channels(it.code, MARKETS.filter((m) => m !== it.market)))).catch(() => {});
  }
  return quotes;
}

export const tpeDayStart = (sec) => Math.floor((sec + TPE_OFFSET) / 86400) * 86400 - TPE_OFFSET;

// 報價的日期時間（台北時間）轉成 Unix 秒
export function quoteEpoch(q) {
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(q?.date || '');
  const t = /^(\d{2}):(\d{2}):(\d{2})$/.exec(q?.time || '');
  if (!d || !t) return null;
  return Date.UTC(+d[1], d[2] - 1, +d[3], +t[1], +t[2], +t[3]) / 1000 - TPE_OFFSET;
}

const yahooSymbol = (code, market) => `${code}.${market === 'otc' ? 'TWO' : 'TW'}`;

function parseChart(chart) {
  const stamps = chart.timestamp || [];
  const closes = chart.indicators?.quote?.[0]?.close || [];
  const points = [];
  stamps.forEach((t, i) => {
    if (closes[i] != null) points.push([t, closes[i]]);
  });
  const anchor = points[0]?.[0] ?? chart.meta?.regularMarketTime ?? Date.now() / 1000;
  const start = tpeDayStart(anchor) + 9 * 3600; // 09:00 開盤
  return {
    points,
    base: chart.meta?.chartPreviousClose ?? chart.meta?.previousClose ?? null,
    start,
    end: start + 4.5 * 3600, // 13:30 收盤
    fetchedAt: Date.now(),
  };
}

// Yahoo 奇摩股市：即時 1 分鐘走勢，一次可查多檔；但只要有一檔代號無效整批就會失敗
async function twTicks(symbols) {
  const data = await getJSON(`${TW_CHART};symbols=${encodeURIComponent(JSON.stringify(symbols))};type=tick`);
  if (!Array.isArray(data)) throw new Error('走勢資料格式不符');
  return data;
}

// Yahoo Finance 國際版：備援用，台股約延遲 20 分鐘
async function globalChart(symbol) {
  let lastErr;
  for (const host of CHART_HOSTS) {
    try {
      const data = await getJSON(`${host}/v8/finance/chart/${symbol}?interval=5m&range=1d`);
      const r = data?.chart?.result?.[0];
      if (!r) throw new Error('沒有走勢資料');
      return parseChart(r);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function pool(items, size, fn) {
  const queue = [...items];
  const worker = async () => {
    while (queue.length) await fn(queue.shift());
  };
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, worker));
}

// items: [{ code, market }]，回傳 Map(code → { points: [[秒, 價]], base, start, end })
export async function fetchIntraday(items) {
  const charts = new Map();
  const codeOf = new Map(items.map((it) => [yahooSymbol(it.code, it.market), it.code]));
  const collect = (list) => {
    for (const x of list) {
      const code = codeOf.get(x.symbol);
      if (code && x.chart) charts.set(code, parseChart(x.chart));
    }
  };

  for (const part of chunk([...codeOf.keys()], 20)) {
    try {
      collect(await twTicks(part));
    } catch {
      // 交給下面逐檔查詢
    }
  }

  const missing = [...codeOf].filter(([, code]) => !charts.has(code));
  await pool(missing, 4, async ([symbol, code]) => {
    try {
      collect(await twTicks([symbol]));
      if (charts.has(code)) return;
    } catch {
      // 改用國際版
    }
    try {
      charts.set(code, await globalChart(symbol));
    } catch {
      // 走勢圖失敗不影響報價，下次再試
    }
  });
  return charts;
}

// 回傳 { list: [{ c: 代號, n: 名稱, m: 'tse' | 'otc' }], complete }
export async function fetchStockList() {
  const [twse, tpex] = await Promise.allSettled([
    getJSON(TWSE_LIST, { timeout: 30000 }),
    getJSON(TPEX_LIST, { timeout: 30000 }),
  ]);
  const list = [];
  if (twse.status === 'fulfilled') {
    for (const r of twse.value) {
      const c = r.Code?.trim();
      if (c) list.push({ c, n: r.Name.trim(), m: 'tse' });
    }
  }
  if (tpex.status === 'fulfilled') {
    for (const r of tpex.value) {
      const c = r.SecuritiesCompanyCode?.trim();
      // 櫃買清單含上萬檔權證（如 712345、72782U），只留股票、特別股與 ETF（00 開頭）
      if (c && (/^\d{4}[A-Z]?$/.test(c) || c.startsWith('00'))) list.push({ c, n: r.CompanyName.trim(), m: 'otc' });
    }
  }
  if (!list.length) throw new Error('無法取得股票清單');
  return { list, complete: twse.status === 'fulfilled' && tpex.status === 'fulfilled' };
}

export function taipeiClock(now = Date.now()) {
  const d = new Date(now + TPE_OFFSET * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    weekday: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    ymd: `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`,
  };
}

// 'pre' 08:30–09:00 試撮、'open' 09:00–13:35（含收盤集合競價後的成交回報）、其餘 'closed'
export function marketPhase(now) {
  const { weekday, minutes } = taipeiClock(now);
  if (weekday === 0 || weekday === 6) return 'closed';
  if (minutes >= 510 && minutes < 540) return 'pre';
  if (minutes >= 540 && minutes <= 815) return 'open';
  return 'closed';
}

export const yahooUrl = (code, market) => `https://tw.stock.yahoo.com/quote/${code}.${market === 'otc' ? 'TWO' : 'TW'}`;
