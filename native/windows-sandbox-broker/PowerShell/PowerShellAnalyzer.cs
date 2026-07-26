using System.Collections.Concurrent;
using System.Management.Automation.Language;
using System.Security.Cryptography;
using System.Text;
using IndependentAiIde.WindowsSandboxBroker.Protocol;

namespace IndependentAiIde.WindowsSandboxBroker.PowerShell;

internal sealed record VerifiedPowerShellAnalysis(
    string AnalysisId,
    string ScriptSha256,
    IReadOnlyList<string> AllowedPaths,
    string Cwd,
    string NetworkMode,
    int TimeoutMs,
    DateTimeOffset CreatedAtUtc);

internal sealed class PowerShellAnalyzer
{
    private static readonly TimeSpan AnalysisLifetime = TimeSpan.FromMinutes(5);
    private static readonly HashSet<string> DeniedCommands = new(StringComparer.OrdinalIgnoreCase)
    {
        "Invoke-Expression", "iex", "Add-Type", "Set-ExecutionPolicy", "Get-Credential",
        "Export-Clixml", "Import-Clixml", "Start-Process", "Start-Job", "Enter-PSSession",
        "Invoke-Command", "New-PSSession", "Register-ObjectEvent", "Register-EngineEvent",
        "Set-ItemProperty", "New-ItemProperty", "Remove-ItemProperty", "Set-Acl",
    };

    // 第一版只开放可静态分析的读取命令；文件写入必须继续走 Diff Proposal。
    private static readonly HashSet<string> ReadOnlyCommands = new(StringComparer.OrdinalIgnoreCase)
    {
        "Get-ChildItem", "Get-Item", "Get-Content", "Test-Path", "Resolve-Path",
        "Select-String", "Measure-Object", "Sort-Object", "Where-Object", "ForEach-Object",
        "Format-List", "Format-Table", "Out-String", "Write-Output", "Write-Host",
        "Get-Date", "Get-Location", "Get-Command", "Get-Help", "Get-Member", "Start-Sleep",
        "git", "git.exe", "node", "node.exe", "npm", "npm.cmd", "npx", "npx.cmd",
        "python", "python.exe", "python3", "pytest", "pytest.exe",
    };

    private static readonly HashSet<string> PathCommands = new(StringComparer.OrdinalIgnoreCase)
    {
        "Get-ChildItem", "Get-Item", "Get-Content", "Test-Path", "Resolve-Path", "Select-String",
    };

    private static readonly HashSet<string> NetworkCommands = new(StringComparer.OrdinalIgnoreCase)
    {
        "Invoke-WebRequest", "Invoke-RestMethod", "curl", "curl.exe", "wget", "wget.exe",
    };

    private readonly ConcurrentDictionary<string, VerifiedPowerShellAnalysis> _analyses = new(StringComparer.Ordinal);

    public PowerShellAnalysisResult Analyze(AnalyzePowerShellRequest request)
    {
        PurgeExpiredAnalyses();
        ValidateRequest(request);
        var scriptHash = Sha256(request.Script);
        var ast = Parser.ParseInput(request.Script, out _, out var parseErrors);
        var errors = parseErrors.Select(error => new PowerShellParseError(
            error.Message,
            error.Extent.StartOffset,
            error.Extent.EndOffset)).ToArray();

        var commands = new List<PowerShellCommandInfo>();
        var affectedFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var networkTargets = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var deniedReasons = new List<string>();
        var requestedCapabilities = new HashSet<string>(StringComparer.Ordinal)
        {
            "process.execute",
        };

        if (errors.Length == 0)
        {
            AnalyzeDangerousSyntax(ast, deniedReasons);
            foreach (var commandAst in ast.FindAll(node => node is CommandAst, searchNestedScriptBlocks: true).Cast<CommandAst>())
            {
                AnalyzeCommand(
                    commandAst,
                    request,
                    commands,
                    affectedFiles,
                    networkTargets,
                    requestedCapabilities,
                    deniedReasons);
            }
        }

        if (request.NetworkMode == "lan")
        {
            requestedCapabilities.Add("network.lan");
        }
        else if (request.NetworkMode == "internet")
        {
            requestedCapabilities.Add("network.internet");
        }

        var analysisId = $"analysis-{Guid.NewGuid():N}";
        var verified = new VerifiedPowerShellAnalysis(
            analysisId,
            scriptHash,
            request.AllowedPaths.Select(Path.GetFullPath).ToArray(),
            Path.GetFullPath(request.Cwd),
            request.NetworkMode,
            request.TimeoutMs,
            DateTimeOffset.UtcNow);
        if (errors.Length == 0 && deniedReasons.Count == 0)
        {
            _analyses[analysisId] = verified;
        }

        return new PowerShellAnalysisResult(
            analysisId,
            scriptHash,
            errors,
            commands,
            affectedFiles.Order(StringComparer.OrdinalIgnoreCase).ToArray(),
            networkTargets.Order(StringComparer.OrdinalIgnoreCase).ToArray(),
            requestedCapabilities.Order(StringComparer.Ordinal).ToArray(),
            deniedReasons.Distinct(StringComparer.Ordinal).ToArray(),
            ReadOnly: deniedReasons.Count == 0);
    }

    public bool Discard(string analysisId)
    {
        if (string.IsNullOrWhiteSpace(analysisId))
        {
            throw new BrokerException("INVALID_ANALYSIS_ID", "analysisId 不能为空");
        }
        return _analyses.TryRemove(analysisId, out _);
    }

    public VerifiedPowerShellAnalysis VerifyExecution(ExecutePowerShellRequest request)
    {
        PurgeExpiredAnalyses();
        ValidateRequest(new AnalyzePowerShellRequest(
            request.Script,
            request.Cwd,
            request.AllowedPaths,
            request.NetworkMode,
            request.TimeoutMs));
        if (!_analyses.TryRemove(request.AnalysisId, out var analysis))
        {
            throw new BrokerException("ANALYSIS_NOT_FOUND", "PowerShell 分析结果不存在或已经使用");
        }
        if (DateTimeOffset.UtcNow - analysis.CreatedAtUtc > AnalysisLifetime)
        {
            throw new BrokerException("ANALYSIS_EXPIRED", "PowerShell 分析结果已过期");
        }
        if (!CryptographicOperations.FixedTimeEquals(
            Convert.FromHexString(analysis.ScriptSha256),
            Convert.FromHexString(Sha256(request.Script))))
        {
            throw new BrokerException("SCRIPT_CHANGED", "PowerShell 脚本在分析后发生变化");
        }
        if (!string.Equals(request.ScriptSha256, analysis.ScriptSha256, StringComparison.Ordinal)
            || !string.Equals(request.Cwd, analysis.Cwd, StringComparison.OrdinalIgnoreCase)
            || request.TimeoutMs != analysis.TimeoutMs
            || !string.Equals(request.NetworkMode, analysis.NetworkMode, StringComparison.Ordinal))
        {
            throw new BrokerException("ANALYSIS_BINDING_MISMATCH", "执行参数与已审核分析结果不一致");
        }
        var normalizedAllowedPaths = request.AllowedPaths.Select(Path.GetFullPath).ToArray();
        if (!normalizedAllowedPaths.SequenceEqual(analysis.AllowedPaths, StringComparer.OrdinalIgnoreCase))
        {
            throw new BrokerException("ALLOWED_PATHS_CHANGED", "执行允许路径与分析阶段不一致");
        }
        return analysis;
    }

    private static void AnalyzeDangerousSyntax(ScriptBlockAst ast, List<string> deniedReasons)
    {
        foreach (var memberCall in ast.FindAll(node => node is InvokeMemberExpressionAst, true).Cast<InvokeMemberExpressionAst>())
        {
            deniedReasons.Add($"禁止 .NET/对象成员方法调用：{memberCall.Extent.Text}");
        }
        foreach (var typeExpression in ast.FindAll(node => node is TypeExpressionAst, true).Cast<TypeExpressionAst>())
        {
            deniedReasons.Add($"禁止直接使用 .NET 类型表达式：{typeExpression.Extent.Text}");
        }
        foreach (var redirection in ast.FindAll(node => node is FileRedirectionAst, true).Cast<FileRedirectionAst>())
        {
            deniedReasons.Add($"禁止 PowerShell 文件重定向：{redirection.Extent.Text}");
        }
        foreach (var commandExpression in ast.FindAll(node => node is CommandExpressionAst, true).Cast<CommandExpressionAst>())
        {
            if (commandExpression.Expression is VariableExpressionAst or ScriptBlockExpressionAst)
            {
                deniedReasons.Add($"禁止动态命令表达式：{commandExpression.Extent.Text}");
            }
        }
        foreach (var usingExpression in ast.FindAll(node => node is UsingExpressionAst, true))
        {
            deniedReasons.Add($"禁止跨运行空间 using 表达式：{usingExpression.Extent.Text}");
        }
    }

    private static void AnalyzeCommand(
        CommandAst commandAst,
        AnalyzePowerShellRequest request,
        List<PowerShellCommandInfo> commands,
        HashSet<string> affectedFiles,
        HashSet<string> networkTargets,
        HashSet<string> requestedCapabilities,
        List<string> deniedReasons)
    {
        var name = commandAst.GetCommandName();
        if (string.IsNullOrWhiteSpace(name))
        {
            deniedReasons.Add($"禁止无法静态解析名称的命令：{commandAst.Extent.Text}");
            return;
        }
        commands.Add(new PowerShellCommandInfo(
            name,
            commandAst.Extent.Text,
            commandAst.Extent.StartOffset,
            commandAst.Extent.EndOffset));

        if (commandAst.InvocationOperator != TokenKind.Unknown)
        {
            deniedReasons.Add($"禁止 call/dot source 动态调用：{commandAst.Extent.Text}");
            return;
        }
        if (DeniedCommands.Contains(name))
        {
            deniedReasons.Add($"禁止高风险 PowerShell 命令：{name}");
            return;
        }
        if (NetworkCommands.Contains(name))
        {
            if (request.NetworkMode == "offline")
            {
                deniedReasons.Add($"offline 模式禁止联网命令：{name}");
            }
            foreach (var target in ExtractLiteralArguments(commandAst))
            {
                if (Uri.TryCreate(target, UriKind.Absolute, out var uri))
                {
                    networkTargets.Add(uri.GetLeftPart(UriPartial.Authority));
                }
            }
            return;
        }
        if (!ReadOnlyCommands.Contains(name))
        {
            deniedReasons.Add($"命令不在 Phase 5 静态审核白名单：{name}");
            return;
        }

        if (PathCommands.Contains(name))
        {
            foreach (var argument in ExtractLiteralArguments(commandAst))
            {
                if (argument.StartsWith("-", StringComparison.Ordinal))
                {
                    continue;
                }
                var relative = WindowsPathPolicy.ValidateAndRelativize(argument, request.Cwd, request.AllowedPaths);
                affectedFiles.Add(relative);
                requestedCapabilities.Add("workspace.read");
            }
        }
    }

    private static IEnumerable<string> ExtractLiteralArguments(CommandAst commandAst)
    {
        foreach (var element in commandAst.CommandElements.Skip(1))
        {
            switch (element)
            {
                case StringConstantExpressionAst literal:
                    yield return literal.Value;
                    break;
                case ExpandableStringExpressionAst expandable when expandable.NestedExpressions.Count == 0:
                    yield return expandable.Value;
                    break;
                case CommandParameterAst:
                    break;
                default:
                    throw new BrokerException(
                        "DYNAMIC_ARGUMENT_DENIED",
                        $"禁止无法静态证明安全的动态参数：{element.Extent.Text}");
            }
        }
    }

    private static void ValidateRequest(AnalyzePowerShellRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Script))
        {
            throw new BrokerException("INVALID_SCRIPT", "PowerShell 脚本不能为空");
        }
        if (request.TimeoutMs is < 100 or > 120_000)
        {
            throw new BrokerException("INVALID_TIMEOUT", "timeoutMs 必须为 100~120000");
        }
        if (request.AllowedPaths.Count == 0)
        {
            throw new BrokerException("EMPTY_ALLOWED_PATHS", "至少需要一个允许路径");
        }
        if (request.NetworkMode is not ("offline" or "lan" or "internet"))
        {
            throw new BrokerException("INVALID_NETWORK_MODE", "networkMode 无效");
        }
        if (request.NetworkMode != "offline")
        {
            throw new BrokerException(
                "EGRESS_BROKER_NOT_AVAILABLE",
                "Phase 5 不允许沙箱进程直接访问 LAN/互联网；必须等待统一 Egress Broker");
        }
        WindowsPathPolicy.ValidateRoot(request.Cwd, request.AllowedPaths);
    }

    private void PurgeExpiredAnalyses()
    {
        var threshold = DateTimeOffset.UtcNow - AnalysisLifetime;
        foreach (var pair in _analyses)
        {
            if (pair.Value.CreatedAtUtc < threshold)
            {
                _analyses.TryRemove(pair.Key, out _);
            }
        }
    }

    private static string Sha256(string text)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(text));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}
