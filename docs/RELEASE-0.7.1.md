# v0.7.1：分析師多來源／多目的配置

2026-10-09，接續 v0.7.0。針對 2–3 個來源、3–4 個 LINE／Telegram 目的及文字為主的 Call 訊補上配置說明與驗證。

- 選來源與目的時顯示配對數及圖片支援範圍，混合目的不會宣稱附件已送達。
- 使用者點選 Call 範例時加入續抱、加碼、減碼、出場；既有規則及預設條件不會自動更改。
- 加入三來源到四目的實際排程 Mock 測試，核對指定作者、路人／寒暄排除、短 Call、來源前綴及重啟去重。
- 說明 Telegram 圖片如何拆分 LINE 純文字與 Telegram 媒體目的，避免重複配對。

[配置教學](CALL-ROUTING.md) · [驗證紀錄](../yomi-probe/VERIFICATION.md) · [版本下載](https://github.com/b40609/LinePort/releases/tag/v0.7.1) · [ZIP](https://github.com/b40609/LinePort/releases/download/v0.7.1/LinePort-v0.7.1.zip) · [SHA256SUMS](https://github.com/b40609/LinePort/releases/download/v0.7.1/SHA256SUMS.txt)

固定版本原始碼 ZIP，需要 Node.js／npm。沿用 [v0.7.0 手動更新步驟](RELEASE-0.7.0.md)：先停止並私下備份完整資料，在另一個目錄解壓，核對 SHA-256，於 yomi-probe 執行 npm.cmd ci --ignore-scripts、npm.cmd test。沒有新增依賴、資料庫 Schema 或不可逆遷移，不自動啟動真實轉送。

LINE 圖片仍未支援，Telegram 圖片僅同一 Bot 轉到 Telegram。純圖片沒有 Call 說明時不能通過必要關鍵字；圖片沒有 OCR。文字代碼／價位的不同格式仍需逐來源模擬，沒有 AI 語意判讀。本次不讀取真實憑證、不用真帳號發訊；不明發送不自動重送。其餘 [v0.7.0 安全限制](RELEASE-0.7.0.md) 維持。
