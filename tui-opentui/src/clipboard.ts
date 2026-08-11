import { spawn } from "node:child_process";

/**
 * OpenCode 在 Windows 上使用 PowerShell Set-Clipboard 写入系统剪贴板。
 * Peru Agent 第一目标平台同样是 Windows 11，因此这里固定使用 PowerShell 7，
 * 不提供 OSC52/clipboardy 等隐式 fallback。
 */
export async function writeClipboard(text: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("OpenTUI 剪贴板 Phase 1 仅支持 Windows 11");
  }
  await runClipboardCommand("pwsh.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
  ], text);
}

function runClipboardCommand(command: string, args: readonly string[], input: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} 剪贴板命令失败 (${code ?? "unknown"})：${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
    child.stdin?.end(input, "utf8");
  });
}
