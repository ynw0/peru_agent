param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$ExpectedPublisher,
    [Parameter(Mandatory = $true)][string]$ExpectedThumbprint
)
$ErrorActionPreference = 'Stop'
$resolved = (Resolve-Path -LiteralPath $InstallerPath).Path
$signature = Get-AuthenticodeSignature -LiteralPath $resolved
if ($signature.Status -ne 'Valid') { throw "Installer Authenticode signature is not valid: $($signature.Status)" }
if ($null -eq $signature.SignerCertificate) { throw 'Installer does not have a signer certificate.' }
if ($signature.SignerCertificate.Subject -ne $ExpectedPublisher) { throw 'Installer publisher does not match the release policy.' }
if ($signature.SignerCertificate.Thumbprint.ToUpperInvariant() -ne $ExpectedThumbprint.ToUpperInvariant()) { throw 'Installer certificate thumbprint does not match the release policy.' }
$process = Start-Process -FilePath $resolved -ArgumentList '/S' -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Installer failed with exit code $($process.ExitCode)." }
