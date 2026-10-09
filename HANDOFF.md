# LinePort 交接

2026-10-09，v0.7.0，master。接續 v0.6.0 tag 5d76031597f66653dc3d2bd6d8913c513c925a67 及文件 commit fd85901；工作目錄 `C:\Users\user\Documents\ChatGPT\line_call`，Desktop 是捷徑。此次開始時沒有未提交變更。先確認實際 Git 狀態與目前內容，不覆蓋後續工作。

v0.5.0 完成第一階段基本能力，v0.6.0 新增作者白名單、Call 範本、搜尋／複製、hold／skip、Telegram 媒體、Discord 目的、工作隔離、容量／封存及 Bot DPAPI。v0.7.0 完成各來源文字／媒體模擬、預設關閉的回覆與持久 ID 對照、封存重新驗證及唯讀核對 CLI，並交付資料保留、壓縮設計及 Yomi／LINE 媒體與加密評估。原三階段的實作／設計／評估成果分別列於 [項目對照](docs/DEVELOPMENT-STATUS.md)，不把評估完成當成能力已支援。

主要程式在 yomi-probe。本次 reply-links 與 verify-archive；multi-relay 持久 queued／media_queued 後才發送，保存 replyVersion／replyTo 與成功 ACK destinationId，每配對各自對照。原訊息被篩掉／不明／人工確認無 ID 就送一般訊息，不補送原訊息；Telegram／Discord 同請求允許原訊息不存在，LINE 引用失敗暫停。每來源獨立工作、每目的序列化。原 JSONL、去重、待送與人工決策不刪改；未知媒體／回覆版本拒絕載入。設定版本仍 1、可選欄位，沒有資料庫 Schema 變更。不明發送不自動重送、不啟動真實服務。

133 項測試通過、0 失敗、0 跳過；較 v0.6.0 新增 19 項。npm audit 已知依賴漏洞 0、沒有新增依賴、Yomi 固定 0.5.0。使用獨立目錄及 Mock；Windows DPAPI 只測合成 Token。另實跑唯讀封存 CLI 有效／竄改案例。瀏覽器核對作者正反例、Call 帶謝謝、編輯回填及合成 Telegram 媒體預覽；390px／桌面無水平溢出、無瀏覽器警告或錯誤，18767 已無監聽。沒有讀真憑證／真發訊。詳見 [版本紀錄](docs/RELEASE-0.7.0.md)、[研究來源](docs/RESEARCH-0.7.0.md) 與 [驗證紀錄](yomi-probe/VERIFICATION.md)。

容量政策：單檔 16 MiB、已知紀錄合計 256 MiB、磁碟可用低於 64 MiB 停止；80% 預警。Telegram 收件 50,000 則、40,000 預警；每配對待送最多 1,000。私人封存複製原紀錄附 SHA-256 manifest，不含憑證但含私人文字／ID；不刪原檔、不釋放空間、不取代完整備份。達檔案容量上限仍需後續安全壓縮設計。保留所有未送及去重證據，不自行清理；任何刪除、資料庫 Schema 或不可逆遷移須先確認。

下一步優先依實際 Call 訊需求確認目的平台／群數、分析師固定 ID、文字及圖片比例。2–3 來源各自一條規則，LINE 群 17 人只列 2–3 位分析師；不要只靠「謝謝」排除字。Call 關鍵字需配合實際格式避免漏掉股票代碼／續抱短訊；不同來源同文不跨來源合併。[設定方案](docs/CALL-ROUTING.md)。未取得真實帳號測試授權前繼續 Mock。

仍未支援／未驗證：跨 LINE 媒體、相簿整組／音訊／影片、編輯／刪除同步、達容量後安全壓縮、LINE 登入與 E2EE 完整加密、朋友端／多日／硬體斷電驗證。媒體預覽與回覆持久對照本版已完成。Yomi OBS 下載無串流大小上限，credentialStore 外有獨立 E2EE；不能直接接上或單改 store。研究文件提供可回復遷移方案，未自動遷移、刪檔或改資料庫 Schema。LINE 社群 OpenChat、Slack、Discord 來源／私訊／討論串未支援。不要宣稱全部漏洞已清除或保證送達。

安全診斷可分享；設定備份、私人封存及完整資料不可公開。Bot Token DPAPI 選用、綁原 Windows 帳號，舊明文檔保留；LINE 登入／E2EE 及訊息仍未加密。受保護檔損壞不退回舊 Token，換機重新連結。新作者、時段、媒體與人工決策不能直接用舊版處理；回復需先停止並規劃一致的程式與完整私人備份。保持單一程序使用同一資料目錄。

[v0.7.0 固定版本下載與 SHA-256](https://github.com/b40609/LinePort/releases/tag/v0.7.0)

前次 v0.6.0 發布證據保留在歷史驗證紀錄。v0.7.0 完成正常 commit／push、固定 tag、ZIP／SHA-256 發布後，於後續文件 commit 補入確切交付 SHA 與資產核對結果。

使用者以手機回報前次本機截圖無法載入，已改提供可公開的合成畫面：[HTTPS 手機畫面](https://raw.githubusercontent.com/b40609/LinePort/v0.7.0/docs/assets/preview-mobile-0.7.jpg)。不發布使用者的附件。完成交付後要接續討論跨軟體多來源／多目的 Call 訊配置，確認目的平台／群數與去識別化樣本，不需再詢問是否繼續開發。
