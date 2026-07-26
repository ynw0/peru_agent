#requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if (-not $IsWindows) {
    throw 'Windows Sandbox Broker 只能在 Windows 11 x64 构建和验证。'
}
if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'Windows Sandbox Broker 不支持 32 位 Windows。'
}
if ([Environment]::OSVersion.Version.Build -lt 22000) {
    throw 'Windows Sandbox Broker 第一目标平台为 Windows 11 build 22000 或更高。'
}

$dotnet = Get-Command dotnet -ErrorAction Stop
$version = & $dotnet.Source --version
if (-not $version.StartsWith('8.', [StringComparison]::Ordinal)) {
    throw "需要 .NET SDK 8.x，当前版本：$version"
}

$project = Join-Path $PSScriptRoot 'IndependentAiIde.WindowsSandboxBroker.csproj'
& $dotnet.Source restore $project --use-lock-file
if ($LASTEXITCODE -ne 0) { throw 'dotnet restore 失败。' }
& $dotnet.Source build $project --configuration $Configuration --no-restore
if ($LASTEXITCODE -ne 0) { throw 'dotnet build 失败。' }
& $dotnet.Source publish $project --configuration $Configuration --no-restore --self-contained true
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish 失败。' }
