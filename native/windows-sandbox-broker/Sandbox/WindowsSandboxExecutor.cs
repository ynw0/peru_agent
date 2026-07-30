using System.Collections.Concurrent;
using System.Diagnostics;
using IndependentAiIde.WindowsSandboxBroker.Audit;
using IndependentAiIde.WindowsSandboxBroker.PowerShell;
using IndependentAiIde.WindowsSandboxBroker.Protocol;

namespace IndependentAiIde.WindowsSandboxBroker.Sandbox;

internal sealed class WindowsSandboxExecutor
{
    private readonly SandboxCapabilityProbe _probe;
    private readonly AuditLogger _audit;
    private readonly ConcurrentDictionary<string, WindowsRestrictedProcess.RestrictedPowerShellTerminal> _terminals = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _terminalReservations = new(StringComparer.Ordinal);

    public WindowsSandboxExecutor(SandboxCapabilityProbe probe, AuditLogger audit)
    {
        _probe = probe;
        _audit = audit;
    }

    public async Task<PowerShellTerminalStartedResult> StartTerminalAsync(
        StartPowerShellTerminalRequest request,
        VerifiedPowerShellAnalysis analysis,
        CancellationToken cancellationToken)
    {
        if (!_terminalReservations.TryAdd(request.TerminalId, 0))
            throw new BrokerException("DUPLICATE_TERMINAL_ID", $"terminalId 已存在：{request.TerminalId}");
        try
        {
            _probe.AssertProductionReady();
            var taskRoot = Path.Combine(Path.GetTempPath(), "IndependentAiIde", request.TerminalId);
            Directory.CreateDirectory(taskRoot);
            var launch = new SandboxLaunchRequest(
                _probe.ResolvePowerShellExecutable(),
                new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-WorkingDirectory", request.Cwd, "-Command", "-" },
                "", request.Cwd, request.AllowedPaths, taskRoot, request.NetworkMode, request.TimeoutMs);
            var terminal = await WindowsRestrictedProcess.StartTerminalAsync(launch, request.TerminalId).ConfigureAwait(false);
            if (!_terminals.TryAdd(request.TerminalId, terminal))
                throw new BrokerException("DUPLICATE_TERMINAL_ID", $"terminalId 已存在：{request.TerminalId}");
            await terminal.WriteInitialAsync(request.Script, cancellationToken).ConfigureAwait(false);
            var auditPath = await _audit.WriteAsync(request.TerminalId, new { request.AnalysisId, request.ScriptSha256, request.NetworkMode, request.AllowedPaths, status = "started" }, cancellationToken).ConfigureAwait(false);
            return new PowerShellTerminalStartedResult(request.TerminalId, request.AnalysisId, request.ScriptSha256, auditPath);
        }
        catch
        {
            if (_terminals.TryRemove(request.TerminalId, out var terminal))
                await terminal.DisposeAsync().ConfigureAwait(false);
            _terminalReservations.TryRemove(request.TerminalId, out _);
            throw;
        }
    }

    public PowerShellTerminalOutput ReadTerminal(ReadPowerShellTerminalRequest request) => RequireTerminal(request.TerminalId).Session.Read(request.Cursor);

    public Task<WritePowerShellTerminalResult> WriteTerminalAsync(WritePowerShellTerminalRequest request, CancellationToken cancellationToken) =>
        WriteTerminalInternalAsync(request, cancellationToken);

    public async Task<CancelPowerShellTerminalResult> CancelTerminalAsync(CancelPowerShellTerminalRequest request)
    {
        if (!_terminals.TryRemove(request.TerminalId, out var terminal)) return new CancelPowerShellTerminalResult(false);
        _terminalReservations.TryRemove(request.TerminalId, out _);
        await terminal.Session.CancelAsync().ConfigureAwait(false);
        await terminal.DisposeAsync().ConfigureAwait(false);
        return new CancelPowerShellTerminalResult(true);
    }

    private async Task<WritePowerShellTerminalResult> WriteTerminalInternalAsync(WritePowerShellTerminalRequest request, CancellationToken cancellationToken)
    {
        var accepted = await RequireTerminal(request.TerminalId).Session.WriteAsync(request.Input, cancellationToken).ConfigureAwait(false);
        return new WritePowerShellTerminalResult(accepted);
    }

    private WindowsRestrictedProcess.RestrictedPowerShellTerminal RequireTerminal(string terminalId) =>
        _terminals.TryGetValue(terminalId, out var terminal)
            ? terminal : throw new BrokerException("TERMINAL_NOT_FOUND", $"后台终端不存在：{terminalId}");
    public async Task<PowerShellExecutionResult> ExecuteAsync(
        ExecutePowerShellRequest request,
        VerifiedPowerShellAnalysis analysis,
        CancellationToken cancellationToken)
    {
        _probe.AssertProductionReady();
        var executable = _probe.ResolvePowerShellExecutable();
        var started = Stopwatch.StartNew();
        var taskRoot = Path.Combine(Path.GetTempPath(), "IndependentAiIde", request.ExecutionId.Replace(':', '_'));
        Directory.CreateDirectory(taskRoot);

        var launch = new SandboxLaunchRequest(
            executable,
            new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-WorkingDirectory", request.Cwd, "-Command", "-" },
            request.Script,
            request.Cwd,
            request.AllowedPaths,
            taskRoot,
            request.NetworkMode,
            request.TimeoutMs);

        SandboxProcessResult processResult;
        try
        {
            processResult = await WindowsRestrictedProcess.RunAsync(launch, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            started.Stop();
            var canceledAudit = await _audit.WriteAsync(request.ExecutionId, new
            {
                request.AnalysisId,
                request.ScriptSha256,
                status = "interrupted",
                durationMs = started.ElapsedMilliseconds,
            }, CancellationToken.None).ConfigureAwait(false);
            return new PowerShellExecutionResult(
                request.ExecutionId,
                request.AnalysisId,
                request.ScriptSha256,
                "",
                "执行已取消",
                -1,
                TimedOut: false,
                Interrupted: true,
                canceledAudit,
                started.ElapsedMilliseconds);
        }

        started.Stop();
        var auditPath = await _audit.WriteAsync(request.ExecutionId, new
        {
            request.AnalysisId,
            request.ScriptSha256,
            request.NetworkMode,
            request.AllowedPaths,
            processResult.ExitCode,
            processResult.TimedOut,
            processResult.Interrupted,
            durationMs = started.ElapsedMilliseconds,
        }, CancellationToken.None).ConfigureAwait(false);

        return new PowerShellExecutionResult(
            request.ExecutionId,
            request.AnalysisId,
            request.ScriptSha256,
            processResult.Stdout,
            processResult.Stderr,
            processResult.ExitCode,
            processResult.TimedOut,
            processResult.Interrupted,
            auditPath,
            started.ElapsedMilliseconds);
    }
}

internal sealed record SandboxLaunchRequest(
    string Executable,
    IReadOnlyList<string> Arguments,
    string StandardInput,
    string WorkingDirectory,
    IReadOnlyList<string> ReadOnlyPaths,
    string WritableTaskDirectory,
    string NetworkMode,
    int TimeoutMs);

internal sealed record SandboxProcessResult(
    string Stdout,
    string Stderr,
    int ExitCode,
    bool TimedOut,
    bool Interrupted);
