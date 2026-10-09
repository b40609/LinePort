# v0.6.0 實際查閱與取捨

2026-10-09。依 agent-reach 的網頁／GitHub 只讀路由取得官方文件及公開原始文件；CLI 不在本機 PATH，未安裝或擴充權限。只參考行為，沒有複製第三方程式碼；未新增平台依賴。

| 實際查閱來源 | 結論與本版取捨 |
| --- | --- |
| [Telegram Bot API](https://core.telegram.org/bots/api) | 同一 Bot 可重用 file_id；sendPhoto 10 MB、sendDocument 50 MB、caption 1,024 字元。採十進位 10／50 MB 本機限制並依平台拒絕結果處理；不下載暫存。受保護、付費或限時內容不轉。sender_chat 只能辨識聊天室。 |
| [Discord Message](https://docs.discord.com/developers/resources/message) | 文字 2,000 字元，明確關閉 allowed_mentions 及連結預覽。nonce／enforce_nonce 只有短時間語意，不當作跨重啟 exactly-once 證據。 |
| [Discord Rate Limits](https://docs.discord.com/developers/topics/rate-limits) | 有效 429 retry_after 才自動重試，期限持久化；保守暫停該 Bot 平台全部目的，避免猜測 bucket。未知錯誤或缺回應 ID 暫停人工核對。未實作完整 proactive bucket 排程。 |
| [Discord Gateway](https://docs.discord.com/developers/events/gateway) | 來源收件會涉及 Gateway／Message Content 等權限與狀態。本版選官方 REST 的純目的，縮小權限與維運範圍，未做 Discord 來源。 |
| [Matterbridge README](https://github.com/42wim/matterbridge/blob/master/README.md) | 多 gateway 與媒體是常見需求；本版保留每配對可靠狀態，只做可驗證的 Telegram 媒體，未照搬多平台架構。 |
| [mautrix Telegram ROADMAP](https://github.com/mautrix/telegram/blob/main/ROADMAP.md) | 媒體、編輯、歷史與回覆需要額外狀態；使用者橋接能力不能直接套用到官方 Bot。回覆關聯留待持久 ID 對照設計。 |
| [Microsoft ProtectedData](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata) | Windows CurrentUser DPAPI 綁原使用者。本版選用保護 Bot Token，傳遞只走子程序 stdin／stdout，不放命令列；換機重新連結。 |

Telegram 本機檢查採十進位 MB，避免把較大的 MiB 當成平台上限；平台仍可能因尺寸、比例或權限拒絕，不明發送暫停並保留證據。

本機 Yomi 0.5.0 原始碼確認：service 接受 credentialStore，介面有 get／set／save／clearAll；原有 keychain／明文 fallback 及損壞處理，另有 line_e2ee_public_、line_e2ee_group_by_mid 的獨立暫存持久化。只替換 credentialStore 不足以保護所有登入與 E2EE，也不能直接沿用損壞時空白 fallback。故 LINE 全面加密尚未遷移，後續需完整盤點、失敗拒絕、回復備份及假資料驗證。

Yomi 有 sendImage／sendFile 與 OBS 功能，但來源媒體解密、大小驗證、受保護內容及發送不明恢復還未完成端到端驗證。存在 OpenChat 模組也不代表目前帳號、權限及歷史讀取可靠；LINE 社群保持未支援，不宣稱已有能力。
