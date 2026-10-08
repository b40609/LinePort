using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

namespace LineCall.Diagnostics;

internal static class LineListReader
{
    [DllImport("user32.dll")] private static extern bool GetWindowRect(nint window, out Rect rect);
    [DllImport("user32.dll")] private static extern bool IsIconic(nint window);
    [DllImport("user32.dll")] private static extern bool PrintWindow(nint window, nint dc, uint flags);
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }

    public static async Task<string[]> ReadWindow(int paneWidth)
    {
        // Read-only capture: no focus changes, clicks, scrolling or keyboard injection.
        using var process = Process.GetProcessesByName("LINE").FirstOrDefault(p => p.MainWindowHandle != 0)
            ?? throw new InvalidOperationException("找不到 LINE 主視窗，請先開啟 LINE 的聊天列表。");
        var handle = process.MainWindowHandle;
        if (IsIconic(handle)) throw new InvalidOperationException("讀取列表時請先還原 LINE 視窗；通知監聽仍可在 LINE 最小化時執行。");
        if (!GetWindowRect(handle, out var rect)) throw new InvalidOperationException("無法取得 LINE 視窗尺寸。");
        using var bitmap = new Bitmap(rect.Right - rect.Left, rect.Bottom - rect.Top);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            var dc = graphics.GetHdc();
            try
            {
                // Some LINE builds reject PrintWindow; capture the visible list below instead.
                if (!PrintWindow(handle, dc, 2))
                {
                    graphics.ReleaseHdc(dc);
                    dc = 0;
                    graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0,
                        new Size(Math.Min(paneWidth, bitmap.Width), bitmap.Height));
                }
            }
            finally { if (dc != 0) graphics.ReleaseHdc(dc); }
        }
        return await ReadBitmap(bitmap, paneWidth);
    }

    public static async Task<string[]> ReadImage(string path, int paneWidth)
    {
        using var bitmap = new Bitmap(path);
        return await ReadBitmap(bitmap, paneWidth);
    }

    private static async Task<string[]> ReadBitmap(Bitmap bitmap, int paneWidth)
    {
        // Only feed the left list into OCR. Never OCR the right conversation pane.
        var width = Math.Min(paneWidth, bitmap.Width);
        using var crop = bitmap.Clone(new Rectangle(0, 0, width, bitmap.Height), System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using var bytes = new MemoryStream();
        crop.Save(bytes, System.Drawing.Imaging.ImageFormat.Png);
        using var stream = new InMemoryRandomAccessStream();
        using (var writer = new DataWriter(stream.GetOutputStreamAt(0)))
        {
            writer.WriteBytes(bytes.ToArray());
            await writer.StoreAsync();
            await writer.FlushAsync();
        }
        stream.Seek(0);
        var decoder = await BitmapDecoder.CreateAsync(stream);
        using var software = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
        var language = OcrEngine.AvailableRecognizerLanguages.FirstOrDefault(l => l.LanguageTag.StartsWith("zh", StringComparison.OrdinalIgnoreCase));
        var engine = language is null ? OcrEngine.TryCreateFromUserProfileLanguages() : OcrEngine.TryCreateFromLanguage(language);
        if (engine is null) throw new InvalidOperationException("Windows 未提供 OCR 語言；可先用「觀察新通知」自動加入來源。");
        var result = await engine.RecognizeAsync(software);
        return result.Lines.Select(line => ExtractName(line.Text)).Where(name => name is not null)
            .Select(name => name!).Distinct().ToArray();
    }

    public static string? ExtractName(string line)
    {
        // Group and OpenChat list rows contain member counts; previews without counts are ignored.
        var match = Regex.Match(line, @"^(?<name>.+?)\s*[（(]\s*[0-9,，\s]+\s*[)）]");
        if (!match.Success) return null;
        var name = match.Groups["name"].Value.Trim().TrimEnd('.', '…').Trim();
        return SourceFilter.Normalize(name).Length >= 3 ? name : null;
    }
}
