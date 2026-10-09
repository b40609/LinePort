# 驗證紀錄

目前主要程式為 yomi-probe。v0.7.2（2026-10-10）全套 136 項 Mock 測試通過，npm 已知依賴漏洞掃描 0；包含指定發訊者、排程、媒體、Discord、積壓、程序中止、磁碟失敗及合成 Token 的 Windows DPAPI。[本版詳細證據與限制](yomi-probe/VERIFICATION.md)。以下為早期 C# 工具紀錄。

執行日期：2026-10-01。環境：Windows 11 build 26200，.NET SDK 10.0.204。

- Release x64 編譯通過，最終編譯沒有警告或錯誤。
- 本機套件註冊成功：`Ryan.LineCall.Diagnostics_3y0bchp7kwvet`。
- 實際視窗已開啟，Windows 回報程序有回應。
- 啟動診斷檔回報 `Ready=true`、`Permission=Allowed`，已取得套件身分與 Windows 通知 API。
- 16 項模擬檢查通過：原有 12 項，加上 Win32 LINE 身分、忽略表情符號與空白、OCR 成員數移除、排除一般預覽。
- v0.2 來源勾選、名稱修正、測試與說明按鈕已開啟並檢查排版。
- 使用者附件截圖 OCR 成功辨識 6 個名稱；部分有錯字，不能當作精確群名。
- 實際 LINE 清單可見時，畫面讀取成功辨識 6 個名稱；最小化時回報需還原。LINE 不支援 PrintWindow，改讀可見畫面的左側清單；沒有注入滑鼠鍵盤或切換聊天室。
- 通知API 探測：兩筆 Intel通知AppInfo 可讀；另有一筆通知 AppInfo 拋出 NotImplementedException 0x80004001，來源不明，未讀其內容。v0.2 對此略過並去重提示。
- 已修正初次還原出現的 SQLite 相依套件弱點警告，使用 `Microsoft.Data.Sqlite 10.0.12` 與 `SQLitePCLRaw.bundle_e_sqlite3 3.0.5`。

尚未驗證：三個真實 LINE 來源的通知、社群通知來源辨識、長訊息完整度、短時間連續訊息、鎖定畫面、24 小時穩定性。列表辨識成功不代表收訊成功。未對外發送訊息，尚未加入 Bot 轉發。
