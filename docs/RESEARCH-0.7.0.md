# v0.7.0 研究與實作選擇

2026-10-09。透過可用的網路研究流程閱讀原始專案與官方文件，並檢查安裝中的 Yomi 0.5.0 程式介面；未複製第三方程式碼，未新增依賴。[前次媒體、Discord 與 DPAPI 研究](RESEARCH-0.6.0.md)

## 送達與回覆

- [Telegram ReplyParameters](https://core.telegram.org/bots/api#replyparameters)：同聊天室的 `allow_sending_without_reply` 可在原訊息不存在時繼續發送。本版只引用目的相同聊天室的有效 ID，不複製 quote 全文；文字與媒體都用單一請求，不以失敗再送一次實現退回。
- [Discord Message Reference](https://docs.discord.com/developers/resources/message#message-reference-structure)：`fail_if_not_exists: false` 提供同請求的一般訊息退回；本版停用提及，避免引用附帶通知原作者。Discord 仍只作一般文字目的。
- [Matterbridge](https://github.com/42wim/matterbridge)：多來源、多目的與媒體是常見橋接能力；本版以每配對已保存的 ACK 對照與佇列處理，保留工作隔離及不明結果暫停，沒有照搬整套 gateway 架構。
- [mautrix Telegram ROADMAP](https://github.com/mautrix/telegram/blob/main/ROADMAP.md)：回覆、媒體、歷史與編輯是分別需要狀態的能力。借鏡 ID 對照的責任分離，不能把個人帳號橋接支援範圍直接宣稱為 Bot API 能力。

本版只保存來源父 ID 與本路線成功送出的目的 ID。被篩掉／首次歷史／不明發送／人工確認但沒有 ID 的父訊息不會被補送。LINE 使用 Yomi 公開 `sendMessage` 的 relatedMessageId／messageRelationType 參數，維持既有 E2EE 公開發送流程；缺少可靠同請求退回，失敗即保留不明狀態，不再送一般訊息。

## LINE 媒體與社群評估

檢查本機 `@rikaidev/yomi` 0.5.0 的公開 sendImage／sendFile、OBS 與 E2EE：來源下載實作把全部 chunks 累積後 Buffer.concat，沒有應用層串流大小上限；有逾時不等於記憶體限額。跨平台還需確認來源解密、媒體類型／大小、受保護內容及目的 ACK 語意。因此沒有直接接上這個下載流程或修改 node_modules。

可回復的後續方案：新 adapter 先只接受已驗證類型；串流強制大小上限、檢查檔頭，不信任檔名；暫存放私人目錄並設定期限；待送保存穩定內容識別及有效性；發送前保存 sending，錯誤不盲目重試。以合成媒體完成損壞、超限、斷線、磁碟失敗、重啟及引用測試，再取得真實平台測試授權。清理暫存若需刪除，依使用者紅線先確認。未完成前 LINE 媒體保持未支援。

Yomi 有 OpenChat 模組，但本次沒有可靠的帳號權限、收件／補讀、加密及送達驗證。[Yomi 專案](https://github.com/RikaiDev/yomi)。LINE 社群保持未支援，不由模組名稱推論已可用。

## Yomi 儲存與 DPAPI 遷移評估

已確認 credentialStore 有 get／set／save／clearAll；另有獨立 E2EE 公鑰／群組儲存。只替換 credentialStore 會留下未加密的 E2EE，損壞時空白 fallback 也不符合本工具保守恢復原則。

[Microsoft ProtectedData](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata) 的 CurrentUser 綁定原 Windows 使用者。本版 Telegram／Discord Token 的選用保護已實作並使用合成 Token 測試；舊明文保留以便回復，受保護檔壞掉不退回舊明文。LINE 全面加密尚未遷移。

後續遷移需先盤點所有儲存介面，停止服務並保留完整原資料；在新目錄加密、核對解密一致性，再一次切換全部 store。模擬損壞、寫入失敗與中止時必須拒絕登入並保留原目錄；回復也必須切回完整一致資料，而非混用新舊 store。換機／換使用者需明確重新連結或另行設計受保護備份；不在本版自動遷移或刪除原憑證。
