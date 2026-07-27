param(
    [Parameter(Mandatory = $true)][string]$CodeOssRoot,
    [ValidateSet('x64', 'arm64')][string]$Architecture = 'x64',
    [ValidateSet('user', 'system')][string]$InstallTarget = 'user',
    [Parameter(Mandatory = $true)][string]$SignToolPath,
    [Parameter(Mandatory = $true)][string]$CertificateThumbprint,
    [Parameter(Mandatory = $true)][string]$ExpectedPublisher,
    [Parameter(Mandatory = $true)][string]$TimestampUrl,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $IsWindows) { throw 'Windows release build must run on Windows.' }
$root = (Resolve-Path -LiteralPath $CodeOssRoot).Path
$signTool = (Resolve-Path -LiteralPath $SignToolPath).Path
if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\gulp\bin\gulp.js') -PathType Leaf)) {
    throw 'Code OSS locked dependencies are missing. Run Yarn 1 with the frozen lockfile first.'
}

$nodeVersion = (& node --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v16\.14\.\d+$') {
    throw "Code OSS 1.74.0 requires Node.js 16.14.x; current=$nodeVersion"
}
$yarnVersion = (& yarn --version).Trim()
if ($LASTEXITCODE -ne 0 -or $yarnVersion -notmatch '^1\.\d+\.\d+$') {
    throw "Code OSS 1.74.0 requires Yarn Classic 1.x; current=$yarnVersion"
}
if ($CertificateThumbprint -notmatch '^[0-9A-Fa-f]{40}$') { throw 'Certificate thumbprint must be 40 hexadecimal characters.' }
if (-not [Uri]::IsWellFormedUriString($TimestampUrl, [UriKind]::Absolute)) { throw 'Timestamp URL is invalid.' }

function Invoke-Checked([string]$FilePath, [string[]]$Arguments) {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$FilePath failed with exit code $LASTEXITCODE." }
}

function Sign-And-Verify([string]$Path) {
    Invoke-Checked $signTool @('sign', '/sha1', $CertificateThumbprint, '/fd', 'SHA256', '/tr', $TimestampUrl, '/td', 'SHA256', $Path)
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
        throw "Authenticode verification failed: $Path / $($signature.Status)"
    }
    if ($signature.SignerCertificate.Subject -ne $ExpectedPublisher) { throw "Publisher mismatch: $Path" }
    if ($signature.SignerCertificate.Thumbprint.ToUpperInvariant() -ne $CertificateThumbprint.ToUpperInvariant()) { throw "Thumbprint mismatch: $Path" }
}

Push-Location $root
try {
    Invoke-Checked 'yarn' @('compile')
    Invoke-Checked 'yarn' @('gulp', "vscode-win32-$Architecture-min-ci")

    $payloadRoot = (Resolve-Path -LiteralPath (Join-Path $root "..\VSCode-win32-$Architecture")).Path
    $payloadExecutables = Get-ChildItem -LiteralPath $payloadRoot -Recurse -File | Where-Object { $_.Extension -in '.exe', '.dll', '.node' }
    if ($payloadExecutables.Count -eq 0) { throw 'No Windows executable payloads were produced.' }
    foreach ($file in $payloadExecutables) { Sign-And-Verify $file.FullName }

    Invoke-Checked 'yarn' @('gulp', "vscode-win32-$Architecture-archive")
    Invoke-Checked 'yarn' @('gulp', "vscode-win32-$Architecture-$InstallTarget-setup")

    $setupPath = Join-Path $root ".build\win32-$Architecture\$InstallTarget-setup\VSCodeSetup.exe"
    if (-not (Test-Path -LiteralPath $setupPath -PathType Leaf)) { throw 'Windows setup executable was not produced.' }
    Sign-And-Verify $setupPath

    $archivePath = Join-Path $root ".build\win32-$Architecture\archive\VSCode-win32-$Architecture.zip"
    if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw 'Windows archive was not produced.' }

    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    Copy-Item -LiteralPath $archivePath -Destination (Join-Path $OutputDirectory "Independent-AI-IDE-$Architecture.zip") -Force
    Copy-Item -LiteralPath $setupPath -Destination (Join-Path $OutputDirectory "Independent-AI-IDE-$Architecture-$InstallTarget-Setup.exe") -Force
} catch {
    if (Test-Path -LiteralPath $OutputDirectory) { Remove-Item -LiteralPath $OutputDirectory -Recurse -Force }
    throw
} finally {
    Pop-Location
}
