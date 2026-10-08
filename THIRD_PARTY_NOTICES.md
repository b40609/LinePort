# 參考來源與第三方授權

## Yomi — 主要登入、收訊、E2EE 與發訊依賴

- 原始專案：[RikaiDev/yomi](https://github.com/RikaiDev/yomi)
- 固定套件：`@rikaidev/yomi` 0.5.0；完整相依版本見 `yomi-probe/package-lock.json`。
- 授權：[MIT License，Copyright (c) 2026 RikaiDev](https://github.com/RikaiDev/yomi/blob/main/LICENSE)。
- 本專案匯入 Yomi 的 LINE protocol service 與無密碼登入流程，自行實作本機頁面、背景輪詢、歷史排除及轉送紀錄；不是 Yomi 官方發行版，也不是 LINE 官方產品。
- 未將 Yomi 原始碼或 node_modules 複製進儲存庫。安裝或重新封裝第三方依賴時，應保留各依賴隨附的授權及著作權聲明；根目錄 MIT 授權只適用於本專案自有程式。
- [上游 issue #6：登入裝置識別與官方桌面登入衝突](https://github.com/RikaiDev/yomi/issues/6)，作為限制說明參考，不代表 Windows 長時間穩定性已獲保證。

## LINE 官方說明

- [以生物辨識登入其他裝置](https://help.line.me/line/smartphone/sp?contentId=20018577&lang=zh-Hant)：手機登入設定與授權流程參考。
- [登入認證碼相關說明](https://help.line.me/line/smartphone/sp?contentId=50001182&lang=zh-Hant)。

## 早期 Windows 通知診斷工具

- [Microsoft：Notification listener](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/notification-listener)。
- [Microsoft：Grant package identity](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/grant-identity-to-nonpackaged-apps)。
- `Microsoft.Data.Sqlite`、`SQLitePCLRaw.bundle_e_sqlite3`：版本見 `.csproj`，各套件授權以 NuGet 套件隨附聲明為準。

## 文件結構參考

- [ntfy](https://github.com/binwiederhier/ntfy)：產品簡介、操作畫面與文件入口。
- [Matterbridge](https://github.com/42wim/matterbridge)：支援範圍與設定說明。

僅參考文件組織方式，未複製程式碼、品牌圖像或文案。介面採 LINE 風格綠色與系統字型，未使用 LINE 官方商標或專有字型。
