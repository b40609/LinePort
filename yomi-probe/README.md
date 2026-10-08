# LinePort：登入、一般群組收訊與轉送

從 [專案 README](../README.md) 開始。第一次安裝請看 [安裝教學](../docs/INSTALL.md)，日常操作見 [使用教學](../docs/USAGE.md)，故障見 [疑難排解](../docs/TROUBLESHOOTING.md)。

- `npm ci --ignore-scripts`：安裝固定依賴。
- `npm test`：執行模擬測試，不發真實訊息。
- `npm start`：啟動本機登入頁。
- `start-relay.ps1 -Interactive`：貼上完整來源／目的名稱後啟動背景轉送。
- `stop-relay.ps1`：停止由此專案啟動器啟動的背景轉送。

本工具使用非官方個人 LINE 協定，有帳號限制風險。登入與 E2EE 資料不得分享；[安全說明](../SECURITY.md) 有完整限制與修正紀錄。
