# v0.8.3：改善補讀與未轉送原因呈現

改善 LINE 混合頁面補讀：頁面中一則已處理訊息不再讓補讀提前停止。每條路線新增掃描、已處理、新候選、符合條件及條件排除數，方便核對人員、關鍵字與排程。新候選是尚未處理且符合時間與內容類型的訊息；符合條件不等於送達。

161 項 Mock 通過，依賴掃描目前已知漏洞 0。發送不明仍暫停、不自動重送；無新依賴或資料 Schema 變更。本次真機未收到的原因尚未確認，Telegram 實機及長期運作仍待驗收。[驗證紀錄](../yomi-probe/VERIFICATION.md)

## 下載與手動更新

[版本頁](https://github.com/b40609/LinePort/releases/tag/v0.8.3) · [ZIP](https://github.com/b40609/LinePort/releases/download/v0.8.3/LinePort-v0.8.3.zip) · [SHA-256](https://github.com/b40609/LinePort/releases/download/v0.8.3/SHA256SUMS.txt)

1. 停止轉送與設定服務，私下備份原程式及完整資料目錄。
2. 下載 ZIP 與 SHA256SUMS.txt，用 Get-FileHash 核對 SHA-256，解壓至新目錄。
3. 在新版 yomi-probe 執行 npm.cmd ci --ignore-scripts、npm.cmd test，再自行啟動 npm.cmd start。
4. 重新整理介面，核對原規則並啟動專用測試路線，以全新合成文字逐筆核對目的接收與路線計數。

若新候選為 0，確認訊息在啟動基準後發出、來源正確，以及是否已處理；若條件排除增加，核對指定人員與關鍵字。已略過訊息不自動重算。保留私人 journal，不以舊版處理新版資料；勿上傳群組、人員 ID、照片、訊息全文或登入資料。已讀實測結論仍限原測試條件。[安全說明](../SECURITY.md) · [排解方式](TROUBLESHOOTING.md)
