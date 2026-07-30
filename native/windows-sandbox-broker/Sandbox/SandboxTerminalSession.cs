using System.Text;
using IndependentAiIde.WindowsSandboxBroker.Protocol;

namespace IndependentAiIde.WindowsSandboxBroker.Sandbox;

// SandboxTerminalSession 不拥有进程创建权限；它只管理已经由 WindowsRestrictedProcess
// 用 Restricted Token、AppContainer、ACL 与 Job Object 创建的受限进程句柄。
internal sealed class SandboxTerminalSession : IAsyncDisposable
{
    private readonly string _terminalId;
    private readonly StreamWriter _stdin;
    private readonly Func<Task> _terminateProcessTree;
    private readonly SemaphoreSlim _stdinLock = new(1, 1);
    private readonly object _outputLock = new();
    private readonly List<TerminalOutputChunk> _chunks = new();
    private readonly TaskCompletionSource<TerminalCompletion> _completion =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    private long _nextCursor;
    private bool _disposed;
    private int _cancelRequested;

    public SandboxTerminalSession(string terminalId, Stream stdin, Func<Task> terminateProcessTree)
    {
        if (string.IsNullOrWhiteSpace(terminalId)) throw new ArgumentException("terminalId 不能为空", nameof(terminalId));
        _terminalId = terminalId;
        _stdin = new StreamWriter(stdin, new UTF8Encoding(false), 4096, leaveOpen: false) { AutoFlush = true };
        _terminateProcessTree = terminateProcessTree;
    }

    public void AppendStdout(string value) => Append("stdout", value);
    public void AppendStderr(string value) => Append("stderr", value);

    public async Task<bool> WriteAsync(string input, CancellationToken cancellationToken)
    {
        if (input.Length == 0 || _completion.Task.IsCompleted) return false;
        await _stdinLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_completion.Task.IsCompleted) return false;
            await _stdin.WriteAsync(input.AsMemory(), cancellationToken).ConfigureAwait(false);
            await _stdin.FlushAsync().ConfigureAwait(false);
            return true;
        }
        finally
        {
            _stdinLock.Release();
        }
    }

    public PowerShellTerminalOutput Read(long cursor)
    {
        if (cursor < 0) throw new BrokerException("INVALID_CURSOR", "后台终端 cursor 不能为负数");
        lock (_outputLock)
        {
            if (cursor > _nextCursor) throw new BrokerException("INVALID_CURSOR", "后台终端 cursor 超过当前输出位置");
            var stdout = new StringBuilder();
            var stderr = new StringBuilder();
            foreach (var chunk in _chunks.Where(chunk => chunk.Cursor >= cursor))
            {
                if (chunk.Stream == "stdout") stdout.Append(chunk.Text);
                else stderr.Append(chunk.Text);
            }
            var completed = _completion.Task.IsCompletedSuccessfully;
            var result = completed ? _completion.Task.Result : default;
            return new PowerShellTerminalOutput(
                _terminalId,
                _nextCursor,
                stdout.ToString(),
                stderr.ToString(),
                completed,
                completed ? result.ExitCode : null,
                completed && result.TimedOut,
                completed && result.Interrupted);
        }
    }

    public void Complete(int exitCode, bool timedOut, bool interrupted)
    {
        _completion.TrySetResult(new TerminalCompletion(exitCode, timedOut, interrupted));
    }

    public async Task<bool> CancelAsync()
    {
        if (_completion.Task.IsCompleted || Interlocked.Exchange(ref _cancelRequested, 1) != 0) return false;
        await _terminateProcessTree().ConfigureAwait(false);
        return true;
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        if (!_completion.Task.IsCompleted) await CancelAsync().ConfigureAwait(false);
        _stdin.Dispose();
        _stdinLock.Dispose();
    }

    private void Append(string stream, string value)
    {
        if (value.Length == 0) return;
        lock (_outputLock)
        {
            _chunks.Add(new TerminalOutputChunk(_nextCursor++, stream, value));
        }
    }

    private sealed record TerminalOutputChunk(long Cursor, string Stream, string Text);
    private readonly record struct TerminalCompletion(int ExitCode, bool TimedOut, bool Interrupted);
}