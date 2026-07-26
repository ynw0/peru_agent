using System.Text.Json;

namespace IndependentAiIde.WindowsSandboxBroker.Audit;

internal sealed class AuditLogger
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    public async Task<string> WriteAsync(
        string executionId,
        object entry,
        CancellationToken cancellationToken)
    {
        var root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "IndependentAiIde",
            "sandbox-audit");
        Directory.CreateDirectory(root);
        var safeName = string.Concat(executionId.Select(character =>
            char.IsLetterOrDigit(character) || character is '-' or '_' ? character : '_'));
        var path = Path.Combine(root, $"{safeName}.jsonl");
        var envelope = new
        {
            timestampUtc = DateTimeOffset.UtcNow,
            executionId,
            entry,
        };
        await File.AppendAllTextAsync(
            path,
            JsonSerializer.Serialize(envelope, JsonOptions) + Environment.NewLine,
            new System.Text.UTF8Encoding(false),
            cancellationToken).ConfigureAwait(false);
        return path;
    }
}
