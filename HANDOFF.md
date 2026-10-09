# LinePort 交接

2026-10-09，v0.6.0，master。接續已發布 v0.5.0 commit 7523bef6b03c63f1c7dc8b56bc5bbbedd12f5674；工作目錄 `C:\Users\user\Documents\ChatGPT\line_call`，Desktop 是捷徑。此次開始時沒有未提交變更。先確認實際 Git 狀態與目前內容，不覆蓋後續工作。

v0.5.0 第一階段已有引導、規則摘要／純文字預覽、逐筆人工處理、安全診斷、排除憑證的設定備份／驗證還原及版本 ZIP／SHA-256。v0.6.0 新增每來源指定作者、Call 範本、搜尋／複製、台北時段 hold／skip、同 Bot Telegram 圖片／檔案、Discord 官方文字目的、來源／待送工作隔離、容量預檢與保留原檔的私人封存、選用 Bot Token DPAPI。三階段清單尚未全部完成。

主要程式在 yomi-probe。新 rule-options、source-senders、media-payload、storage-health、bot-credentials／dpapi、discord 模組；multi-relay 持久 queued／media_queued 後才發送，每來源獨立工作、每目的序列化。server API 仍驗證本機權杖、停止狀態及操作鎖。原 JSONL、去重、待送與人工決策不刪改；未知媒體版本拒絕載入。設定版本仍 1，僅增加可選欄位，沒有資料庫 Schema 變更。不明發送不自動重送、不啟動真實服務。

114 項測試通過、0 失敗、0 跳過；較 v0.5.0 新增 32 項。npm audit 已知依賴漏洞 0、沒有新增依賴、Yomi 固定 0.5.0。使用獨立目錄及 Mock；Windows DPAPI 只測合成 Token。瀏覽器以 ui-mock 的 18767 假服務核對作者正反例、純寒暄、有 Call 帶謝謝、編輯、搜尋、暫停複本及假 Discord 連結。沒有讀真憑證／真發訊。詳見 [版本紀錄](docs/RELEASE-0.6.0.md)、[研究來源](docs/RESEARCH-0.6.0.md) 與 [驗證紀錄](yomi-probe/VERIFICATION.md)。

容量政策：單檔 16 MiB、已知紀錄合計 256 MiB、磁碟可用低於 64 MiB 停止；80% 預警。Telegram 收件 50,000 則、40,000 預警；每配對待送最多 1,000。私人封存複製原紀錄附 SHA-256 manifest，不含憑證但含私人文字／ID；不刪原檔、不釋放空間、不取代完整備份。達檔案容量上限仍需後續安全壓縮設計。保留所有未送及去重證據，不自行清理；任何刪除、資料庫 Schema 或不可逆遷移須先確認。

下一步優先依實際 Call 訊需求確認目的平台／群數、分析師固定 ID、文字及圖片比例。2–3 來源各自一條規則，LINE 群 17 人只列 2–3 位分析師；不要只靠「謝謝」排除字。Call 關鍵字需配合實際格式避免漏掉股票代碼／續抱短訊；不同來源同文不跨來源合併。[設定方案](docs/CALL-ROUTING.md)。未取得真實帳號測試授權前繼續 Mock。

後續未完成：跨 LINE 媒體及媒體預覽、回覆 ID 持久對照、相簿／音訊／影片、編輯／刪除同步、達容量後安全壓縮、LINE 登入與 E2EE 完整加密、朋友端／多日／硬體斷電驗證。已檢查 Yomi credentialStore，但獨立 E2EE 儲存不能靠單一 store 取代；需完整假資料遷移／回復設計。LINE 社群 OpenChat、Slack、Discord 來源／私訊／討論串未支援。不要宣稱全部漏洞已清除或保證送達。

安全診斷可分享；設定備份、私人封存及完整資料不可公開。Bot Token DPAPI 選用、綁原 Windows 帳號，舊明文檔保留；LINE 登入／E2EE 及訊息仍未加密。受保護檔損壞不退回舊 Token，換機重新連結。新作者、時段、媒體與人工決策不能直接用舊版處理；回復需先停止並規劃一致的程式與完整私人備份。保持單一程序使用同一資料目錄。

[v0.6.0 固定版本下載與 SHA-256](https://github.com/b40609/LinePort/releases/tag/v0.6.0)
