using System.Text.Json;

namespace LineCall.Diagnostics;

internal static class SelfTest
{
    public static void Run(string directory)
    {
        Directory.CreateDirectory(directory);
        var run = Path.Combine(directory, DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fffffff"));
        Directory.CreateDirectory(run);
        var checks = new List<string>();
        void Check(bool condition, string name)
        {
            if (!condition) throw new InvalidOperationException(name);
            checks.Add(name);
        }
        var path = Path.Combine(run, "mock.sqlite3");
        try
        {
            Check(SourceFilter.IsLine("NAVER.LINE_abc!LINE", "其他名稱"), "LINE package detection");
            Check(!SourceFilter.IsLine("Outlook", "Outlook"), "Other apps excluded");
            Check(SourceFilter.IsLine("NAVER.WIN32_LINEwin8_test!LINE", "Other"), "Win32 LINE package detection");
            Check(SourceFilter.Match("台股 📈 群組：新訊息", ["台股群組🙂"]) == "台股群組🙂", "Emoji and whitespace ignored in source matching");
            Check(LineListReader.ExtractName("台股群組🙂 (1,234) 下午 4:25") == "台股群組🙂", "Member count removed from OCR name");
            Check(LineListReader.ExtractName("普通訊息預覽 下午 4:25") is null, "Preview without member count excluded");
            Check(SourceFilter.Match("測試群組A：投顧", ["測試群組A"]) == "測試群組A", "Source title matching");
            Check(SourceFilter.Match("其他群", []) is null, "Empty allowlist saves nothing");
            Check(SourceFilter.Match("測試群組A", ["測試群", "測試群組A"]) is null, "Ambiguous sources withheld");
            var created = DateTimeOffset.UtcNow;
            var longText = string.Concat(Enumerable.Repeat("台股測試文字🙂\n價格 123.45\n", 1000));
            var item = new Capture("LINE", 42, created, ["測試群組A", longText], "測試群組A", false);
            using (var store = new CaptureStore(path))
            {
                Check(store.Save(item), "First capture persisted");
                Check(!store.Save(item), "Repeated snapshot deduplicated");
                Check(store.Save(item with { Texts = ["測試群組A", "修正版"] }), "Same notification updated content retained");
                Check(store.Save(item with { CreatedAt = created.AddMinutes(1) }), "Reused ID and repeated call retained");
                Check(store.Count == 3, "Expected record count");
                var export = Path.Combine(run, "export.jsonl");
                store.Export(export);
                using var row = JsonDocument.Parse(File.ReadLines(export).First());
                Check(row.RootElement.GetProperty("body").GetString() == longText, "Long Unicode multiline round trip");
            }
            using (var reopened = new CaptureStore(path))
            {
                Check(reopened.Count == 3 && !reopened.Save(item), "Restart persistence and deduplication");
            }
            File.WriteAllText(Path.Combine(directory, "latest.json"), JsonSerializer.Serialize(new { Passed = true, Checks = checks, RunDirectory = run }, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            File.WriteAllText(Path.Combine(directory, "latest.json"), JsonSerializer.Serialize(new { Passed = false, Checks = checks, Error = ex.Message, RunDirectory = run }, new JsonSerializerOptions { WriteIndented = true }));
            Environment.ExitCode = 1;
        }
    }
}
