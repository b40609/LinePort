using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

if (args.Contains("--verify-package")) {
    var required = new[] { "runtime/node.exe", "runtime/LICENSE", "yomi-probe/start.ps1", "yomi-probe/upgrade-service.ps1", "yomi-probe/server.mjs", "yomi-probe/autostart.mjs", "yomi-probe/health-alert.mjs", "yomi-probe/watchdog.ps1", "yomi-probe/install-watchdog.ps1", "yomi-probe/prune-versions.ps1", "yomi-probe/launcher-preference.mjs", "yomi-probe/compaction.mjs", "yomi-probe/network-errors.mjs", "yomi-probe/line-media.mjs", "yomi-probe/node_modules/@rikaidev/yomi/dist/line/core/service.js", "yomi-probe/node_modules/qrcode/lib/index.js", "yomi-probe/node_modules/tweetnacl/nacl-fast.js" };
    Environment.Exit(required.All(file => File.Exists(Path.Combine(AppContext.BaseDirectory, file))) ? 0 : 1);
    return;
}
ApplicationConfiguration.Initialize();
var trayOnly = args.Contains("--tray");
var withoutTray = args.Contains("--no-tray");
var launched = trayOnly;
if (!trayOnly) {
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
                throw new InvalidOperationException("程式檔案不完整，請重新執行 LinePort 安裝程式，再由桌面捷徑啟動。使用舊免安裝版時，請確認已完整解壓縮。");
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
                throw new InvalidOperationException("啟動未完成。請保留此訊息供排查；若檔案不完整，請重新執行安裝程式。\n\n" + details[..Math.Min(details.Length, 1800)]);
            }
            launched = true;
        } catch (Exception error) {
            MessageBox.Show(window, error.Message, "LinePort 啟動失敗", MessageBoxButtons.OK, MessageBoxIcon.Error);
        } finally { launching = false; window.Close(); }
    };
    Application.Run(window);
}
if (!launched || withoutTray) return;
// One tray per Windows session; later launches only start the service and exit.
using var trayLock = new Mutex(false, "Local\\LinePort.Tray");
try { if (!trayLock.WaitOne(0)) return; } catch (AbandonedMutexException) { }
Application.Run(new TrayContext());

/// <summary>
/// Lightweight status light. Reads only the de-identified diagnostics (phase and per-route counts) from
/// the local service using the page's one-time token; never message text, accounts or Bot tokens.
/// Exiting the tray leaves the background service and relay running.
/// </summary>
sealed class TrayContext : ApplicationContext {
    // LINEPORT_TRAY_PORT exists only so tests can point the tray at a mock service.
    static readonly string BaseUrl = "http://127.0.0.1:" + (int.TryParse(Environment.GetEnvironmentVariable("LINEPORT_TRAY_PORT"), out var port) && port is > 1024 and < 65536 ? port : 18765);
    static readonly Regex TokenPattern = new("const token='([a-f0-9]{64})'", RegexOptions.Compiled);
    readonly HttpClient http = new(new SocketsHttpHandler { UseProxy = false, AllowAutoRedirect = false, PooledConnectionLifetime = TimeSpan.FromMinutes(5) }) { Timeout = TimeSpan.FromSeconds(10) };
    readonly NotifyIcon icon = new();
    readonly System.Windows.Forms.Timer timer = new() { Interval = 15000 };
    readonly Dictionary<string, Icon> icons = new();
    readonly ToolStripMenuItem restartItem;
    string? token;
    string lastLevel = "";
    bool busy;

    public TrayContext() {
        foreach (var (name, color) in new[] { ("green", Color.FromArgb(6, 199, 85)), ("yellow", Color.FromArgb(240, 180, 0)), ("red", Color.FromArgb(220, 53, 69)), ("gray", Color.FromArgb(140, 150, 145)) })
            icons[name] = Dot(color);
        var menu = new ContextMenuStrip();
        menu.Items.Add("開啟本機頁面", null, (_, _) => OpenPage());
        restartItem = new ToolStripMenuItem("重啟轉送", null, async (_, _) => await RestartRelay());
        menu.Items.Add(restartItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("結束系統匣（保留背景服務）", null, (_, _) => ExitThread());
        icon.ContextMenuStrip = menu;
        icon.DoubleClick += (_, _) => OpenPage();
        icon.Icon = icons["gray"];
        icon.Text = "LinePort：檢查中…";
        icon.Visible = true;
        timer.Tick += async (_, _) => await Refresh();
        timer.Start();
        _ = Refresh();
    }

    static Icon Dot(Color color) {
        using var bitmap = new Bitmap(16, 16);
        using (var g = Graphics.FromImage(bitmap)) {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using var fill = new SolidBrush(color);
            using var edge = new Pen(Color.FromArgb(60, 0, 0, 0));
            g.FillEllipse(fill, 1, 1, 13, 13);
            g.DrawEllipse(edge, 1, 1, 13, 13);
        }
        return Icon.FromHandle(bitmap.GetHicon());
    }

    static void OpenPage() {
        try { Process.Start(new ProcessStartInfo(BaseUrl + "/") { UseShellExecute = true }); } catch { }
    }

    async Task<string?> Token(bool refresh) {
        if (token != null && !refresh) return token;
        var html = await http.GetStringAsync(BaseUrl + "/");
        var match = TokenPattern.Match(html);
        token = match.Success ? match.Groups[1].Value : null;
        return token;
    }

    async Task<HttpResponseMessage> Send(HttpMethod method, string route, string? json = null) {
        for (var attempt = 0; attempt < 2; attempt++) {
            var value = await Token(attempt > 0) ?? throw new InvalidOperationException("token");
            using var request = new HttpRequestMessage(method, BaseUrl + route);
            request.Headers.Add("X-Probe-Token", value);
            if (json != null) request.Content = new StringContent(json, Encoding.UTF8, new MediaTypeHeaderValue("application/json"));
            var response = await http.SendAsync(request);
            // The service rotates its token when it restarts; fetch the page again once.
            if (response.StatusCode != System.Net.HttpStatusCode.Forbidden) return response;
            response.Dispose();
        }
        throw new InvalidOperationException("forbidden");
    }

    async Task<JsonElement?> Diagnostics() {
        using var response = await Send(HttpMethod.Get, "/api/diagnostics");
        if (!response.IsSuccessStatusCode) return null;
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.Clone();
    }

    static (string level, string text) Summarize(JsonElement data) {
        var phase = data.TryGetProperty("phase", out var p) ? p.GetString() ?? "unavailable" : "unavailable";
        var line = data.TryGetProperty("lineConnected", out var c) && c.ValueKind == JsonValueKind.True;
        int total = 0, running = 0, blocked = 0, failed = 0, pending = 0, forwarded = 0;
        if (data.TryGetProperty("routes", out var routes) && routes.ValueKind == JsonValueKind.Array) {
            foreach (var route in routes.EnumerateArray()) {
                total++;
                var state = route.TryGetProperty("phase", out var rp) ? rp.GetString() : "";
                if (state == "running") running++; else if (state == "blocked") blocked++; else if (state == "failed") failed++;
                if (route.TryGetProperty("pending", out var pe) && pe.TryGetInt32(out var pv)) pending += pv;
                if (route.TryGetProperty("forwarded", out var fw) && fw.TryGetInt32(out var fv)) forwarded += fv;
            }
        }
        var label = phase switch {
            "running" => "轉送中", "degraded" => "部分路線受阻", "failed" => "轉送失敗", "blocked" => "需人工核對",
            "starting" => "啟動中", "stopped" => "已停止", _ => "狀態不明"
        };
        var level = phase switch {
            "running" => "green",
            "failed" or "blocked" or "unavailable" or "legacy" => "red",
            "stopped" => "gray",
            _ => blocked + failed > 0 ? "red" : "yellow"
        };
        if (phase == "degraded" && blocked + failed > 0) level = "red";
        var text = $"LinePort：{label}";
        if (total > 0) text += $"\n路線 {running}/{total} 正常" + (blocked > 0 ? $"，{blocked} 待核對" : "") + (failed > 0 ? $"，{failed} 失敗" : "");
        if (total > 0) text += $"\n已送 {forwarded}，待送 {pending}";
        if (!line) text += "\nLINE 未連線";
        return (level, text.Length > 127 ? text[..127] : text);
    }

    async Task Refresh() {
        if (busy) return;
        busy = true;
        try {
            var data = await Diagnostics();
            var (level, text) = data is { } value ? Summarize(value) : ("red", "LinePort：服務回應異常");
            Apply(level, text);
        } catch {
            token = null;
            Apply("red", "LinePort：本機服務沒有回應\n看門狗會嘗試重啟；也可從開始功能表重新開啟 LinePort");
        } finally { busy = false; }
    }

    void Apply(string level, string text) {
        icon.Icon = icons[level];
        icon.Text = text.Length > 127 ? text[..127] : text;
        if (lastLevel != "" && lastLevel != level && level == "red")
            icon.ShowBalloonTip(8000, "LinePort 需要注意", text.Replace("\n", "；"), ToolTipIcon.Warning);
        lastLevel = level;
    }

    async Task RestartRelay() {
        restartItem.Enabled = false;
        timer.Stop();
        try {
            using (var stop = await Send(HttpMethod.Post, "/api/relay/stop", "{}")) { }
            var stopped = false;
            for (var i = 0; i < 60 && !stopped; i++) {
                await Task.Delay(1000);
                var data = await Diagnostics();
                stopped = data is { } value && value.TryGetProperty("phase", out var p) && p.GetString() == "stopped";
            }
            if (!stopped) throw new InvalidOperationException("轉送沒有在 60 秒內停止；請開啟本機頁面查看。");
            using var start = await Send(HttpMethod.Post, "/api/relay/start", "{\"useRules\":true}");
            if (!start.IsSuccessStatusCode) {
                var body = await start.Content.ReadAsStringAsync();
                string message;
                try { message = JsonDocument.Parse(body).RootElement.GetProperty("error").GetString() ?? "請開啟本機頁面查看。"; }
                catch { message = "請開啟本機頁面查看。"; }
                throw new InvalidOperationException(message);
            }
            icon.ShowBalloonTip(5000, "LinePort", "已重新開始轉送。", ToolTipIcon.Info);
        } catch (Exception error) {
            icon.ShowBalloonTip(8000, "LinePort 重啟轉送未完成", error is InvalidOperationException && error.Message is not ("token" or "forbidden") ? error.Message : "無法連到本機服務；請開啟本機頁面查看。", ToolTipIcon.Error);
        } finally {
            restartItem.Enabled = true;
            timer.Start();
            await Refresh();
        }
    }

    protected override void ExitThreadCore() {
        timer.Stop();
        icon.Visible = false;
        icon.Dispose();
        http.Dispose();
        foreach (var value in icons.Values) value.Dispose();
        base.ExitThreadCore();
    }
}
