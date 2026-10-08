# LINE Relay Bridge｜登入與轉送

本目錄包含 Yomi 0.5.0 登入頁、訊息讀取及「來源1 → 目的2」背景文字轉送。安裝、操作、資料保存及限制請看根目錄 [README](../README.md)，第三方來源請看 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)。

```powershell
npm ci --ignore-scripts
npm test
npm start
# 手機授權完成後，在另一個終端啟動背景服務：
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-relay.ps1
```

登入資料存放於 `%LOCALAPPDATA%\LineCallYomiProbe`；請勿提交或分享。即時狀態為 http://127.0.0.1:18766/status。LINE 社群及 Telegram 尚未支援。
