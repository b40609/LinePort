# 裝置相容性與設計原則

更新：2026-10-21。LinePort 的設計不應綁定「Windows 電腦＋iPhone」。目前主機實作只支援 Windows；這與主要裝置、官方 LINE 電腦版及協定登入身分是不同的相容性問題。

## 三個獨立面向

| 面向 | 決定的行為 | 目前狀態 |
| --- | --- | --- |
| 執行 LinePort 的主機 | 資料目錄、檔案權限、憑證保護、背景程序與啟停 | Windows 11 已實測；macOS／Linux 尚未移植 |
| 授權登入的 LINE 主要裝置 | 在 LINE 中允許追加登入、掃碼、PIN 或生物辨識授權 | 程式不檢查 iPhone／Android 品牌或 OS；不同裝置組合仍需實機驗收 |
| LinePort 的 LINE 協定身分 | 向 LINE 宣告的裝置類型、登入流程、Token／E2EE 及獨立資料 | 帳號連結頁可選 `DESKTOPMAC`、`DESKTOPWIN`、`IOSIPAD`；切換需重啟 |

`IOSIPAD` 不要求擁有 iPad；其中的 iOS 版本不是主要裝置的最低版本。`DESKTOPMAC`／`DESKTOPWIN` 也不限定主機種類。由使用者依工作需求選擇，不依 `process.platform` 或主要裝置品牌自動決定。

## 依需要保留的官方裝置選擇

| 使用者需求 | 可選身分 | 對應登入方式 |
| --- | --- | --- |
| A 用戶要同時使用 LinePort 與官方 Windows 電腦版 LINE | `IOSIPAD` | iPad secondary QR／PIN；本次單一帳號共存通過 |
| B 用戶需要保留官方 iPad LINE，讓 LinePort 使用 Windows 桌面登入 | `DESKTOPWIN` | 既有主要裝置 passwordless 授權流程；真實登入及共存待驗收 |
| 沿用既有桌面授權 | `DESKTOPMAC` | 既有主要裝置 passwordless 授權流程；可能影響官方電腦版登入 |

在「帳號連結」選身分並按「切換身分並重啟服務」。先保存編輯及停止轉送；登入或其他操作進行中不得切換。新程序準備成功後才釋放舊服務的監聽埠，啟用失敗則恢復原服務。切換後不自動登入或啟動轉送；各身分的 LINE 登入／E2EE、Telegram／Discord 連結、規則與轉送紀錄全部隔離，不能直接複製登入檔。

一般啟動器重用目前模式；完全停止後預設仍是 `DESKTOPMAC`，可用 `啟動Windows實驗模式.cmd` 或 `啟動iPad實驗模式.cmd` 直接重開所需模式。這些選項位於 master 原始碼，既有 v0.8.3 ZIP 尚未包含。

[LINE 官方說明](https://help.line.me/line/smartphone/sp?contentId=20000132&lang=zh-Hant)區分主要與追加裝置，列出 iPhone、Android、iPad 與電腦等類型。這只說明官方 App 能力，不能推導本非官方工具已支援所有組合，或每類追加裝置都有永久獨立的登入名額。

## 共存驗證矩陣

| 組合／情境 | 驗證結果 |
| --- | --- |
| Windows LinePort＋`IOSIPAD`＋同帳號官方 Windows LINE | 單一帳號完成 QR 授權、目錄讀取、重啟恢復；使用者確認官方電腦版仍能收發 |
| Windows LinePort＋`DESKTOPWIN`＋同帳號官方 iPad LINE | 待實機驗收；本輪僅通過設定標頭、授權路徑、資料隔離、啟動與切換的合成測試 |
| 上述組合的 iPad 身分訊息解密、轉送、多日運作 | 待驗收 |
| Android 與 iPhone 主要裝置分別驗收 | 未建立分組實機證據，不能把單一帳號結果外推成兩者均已通過 |
| 官方 Mac LINE 與 LinePort 共存 | 待實測；官方 App 能安裝不代表已通過本工具驗收 |
| 已使用其他 iPad／Android 平板等追加裝置 | 待實測；新增登入仍可能影響既有工作階段 |
| LinePort 本身執行於 macOS／Linux | 未支援；只有 Node.js 並不足以執行現行主機整合 |

「可完成登入」、「可讀目錄」、「可解密／轉送」與「不影響其他裝置」須分別驗證。[本次實機與 Mock 證據](ACCEPTANCE-2026-10-21.md)沒有涵蓋上述所有組合。

## 實作邊界與擴充方式

目前已有協定身分集中設定，但主機整合尚未完成跨作業系統抽象。後續依下列邊界擴充：

- **LINE 身分與登入流程**：`yomi-probe/line-device.mjs` 集中允許三種身分，`qr-login.mjs` 實作 iPad secondary QR；桌面身分保留 Yomi 的主要裝置授權入口，不提供未實作的桌面 QR。Windows 版本欄位依 [linejs 固定參考](https://github.com/evex-dev/linejs/blob/4fc512ab8c19a2490ca73bb71777beb775ca3ae3/packages/linejs/base/core/utils/devices.ts)採 `DESKTOPWIN / 9.7.0.3556 / WINDOWS / 10.0.0-NT-x64`；這不是 LINE 官方認證或實機成功證據。不得只換裝置標頭就宣稱新平台可用。LINE 傳輸設定為程序共用，`device-restart.mjs` 透過獨立程序切換，不同程序才可使用不同身分。
- **主要裝置授權**：介面使用「主要裝置」、「PIN／生物辨識」等通用提示，由 LINE 決定認證方式；不以 Face ID／Touch ID 當作唯一入口，也不執行帳號移動或註冊主要裝置。
- **主機服務**：`runtime.mjs`、PowerShell 啟動器、`relay-controller.mjs` 與 `dpapi.mjs` 包含 Windows 整合。移植時需分開提供資料根目錄、使用者存取權限、憑證儲存及程序生命週期，保留相同資料隔離與錯誤行為；不得以跳過 ACL 或改存明文冒充相容。
- **轉送核心**：規則、固定聊天室／發訊者 ID、條件與去重邏輯沿用，不因手機 OS 或登入身分建立不同規則格式。
- **失敗處理**：不因 QR 失敗自動改為桌面身分、不從一種身分複製登入／E2EE 給另一種身分，避免再次登出使用者既有裝置。新增其他協定身分須具備獨立資料、對應登入實作與測試，不能開放任意字串。

新組合的實機驗收應記錄主機 OS、主要裝置類型與 LINE 版本、官方電腦版 OS／版本、所選協定身分及其他已登入追加裝置；依序核對登入、目錄、訊息解密、單次轉送、重啟去重及兩端持續收發。公開紀錄排除帳號、聯絡人、訊息、QR、PIN 與憑證。

[為何採用 iPad 身分及完整實驗紀錄](IPAD-EXPERIMENT.md) · [運作架構](ARCHITECTURE.md)
