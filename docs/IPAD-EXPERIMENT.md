# iPad 裝置共存實驗

目標：讓 LinePort 以 `IOSIPAD` 身分登入，與同帳號的官方電腦版 LINE 同時使用。單一真實帳號已在 Windows 環境通過 QR 登入、群組／好友讀取、重啟後恢復登入，並確認官方電腦版同時收發正常；iPad 模式的訊息解密與轉送仍待驗收。這是實驗功能，不代表完整支援官方 iPad 協定。

## 身分與實體裝置的差別

`IOSIPAD` 是 LinePort 向 LINE 宣告的協定登入身分，無需實體 iPad，也不限定主要裝置為 iPhone；QR 流程由主要裝置的 LINE 掃碼並授權，不依其作業系統分流。`IOSIPAD / 26.7.2 / iOS / 18.0` 是請求中的版本組合，不是使用者手機或主機的最低規格。原 `DESKTOPMAC` 同樣是協定身分。

採用此身分的原因是使用者回報原桌面登入會使官方電腦版登出；推測存在追加裝置登入衝突。改用另一類身分並配合對應 QR 流程後，本次單一帳號可共存。不能據此保證 Android、官方 Mac、已登入其他 iPad／平板等所有組合，也不能將官方 App 的支援清單視為本工具已驗收。[官方裝置類型](https://help.line.me/line/smartphone/sp?contentId=20000132&lang=zh-Hant) · [官方追加裝置登出原因](https://help.line.me/line/smartphone/?contentId=50001462&lang=zh-Hant)

本次沒有把預設值全面改成 iPad，亦不新增 iPhone 專用限制；目前 LinePort 主機仍只支援 Windows。macOS／Linux 執行支援屬於獨立的主機移植工作，見[相容性矩陣與設計原則](COMPATIBILITY.md)。此模式位於 `master` 原始碼，既有 v0.8.3 發布 ZIP 尚未包含。

帳號連結頁保留三種身分選擇：需要官方電腦版時可選 iPad QR；需要保留官方 iPad 時可測試 Windows 桌面身分（`DESKTOPWIN`，主要裝置授權，真實登入／共存尚未驗收）；原 Mac 桌面身分（`DESKTOPMAC`）也保留。iPad QR 不是所有使用者的唯一入口。

## 2026-10-21 實測結果

- 使用者完成手機 PIN／授權後，`loginV2` 回傳例外，畫面顯示 `LINE code 0`。本次未完成登入，因此尚未進入共存與轉送驗收。
- [SecondaryPwlessLoginErrorCode 定義](https://github.com/DeachSword/CHRLINE-Thrift/blob/49aed159e08d8db368add63fddc6c63562187068/subs/Types.thrift)將 `0` 定義為 `INTERNAL_ERROR`；它不是成功碼，也不是明確的 `NOT_SUPPORTED`。僅憑此代碼無法判定裝置限制、協定差異或暫時性伺服器問題。
- 更換裝置身分並沿用 Yomi 手機 passwordless 流程的組合本次失敗，不能交付為可與電腦版共存的解法。不要求重複相同授權，也不自動退回可能使電腦版登出的桌面身分。
- 已新增獨立 QR 登入流程，依據 [linejs 登入實作](https://github.com/evex-dev/linejs/blob/4fc512ab8c19a2490ca73bb71777beb775ca3ae3/packages/linejs/base/login/mod.ts)使用 `createQrCodeForSecure` 與 `qrCodeLoginV2ForSecure`，涵蓋 QR／PIN、Token 保存與 E2EE 匯入。實機已成功取得 QR Code；尚未證明最終登入、恢復登入或電腦版共存成功。
- 首次 QR 測試逾時。另以不輸出憑證的實機診斷確認 LINE 回傳 `longPollingMaxCount=2`、`longPollingIntervalSec=150`；原實作將間隔縮成 30 秒，已修正為遵循伺服器等待時間，並保留六分鐘總上限。
- 等待時間修正後，實機已通過掃碼等待，但 `createPinCode` 回傳 `LINE code 100`；QR 專用錯誤列舉將其定義為 `INVALID_CONTEXT`。比對參考實作後補上 PIN 前的 `verifyCertificate` 步驟。
- 補上認證書步驟後，使用者實測回報 `iPad QR 實驗：完成 QR 裝置登入失敗（LINE code 4）`；失敗點已推進到 `qrCodeLoginV2ForSecure`。依同一 QR 錯誤列舉，`4` 是 `VERIFICATION_NOTICE_FAILED`，不同於 `3: NOT_ALLOWED_QR_CODE_LOGIN`，不能據此斷言 iPad 不受支援。
- 曾測試讓所有 QR 請求攜帶臨時 `X-Line-Access`，依據為另一專案對官方 Windows 26.3.0.3916 的[協定追蹤紀錄](https://github.com/ergs0204/line-message-personal/blob/906c8119190087636b2d4be48ad95b465f7e2757/PROTOCOL.md)。本機 IOSIPAD 實測在產生 QR 階段即失敗；無需手機授權的對照請求顯示，不帶標頭時 HTTP 200／164 bytes／可解碼 REPLY，帶標頭時 HTTP 200／34 bytes／無法依現有格式解碼。已撤回此改法，臨時存取與等待標頭仍僅限長輪詢；不使用既有帳號 Token。
- 將 ForSecure 最終請求的 `autoLoginIsRequired` 由 `true` 改為 `false` 後，使用者實測仍回傳 `LINE code 4`；本輪無法解決最終登入失敗。
- 重新比對 [linejs 裝置分流](https://github.com/evex-dev/linejs/blob/4fc512ab8c19a2490ca73bb71777beb775ca3ae3/packages/linejs/base/core/utils/devices.ts)與上述登入實作，確認 `isV3Support` 不包含 `IOSIPAD`，其預設走 `requestSQR`（`createQrCode → qrCodeLogin`），原先直接套用 ForSecure 與參考實作的 iPad 預設不一致。目前已改為此流程：最終請求欄位為 session、`IOSIPAD`、autoLogin=true；回應從欄位 2／4／5 取得 Token／E2EE／mid，不要求 nonce 或 TokenV3，也不自行產生 Refresh Token 或有效期限。仍保留六分鐘上限、認證書與 PIN 步驟。
- 改走上述 iPad QR 流程後，使用者完成手機授權，畫面顯示「帳號已連結」。已通過登入時的 E2EE 金鑰匯入及帳號驗證，並成功讀取 46 個群組、356 位好友；尚未測試實際訊息解密。
- 停止並重新啟動 iPad 模式服務後，按「使用已保存的登入」成功恢復，無需重新掃碼；再次查詢目錄仍取得 46 個群組、356 位好友。使用者在此期間回報官方電腦版曾「離開座位太久被暫時登出，目前已重新登入」；其確切原因未確認，不能當作已證實的閒置逾時或互踢。電腦版重新登入後，LinePort 的保存登入與目錄查詢仍有效；使用者隨後確認官方電腦版「仍登入，收發正常」，通過本次單一帳號的同時登入及官方電腦版收發驗收。本輪未啟動背景轉送或對聯絡人發送訊息。

## 啟動與切換

本模式需 [master 原始碼 ZIP](https://github.com/b40609/LinePort/archive/refs/heads/master.zip)或更新後的 Git checkout；發布頁的舊版 ZIP 不含本模式。新版服務可直接在「帳號連結」選「iPad 身分（QR 實驗）」，先保存編輯及停止轉送，再按「切換身分並重啟服務」並等待頁面重載。切換不會自動登入或啟動轉送；新程序啟用失敗會恢復原服務。

舊服務尚無選單時，先完成下列停止步驟，再更新原始碼並於 `yomi-probe` 執行 `npm.cmd ci --ignore-scripts` 安裝鎖定依賴，之後啟動 iPad 模式。

1. 在舊頁面按「停止轉送」。關閉瀏覽器不會停止背景服務。
2. 在專案目錄執行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\yomi-probe\stop-server.ps1`。這只停止本專案啟動器建立的介面程序；若是 `npm start` 手動啟動，回原終端按 Ctrl+C。
3. 雙擊專案根目錄的 `啟動iPad實驗模式.cmd`。確認帳號區顯示「iPad 實驗模式」。
4. 保持官方電腦版 LINE 已登入，切到「帳號連結」，按「iPad QR Code 實驗登入」。以主要裝置的 LINE 掃描器掃描並授權；出現 PIN 時在主要裝置完成驗證。首次不可沿用桌面模式的保存登入。
5. QR Code 僅在本機產生，約六分鐘內有效；可按「取消 QR 登入」並重新申請，晚到的等待回應會被忽略。送出最終登入請求及後續金鑰初始化期間無法取消。若畫面失敗，保留階段及錯誤代碼，不需分享 QR Code 或 PIN。
6. 之後重新啟動同一 iPad 模式，可按「使用已保存的登入」；本次已驗證可恢復。只有登入失效時才重新掃碼授權。

也可在 PowerShell 手動執行：

```powershell
cd yomi-probe
$env:LINEPORT_LINE_DEVICE = 'IOSIPAD'
npm.cmd start
```

僅接受 `DESKTOPMAC`、`DESKTOPWIN` 和 `IOSIPAD`。未指定時預設仍是原 Mac 桌面身分，同一時間只能執行一種 LinePort 模式。一般啟動器會開啟目前模式；明確指定模式的啟動器遇到另一模式會拒絕重用，請從帳號頁切換。請從 iPad 模式頁面啟動背景轉送，使子程序繼承相同設定。

## 資料隔離

| 模式 | 資料目錄 |
| --- | --- |
| 原桌面模式 | `%LOCALAPPDATA%\LineCallYomiProbe` |
| Windows 桌面實驗模式 | `%LOCALAPPDATA%\LineCallYomiProbe-DESKTOPWIN` |
| iPad 實驗模式 | `%LOCALAPPDATA%\LineCallYomiProbe-IOSIPAD` |

登入憑證、登入認證書、E2EE、規則、Bot 設定與轉送紀錄全部分開。不要手動複製登入或 E2EE 檔案。既有規則可使用頁面的設定備份／還原，但不會帶入原本待送與去重進度；先用一條測試規則驗證。資料沿用既有 Windows ACL 保護。

## 實機驗收

1. 登入後確認官方電腦版仍能收發訊息，並載入 LinePort 的群組與好友。
2. 在測試來源發送一則新的文字，確認 LinePort 預覽可解密。
3. 建立一條測試轉送規則，開始轉送後再發新文字，確認目的收到一次；再次確認官方電腦版可收發。
4. 停止轉送、停止介面，重新啟動 iPad 模式並按「使用已保存的登入」，重複上述檢查。
5. 若官方電腦版被登出、iPad 授權失敗或無法解密，停止實驗，記錄失敗步驟與畫面狀態。不要反覆在兩端重登。日誌或畫面勿分享憑證與私人訊息。

回原模式：先停止轉送，在帳號頁選 Mac 桌面身分並切換；舊版沒有選單時，停止轉送和介面，再執行原本的 `啟動一般群組驗證.cmd`。手動執行時將環境變數改成 `DESKTOPMAC`。原資料保留，但 LINE 伺服器是否仍接受原憑證取決於實際登入狀態，必要時需重新授權。

## 實作依據與限制

- 裝置版本組合來自 [linejs devices.ts 固定版本](https://github.com/evex-dev/linejs/blob/4fc512ab8c19a2490ca73bb71777beb775ca3ae3/packages/linejs/base/core/utils/devices.ts)：`IOSIPAD / 26.7.2 / iOS / 18.0`。
- [LINE 官方 iPad 登入說明](https://help.line.me/line/IOSSecondary/?contentId=20018574&lang=zh-Hant)提供追加裝置登入流程；不代表官方保證此非官方程式可以共存。
- 保留 Yomi 0.5.0 的 passwordless、Talk 與 E2EE 流程，另接入 QR 登入；在匯入登入模組前設定共用 `LINE_APP_CONFIG`，涵蓋首次登入、恢復登入、Token 更新及背景服務。沒有修改 `node_modules`，重裝依賴後仍生效。
- QR 流程要求手機回傳的 E2EE 金鑰可成功匯入，不自行向 LINE 註冊替代金鑰。QR 認證書不與 passwordless 認證書共用。
- 本機完整測試 213 項通過、0 失敗／跳過。涵蓋三種身分與資料隔離、切換鎖定／程序重啟／失敗復原及停止工具辨識、QR 請求與回應欄位、無 nonce 的 QR、30 秒長輪詢與總時間上限、認證書／PIN 分支、工作階段標頭、code 0／4、逾時、立即取消與晚到回應、最終登入禁止取消、拒絕誤用 V3 回應、E2EE JSON 解析與本機 API 存取控制；不能取代真實帳號登入與共存驗收。詳見 [本輪檢查紀錄](ACCEPTANCE-2026-10-21.md)。
