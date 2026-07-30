[CmdletBinding()]
param(
    [string]$Workspace = (Get-Location).Path,
    [switch]$ForceBuild,
    [switch]$BuildOnly,
    [switch]$E2E
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$nodeRoot = Join-Path $projectRoot 'vendor\node22-22.14.0'
$nodePath = Join-Path $nodeRoot 'node.exe'
$npmPath = Join-Path $nodeRoot 'node-v22.14.0-win-x64\npm.cmd'
$npmCiCommand = "& '$npmPath' ci"
$brokerBuildCommand = "& '$npmPath' run sandbox:build-windows"
$tscPath = Join-Path $projectRoot 'node_modules\typescript\bin\tsc'
$stampPath = Join-Path $projectRoot 'dist\.tui-build.sha256'
$entryPath = Join-Path $projectRoot 'dist\src\tui\main.js'
$e2eEntryPath = Join-Path $projectRoot 'dist\src\tui\e2e.js'

if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    throw "仓库内 Node 22 不存在：$nodePath"
}
$nodeVersion = (& $nodePath --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.') {
    throw "仓库内 Node 版本不符合 TUI 要求：$nodeVersion"
}
if (-not (Test-Path -LiteralPath $tscPath -PathType Leaf)) {
    throw ("TypeScript 依赖不存在：{0}；请执行 {1}" -f $tscPath, $npmCiCommand)
}
foreach ($dependency in @('ink', 'react', 'slice-ansi', 'string-width', 'wrap-ansi', 'exceljs', 'pdf-lib', 'pdfjs-dist', 'mammoth', 'docx', 'jszip', '@pdf-lib\fontkit')) {
    $dependencyPackage = Join-Path $projectRoot ("node_modules\{0}\package.json" -f $dependency)
    if (-not (Test-Path -LiteralPath $dependencyPackage -PathType Leaf)) {
        throw ("{0} 依赖不存在；请执行 {1}" -f $dependency, $npmCiCommand)
    }
}

$packagedBrokerPath = Join-Path $projectRoot 'resources\app\bin\windows-sandbox-broker\IndependentAiIde.WindowsSandboxBroker.exe'
$defaultBrokerPath = Join-Path $projectRoot 'native\windows-sandbox-broker\bin\Release\net8.0-windows\win-x64\publish\IndependentAiIde.WindowsSandboxBroker.exe'
$brokerPath = if (Test-Path -LiteralPath $packagedBrokerPath -PathType Leaf) { $packagedBrokerPath } else { $defaultBrokerPath }
if (-not (Test-Path -LiteralPath $brokerPath -PathType Leaf)) {
    throw ("Windows Sandbox Broker 不存在：{0}；请执行 {1} 构建后重试。" -f $brokerPath, $brokerBuildCommand)
}

$workspacePath = ''
if (-not $E2E) {
    $workspacePath = (Resolve-Path -LiteralPath $Workspace -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) {
        throw "工作区必须是已经存在的目录：$workspacePath"
    }
}

function Get-TuiBuildDigest {
    $inputs = @(
        Get-ChildItem -LiteralPath (Join-Path $projectRoot 'src') -Recurse -File |
            Where-Object { $_.Extension -in @('.ts', '.tsx') }
        Get-Item -LiteralPath (Join-Path $projectRoot 'tsconfig.json')
        Get-Item -LiteralPath (Join-Path $projectRoot 'package.json')
        if (Test-Path -LiteralPath (Join-Path $projectRoot 'package-lock.json') -PathType Leaf) {
            Get-Item -LiteralPath (Join-Path $projectRoot 'package-lock.json')
        }
    ) | Sort-Object FullName
    $parts = foreach ($file in $inputs) {
        $relative = $file.FullName.Substring($projectRoot.Length).TrimStart('\', '/')
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        "$relative`n$hash"
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($parts -join "`n"))
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha256.ComputeHash($bytes)
    } finally {
        $sha256.Dispose()
    }
    return (($hashBytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

$digest = Get-TuiBuildDigest
$previousDigest = if (Test-Path -LiteralPath $stampPath -PathType Leaf) {
    (Get-Content -LiteralPath $stampPath -Raw).Trim()
} else { '' }

if ($ForceBuild -or -not (Test-Path -LiteralPath $entryPath -PathType Leaf) -or -not (Test-Path -LiteralPath $e2eEntryPath -PathType Leaf) -or $digest -ne $previousDigest) {
    Write-Host "正在使用仓库内 Node 22 编译 TUI…"
    & $nodePath $tscPath
    if ($LASTEXITCODE -ne 0) { throw "TypeScript 编译失败，退出码：$LASTEXITCODE" }
    New-Item -ItemType Directory -Path (Split-Path -Parent $stampPath) -Force | Out-Null
    Set-Content -LiteralPath $stampPath -Value $digest -Encoding utf8
} else {
    Write-Host 'TUI 构建缓存有效，跳过 TypeScript 编译。'
}

if ($BuildOnly) {
    Write-Output "TUI_BUILD_OK=$entryPath"
    exit 0
}

if ($E2E) {
    & $nodePath $e2eEntryPath
} else {
    & $nodePath $entryPath $workspacePath
}
exit $LASTEXITCODE
