// 在畫面繪製前套用使用者選的主題，避免開啟時先閃一下另一種顏色。
// 設定以 chrome.storage 為準，popup.js 會把主題同步一份到 localStorage 給這裡讀。
try {
  const theme = localStorage.getItem('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // 讀不到就跟隨系統
}
