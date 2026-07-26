using System.Diagnostics;
using IndependentAiIde.WindowsSandboxBroker.Audit;
using IndependentAiIde.WindowsSandboxBroker.PowerShell;
using IndependentAiIde.WindowsSandboxBroker.Protocol;

namespace IndependentAiIde.WindowsSandboxBroker.Sandbox;

internal sealed class WindowsSandboxExecutor
{
    private readonly SandboxCapabilityProbe _probe;
    private readonly AuditLogger _audit;

    public WindowsSandboxExecutor(SandboxCapabilityProbe probe, AuditLogger audit)
    {
        _probe = probe;
        _audit = audit;
    }

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
            new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-" },
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
