# v0.8.0：人員選取、故障隔離與跨平台圖片

2026-10-10。讓多來源／多目的設定更容易核對，保留發送不明不自動重送的原則。

- LINE 來源可勾選已加入成員，包括尚未發言的人；邀請中成員不列入。無成員資料時改列最近發訊者並提示，Telegram 仍只列最近發訊者。固定 ID 可手動調整，每來源最多 20 人。
- 規則摘要顯示各來源只轉指定幾人；保存／編輯回填及模擬正反例已驗證，模擬不發訊。
- 補上三來源到四目的（12 配對）的 Telegram 限流、LINE 不明、來源斷線、重啟恢復與去重隔離測試。
- 選用 Telegram → LINE JPEG／PNG 圖片：最多 10 MB，記憶體下載及大小／檔頭檢查，圖片先送、說明另送。圖片／說明任一步結果不明即暫停此配對；晚到的圖片回應不能再發說明，重啟不重送。
- LINE 目的遇到檔案時保留待送並暫停該配對，其他 Telegram 配對繼續；模擬會顯示差異與處理原因。

148 項測試通過，0 失敗／跳過；本次 npm audit 已知依賴漏洞 0。桌面 1280px 與手機 390px 無水平溢出，瀏覽器警告／錯誤為空。本次使用合成資料、Mock 與獨立目錄，沒有啟動真實轉送。[完整驗證](../yomi-probe/VERIFICATION.md)

## 下載與更新

[版本頁](https://github.com/b40609/LinePort/releases/tag/v0.8.0) · [ZIP](https://github.com/b40609/LinePort/releases/download/v0.8.0/LinePort-v0.8.0.zip) · [SHA-256](https://github.com/b40609/LinePort/releases/download/v0.8.0/SHA256SUMS.txt) · [使用教學](USAGE.md) · [來源與篩選](ROUTING.md)

固定版本原始碼 ZIP，需要 Node.js 與 npm，尚無 EXE 或自動更新。

1. 停止轉送並結束原本的設定服務；私下備份完整資料目錄及自行修改的程式，保留舊程式。
2. 下載 ZIP 與 SHA256SUMS.txt，以 `Get-FileHash .\LinePort-v0.8.0.zip -Algorithm SHA256` 核對，不一致就不要執行。
3. 解壓到新目錄，於 yomi-probe 執行 `npm.cmd ci --ignore-scripts` 及 `npm.cmd test`。
4. 自行啟動 `npm.cmd start`，重新整理頁面、確認規則與待送狀態後，先用專用群組驗收新文字；圖片另外啟用測試。

既有規則不自動開啟媒體、時段或回覆。沒有新增依賴、資料庫 Schema、資料格式遷移或刪除；保留私人設定及既有待送／去重證據。新版媒體設定可能含舊版不接受的混合目的，不可直接用舊程式處理新版設定與資料。設定備份不含憑證，也不是完整資料備份。

## 限制

LINE 來源附件、LINE 目的檔案、貼圖及 OCR 尚未支援。LINE 圖片不能同時保留回覆關聯；圖片與說明並非原子發送，人工處理時需核對兩部分。下載只檢查大小及檔頭，不是完整解碼或安全掃描；重啟需要 Telegram Bot 仍能取得附件。

Telegram → LINE 圖片、完整跨平台文字與多目的、長期運作仍待真實平台驗收。先前已讀實測限 v0.7.2 與當時條件，不保證新版或所有情況不產生已讀。[驗收表](LIVE-ACCEPTANCE.md) · [已讀結果](READ-RECEIPT-2026-10-10.md) · [安全限制](../SECURITY.md)
