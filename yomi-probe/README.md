# LinePort v1.2.0 (`yomi-probe`)

LINE／Telegram／Discord 多來源、多目的本機轉送核心與管理伺服器。請從 [專案 README](../README.md) 開始閱讀。

- `npm ci --ignore-scripts`：安裝固定依賴。
- `npm test`：執行離線模擬與整合測試，不讀取真實憑證、不對外發送訊息。
- `node verify-release.mjs --ci`：執行版本一致性、未驗證項目揭露、入口語法與識別碼遮罩檢查。
- `npm start`：啟動本機設定頁 `127.0.0.1:18765`。
- `node ui-mock.mjs`：啟動純記憶體獨立示範頁 `127.0.0.1:18767`，不連線外部平台；10 分鐘自動結束。
- `stop-relay.ps1`：停止此目錄啟動的背景轉送程序（`18766`）。

[安裝](../docs/INSTALL.md) · [使用與更新](../docs/USAGE.md) · [疑難排解](../docs/TROUBLESHOOTING.md) · [架構](../docs/ARCHITECTURE.md) · [驗證紀錄](VERIFICATION.md)

登入憑證、E2EE 金鑰、Bot Token 及訊息紀錄保存在本機 `%LOCALAPPDATA%`，切勿公開或分享。[安全說明](../SECURITY.md)
