using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using IndependentAiIde.WindowsSandboxBroker.PowerShell;
using IndependentAiIde.WindowsSandboxBroker.Sandbox;

namespace IndependentAiIde.WindowsSandboxBroker.Protocol;

internal sealed class JsonLinesServer
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _executions = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Task> _requests = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _requestIds = new(StringComparer.Ordinal);
    private readonly PowerShellAnalyzer _analyzer;
    private readonly WindowsSandboxExecutor _executor;
    private readonly SandboxCapabilityProbe _probe;

    public JsonLinesServer(
        PowerShellAnalyzer analyzer,
        WindowsSandboxExecutor executor,
        SandboxCapabilityProbe probe)
    {
        _analyzer = analyzer;
        _executor = executor;
        _probe = probe;
    }

    public async Task RunAsync(TextReader input, TextWriter output, CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var line = await input.ReadLineAsync(cancellationToken).ConfigureAwait(false);
                if (line is null)
                {
                    break;
                }
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                BrokerRequest? request;
                try
                {
                    request = JsonSerializer.Deserialize<BrokerRequest>(line, JsonOptions);
                    if (request is null || request.Kind != "request" || string.IsNullOrWhiteSpace(request.Id))
                    {
                        throw new InvalidDataException("请求结构无效");
                    }
                }
                catch (Exception error) when (error is JsonException or InvalidDataException)
                {
                    await WriteAsync(output, BrokerResponse.Failure("invalid", "INVALID_JSON", error.Message), cancellationToken)
                        .ConfigureAwait(false);
                    continue;
                }

                if (!_requestIds.TryAdd(request.Id, 0))
                {
                    await WriteAsync(output, BrokerResponse.Failure(request.Id, "DUPLICATE_REQUEST_ID", "请求 ID 已存在"), cancellationToken)
                        .ConfigureAwait(false);
                    continue;
                }
                // execute 必须异步调度，否则服务端无法继续读取 powershell.cancel。
                var task = HandleRequestAsync(request, output, cancellationToken);
                _requests[request.Id] = task;
                _ = task.ContinueWith(
                    completedTask =>
                    {
                        _ = completedTask.Exception;
                        _requests.TryRemove(request.Id, out _);
                        _requestIds.TryRemove(request.Id, out _);
                    },
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
            }
        }
        finally
        {
            foreach (var execution in _executions.Values)
            {
                execution.Cancel();
            }
            await Task.WhenAll(_requests.Values).ConfigureAwait(false);
        }
    }

    private async Task HandleRequestAsync(BrokerRequest request, TextWriter output, CancellationToken serverToken)
    {
        try
        {
            object result = request.Method switch
            {
                "hello" => _probe.CreateHello(),
                "powershell.analyze" => _analyzer.Analyze(Deserialize<AnalyzePowerShellRequest>(request)),
                "powershell.execute" => await ExecuteAsync(Deserialize<ExecutePowerShellRequest>(request), serverToken)
                    .ConfigureAwait(false),
                "powershell.cancel" => Cancel(Deserialize<CancelPowerShellRequest>(request)),
                "powershell.discard-analysis" => new DiscardPowerShellAnalysisResult(
                    _analyzer.Discard(Deserialize<DiscardPowerShellAnalysisRequest>(request).AnalysisId)),
                "powershell.terminal.start" => await StartTerminalAsync(Deserialize<StartPowerShellTerminalRequest>(request), serverToken)
                    .ConfigureAwait(false),
                "powershell.terminal.read" => _executor.ReadTerminal(Deserialize<ReadPowerShellTerminalRequest>(request)),
                "powershell.terminal.write" => await _executor.WriteTerminalAsync(Deserialize<WritePowerShellTerminalRequest>(request), serverToken)
                    .ConfigureAwait(false),
                "powershell.terminal.cancel" => await _executor.CancelTerminalAsync(Deserialize<CancelPowerShellTerminalRequest>(request))
                    .ConfigureAwait(false),
                _ => throw new BrokerException("METHOD_NOT_FOUND", $"未知 Broker 方法：{request.Method}"),
            };
            await WriteAsync(output, BrokerResponse.Success(request.Id, result), serverToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            await WriteAsync(output, BrokerResponse.Failure(request.Id, "EXECUTION_CANCELED", "执行已取消"), CancellationToken.None)
                .ConfigureAwait(false);
        }
        catch (BrokerException error)
        {
            await WriteAsync(output, BrokerResponse.Failure(request.Id, error.Code, error.Message), CancellationToken.None)
                .ConfigureAwait(false);
        }
        catch (Exception error)
        {
            await WriteAsync(output, BrokerResponse.Failure(request.Id, "BROKER_INTERNAL_ERROR", error.Message), CancellationToken.None)
                .ConfigureAwait(false);
        }
    }

    private async Task<PowerShellExecutionResult> ExecuteAsync(
        ExecutePowerShellRequest request,
        CancellationToken serverToken)
    {
        if (!_executions.TryAdd(request.ExecutionId, new CancellationTokenSource()))
        {
            throw new BrokerException("DUPLICATE_EXECUTION_ID", $"executionId 已存在：{request.ExecutionId}");
        }

        var localCancellation = _executions[request.ExecutionId];
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(serverToken, localCancellation.Token);
        try
        {
            var verified = _analyzer.VerifyExecution(request);
            return await _executor.ExecuteAsync(request, verified, linked.Token).ConfigureAwait(false);
        }
        finally
        {
            _executions.TryRemove(request.ExecutionId, out _);
            localCancellation.Dispose();
        }
    }

    private async Task<PowerShellTerminalStartedResult> StartTerminalAsync(
        StartPowerShellTerminalRequest request,
        CancellationToken serverToken)
    {
        var verified = _analyzer.VerifyExecution(new ExecutePowerShellRequest(
            request.TerminalId,
            request.AnalysisId,
            request.ScriptSha256,
            request.Script,
            request.Cwd,
            request.AllowedPaths,
            request.NetworkMode,
            request.TimeoutMs));
        return await _executor.StartTerminalAsync(request, verified, serverToken).ConfigureAwait(false);
    }
    private CancelPowerShellResult Cancel(CancelPowerShellRequest request)
    {
        if (!_executions.TryGetValue(request.ExecutionId, out var source))
        {
            return new CancelPowerShellResult(false);
        }
        source.Cancel();
        return new CancelPowerShellResult(true);
    }

    private static T Deserialize<T>(BrokerRequest request)
    {
        return request.Params.Deserialize<T>(JsonOptions)
            ?? throw new BrokerException("INVALID_PARAMS", $"{request.Method} 参数无效");
    }

    private async Task WriteAsync(TextWriter output, BrokerResponse response, CancellationToken cancellationToken)
    {
        var json = JsonSerializer.Serialize(response, JsonOptions);
        await _writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await output.WriteLineAsync(json.AsMemory(), cancellationToken).ConfigureAwait(false);
            await output.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }
}

internal sealed class BrokerException : Exception
{
    public BrokerException(string code, string message) : base(message) => Code = code;
    public string Code { get; }
}
