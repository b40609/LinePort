# LinePort v0.3.0

LINE／Telegram 多來源、多目的純文字轉送。從 [專案 README](../README.md) 開始。

- `npm ci --ignore-scripts`：安裝固定依賴。
- `npm test`：模擬測試，不讀取真實憑證、不發真實訊息。
- `npm start`：啟動本機設定頁 18765。
- `node ui-mock.mjs`：啟動獨立示範頁 18767，不連線 LINE／Telegram；輸入 stop 或 Ctrl+C 停止，10 分鐘自動結束。
- `stop-relay.ps1`：停止此 checkout 啟動器建立的背景程序。
- `start-relay.ps1 -Interactive`：保留的舊版單配對名稱設定；新版請從網頁保存並啟動多規則。

[安裝](../docs/INSTALL.md) · [使用與更新](../docs/USAGE.md) · [疑難排解](../docs/TROUBLESHOOTING.md) · [架構](../docs/ARCHITECTURE.md) · [驗證](VERIFICATION.md)

登入、E2EE、Bot Token 及 Telegram 來源文字保存在本機，勿分享。[安全說明](../SECURITY.md)
