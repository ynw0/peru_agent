using System.Text;
using IndependentAiIde.WindowsSandboxBroker.Audit;
using IndependentAiIde.WindowsSandboxBroker.PowerShell;
using IndependentAiIde.WindowsSandboxBroker.Protocol;
using IndependentAiIde.WindowsSandboxBroker.Sandbox;

Console.InputEncoding = new UTF8Encoding(false, true);
Console.OutputEncoding = new UTF8Encoding(false, true);

if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess)
{
    Console.Error.WriteLine("Windows Sandbox Broker 只支持 Windows x64");
    return 2;
}

using var shutdown = new CancellationTokenSource();
Console.CancelKeyPress += (_, eventArgs) =>
{
    eventArgs.Cancel = true;
    shutdown.Cancel();
};

var probe = new SandboxCapabilityProbe();
var audit = new AuditLogger();
var analyzer = new PowerShellAnalyzer();
var executor = new WindowsSandboxExecutor(probe, audit);
var server = new JsonLinesServer(analyzer, executor, probe);
await server.RunAsync(Console.In, Console.Out, shutdown.Token).ConfigureAwait(false);
return 0;
