// 商店截圖用的示範資料：寫進開發預覽的 localStorage（擴充套件本身不會載入這個檔案）
const group = (id, name, cash, items) => ({
  id,
  name,
  cash,
  items: items.map(([code, stockName, market, lots, cost]) => ({ code, name: stockName, alias: '', market, lots, cost })),
});

export function seed(theme) {
  const groups = [
    group('demo-1', '長期持股', 300000, [
      ['2330', '台積電', 'tse', 2, 1620],
      ['2317', '鴻海', 'tse', 5, 205],
      ['2454', '聯發科', 'tse', 0, 0],
      ['0050', '元大台灣50', 'tse', 10, 92.5],
      ['00878', '國泰永續高股息', 'tse', 20, 28.6],
      ['2603', '長榮', 'tse', 2, 238],
      ['6488', '環球晶', 'otc', 1, 820],
      ['2881', '富邦金', 'tse', 3, 168],
    ]),
    group('demo-2', '觀察', 0, [
      ['2308', '台達電', 'tse', 0, 0],
      ['2382', '廣達', 'tse', 0, 0],
      ['3017', '奇鋐', 'tse', 0, 0],
    ]),
    group('demo-3', '高股息', 0, [
      ['00919', '群益台灣精選高息', 'tse', 0, 0],
      ['2412', '中華電', 'tse', 0, 0],
    ]),
    group('demo-4', 'ETF', 0, []),
  ];
  localStorage.setItem('groups', JSON.stringify(groups));
  localStorage.setItem('activeGroup', JSON.stringify('demo-1'));
  localStorage.setItem(
    'settings',
    JSON.stringify({ theme, refreshSec: 10, colorMode: 'tw', includeCost: false, feeDiscount: 1, minFee: 20 }),
  );
  localStorage.setItem('privacy', 'false');
  localStorage.setItem('theme', theme);
}
