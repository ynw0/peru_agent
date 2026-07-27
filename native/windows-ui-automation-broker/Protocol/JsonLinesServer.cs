using System.Text.Json;
using IndependentAiIde.WindowsUiAutomationBroker.Audit;
using IndependentAiIde.WindowsUiAutomationBroker.Identity;
using IndependentAiIde.WindowsUiAutomationBroker.UiAutomation;

namespace IndependentAiIde.WindowsUiAutomationBroker.Protocol;

internal sealed class JsonLinesServer
{
    private readonly JsonSerializerOptions json = new(JsonSerializerDefaults.Web) { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private readonly ApplicationIdentityService identities = new();
    private readonly UiAutomationService automation;
    private readonly AuditLogger audit = new();

    internal JsonLinesServer() => automation = new UiAutomationService(identities);

    internal async Task RunAsync()
    {
        string? line;
        while ((line = await Console.In.ReadLineAsync()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            BrokerResponse response;
            try
            {
                var request = JsonSerializer.Deserialize<BrokerRequest>(line, json) ?? throw new InvalidOperationException("请求为空");
                if (!string.Equals(request.Kind, "request", StringComparison.Ordinal)) throw new InvalidOperationException("kind 必须是 request");
                var result = Dispatch(request);
                response = new BrokerResponse("response", request.Id, true, result, null);
                audit.Write(request.Method, "completed", "请求完成", request.Id);
            }
            catch (Exception error)
            {
                var id = TryReadId(line) ?? "unknown";
                response = new BrokerResponse("response", id, false, null, new BrokerError("BROKER_REQUEST_FAILED", error.Message));
                audit.Write("unknown", "failed", error.Message, id);
            }
            await Console.Out.WriteLineAsync(JsonSerializer.Serialize(response, json));
            await Console.Out.FlushAsync();
        }
    }

    private object Dispatch(BrokerRequest request) => request.Method switch
    {
        "hello" => new BrokerHello(1, "0.1.0", "windows", "x64", new BrokerFeatures(true, true, true, true, true, true, true, true, true, true)),
        "computer.list-windows" => identities.ListWindows(),
        "computer.inspect" => Inspect(request.Params),
        "computer.screenshot" => automation.Screenshot(RequiredString(request.Params, "snapshotId")),
        "computer.action" => automation.Act(request.Params.Deserialize<ComputerActionRequest>(json) ?? throw new InvalidOperationException("动作参数无效")),
        _ => throw new InvalidOperationException($"未知 Broker 方法：{request.Method}"),
    };

    private UiSnapshot Inspect(JsonElement parameters)
    {
        var handle = RequiredString(parameters, "windowHandle");
        var max = parameters.TryGetProperty("maxElements", out var item) && item.TryGetInt32(out var value) ? value : 2000;
        return automation.Inspect(handle, max);
    }

    private static string RequiredString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()!
            : throw new InvalidOperationException($"{name} 必须是非空字符串");

    private static string? TryReadId(string line)
    {
        try
        {
            using var document = JsonDocument.Parse(line);
            return document.RootElement.TryGetProperty("id", out var id) ? id.GetString() : null;
        }
        catch (JsonException) { return null; }
    }
}
