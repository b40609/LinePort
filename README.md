# LINE Call Relay

Windows 上執行的 LINE 一般群組文字轉送原型。使用自己的 LINE 帳號登入，來源群組不需加入 Bot；透過 Yomi 讀取近期訊息並轉送，不需要 AI，也不操作滑鼠鍵盤。

目前是原始碼測試版，沒有安裝檔。已實測登入、群組列表、文字解密，以及「來源1 → 目的2」單次傳送後讀回核對。背景監控已啟動並確認輪詢成功；尚未完成長時間穩定性驗證。

## 環境與啟動

需求：Windows 11、Node.js 與 npm（開發實測 Node.js 26.4.0）、已登入 LINE 的主要手機。每位使用者需自行授權登入，不共用登入資料。

```powershell
cd yomi-probe
npm ci --ignore-scripts
npm test
npm start
```

1. 開啟 http://127.0.0.1:18765/，輸入自己的手機號碼，依頁面指示在手機 LINE 授權。
2. 讀取群組列表，選擇群組並確認文字可讀；支援表情符號群名。
3. 在 LINE 建立或準備名稱完全相符的「來源1」和「目的2」兩個一般群組。程式要求每個名稱只有一個符合群組，避免傳錯。
4. 在專案根目錄雙擊 `啟動自動轉送.cmd`，或於 yomi-probe 執行下列指令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-relay.ps1
```

5. 查看 http://127.0.0.1:18766/status，確認 phase 為 running，再於來源1發新文字，觀察目的2。

其他群組名稱目前需修改 `relay.mjs` 的 state.source 與 state.destination，再重新啟動背景程序。尚未提供圖形化轉送設定。

## 自動轉送行為

- 每次查詢完成後等待 3 秒再讀取來源最近 50 則，依時間排序，只轉送未處理的可讀文字。
- 第一次啟動將目前近期訊息設為基準，不回傳歷史訊息。後续重啟沿用本機基準及紀錄，可補處理最近 50 則內的未處理訊息。
- 以訊息 ID 去重；相同文字、不同訊息 ID 仍會轉送。
- 傳送前寫入紀錄，避免程序中斷或網路結果不明時重複發送。結果不明的訊息不自動重試，因此可能漏訊；不是保證恰好一次送達。
- 目的訊息由登入的個人帳號發送。未支援 Telegram、圖片、LINE 社群（OpenChat）、條件篩選或多來源規則。
- 可關閉收訊網頁；背景程序會繼續執行。電腦需不休眠、不登出且保持網路。目前沒有開機自啟動或停止按鈕；需在工作管理員中依命令列辨識 `relay.mjs` 對應 Node.js 程序並結束它，勿結束其他 Node.js 工作。
- `test-relay.mjs` 是會實際傳送一則來源最新文字的手動測試程式；請勿將它当成背景啟動器。

## 資料與限制

登入資料由 Yomi 保存於 `%LOCALAPPDATA%\LineCallYomiProbe`。此目錄含敏感登入資料，不可分享、提交 Git 或放入安裝包。轉送紀錄 `relay-source1-destination2.jsonl` 只含訊息 ID、基準與結果；不是完整訊息備份。網頁訊息保存在記憶體，需手動匯出。

使用非官方 LINE 協定。LINE 更新可能使登入或收發失效，登入可能讓官方電腦版 LINE 登出。大量新訊息超過最近 50 則、網路錯誤或休眠可能漏訊，不能保證他人不察覺轉送。改動監控群組時，需同時設計独立紀錄檔，避免沿用舊規則基準。

## 專案結構

| 路徑 | 用途 |
| --- | --- |
| `yomi-probe/` | 現行登入頁、收訊驗證、背景轉送與測試 |
| `yomi-probe/VERIFICATION.md` | 實際驗證紀錄與未驗證項目 |
| `src/`、`scripts/`、`package/` | 早期 Windows 通知與 OCR 診斷工具，非目前轉送服務 |
| `NOTIFICATION_DIAGNOSTICS.md` | 早期工具說明，含開發環境歷史紀錄 |
| `THIRD_PARTY_NOTICES.md` | 原始專案、官方文件與第三方授權參考 |

## 參考來源與授權

核心依賴 [RikaiDev/yomi](https://github.com/RikaiDev/yomi)，固定使用 `@rikaidev/yomi` 0.5.0（MIT，Copyright 2026 RikaiDev）。本專案自行實作頁面與轉送邏輯，並非 LINE 或 Yomi 官方產品。完整來源列於 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本專案自有程式採 [MIT License](LICENSE)，第三方依賴遵循其各自授權。
