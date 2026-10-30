# Chrome 線上應用程式商店上架資料

開發人員資訊主頁：https://chrome.google.com/webstore/devconsole

## 檔案

| 用途 | 檔案 |
| --- | --- |
| 上傳的套件 | `dist/my-stock-1.2.0.zip` |
| 商店圖示 128×128 | `icons/icon128.png`（後台要求另外上傳時用這張） |
| 螢幕截圖 1280×800 | `store/screenshot-1-popup.png`、`store/screenshot-2-dark.png` |
| 小型宣傳圖塊 440×280 | `store/promo-tile-440x280.png` |
| 隱私權政策 | 已發布：https://sites.google.com/view/mystock-privacy（原始檔 `store/privacy-policy.html`） |

`store/src/` 是產生截圖用的模板，不需要上傳。

---

## 1. 商店資訊（Store listing）

**名稱**：My Stock 自選股（從 manifest 帶入）

**摘要**（從 manifest 帶入）：
台股自選清單：即時報價與走勢、多組分組，記錄持有張數與均價，自動計算總資產與損益。

**詳細說明**（直接複製貼上）：

```
My Stock 自選股是給台股投資人的瀏覽器工具。點一下工具列圖示，就能看到自選股的即時報價、當日走勢，並依你輸入的持有張數與平均成本，自動算出總資產與損益。

■ 主要功能
・自選清單：用代號或名稱搜尋上市、上櫃股票與 ETF，拖曳即可排序
・即時行情：今價、漲跌、漲跌幅、最高／最低、當日走勢圖，漲停跌停反白提示
・持股損益：輸入張數（零股可用小數）與均價，即時計算總資產、投入成本、未實現損益、報酬率與今日損益
・交易成本估算：可選擇扣除賣出手續費（可設折扣）與證交稅
・多個分組：每組有自己的清單、持股與現金部位，可改名、新增、刪除
・匯出匯入：CSV（可用 Excel 開啟）、JSON 完整備份、複製到剪貼簿
・一鍵開啟 Yahoo 奇摩股市個股頁
・大畫面模式、隱藏金額、淺色／深色主題（預設跟隨系統）、紅漲綠跌／綠漲紅跌

■ 隱私
自選清單、持股與設定只儲存在你的瀏覽器裡，不會上傳到開發者或任何伺服器。擴充套件只會向公開的行情來源查詢股價。

■ 資料來源與聲明
報價來自臺灣證券交易所基本市況報導，走勢圖來自 Yahoo 奇摩股市，股票清單來自證交所與櫃買中心 OpenAPI。本擴充套件與上述機構沒有任何關聯。資料僅供參考，不構成投資建議；手續費與稅額為估算值，請以券商對帳單為準。
```

**類別**：建議選「生產力 → 工具」（Productivity → Tools）。商店沒有財經類別，這是最接近的。

**語言**：中文（台灣）

**圖片**：上傳上面表格中的 2 張截圖和宣傳圖塊。大型宣傳圖塊（1400×560）是選填。

---

## 2. 隱私權實務（Privacy practices）

**單一用途說明**：

```
在瀏覽器工具列顯示使用者自選的台灣股票即時行情，並依使用者自行輸入的持股計算資產與損益。
Shows real-time quotes for the user's Taiwan stock watchlist in a toolbar popup and calculates portfolio value and profit/loss from the holdings the user enters.
```

**storage 權限理由**：

```
Saves the user's watchlist groups, holdings (shares and average cost) and settings locally with chrome.storage.local. This data never leaves the user's browser.
```

**主機權限理由**（一個欄位，整段貼上）：

```
All host permissions are used only to fetch public market data as JSON:
- mis.twse.com.tw: real-time quotes for the stocks in the user's watchlist (Taiwan Stock Exchange).
- tw.stock.yahoo.com: intraday prices for the small trend chart of each stock.
- query1.finance.yahoo.com / query2.finance.yahoo.com: fallback source for the trend chart.
- openapi.twse.com.tw / www.tpex.org.tw: public lists of stock codes and names, used for searching stocks by name.
No user data is sent to these hosts other than the stock codes needed to look up prices.
```

**是否使用遠端程式碼**：選「否」。

```
All JavaScript is included in the package. The extension only downloads JSON market data, never code.
```

**資料使用**：所有資料類別都**不要勾選**，然後勾選下方三項聲明：
- 不會將使用者資料出售或轉讓給第三方（核准用途除外）
- 不會將使用者資料用於與單一用途無關的用途
- 不會將使用者資料用於判斷信用額度或借貸

> 依我的理解：持股資料只存在本機、不會傳出裝置，所以不算「收集」；查報價時送出的只有股票代號。若審查人員對此有疑問，可以改勾「財務和付款資訊」，並說明只存在使用者的瀏覽器中。

**隱私權政策網址**：

```
https://sites.google.com/view/mystock-privacy
```

---

## 3. 發布（Distribution）

- **可見度**：公開；只想分享給朋友的話選「不公開」（只有拿到連結的人能安裝）
- **地區**：所有地區，或只選台灣
- **商家聲明**（歐盟規定）：個人免費提供、沒有營利的話選「非商家」（non-trader）

---

## 4. 隱私權政策要放在公開網址

商店只接受網址，不能上傳檔案。擇一即可：

1. **Google 協作平台**（最簡單）：到 https://sites.google.com 建立網站，把 `privacy-policy.html` 的文字貼上，發布後複製網址
2. **GitHub Pages**：把 `privacy-policy.html` 放到 GitHub repository，開啟 Pages，網址類似 `https://你的帳號.github.io/repo名稱/privacy-policy.html`

上傳前先把檔案中的 `【請填入聯絡 Email】` 換成你的聯絡信箱。

---

## 5. 送出前檢查

- [ ] 已註冊開發人員帳號（一次性 5 美元，帳號需開啟兩步驟驗證）
- [ ] 上傳 `dist/my-stock-1.2.0.zip`
- [ ] 填好商店資訊、上傳 2 張截圖與宣傳圖塊
- [ ] 隱私權政策已放上公開網址，聯絡 Email 已填入
- [ ] 隱私權實務各欄位已填
- [ ] 送審（通常需要幾天）

**之後更新版本**：修改程式後，先提高 `manifest.json` 的 `version`（例如 1.2.0 → 1.2.1），重新打包上傳，再送審。
