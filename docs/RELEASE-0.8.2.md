# v0.8.2：人員別名更容易辨認與保存

人員清單優先顯示你設定的本機別名，平台名稱另列供核對。平台未提供你在 LINE 設定的名稱時，可以自行填別名；特殊符號名稱也可辨識，篩選始終依固定帳號 ID，同名與改名不影響既有篩選。

切換來源、重新載入人員及保存規則時保留輸入欄位中的別名；編輯不同規則不混入上一條規則的別名。仍需按保存規則才會持久保留。沒有別名的規則摘要只顯示指定人數，固定 ID 保留在人員設定中供核對。

154 項 Mock 通過、0 失敗／跳過；npm audit 已知依賴漏洞 0。新增正式前端程式的合成 DOM／Mock API 編輯流程測試，未做本次瀏覽器視覺驗收、未啟動真實轉送。指定人員實機正反例尚待測試，不表示所有功能已驗收。[驗證紀錄](../yomi-probe/VERIFICATION.md)

## 下載與更新

[版本頁](https://github.com/b40609/LinePort/releases/tag/v0.8.2) · [ZIP](https://github.com/b40609/LinePort/releases/download/v0.8.2/LinePort-v0.8.2.zip) · [SHA-256](https://github.com/b40609/LinePort/releases/download/v0.8.2/SHA256SUMS.txt)

1. 停止轉送、關閉設定服務，私下備份完整資料目錄，保留原程式。
2. 下載 ZIP 與 SHA256SUMS.txt，用 `Get-FileHash .\LinePort-v0.8.2.zip -Algorithm SHA256` 核對。
3. 解壓到新目錄，在 yomi-probe 執行 `npm.cmd ci --ignore-scripts`、`npm.cmd test`，再自行啟動 `npm.cmd start`。
4. 重新整理頁面，核對指定人員、別名及待送狀態，再以專用群組驗收。

沒有新增依賴、資料庫 Schema 或不可逆遷移。設定備份包含人員 ID、名稱及別名，請私下保存；安全診斷排除這些資料。不以舊版保存新版規則或處理新版待送資料。LINE 來源媒體、跨平台及長期運作仍有既有限制，本次不擴大已讀實測結論。[使用教學](USAGE.md) · [安全說明](../SECURITY.md)
