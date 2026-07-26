#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$BrokerPath,
    [Parameter(Mandatory)]
    [string]$WorkspacePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if (-not $IsWindows) { throw '集成测试只能在 Windows 11 执行。' }
if (-not (Test-Path -LiteralPath $BrokerPath -PathType Leaf)) { throw "Broker 不存在：$BrokerPath" }
$workspace = (Resolve-Path -LiteralPath $WorkspacePath).Path

$process = [Diagnostics.Process]::new()
$process.StartInfo = [Diagnostics.ProcessStartInfo]@{
    FileName = $BrokerPath
    UseShellExecute = $false
    RedirectStandardInput = $true
    RedirectStandardOutput = $true
    RedirectStandardError = $true
    CreateNoWindow = $true
}
if (-not $process.Start()) { throw '无法启动 Broker。' }

function Invoke-Broker([string]$Id, [string]$Method, [hashtable]$Params) {
    $request = @{ kind = 'request'; id = $Id; method = $Method; params = $Params } | ConvertTo-Json -Compress -Depth 8
    $process.StandardInput.WriteLine($request)
    $process.StandardInput.Flush()
    $line = $process.StandardOutput.ReadLine()
    if ([string]::IsNullOrWhiteSpace($line)) { throw "Broker 未返回响应：$Method" }
    $response = $line | ConvertFrom-Json -Depth 16
    if (-not $response.ok) { throw "$($response.error.code): $($response.error.message)" }
    return $response.result
}

try {
    $hello = Invoke-Broker 'hello-1' 'hello' @{}
    foreach ($feature in 'powerShellAst','restrictedToken','appContainer','jobObject','filesystemAcl','networkIsolation','processTreeTermination','utf8Protocol') {
        if (-not $hello.features.$feature) { throw "Broker 缺少能力：$feature" }
    }

    $safe = 'Get-Date'
    $analysis = Invoke-Broker 'analysis-1' 'powershell.analyze' @{
        script = $safe; cwd = $workspace; allowedPaths = @($workspace); networkMode = 'offline'; timeoutMs = 30000
    }
    if ($analysis.deniedReasons.Count -ne 0) { throw "安全脚本被拒绝：$($analysis.deniedReasons -join '; ')" }

    $execution = Invoke-Broker 'execute-1' 'powershell.execute' @{
        executionId = 'integration-execution-1'; analysisId = $analysis.analysisId
        scriptSha256 = $analysis.scriptSha256; script = $safe; cwd = $workspace
        allowedPaths = @($workspace); networkMode = 'offline'; timeoutMs = 30000
    }
    if ($execution.exitCode -ne 0) { throw "安全执行失败：$($execution.stderr)" }

    $unsafe = Invoke-Broker 'analysis-2' 'powershell.analyze' @{
        script = '[IO.File]::WriteAllText("x.txt", "x")'; cwd = $workspace
        allowedPaths = @($workspace); networkMode = 'offline'; timeoutMs = 30000
    }
    if ($unsafe.deniedReasons.Count -eq 0) { throw '静态 .NET 写文件绕过没有被拒绝。' }

    Write-Host 'Windows Sandbox Broker 集成测试通过。'
}
finally {
    if (-not $process.HasExited) { $process.Kill($true) }
    $process.Dispose()
}
