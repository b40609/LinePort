using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace LineCall.Diagnostics;

public sealed record Capture(string AppId, uint NotificationId, DateTimeOffset CreatedAt,
    string[] Texts, string Source, bool InitialSnapshot)
{
    public string Title => Texts.FirstOrDefault() ?? "";
    public string Body => string.Join("\n", Texts.Skip(1));
    // Notification identity plus content revision: repeated calls at different times survive.
    public string Key => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
        JsonSerializer.Serialize(new { AppId, NotificationId, CreatedAt = CreatedAt.ToUniversalTime(), Texts }))));
}

public static class SourceFilter
{
    public static string Normalize(string value) => string.Concat(value.Normalize(NormalizationForm.FormKC)
        .EnumerateRunes().Where(r => Rune.IsLetterOrDigit(r)).Select(r => r.ToString()));
    public static bool IsLine(string appId, string displayName) =>
        displayName.Equals("LINE", StringComparison.OrdinalIgnoreCase) ||
        appId.StartsWith("NAVER.LINE", StringComparison.OrdinalIgnoreCase) ||
        appId.StartsWith("NAVER.WIN32_LINE", StringComparison.OrdinalIgnoreCase);

    // Match title only. A stock call mentioning another group must not become a source match.
    // Ambiguous matches are withheld rather than assigned to the wrong group.
    public static string? Match(string title, IEnumerable<string> sources)
    {
        var normalizedTitle = Normalize(title);
        var matches = sources.Where(s => !string.IsNullOrWhiteSpace(s) && Normalize(s).Length >= 3 &&
            normalizedTitle.Contains(Normalize(s), StringComparison.OrdinalIgnoreCase)).Select(s => s.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        return matches.Length == 1 ? matches[0] : null;
    }
}

public sealed class CaptureStore : IDisposable
{
    private readonly SqliteConnection connection;
    public CaptureStore(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path }.ToString());
        connection.Open();
        using var command = connection.CreateCommand();
        // Only initialize our new database; reject unknown schemas rather than migrate them.
        command.CommandText = "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'";
        var tables = Convert.ToInt64(command.ExecuteScalar());
        command.CommandText = "PRAGMA user_version";
        var version = Convert.ToInt64(command.ExecuteScalar());
        if (tables != 0 && version != 1)
            throw new InvalidOperationException("Unsupported database schema. No changes made.");
        if (tables == 0)
        {
            command.CommandText = """
                CREATE TABLE captures (
                    capture_key TEXT PRIMARY KEY, observed_at TEXT NOT NULL,
                    app_id TEXT NOT NULL, notification_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL, source TEXT NOT NULL,
                    title TEXT NOT NULL, body TEXT NOT NULL, texts_json TEXT NOT NULL,
                    initial_snapshot INTEGER NOT NULL);
                PRAGMA user_version=1;
                """;
            command.ExecuteNonQuery();
        }
        command.CommandText = "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;";
        command.ExecuteNonQuery();
    }

    public bool Save(Capture item)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT OR IGNORE INTO captures VALUES
            ($key,$observed,$app,$id,$created,$source,$title,$body,$texts,$baseline)
            """;
        command.Parameters.AddWithValue("$key", item.Key);
        command.Parameters.AddWithValue("$observed", DateTimeOffset.UtcNow.ToString("O"));
        command.Parameters.AddWithValue("$app", item.AppId);
        command.Parameters.AddWithValue("$id", item.NotificationId);
        command.Parameters.AddWithValue("$created", item.CreatedAt.ToUniversalTime().ToString("O"));
        command.Parameters.AddWithValue("$source", item.Source);
        command.Parameters.AddWithValue("$title", item.Title);
        command.Parameters.AddWithValue("$body", item.Body);
        command.Parameters.AddWithValue("$texts", JsonSerializer.Serialize(item.Texts));
        command.Parameters.AddWithValue("$baseline", item.InitialSnapshot ? 1 : 0);
        return command.ExecuteNonQuery() == 1;
    }

    public long Count
    {
        get
        {
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT count(*) FROM captures";
            return Convert.ToInt64(command.ExecuteScalar());
        }
    }

    public void Export(string destination)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT * FROM captures ORDER BY observed_at, rowid";
        using var reader = command.ExecuteReader();
        using var output = new StreamWriter(destination, false, new UTF8Encoding(false));
        while (reader.Read())
        {
            var row = Enumerable.Range(0, reader.FieldCount).ToDictionary(reader.GetName, reader.GetValue);
            output.WriteLine(JsonSerializer.Serialize(row, new JsonSerializerOptions
            { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
        }
    }
    public void Dispose() => connection.Dispose();
}
