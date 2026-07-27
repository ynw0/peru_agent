using System.Text;
using IndependentAiIde.WindowsUiAutomationBroker.Protocol;

Console.InputEncoding = new UTF8Encoding(false, true);
Console.OutputEncoding = new UTF8Encoding(false, true);
Console.Error.WriteLine("Independent AI IDE Windows UI Automation Broker");
await new JsonLinesServer().RunAsync();
