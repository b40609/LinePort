# v0.8.1：LINE 自訂名稱與本機別名

LINE 中自己替朋友設定的名稱，可能與平台原始名稱不同。成員清單現在優先顯示平台回傳的自訂名稱，並保留原始名稱供核對；若平台未提供，可在 LinePort 填入本機別名。

選來源 → 展開進階設定 → 載入可選人員 → 填別名及勾選 → 加入選取人員 → 保存規則。別名隨這條規則保存，摘要與再次編輯會保留；複製規則、設定備份與還原也會保留。篩選仍只比對固定 ID，同名或改名不會讓其他成員通過。

152 項模擬測試通過，npm audit 已知依賴漏洞 0；瀏覽器合成資料確認保存、重新載入、摘要及編輯回填。已確認 Yomi 提供自訂名稱欄位，實際帳號是否回傳仍待實機驗收。本次沒有啟動真實轉送。

## 下載與更新

[版本頁](https://github.com/b40609/LinePort/releases/tag/v0.8.1) · [ZIP](https://github.com/b40609/LinePort/releases/download/v0.8.1/LinePort-v0.8.1.zip) · [SHA-256](https://github.com/b40609/LinePort/releases/download/v0.8.1/SHA256SUMS.txt) · [教學](USAGE.md)

1. 停止轉送並關閉設定服務，私下備份完整資料目錄，保留原程式。
2. 下載 ZIP 與 SHA256SUMS.txt，用 `Get-FileHash .\LinePort-v0.8.1.zip -Algorithm SHA256` 核對。
3. 解壓到新目錄，於 yomi-probe 執行 `npm.cmd ci --ignore-scripts`、`npm.cmd test`，再自行啟動 `npm.cmd start`。
4. 重新整理頁面，核對人員、規則與待送狀態，以專用群組測試。

沒有新增依賴、資料庫 Schema 或不可逆遷移。新別名欄位為選用，既有人員 ID 與轉送行為不變；舊版保存規則可能遺失別名，請勿以舊程式處理新版設定／待送資料。設定備份包含聊天室及人員 ID、名稱與別名，不含憑證；安全診斷排除這些名稱及 ID。LINE 媒體、跨平台與長期運作的既有限制仍適用，這次不擴大已讀實測結論。[安全說明](../SECURITY.md) · [驗證](../yomi-probe/VERIFICATION.md)
