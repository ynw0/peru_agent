import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("../../native/windows-sandbox-broker/", import.meta.url);
const requiredFiles = [
  "IndependentAiIde.WindowsSandboxBroker.csproj",
  "Program.cs",
  "Protocol/Models.cs",
  "Protocol/JsonLinesServer.cs",
  "PowerShell/PowerShellAnalyzer.cs",
  "PowerShell/WindowsPathPolicy.cs",
  "Sandbox/SandboxCapabilityProbe.cs",
  "Sandbox/WindowsSandboxExecutor.cs",
  "Sandbox/SandboxTerminalSession.cs",
  "Sandbox/WindowsRestrictedProcess.cs",
  "Sandbox/NativeMethods.cs",
  "Sandbox/AppContainerAclScope.cs",
  "Audit/AuditLogger.cs",
];

const requiredFragments = new Map([
  ["IndependentAiIde.WindowsSandboxBroker.csproj", ["net8.0-windows", "win-x64", "Microsoft.PowerShell.SDK"]],
  ["PowerShell/PowerShellAnalyzer.cs", ["Parser.ParseInput", "InvokeMemberExpressionAst", "Invoke-Expression", "ANALYSIS_EXPIRED"]],
  ["Sandbox/WindowsRestrictedProcess.cs", ["CreateRestrictedToken", "CreateProcessAsUser", "AssignProcessToJobObject", "TerminateJobObject", "AppContainerAclScope"]],
  ["Sandbox/NativeMethods.cs", ["CreateAppContainerProfile", "PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES", "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE"]],
  ["Protocol/JsonLinesServer.cs", ["powershell.cancel", "powershell.discard-analysis", "powershell.terminal.start", "ConcurrentDictionary"]],
  ["Sandbox/SandboxTerminalSession.cs", ["PowerShellTerminalOutput", "CancelAsync", "AppendStdout"]],
]);

const forbiddenFragments = [
  "Process.Start(",
  "UseShellExecute = true",
  "cmd.exe /c",
  "\"powershell.exe\"",
];

const violations = [];
for (const file of requiredFiles) {
  let content;
  try {
    content = await readFile(new URL(file, root), "utf8");
  } catch (error) {
    violations.push(`${file}: 文件不存在或不可读：${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  for (const fragment of requiredFragments.get(file) ?? []) {
    if (!content.includes(fragment)) {
      violations.push(`${file}: 缺少强制实现片段 ${fragment}`);
    }
  }
  for (const forbidden of forbiddenFragments) {
    if (content.includes(forbidden)) {
      violations.push(`${file}: 包含禁止实现 ${forbidden}`);
    }
  }
}

async function collectCs(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const item = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) result.push(...await collectCs(item, `${prefix}${entry.name}/`));
    else if (entry.name.endsWith(".cs")) result.push(`${prefix}${entry.name}`);
  }
  return result;
}

const csFiles = await collectCs(root);
if (csFiles.length < 10) {
  violations.push(`原生 Broker C# 源文件过少：${csFiles.length}`);
}

if (violations.length > 0) {
  console.error("Windows Sandbox Broker 源码契约检查失败：");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Windows Sandbox Broker 源码契约检查通过：${csFiles.length} 个 C# 文件`);
}
