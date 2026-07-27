$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root "bin\Release\net8.0-windows\win-x64\publish\IndependentAiIde.WindowsUiAutomationBroker.exe"
if (-not (Test-Path $exe)) { throw "Broker 尚未构建：$exe" }
$hello = '{"kind":"request","id":"hello-1","method":"hello","params":{}}' | & $exe | Select-Object -First 1
if ($hello -notmatch '"ok":true') { throw "Broker hello 失败：$hello" }
Write-Host "Windows UI Automation Broker hello 通过"
