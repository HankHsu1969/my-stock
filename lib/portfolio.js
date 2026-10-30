// 持股損益計算與數字格式

export const LOT = 1000; // 1 張 = 1000 股

export const sharesOf = (item) => Math.round((Number(item.lots) || 0) * LOT);

// 賣出交易成本估算：手續費 0.1425% × 折扣（有最低金額），
// 證交稅股票 0.3%、ETF 0.1%、債券 ETF（代號 B 結尾）停徵
export function sellCost(code, amount, settings) {
  if (amount <= 0) return 0;
  const fee = Math.max(settings.minFee, Math.floor(amount * 0.001425 * settings.feeDiscount));
  const taxRate = /^00\d+B$/.test(code) ? 0 : code.startsWith('00') ? 0.001 : 0.003;
  return fee + Math.floor(amount * taxRate);
}

export function evaluate(item, quote, settings) {
  const shares = sharesOf(item);
  const row = {
    shares,
    held: shares > 0,
    costTotal: shares * (Number(item.cost) || 0),
    mv: null,
    pnl: null,
    pnlPct: null,
    dayPnl: null,
  };
  if (!row.held || quote?.price == null) return row;
  row.mv = quote.price * shares;
  row.pnl = row.mv - row.costTotal - (settings.includeCost ? sellCost(item.code, row.mv, settings) : 0);
  row.pnlPct = row.costTotal > 0 ? (row.pnl / row.costTotal) * 100 : null;
  row.dayPnl = quote.change * shares;
  return row;
}

export function summarize(rows) {
  // cost 只算已有報價的持股（報酬率用）；costAll 是全部持股的投入成本
  const t = { mv: 0, cost: 0, costAll: 0, pnl: 0, day: 0, held: 0, priced: 0 };
  for (const r of rows) {
    if (!r.held) continue;
    t.held++;
    t.costAll += r.costTotal;
    if (r.mv == null) continue;
    t.priced++;
    t.mv += r.mv;
    t.cost += r.costTotal;
    t.pnl += r.pnl;
    t.day += r.dayPnl;
  }
  t.pnlPct = t.cost > 0 ? (t.pnl / t.cost) * 100 : null;
  const prevMv = t.mv - t.day;
  t.dayPct = prevMv > 0 ? (t.day / prevMv) * 100 : null;
  return t;
}

const trimZeros = (s) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);

export const trend = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
export const fmtPrice = (n) => (n == null ? '—' : trimZeros(n.toFixed(2)));
export const fmtLots = (n) => trimZeros((Number(n) || 0).toFixed(3));
export const fmtInt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
export const fmtSigned = (n) => {
  if (n == null) return '—';
  const r = Math.round(n);
  return (r > 0 ? '+' : r < 0 ? '-' : '') + Math.abs(r).toLocaleString('en-US');
};
export const fmtPct = (n, signed = true) => {
  if (n == null) return '—';
  const s = Math.abs(n).toFixed(2);
  if (!signed || s === '0.00') return `${s}%`;
  return `${n > 0 ? '+' : '-'}${s}%`;
};
