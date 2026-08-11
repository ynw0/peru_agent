[CmdletBinding()]
param(
    [string]$Workspace = (Get-Location).Path,
    [switch]$BuildOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw "peru_agent OpenTUI 只支持 PowerShell 7。当前版本：$($PSVersionTable.PSVersion)"
}

$projectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$openTuiRoot = Join-Path $projectRoot 'tui-opentui'
$entryPath = Join-Path $openTuiRoot 'src\main.tsx'
$packagePath = Join-Path $openTuiRoot 'package.json'

$bunCommand = Get-Command bun.exe -ErrorAction SilentlyContinue
if ($null -eq $bunCommand) {
    $standardBun = Join-Path $HOME '.bun\bin\bun.exe'
    if (Test-Path -LiteralPath $standardBun -PathType Leaf) {
        $bunPath = $standardBun
    } else {
        throw "OpenTUI 原生 renderer 要求 Bun >= 1.3。请先安装 Bun，并确保 bun.exe 位于 PATH 或 $standardBun。不会回退到 Ink/Node TUI。"
    }
} else {
    $bunPath = $bunCommand.Source
}

$bunVersion = (& $bunPath --version).Trim()
if ($LASTEXITCODE -ne 0 -or $bunVersion -notmatch '^(\d+)\.(\d+)\.(\d+)') {
    throw "无法识别 Bun 版本：$bunVersion"
}
$major = [int]$Matches[1]
$minor = [int]$Matches[2]
if ($major -lt 1 -or ($major -eq 1 -and $minor -lt 3)) {
    throw "OpenTUI 要求 Bun >= 1.3；当前：$bunVersion"
}

foreach ($path in @($openTuiRoot, $entryPath, $packagePath)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "OpenTUI 文件不存在：$path"
    }
}

$dependencyMarkers = @(
    (Join-Path $openTuiRoot 'node_modules\@opentui\core\package.json'),
    (Join-Path $openTuiRoot 'node_modules\@opentui\react\package.json'),
    (Join-Path $openTuiRoot 'node_modules\react\package.json')
)
if ($dependencyMarkers | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }) {
    Write-Host '首次安装 OpenTUI 固定版本依赖…'
    Push-Location $openTuiRoot
    try {
        & $bunPath install
        if ($LASTEXITCODE -ne 0) { throw "bun install 失败，退出码：$LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

if ($BuildOnly) {
    Push-Location $openTuiRoot
    try {
        & $bunPath x tsc --noEmit -p tsconfig.json
        if ($LASTEXITCODE -ne 0) { throw "OpenTUI TypeScript 检查失败，退出码：$LASTEXITCODE" }
    } finally {
        Pop-Location
    }
    Write-Output "OPENTUI_BUILD_OK=$entryPath"
    exit 0
}

$packagedBrokerPath = Join-Path $projectRoot 'resources\app\bin\windows-sandbox-broker\IndependentAiIde.WindowsSandboxBroker.exe'
$defaultBrokerPath = Join-Path $projectRoot 'native\windows-sandbox-broker\bin\Release\net8.0-windows\win-x64\publish\IndependentAiIde.WindowsSandboxBroker.exe'
$brokerPath = if (Test-Path -LiteralPath $packagedBrokerPath -PathType Leaf) { $packagedBrokerPath } else { $defaultBrokerPath }
if (-not (Test-Path -LiteralPath $brokerPath -PathType Leaf)) {
    $buildScript = Join-Path $projectRoot 'native\windows-sandbox-broker\build.ps1'
    throw "Windows Sandbox Broker 不存在：$brokerPath；请执行 pwsh -File `"$buildScript`" 构建后重试。"
}

$workspacePath = (Resolve-Path -LiteralPath $Workspace -ErrorAction Stop).Path
if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) {
    throw "工作区必须是已经存在的目录：$workspacePath"
}

Write-Host "正在使用 Bun $bunVersion 启动 OpenTUI renderer…"
& $bunPath $entryPath $workspacePath
exit $LASTEXITCODE
