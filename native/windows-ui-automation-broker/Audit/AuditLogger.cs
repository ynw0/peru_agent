using System.Text.Json;

namespace IndependentAiIde.WindowsUiAutomationBroker.Audit;

internal sealed class AuditLogger
{
    private readonly string path;
    private readonly object gate = new();

    internal AuditLogger()
    {
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "IndependentAiIde", "ComputerUseAudit");
        Directory.CreateDirectory(root);
        path = Path.Combine(root, $"broker-{DateTime.UtcNow:yyyyMMdd}.jsonl");
    }

    internal void Write(string method, string decision, string reason, string? requestId = null)
    {
        var line = JsonSerializer.Serialize(new { timestamp = DateTimeOffset.UtcNow.ToString("O"), method, decision, reason, requestId });
        lock (gate) File.AppendAllText(path, line + Environment.NewLine, new System.Text.UTF8Encoding(false));
    }
}
