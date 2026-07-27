$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
dotnet publish "$root\IndependentAiIde.WindowsUiAutomationBroker.csproj" -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true
