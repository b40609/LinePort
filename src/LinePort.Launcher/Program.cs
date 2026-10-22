using System.Diagnostics;

if (args.Contains("--verify-package")) {
    var required = new[] { "runtime/node.exe", "runtime/LICENSE", "yomi-probe/start.ps1", "yomi-probe/upgrade-service.ps1", "yomi-probe/server.mjs", "yomi-probe/node_modules/@rikaidev/yomi/dist/line/core/service.js", "yomi-probe/node_modules/qrcode/lib/index.js", "yomi-probe/node_modules/tweetnacl/nacl-fast.js" };
    Environment.Exit(required.All(file => File.Exists(Path.Combine(AppContext.BaseDirectory, file))) ? 0 : 1);
    return;
}
ApplicationConfiguration.Initialize();
using var launchLock = new Mutex(false, "Local\\LinePort.Launcher");
try {
    if (!launchLock.WaitOne(0)) {
        MessageBox.Show("LinePort 正在啟動，請稍候。", "LinePort");
        return;
    }
} catch (AbandonedMutexException) { }
using var window = new Form {
    Text = "LinePort", Width = 460, Height = 180,
    StartPosition = FormStartPosition.CenterScreen,
    FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false
};
var label = new Label {
    Text = "正在啟動 LinePort…\n如有舊版，會自動停止並切換，請稍候。",
    Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter,
    Font = new Font("Microsoft JhengHei UI", 11)
};
window.Controls.Add(label);
var launching = true;
window.FormClosing += (_, e) => { if (launching) e.Cancel = true; };
window.Shown += async (_, _) => {
    try {
        var root = AppContext.BaseDirectory;
        var runtime = Path.Combine(root, "runtime");
        var script = Path.Combine(root, "yomi-probe", "start.ps1");
        if (!File.Exists(Path.Combine(runtime, "node.exe")) || !File.Exists(script))
            throw new InvalidOperationException("檔案不完整，請先將整個 Windows ZIP 解壓縮，再開啟 LinePort.exe。");
        var info = new ProcessStartInfo {
            FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"),
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        foreach (var arg in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script }) info.ArgumentList.Add(arg);
        info.Environment["PATH"] = runtime + Path.PathSeparator + Environment.GetEnvironmentVariable("PATH");
        using var process = Process.Start(info) ?? throw new InvalidOperationException("無法啟動本機服務。");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        await output;
        var details = await error;
        if (process.ExitCode != 0) {
            // Launcher errors contain no account files or message contents.
            throw new InvalidOperationException("啟動未完成，已避免關閉無法辨識的程序。\n請確認已完整解壓縮，並保留此訊息供排查。\n\n" + details[..Math.Min(details.Length, 1800)]);
        }
    } catch (Exception error) {
        MessageBox.Show(window, error.Message, "LinePort 啟動失敗", MessageBoxButtons.OK, MessageBoxIcon.Error);
    } finally { launching = false; window.Close(); }
};
Application.Run(window);
