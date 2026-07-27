param([Parameter(Mandatory = $true)][string]$UninstallerPath)
$ErrorActionPreference = 'Stop'
$resolved = (Resolve-Path -LiteralPath $UninstallerPath).Path
$signature = Get-AuthenticodeSignature -LiteralPath $resolved
if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw 'Uninstaller Authenticode signature is invalid.' }
$process = Start-Process -FilePath $resolved -ArgumentList '/S' -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Uninstaller failed with exit code $($process.ExitCode)." }
