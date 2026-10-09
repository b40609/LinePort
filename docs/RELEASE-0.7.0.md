# v0.7.0 更新與手動安裝

2026-10-09。接續 v0.6.0，完成多來源媒體模擬、選用回覆關聯及私人封存完整性核對；沒有新增依賴。各來源指定發訊者白名單可排除 LINE 群內其他人，再以必要內容條件排除指定發訊者純寒暄。

## 本版變更

- 模擬可選規則內每個來源，測文字、Telegram 圖片／檔案、大小、受保護與回覆；顯示各目的、篩選後內容與等待／拒絕原因。不發訊、不下載附件，也不讀取真實回覆對照。
- 回覆關聯預設關閉。LINE／Telegram 來源引用同配對已確認送達的原訊息；目的 ID 保存後可跨重啟恢復，各目的獨立對照。缺少對照時送一般訊息，不補送被篩掉或未確認的原訊息。
- Telegram／Discord 原訊息不存在時可在單次請求內退回一般訊息；LINE 引用失敗暫停配對。發送結果不明維持人工逐筆核對，不自動重送。
- 私人封存檢查來源／複本一致，建立後重新驗證；新增唯讀 `verify-archive.mjs`。原檔保留，不清除去重、待送或憑證。
- 完成三階段項目對照、資料保留與 LINE 媒體／Yomi 儲存評估文件。[項目狀態](DEVELOPMENT-STATUS.md) · [研究依據](RESEARCH-0.7.0.md)

## 下載與核對

[版本頁](https://github.com/b40609/LinePort/releases/tag/v0.7.0) · [LinePort-v0.7.0.zip](https://github.com/b40609/LinePort/releases/download/v0.7.0/LinePort-v0.7.0.zip) · [SHA256SUMS.txt](https://github.com/b40609/LinePort/releases/download/v0.7.0/SHA256SUMS.txt)

這是固定版本原始碼 ZIP，需要 Node.js 與 npm，並非免安裝 EXE。下載 ZIP 與 SHA256SUMS，核對以下結果與清單中的值一致：

```powershell
Get-FileHash .\LinePort-v0.7.0.zip -Algorithm SHA256
```

1. 停止轉送，等已停止，再結束原 `npm start` 程序。
2. 匯出設定備份；私下備份完整資料目錄及原程式。設定備份不含登入／Token／待送／去重，不能取代完整私人備份。
3. 在新資料夾解壓 ZIP，到 `yomi-probe` 執行 `npm.cmd ci --ignore-scripts`、`npm.cmd test`。
4. 執行 `npm.cmd start`，核對版本、載入平台並檢查規則；確認後自行開始轉送。更新不會自動啟動轉送。

新增 JSONL 回覆欄位及既有媒體、retry、人工決策，沒有資料庫 Schema 變更。原待送與去重紀錄保留；舊 queued／retry 可載入，但舊版沒有完整新欄位語意。**不可直接降版讀取新版資料**；回復需停止並核對一致的程式與完整私人備份。

## 驗證與限制

133 項測試通過、0 失敗、0 跳過；19 項新測試涵蓋模擬與實際內容一致、回覆持久對照、跨平台／多目的、原訊息缺失、429、不明結果與封存竄改拒絕。npm 已知依賴漏洞 0。[驗證紀錄](../yomi-probe/VERIFICATION.md)

390px 手機寬度與桌面無水平溢出，Mock 瀏覽器無警告／錯誤。畫面全部為合成資料：[手機畫面](https://raw.githubusercontent.com/b40609/LinePort/v0.7.2/docs/assets/preview-mobile-0.7.jpg) · [完整桌面畫面](https://raw.githubusercontent.com/b40609/LinePort/v0.7.2/docs/assets/preview-0.7.jpg)。

LINE 為非官方協定；真實平台權限、回覆及媒體收送沒有在本次用真人帳號驗證。LINE 媒體／社群、相簿整組／影音、編輯／刪除同步、Slack、Discord 來源未支援。Bot Token DPAPI 選用，LINE 登入／E2EE、訊息與原明文憑證副本未完整加密。封存不釋放容量，安全壓縮尚未實作；沒有無限期運作、無漏洞或完整送達保證。
