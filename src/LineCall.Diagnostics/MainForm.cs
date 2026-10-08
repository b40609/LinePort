using System.Diagnostics;
using Windows.ApplicationModel;
using Windows.UI.Notifications;
using Windows.UI.Notifications.Management;

namespace LineCall.Diagnostics;

internal sealed class MainForm : Form
{
    private readonly string root;
    private readonly CaptureStore store;
    private readonly CheckedListBox sources = new() { Dock = DockStyle.Fill, CheckOnClick = true, IntegralHeight = false };
    private readonly NumericUpDown paneWidth = new() { Minimum = 220, Maximum = 800, Value = 375, Width = 65 };
    private readonly TextBox observations = new() { Multiline = true, ReadOnly = true, Dock = DockStyle.Fill, ScrollBars = ScrollBars.Vertical };
    private readonly Label status = new() { AutoSize = true, MaximumSize = new Size(850, 0) };
    private readonly Label count = new() { AutoSize = true };
    private readonly Button permission = new() { Text = "1. 授權通知存取", AutoSize = true };
    private readonly Button start = new() { Text = "2. 開始診斷", AutoSize = true };
    private readonly Button stop = new() { Text = "停止", AutoSize = true, Enabled = false };
    private readonly NotifyIcon tray;
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 500 };
    private readonly HashSet<string> savedThisSession = [];
    private readonly HashSet<string> observedTitles = [];
    private readonly HashSet<uint> unsupportedNotifications = [];
    private UserNotificationListener? listener;
    private string[] activeSources = [];
    private bool busy, initialSnapshot, exiting;
    private int snapshotLines, failures;
    private DateTimeOffset? lastScan;
    private DateTimeOffset? testUntil;
    private int testCaptured;

    public MainForm(string root)
    {
        this.root = root;
        store = new CaptureStore(Path.Combine(root, "captures.sqlite3"));
        Text = "LINE Call 通知診斷 v0.2 — 勾選來源";
        Size = new Size(1040, 840);
        MinimumSize = new Size(900, 720);
        Font = new Font("Microsoft JhengHei UI", 10);
        StartPosition = FormStartPosition.CenterScreen;
        Icon = SystemIcons.Information;
        foreach (var source in Settings.Load(SettingsPath).Sources) sources.Items.Add(source, true);

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(16), ColumnCount = 1, RowCount = 11 };
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 145));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(new Label { Text = "先讀取 LINE 列表，再勾選來源。表情符號不必輸入；只比對文字與數字。", AutoSize = true }, 0, 0);
        var discovery = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill };
        var readList = new Button { Text = "讀取 LINE 畫面列表", AutoSize = true };
        var importImage = new Button { Text = "匯入 LINE 截圖", AutoSize = true };
        var observe = new Button { Text = "觀察新通知並加入列表", AutoSize = true };
        var editName = new Button { Text = "修正選取名稱", AutoSize = true };
        discovery.Controls.AddRange([readList, importImage, observe, editName, new Label { Text = "左側清單寬度(px)", AutoSize = true, Padding = new Padding(0, 8, 0, 0) }, paneWidth]);
        layout.Controls.Add(discovery, 0, 1);
        layout.Controls.Add(sources, 0, 2);
        var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill };
        var save = new Button { Text = "套用勾選來源", AutoSize = true };
        var test = new Button { Text = "測試收訊（60秒）", AutoSize = true };
        var help = new Button { Text = "怎麼測試？", AutoSize = true };
        var export = new Button { Text = "匯出 JSONL", AutoSize = true };
        var folder = new Button { Text = "開啟資料夾", AutoSize = true };
        buttons.Controls.AddRange([permission, start, stop, save, test, help, export, folder]);
        layout.Controls.Add(buttons, 0, 3);
        layout.Controls.Add(status, 0, 4);
        layout.Controls.Add(count, 0, 5);
        layout.Controls.Add(new Label { Text = "讀列表時請讓 LINE 左側清單可見、不被遮住；只含目前可見項目。OCR 錯字可按「修正選取名稱」。", AutoSize = true, MaximumSize = new Size(950, 0) }, 0, 6);
        layout.Controls.Add(new Label { Text = "本次觀察與測試結果（僅本機）", AutoSize = true }, 0, 7);
        layout.Controls.Add(observations, 0, 8);
        layout.Controls.Add(new Label { Text = "關閉視窗會縮到系統匣；從系統匣選「結束」才會停止程式。", AutoSize = true }, 0, 9);
        layout.Controls.Add(new Label { Text = "通知被關閉、合併或截短時無法補回；無法辨識來源的 Windows 通知會略過。", AutoSize = true, MaximumSize = new Size(950, 0) }, 0, 10);
        Controls.Add(layout);

        var menu = new ContextMenuStrip();
        menu.Items.Add("顯示診斷視窗", null, (_, _) => Restore());
        menu.Items.Add("停止診斷", null, (_, _) => Stop());
        menu.Items.Add("結束", null, (_, _) => { exiting = true; Close(); });
        tray = new NotifyIcon { Icon = SystemIcons.Information, Text = "LINE Call 通知診斷：尚未開始", Visible = true, ContextMenuStrip = menu };
        tray.DoubleClick += (_, _) => Restore();
        permission.Click += async (_, _) => await RequestPermission();
        start.Click += async (_, _) => await Start();
        stop.Click += (_, _) => Stop();
        save.Click += (_, _) => SaveSources();
        readList.Click += async (_, _) => await DiscoverList(readList, null);
        editName.Click += (_, _) => EditSelectedName();
        importImage.Click += async (_, _) =>
        {
            using var dialog = new OpenFileDialog { Filter = "圖片|*.png;*.jpg;*.jpeg;*.bmp", Title = "選擇含 LINE 左側聊天室列表的截圖" };
            if (dialog.ShowDialog(this) == DialogResult.OK) await DiscoverList(importImage, dialog.FileName);
        };
        observe.Click += async (_, _) =>
        {
            if (!timer.Enabled) await Start();
            Append("等待新通知；能辨識 LINE 身分的通知標題會自動加入列表，預設不勾選。若群組沒有發通知，列表不會增加。");
        };
        test.Click += async (_, _) =>
        {
            if (sources.CheckedItems.Count == 0) { ShowHelp(); return; }
            if (!timer.Enabled) await Start();
            if (!timer.Enabled) return;
            testCaptured = 0; testUntil = DateTimeOffset.Now.AddSeconds(60);
            Append("收訊測試開始：60 秒內觀察勾選來源的新通知。請將 LINE 留在其他聊天室或最小化，等待來源自然收到訊息。程式不發送測試訊息。");
        };
        help.Click += (_, _) => ShowHelp();
        export.Click += (_, _) => Export();
        folder.Click += (_, _) => Process.Start(new ProcessStartInfo(root) { UseShellExecute = true });
        timer.Tick += async (_, _) => await Poll();
        FormClosing += (_, e) =>
        {
            if (!exiting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); }
        };
        FormClosed += (_, _) => { timer.Stop(); tray.Dispose(); store.Dispose(); };
        Shown += (_, _) => InitializeListener();
        RefreshCount();
    }

    private string SettingsPath => Path.Combine(root, "settings.json");
    private void InitializeListener()
    {
        try
        {
            var identity = Package.Current.Id.FamilyName;
            listener = UserNotificationListener.Current;
            status.Text = $"應用程式身分：{identity}\n通知權限：{listener.GetAccessStatus()}；請先授權，再開始診斷。";
            File.WriteAllText(Path.Combine(root, "runtime-status.json"), System.Text.Json.JsonSerializer.Serialize(new
            { PackageIdentity = identity, Permission = listener.GetAccessStatus().ToString(), Ready = true }));
        }
        catch (Exception ex)
        {
            permission.Enabled = start.Enabled = false;
            Error("initialize", ex);
            status.Text = "未取得通知 API／應用程式身分。請使用「啟動診斷.cmd」安裝並啟動。";
            File.WriteAllText(Path.Combine(root, "runtime-status.json"), System.Text.Json.JsonSerializer.Serialize(new
            { Ready = false, ErrorType = ex.GetType().Name, HResult = $"0x{ex.HResult:X8}" }));
        }
    }

    private async Task RequestPermission()
    {
        if (listener is null) return;
        permission.Enabled = false;
        try
        {
            var result = await listener.RequestAccessAsync();
            status.Text = $"通知權限：{result}" + (result == UserNotificationListenerAccessStatus.Denied
                ? "；請在 Windows 設定 → 隱私權與安全性 → 通知，允許此工具存取通知。" : "；可開始診斷。");
        }
        catch (Exception ex) { Error("permission", ex); }
        finally { permission.Enabled = true; }
    }

    private bool SaveSources()
    {
        try
        {
            activeSources = sources.CheckedItems.Cast<string>().Select(s => s.Trim()).Where(s => s.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            new Settings(activeSources).Save(SettingsPath);
            Append($"來源設定：{activeSources.Length} 個；" + (activeSources.Length == 0 ? "只觀察標題，不保存內容。" : "僅保存標題符合單一來源的通知。"));
            return true;
        }
        catch (Exception ex) { Error("settings", ex); return false; }
    }

    private async Task Start()
    {
        if (listener is null || busy) return;
        if (listener.GetAccessStatus() != UserNotificationListenerAccessStatus.Allowed)
        { status.Text = "尚未取得通知權限，請先按「授權通知存取」。"; return; }
        if (!SaveSources()) return;
        initialSnapshot = true;
        start.Enabled = false; stop.Enabled = true;
        Append("開始診斷；第一輪保留通知中心既有通知，並標示 initial_snapshot。變更來源後按「套用勾選來源」即可生效。");
        timer.Start();
        await Poll();
    }

    private void Stop()
    {
        timer.Stop(); start.Enabled = listener is not null; stop.Enabled = false;
        if (testUntil is not null) Append("收訊測試因停止診斷而中止。");
        testUntil = null;
        tray.Text = "LINE Call 通知診斷：已停止";
        status.Text = "已停止；本機保存資料保留。";
    }

    private async Task Poll()
    {
        if (busy || listener is null) return;
        busy = true;
        try
        {
            if (listener.GetAccessStatus() != UserNotificationListenerAccessStatus.Allowed)
            { Stop(); status.Text = "通知權限已撤銷，診斷已停止。"; return; }
            var notifications = await listener.GetNotificationsAsync(NotificationKinds.Toast);
            if (!timer.Enabled || IsDisposed) return;
            unsupportedNotifications.IntersectWith(notifications.Select(n => n.Id));
            snapshotLines = 0;
            foreach (var notification in notifications)
            {
                try
                {
                    // Inspect app identity before reading any notification text.
                    if (unsupportedNotifications.Contains(notification.Id)) continue;
                    Windows.ApplicationModel.AppInfo app;
                    try { app = notification.AppInfo; }
                    catch (NotImplementedException)
                    {
                        unsupportedNotifications.Add(notification.Id);
                        Append("Windows 有一筆不提供來源身分的通知，已略過；無法確認是否來自 LINE，不讀取其文字。");
                        continue;
                    }
                    if (!SourceFilter.IsLine(app.AppUserModelId, app.DisplayInfo.DisplayName)) continue;
                    snapshotLines++;
                    var binding = notification.Notification.Visual.GetBinding(KnownNotificationBindings.ToastGeneric);
                    if (binding is null) { AppendOnce("[LINE 通知沒有 ToastGeneric 文字]"); continue; }
                    var texts = binding.GetTextElements().Select(t => t.Text ?? "").ToArray();
                    var title = texts.FirstOrDefault() ?? "";
                    AppendOnce(title.Length == 0 ? "[LINE 通知標題為空，無法識別來源]" : title);
                    if (!string.IsNullOrWhiteSpace(title)) AddSource(title);
                    var source = SourceFilter.Match(title, activeSources);
                    if (source is null) continue;
                    var capture = new Capture(app.AppUserModelId, notification.Id, notification.CreationTime, texts, source, initialSnapshot);
                    if (savedThisSession.Contains(capture.Key)) continue;
                    if (store.Save(capture))
                    {
                        Append($"保存：{source}；本文 {capture.Body.Length} 個 UTF-16 字元" + (initialSnapshot ? "；既有通知" : ""));
                        if (!initialSnapshot && testUntil is not null) testCaptured++;
                    }
                    savedThisSession.Add(capture.Key);
                    // Keep memory bounded for long runs. SQLite remains the authoritative deduplication store.
                    if (savedThisSession.Count > 10000) savedThisSession.Clear();
                }
                catch (Exception ex) { Error("notification", ex); }
            }
            initialSnapshot = false;
            if (testUntil is not null && DateTimeOffset.Now >= testUntil)
            {
                Append(testCaptured > 0 ? $"收訊測試：保存 {testCaptured} 筆新通知／修訂。請匯出 JSONL 與 LINE 原文核對完整度。" :
                    "收訊測試：沒有保存新的符合通知。若來源在這段時間沒有新訊息，測試尚無結論；若 LINE 確有新訊息，請檢查通知設定與來源比對。無法辨識身分的通知也可能造成漏收。");
                testUntil = null;
            }
            lastScan = DateTimeOffset.Now;
            status.Text = $"運作中：每 0.5 秒檢查；目前可辨識 LINE 通知 {snapshotLines} 筆，無法辨識來源 {unsupportedNotifications.Count} 筆。" +
                (activeSources.Length == 0 ? "\n目前只觀察標題；勾選來源並套用後才會保存內容。" : "\n只保存符合來源的通知；不控制滑鼠、鍵盤或 LINE 視窗。");
            tray.Text = "LINE Call 通知診斷：運作中";
            RefreshCount();
        }
        catch (Exception ex)
        {
            Error("poll", ex);
            Stop();
            status.Text = "通知讀取失敗，已停止。查看 errors.log 後重新開始。";
        }
        finally { busy = false; }
    }

    private void AddSource(string name)
    {
        if (!sources.Items.Cast<string>().Any(existing => SourceFilter.Normalize(existing) == SourceFilter.Normalize(name))) sources.Items.Add(name, false);
    }
    private async Task DiscoverList(Button button, string? imagePath)
    {
        await DiscoverListCore(button, imagePath);
    }
    private void EditSelectedName()
    {
        var index = sources.SelectedIndex;
        if (index < 0) { Append("請先選取要修正的名稱，再按「修正選取名稱」。"); return; }
        using var dialog = new Form { Text = "修正名稱：只需中文／英文／數字，表情符號可省略", Width = 600, Height = 160,
            StartPosition = FormStartPosition.CenterParent, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false };
        var input = new TextBox { Text = (string)sources.Items[index], Dock = DockStyle.Top };
        var accept = new Button { Text = "確定", Dock = DockStyle.Bottom, DialogResult = DialogResult.OK };
        dialog.Controls.Add(input); dialog.Controls.Add(accept); dialog.AcceptButton = accept;
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        var name = input.Text.Trim();
        if (SourceFilter.Normalize(name).Length < 3) { Append("名稱至少需 3 個文字／數字字元，避免誤判來源。"); return; }
        sources.Items[index] = name;
        Append("名稱已修正；請按「套用勾選來源」保存設定。");
    }
    private async Task DiscoverListCore(Button button, string? imagePath)
    {
        button.Enabled = false;
        try
        {
            var width = (int)paneWidth.Value;
            var names = imagePath is null ? await LineListReader.ReadWindow(width) : await LineListReader.ReadImage(imagePath, width);
            foreach (var name in names) AddSource(name);
            Append(names.Length > 0 ? $"讀取到 {names.Length} 個群組／社群名稱，請勾選並按「套用勾選來源」。表情符號與空白不影響比對。" :
                "沒有辨識到群組名稱。請確認 LINE 顯示聊天列表，或改用「匯入 LINE 截圖」；左側寬度預設 375px，可依 LINE 列表調整。");
        }
        catch (Exception ex) { Append($"列表讀取失敗：{ex.Message}"); }
        finally { button.Enabled = true; }
    }
    private void ShowHelp() => MessageBox.Show(this,
        "1. 開啟 LINE 聊天列表，保持左側清單可見、不被其他視窗遮住，按「讀取 LINE 畫面列表」。\n" +
        "2. 勾選要保存的來源，按「套用勾選來源」。\n" +
        "3. 按「測試收訊（60秒）」，將 LINE 留在其他聊天室或最小化，等待來源有新訊息。\n" +
        "4. 觀察結果；保存成功後匯出 JSONL，對照 LINE 原文是否完整。\n\n" +
        "沒有新訊息時，60秒測試無法判定成功或失敗。\n" +
        "列表 OCR 只含目前可見項目；可自行捲動後再次讀取。\n" +
        "若通知不提供來源身分、沒有內容或被截短，本工具無法補回。",
        "怎麼測試？", MessageBoxButtons.OK, MessageBoxIcon.Information);

    private void AppendOnce(string title)
    {
        if (observedTitles.Add(title)) Append($"觀察標題：{title}");
        if (observedTitles.Count > 1000) observedTitles.Clear();
    }
    private void Append(string text)
    {
        if (observations.TextLength > 30000) observations.Text = observations.Text[^15000..];
        observations.AppendText($"[{DateTime.Now:HH:mm:ss}] {text}{Environment.NewLine}");
    }
    private void Error(string operation, Exception ex)
    {
        failures++;
        var message = $"{operation}: {ex.GetType().Name} 0x{ex.HResult:X8}";
        File.AppendAllText(Path.Combine(root, "errors.log"), $"{DateTimeOffset.UtcNow:O} {message}\n");
        status.Text = $"錯誤：{message}";
        Append($"錯誤：{message}");
    }
    private void RefreshCount() => count.Text = $"累積保存 {store.Count} 筆（含修訂）｜本次處理錯誤 {failures} 次｜上次檢查 {lastScan?.ToString("HH:mm:ss") ?? "尚未開始"}";
    private void Restore() { Show(); WindowState = FormWindowState.Normal; Activate(); }
    private void Export()
    {
        using var dialog = new SaveFileDialog { Filter = "JSON Lines (*.jsonl)|*.jsonl", FileName = $"line-notifications-{DateTime.Now:yyyyMMdd-HHmmss}.jsonl", InitialDirectory = root };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        try { store.Export(dialog.FileName); Append("匯出完成。"); }
        catch (Exception ex) { Error("export", ex); }
    }
}
