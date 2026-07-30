using System.Text.Json;
using System.Text.Json.Serialization;

namespace IndependentAiIde.WindowsSandboxBroker.Protocol;

internal static class ProtocolConstants
{
    public const int Version = 2;
}

internal sealed record BrokerRequest(
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("method")] string Method,
    [property: JsonPropertyName("params")] JsonElement Params);

internal sealed record BrokerError(
    [property: JsonPropertyName("code")] string Code,
    [property: JsonPropertyName("message")] string Message);

internal sealed record BrokerResponse(
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("result")] object? Result,
    [property: JsonPropertyName("error")] BrokerError? Error)
{
    public static BrokerResponse Success(string id, object result) =>
        new("response", id, true, result, null);

    public static BrokerResponse Failure(string id, string code, string message) =>
        new("response", id, false, null, new BrokerError(code, message));
}

internal sealed record WindowsSandboxFeatures(
    bool PowerShellAst,
    bool RestrictedToken,
    bool AppContainer,
    bool JobObject,
    bool FilesystemAcl,
    bool NetworkIsolation,
    bool ProcessTreeTermination,
    bool Utf8Protocol);

internal sealed record BrokerHelloResult(
    int ProtocolVersion,
    string BrokerVersion,
    string Platform,
    string Architecture,
    string PowerShellVersion,
    string PowerShellExecutable,
    WindowsSandboxFeatures Features);

internal sealed record AnalyzePowerShellRequest(
    string Script,
    string Cwd,
    IReadOnlyList<string> AllowedPaths,
    string NetworkMode,
    int TimeoutMs);

internal sealed record ExecutePowerShellRequest(
    string ExecutionId,
    string AnalysisId,
    string ScriptSha256,
    string Script,
    string Cwd,
    IReadOnlyList<string> AllowedPaths,
    string NetworkMode,
    int TimeoutMs);

internal sealed record CancelPowerShellRequest(string ExecutionId);
internal sealed record CancelPowerShellResult(bool Canceled);
internal sealed record DiscardPowerShellAnalysisRequest(string AnalysisId);
internal sealed record DiscardPowerShellAnalysisResult(bool Discarded);

internal sealed record StartPowerShellTerminalRequest(
    string TerminalId,
    string AnalysisId,
    string ScriptSha256,
    string Script,
    string Cwd,
    IReadOnlyList<string> AllowedPaths,
    string NetworkMode,
    int TimeoutMs);

internal sealed record PowerShellTerminalStartedResult(
    string TerminalId,
    string AnalysisId,
    string ScriptSha256,
    string AuditLogPath);

internal sealed record ReadPowerShellTerminalRequest(string TerminalId, long Cursor);

internal sealed record PowerShellTerminalOutput(
    string TerminalId,
    long Cursor,
    string Stdout,
    string Stderr,
    bool Completed,
    int? ExitCode,
    bool TimedOut,
    bool Interrupted);

internal sealed record WritePowerShellTerminalRequest(string TerminalId, string Input);
internal sealed record WritePowerShellTerminalResult(bool Accepted);
internal sealed record CancelPowerShellTerminalRequest(string TerminalId);
internal sealed record CancelPowerShellTerminalResult(bool Canceled);
internal sealed record PowerShellParseError(string Message, int StartOffset, int EndOffset);
internal sealed record PowerShellCommandInfo(string Name, string Text, int StartOffset, int EndOffset);

internal sealed record PowerShellAnalysisResult(
    string AnalysisId,
    string ScriptSha256,
    IReadOnlyList<PowerShellParseError> ParseErrors,
    IReadOnlyList<PowerShellCommandInfo> Commands,
    IReadOnlyList<string> AffectedFiles,
    IReadOnlyList<string> NetworkTargets,
    IReadOnlyList<string> RequestedCapabilities,
    IReadOnlyList<string> DeniedReasons,
    bool ReadOnly);

internal sealed record PowerShellExecutionResult(
    string ExecutionId,
    string AnalysisId,
    string ScriptSha256,
    string Stdout,
    string Stderr,
    int ExitCode,
    bool TimedOut,
    bool Interrupted,
    string AuditLogPath,
    long DurationMs);
