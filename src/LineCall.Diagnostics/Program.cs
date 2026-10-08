using System.Text.Json;

namespace LineCall.Diagnostics;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        string storage;
        try { storage = Windows.Storage.ApplicationData.Current.LocalFolder.Path; }
        catch { storage = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData); }
        var root = Path.Combine(storage, "LineCallDiagnostics");
        Directory.CreateDirectory(root);
        if (args.Length >= 2 && args[0] == "--read-list-image")
        {
            var names = LineListReader.ReadImage(args[1], 375).GetAwaiter().GetResult();
            File.WriteAllText(Path.Combine(root, "list-image-test.json"), JsonSerializer.Serialize(names));
            return;
        }
        if (args.Contains("--read-list-window"))
        {
            try
            {
                var names = LineListReader.ReadWindow(375).GetAwaiter().GetResult();
                File.WriteAllText(Path.Combine(root, "list-window-test.json"), JsonSerializer.Serialize(new { Names = names }));
            }
            catch (Exception ex)
            {
                File.WriteAllText(Path.Combine(root, "list-window-test.json"), JsonSerializer.Serialize(new { Error = ex.Message }));
                Environment.ExitCode = 1;
            }
            return;
        }
        if (args.Contains("--probe-notification-api"))
        {
            NotificationProbe.Run(root).GetAwaiter().GetResult();
            return;
        }
        if (args.Contains("--self-test"))
        {
            SelfTest.Run(Path.Combine(root, "self-tests"));
            return;
        }
        using var mutex = new Mutex(true, "Local\\Ryan.LineCall.Diagnostics", out var first);
        if (!first) return;
        ApplicationConfiguration.Initialize();
        try { Application.Run(new MainForm(root)); }
        catch (Exception ex)
        {
            File.AppendAllText(Path.Combine(root, "errors.log"), $"{DateTimeOffset.UtcNow:O} startup {ex.GetType().Name} 0x{ex.HResult:X8}\n");
            MessageBox.Show($"工具啟動失敗：{ex.GetType().Name}（0x{ex.HResult:X8}）。\n請查看本機 errors.log。", "LINE Call 診斷");
        }
    }
}

internal sealed record Settings(string[] Sources)
{
    public static Settings Load(string path) => File.Exists(path)
        ? JsonSerializer.Deserialize<Settings>(File.ReadAllText(path)) ?? new([]) : new([]);
    public void Save(string path) => File.WriteAllText(path, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
}
