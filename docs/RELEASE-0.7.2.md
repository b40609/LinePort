# v0.7.2：通用訊息轉送介面與文件

2026-10-10。統一產品定位與公開範例，適用團隊公告、系統通知與一般訊息轉送。

- 介面關鍵字範例改為公告、通知、提醒；只在自行點選時填入，不改寫既有規則。
- 文件、測試資料與示範畫面採一般群組、指定發訊者及通知範例。
- 多來源／多目的與人員、內容篩選教學改為通用配置。
- GitHub 專案描述與舊版本頁的展示文字同步整理；歷史 commit、tag 與固定下載檔保留。

136 項 Mock 測試通過，npm audit 已知依賴漏洞 0。沒有新增依賴、資料格式變更或不可逆遷移；不明發送仍不自動重送。未使用真實帳號收送測試。

[版本頁](https://github.com/b40609/LinePort/releases/tag/v0.7.2) · [ZIP](https://github.com/b40609/LinePort/releases/download/v0.7.2/LinePort-v0.7.2.zip) · [SHA-256](https://github.com/b40609/LinePort/releases/download/v0.7.2/SHA256SUMS.txt) · [配置教學](ROUTING.md)

固定版本原始碼 ZIP，需要 Node.js 與 npm，尚無 EXE 或自動更新。先停止舊程序並私下備份完整資料，在新目錄解壓，核對 SHA-256，於 yomi-probe 執行 `npm.cmd ci --ignore-scripts`、`npm.cmd test`，確認規則後自行啟動。詳見 [手動更新步驟](RELEASE-0.7.0.md)。不可直接降版處理新版資料。

LINE 圖片與跨 LINE 媒體尚未支援；圖片／檔案僅限同一 Bot 的 Telegram → Telegram。關鍵字是文字比對，沒有 OCR 或語意判讀。真實平台收送、多日運作、硬體斷電、安全壓縮及 LINE 登入全面加密仍待驗證或開發。
