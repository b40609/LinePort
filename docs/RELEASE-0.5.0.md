# v0.5.0：容易上手、可核對、可恢復

2026-10-09。這次交付第一階段；維持純文字轉送與既有預設，不自動啟動服務。

- 首頁三步引導、空白狀態與規則摘要；篩選及全文預覽收進進階設定。
- 編輯中的規則可輸入範例，列出各目的、篩選後內容與 Telegram 長度限制；全程不呼叫發送 API。
- 啟動前只讀檢查 LINE 本機連結／金鑰、Telegram Bot、Webhook、聊天室及成員權限。不能證明實際送達，也無法證明 Bot 可看到所有群組文字。
- 顯示運作中、等待平台、需要處理、已停止；配對另列待送、成功、不明、失敗、略過與限流倒數。
- 停止後逐筆核對發送不明，選「確認收到」或「略過」。另存 `lineport-review-*.jsonl` 決策，原始紀錄不變、去重證據保留；重新啟動接續其他待送，沒有整批重送功能。
- 設定備份不含憑證；還原先驗證格式／配對／設定版本衝突，再保存 `lineport-settings-before-restore-*.json` 原設定。還原不啟動轉送、不改登入及待送進度。
- 安全診斷只匯出版本、旗標、階段及計數，不包含訊息、名稱、ID、Token、檔案路徑及錯誤全文。

## 下載與手動更新

[版本頁](https://github.com/b40609/LinePort/releases/tag/v0.5.0) · [LinePort-v0.5.0.zip](https://github.com/b40609/LinePort/releases/download/v0.5.0/LinePort-v0.5.0.zip) · [SHA256SUMS.txt](https://github.com/b40609/LinePort/releases/download/v0.5.0/SHA256SUMS.txt)

這是固定版本原始碼 ZIP，需要 Node.js 與 npm，尚無 EXE 安裝器或自動更新。SHA-256 用於核對下載完整性，不是數位簽章。

1. 停止轉送並關閉原 Node 程序；不要同時執行兩份共用資料目錄的程式。
2. 私下保存設定備份；另將完整 `%LOCALAPPDATA%\LineCallYomiProbe` 複製至自己保護的備份位置。完整資料含憑證及訊息，禁止分享或公開同步。程式不會自動代為複製。
3. 下載 ZIP 與 SHA256SUMS.txt，執行以下指令，人工比對 SHA256SUMS.txt 中的完整 64 字元摘要；不一致就重新下載，先不要執行。
4. 解壓至新的資料夾，保留舊程式與私人備份；在新版 `yomi-probe` 執行 `npm.cmd ci --ignore-scripts`、`npm.cmd test`，再自行執行 `npm.cmd start`。
5. 重新整理頁面，恢復連結、檢查規則與權限；確認後再按開始轉送。

```powershell
Get-FileHash .\LinePort-v0.5.0.zip -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

v0.4.0 的 queued／retry 及待送資料可繼續使用。新增決策是額外 JSONL，沒有資料庫 Schema 或不可逆遷移。人工處理後舊版看不懂決策，會重新受阻；禁止直接降版處理新版資料。若要回復，需停止所有程序並先另行規劃完整一致的私人資料備份恢復，不能只替換單一紀錄檔。

## 驗證與限制

82 項 Mock 測試通過，涵蓋預覽、診斷遮蔽、備份格式、還原前保留原設定、寫入失敗、人工決策重啟恢復、其餘待送保留、舊決策／截斷紀錄拒絕、API 停止與操作鎖。未新增依賴。完整紀錄見 [VERIFICATION.md](../yomi-probe/VERIFICATION.md)。

人工核對畫面會顯示待送全文，僅供本機檢查，不能作為公開診斷。舊路線紀錄不一定含名稱；需依訊息 ID、文字、路線摘要及原規則到目的核對，無法確認就不要解除。成功只代表平台回應與紀錄保存，不代表已讀；無法做到跨平台 exactly-once。

未實測真實帳號或多日運作。圖片／檔案、回覆關聯、排程、新平台與 LINE 社群尚未支援。保留與封存、磁碟配額、DPAPI、跨平台工作隔離及中止／積壓壓力測試列為後續階段。權限檢查大量聊天室時可能較久；來源與目的權限仍須使用者確認。

## 實際查閱的參考

- [Telegram Bot API](https://core.telegram.org/bots/api)：retry_after、文字長度、getChatMember、受保護內容；只在明確限流時允許重試，其餘不明結果維持暫停。
- [Matterbridge README](https://github.com/42wim/matterbridge/blob/master/README.md)：多 gateway、媒體與回覆能力，作為後續範圍參考。
- [mautrix Telegram ROADMAP](https://github.com/mautrix/telegram/blob/master/ROADMAP.md)：媒體、編輯、歷史恢復能力。其橋接帳號能力不能直接視為 Telegram Bot 可用能力。

僅參考行為與產品取捨，沒有複製上游程式碼或增加平台依賴。
