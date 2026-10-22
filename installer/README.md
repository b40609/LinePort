# Windows 安裝版

使用 Inno Setup 6.7.3 編譯 `LinePort.iss`。編譯器 Languages 目錄需有 [上游繁體中文語系檔](https://github.com/jrsoftware/issrc/blob/main/Files/Languages/ChineseTraditional.isl)，並保留其中的作者聲明。透過 `scripts/Build-Installer.ps1` 傳入已驗證的免安裝 payload、全新輸出目錄與 ISCC.exe 路徑。

每次安裝及同版修復均建立獨立 versions 子目錄，保留舊程式；不處理私人登入／轉送資料，也不在安裝時中止服務。新捷徑由啟動器完成可辨識舊服務的安全切換。安裝版本記錄會阻擋可辨識的降版。

隔離驗證可使用 `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LINEPORTSMOKE=1 /DIR=<全新測試目錄>`。此模式不註冊解除安裝、不建立捷徑、不執行 LinePort；只驗證解壓、版本目錄與安裝版本保護，不能當作 LINE 實機驗收。
