# LinePort 交接

## 最新：v0.7.1（2026-10-09）

使用者已確認：目的主要 LINE／Telegram 群組合計約 3–4 個；分析師 Call 主要文字、少量圖片。此前 v0.7.0 已發布，master `007e78b` 為發布證據文件，接續時工作目錄乾淨。

本次補上選取配對數與附件限制提示，Call 點選範例含續抱／加碼／減碼／出場；沒有改既有規則或預設行為。三來源到四目的共 12 組的 Mock 驗證：Call 帶謝謝與續抱共 24 次接受、路人／純寒暄排除、重啟不增加成功送達次數。136 項全套通過、本次 npm audit 已知漏洞 0，沒有新依賴。新提示只做 VM 驗證，沒有重新跑瀏覽器；公開圖片仍為 v0.7.0 合成畫面。

配置以每來源一條文字規則，獨立作者及必要關鍵字，送至同一組目的為主。Telegram 若啟用圖片，要拆 LINE 文字目的與 Telegram 媒體目的，避免重複配對；後者同時處理文字。無說明圖片仍受關鍵字阻擋。LINE 圖片／跨 LINE 媒體及 OCR 未支援，不宣稱完整圖片通道。

下一步需要去識別化文字範例（進場、續抱、出場等），確認只有代碼／價位的短 Call，才決定內容條件；無需提供真實帳號或憑證。目的 LINE／Telegram 各幾群尚未確定，教學用兩群加兩群作假設。維持 Mock、不自動啟動真實轉送，跨 LINE 圖片為後續工程。

v0.7.1 交付 commit／固定 tag：`c6b09d4d759141cb2b2d8e44302fea8f278543de`，已正常推送。[公開版本下載](https://github.com/b40609/LinePort/releases/tag/v0.7.1) 包含原始碼 ZIP（105 項、533,009 bytes）與 SHA256SUMS。ZIP 未包含私人資料路徑；本機 SHA-256 `96d1ea012f3634ca1b23339d32f71c83b5bf1950958e1990dc63b2663acd43cf` 與 GitHub 資產 digest 一致，版本頁、ZIP、SHA256SUMS 均回應 HTTP 200。後續文件 commit 補入發布證據，固定 ZIP 仍對應交付 tag。下方保留 v0.7.0 開發與研究記錄。

2026-10-09，v0.7.0，master。接續 v0.6.0 tag 5d76031597f66653dc3d2bd6d8913c513c925a67 及文件 commit fd85901；工作目錄 `C:\Users\user\Documents\ChatGPT\line_call`，Desktop 是捷徑。此次開始時沒有未提交變更。先確認實際 Git 狀態與目前內容，不覆蓋後續工作。

v0.5.0 完成第一階段基本能力，v0.6.0 新增作者白名單、Call 範本、搜尋／複製、hold／skip、Telegram 媒體、Discord 目的、工作隔離、容量／封存及 Bot DPAPI。v0.7.0 完成各來源文字／媒體模擬、預設關閉的回覆與持久 ID 對照、封存重新驗證及唯讀核對 CLI，並交付資料保留、壓縮設計及 Yomi／LINE 媒體與加密評估。原三階段的實作／設計／評估成果分別列於 [項目對照](docs/DEVELOPMENT-STATUS.md)，不把評估完成當成能力已支援。

主要程式在 yomi-probe。本次 reply-links 與 verify-archive；multi-relay 持久 queued／media_queued 後才發送，保存 replyVersion／replyTo 與成功 ACK destinationId，每配對各自對照。原訊息被篩掉／不明／人工確認無 ID 就送一般訊息，不補送原訊息；Telegram／Discord 同請求允許原訊息不存在，LINE 引用失敗暫停。每來源獨立工作、每目的序列化。原 JSONL、去重、待送與人工決策不刪改；未知媒體／回覆版本拒絕載入。設定版本仍 1、可選欄位，沒有資料庫 Schema 變更。不明發送不自動重送、不啟動真實服務。

133 項測試通過、0 失敗、0 跳過；較 v0.6.0 新增 19 項。npm audit 已知依賴漏洞 0、沒有新增依賴、Yomi 固定 0.5.0。使用獨立目錄及 Mock；Windows DPAPI 只測合成 Token。另實跑唯讀封存 CLI 有效／竄改案例。瀏覽器核對作者正反例、Call 帶謝謝、編輯回填及合成 Telegram 媒體預覽；390px／桌面無水平溢出、無瀏覽器警告或錯誤，18767 已無監聽。沒有讀真憑證／真發訊。詳見 [版本紀錄](docs/RELEASE-0.7.0.md)、[研究來源](docs/RESEARCH-0.7.0.md) 與 [驗證紀錄](yomi-probe/VERIFICATION.md)。

容量政策：單檔 16 MiB、已知紀錄合計 256 MiB、磁碟可用低於 64 MiB 停止；80% 預警。Telegram 收件 50,000 則、40,000 預警；每配對待送最多 1,000。私人封存複製原紀錄附 SHA-256 manifest，不含憑證但含私人文字／ID；不刪原檔、不釋放空間、不取代完整備份。達檔案容量上限仍需後續安全壓縮設計。保留所有未送及去重證據，不自行清理；任何刪除、資料庫 Schema 或不可逆遷移須先確認。

下一步優先依實際 Call 訊需求確認目的平台／群數、分析師固定 ID、文字及圖片比例。2–3 來源各自一條規則，LINE 群 17 人只列 2–3 位分析師；不要只靠「謝謝」排除字。Call 關鍵字需配合實際格式避免漏掉股票代碼／續抱短訊；不同來源同文不跨來源合併。[設定方案](docs/CALL-ROUTING.md)。未取得真實帳號測試授權前繼續 Mock。

仍未支援／未驗證：跨 LINE 媒體、相簿整組／音訊／影片、編輯／刪除同步、達容量後安全壓縮、LINE 登入與 E2EE 完整加密、朋友端／多日／硬體斷電驗證。媒體預覽與回覆持久對照本版已完成。Yomi OBS 下載無串流大小上限，credentialStore 外有獨立 E2EE；不能直接接上或單改 store。研究文件提供可回復遷移方案，未自動遷移、刪檔或改資料庫 Schema。LINE 社群 OpenChat、Slack、Discord 來源／私訊／討論串未支援。不要宣稱全部漏洞已清除或保證送達。

安全診斷可分享；設定備份、私人封存及完整資料不可公開。Bot Token DPAPI 選用、綁原 Windows 帳號，舊明文檔保留；LINE 登入／E2EE 及訊息仍未加密。受保護檔損壞不退回舊 Token，換機重新連結。新作者、時段、媒體與人工決策不能直接用舊版處理；回復需先停止並規劃一致的程式與完整私人備份。保持單一程序使用同一資料目錄。

[v0.7.0 固定版本下載與 SHA-256](https://github.com/b40609/LinePort/releases/tag/v0.7.0)

v0.7.0 交付 commit／固定 tag：`7474b93085aeb1cb93e2c93c434dce51f5fa8b31`，已正常推送。原始碼 ZIP 共 103 項、526,271 bytes，沒有私人資料路徑。本機 SHA-256 `59108d6f2a9b4104d7be8188ca2e58d390d149f5f1e9abbbaa3ab39708e0495f` 與 GitHub 資產 digest 一致。版本頁、ZIP、SHA256SUMS 及 HTTPS 手機 JPEG 均回應 HTTP 200。後續文件 commit 補入發布證據，固定 ZIP 仍對應交付 tag；前次 v0.6.0 證據保留在歷史驗證紀錄。

使用者以手機回報前次本機截圖無法載入，已改提供可公開的合成畫面：[HTTPS 手機畫面](https://raw.githubusercontent.com/b40609/LinePort/v0.7.0/docs/assets/preview-mobile-0.7.jpg)。不發布使用者的附件。完成交付後要接續討論跨軟體多來源／多目的 Call 訊配置，確認目的平台／群數與去識別化樣本，不需再詢問是否繼續開發。
