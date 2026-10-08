using Windows.UI.Notifications;
using Windows.UI.Notifications.Management;
using System.Text.Json;

namespace LineCall.Diagnostics;

internal static class NotificationProbe
{
    public static async Task Run(string root)
    {
        var results = new List<object>();
        var listener = UserNotificationListener.Current;
        if (listener.GetAccessStatus() == UserNotificationListenerAccessStatus.Allowed)
        {
            foreach (var item in await listener.GetNotificationsAsync(NotificationKinds.Toast))
            {
                var stages = new Dictionary<string, string>();
                void Probe(string stage, Func<string> read)
                {
                    try { stages[stage] = read(); }
                    catch (Exception ex) { stages[stage] = $"{ex.GetType().Name}:0x{ex.HResult:X8}"; }
                }
                Probe("AppInfo", () => item.AppInfo is null ? "null" : "OK");
                Probe("AppId", () => item.AppInfo.AppUserModelId);
                Probe("PackageFamily", () => item.AppInfo.PackageFamilyName);
                Probe("DisplayName", () => item.AppInfo.DisplayInfo.DisplayName);
                // Never read notification text in this compatibility probe.
                results.Add(new { item.Id, Stages = stages });
            }
        }
        File.WriteAllText(Path.Combine(root, "notification-api-probe.json"), JsonSerializer.Serialize(results, new JsonSerializerOptions { WriteIndented = true }));
    }
}
