param(
    [Parameter(Mandatory = $true)][string]$CodeOssRoot,
    [ValidateSet('x64', 'arm64')][string]$Architecture = 'x64'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $IsWindows) { throw 'Windows local package build must run on Windows.' }
$root = (Resolve-Path -LiteralPath $CodeOssRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\gulp\bin\gulp.js') -PathType Leaf)) {
    throw 'Code OSS locked dependencies are missing. Run Yarn 1 with the frozen lockfile first.'
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments) {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$FilePath failed with exit code $LASTEXITCODE." }
}

$nodeVersion = (& node --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v16\.14\.\d+$') {
    throw "Code OSS 1.74.0 requires Node.js 16.14.x; current=$nodeVersion"
}
$yarnVersion = (& yarn --version).Trim()
if ($LASTEXITCODE -ne 0 -or $yarnVersion -notmatch '^1\.\d+\.\d+$') {
    throw "Code OSS 1.74.0 requires Yarn Classic 1.x; current=$yarnVersion"
}

$buildRoot = Join-Path (Split-Path -Parent $root) 'Independent-AI-IDE-local-build'
$env:INDEPENDENT_AI_IDE_BUILD_ROOT = $buildRoot
$env:INDEPENDENT_AI_IDE_LOCAL_PACKAGE = '1'

Push-Location $root
try {
    Invoke-Checked 'yarn' @('compile')
    Invoke-Checked 'yarn' @('gulp', 'extensions-ci')
    Invoke-Checked 'yarn' @('gulp', "vscode-win32-$Architecture-min-ci")
    Invoke-Checked 'npm' @('--prefix', (Join-Path $root '..\ai-ide-phase12'), 'run', 'build')
    Invoke-Checked 'npm' @('--prefix', (Join-Path $root '..\ai-ide-phase12'), 'run', 'sandbox:build-windows')

    $payloadRoot = (Resolve-Path -LiteralPath (Join-Path $buildRoot "VSCode-win32-$Architecture")).Path
    Invoke-Checked 'node' @((Join-Path $root '..\ai-ide-phase12\tools\code-oss\package-ai-runtime.mjs'), '--target', $payloadRoot)
    $extensions = Join-Path $payloadRoot 'resources\app\extensions'
    if (-not (Test-Path -LiteralPath $extensions -PathType Container)) { throw "Built-in extensions were not packaged: $extensions" }
    $languagePack = Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE '.vscode\extensions') -Directory |
        Where-Object { $_.Name -like 'ms-ceintl.vscode-language-pack-zh-hans-*' } |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if ($null -eq $languagePack) { throw '未找到微软官方简体中文语言包 ms-ceintl.vscode-language-pack-zh-hans。' }
    $languagePackTarget = Join-Path $extensions 'ms-ceintl.vscode-language-pack-zh-hans'
    Copy-Item -LiteralPath $languagePack.FullName -Destination $languagePackTarget -Recurse -Force
    if (-not (Test-Path -LiteralPath (Join-Path $languagePackTarget 'package.json') -PathType Leaf)) { throw '简体中文语言包复制失败。' }
    $executable = Join-Path $payloadRoot 'Independent AI IDE.exe'
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw "Windows portable executable was not produced: $executable"
    }
    Write-Output "LOCAL_PORTABLE_PACKAGE=$payloadRoot"
} finally {
    Pop-Location
}