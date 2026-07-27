using System.Diagnostics;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Runtime.InteropServices;
using IndependentAiIde.WindowsUiAutomationBroker.Protocol;
using IndependentAiIde.WindowsUiAutomationBroker.Security;

namespace IndependentAiIde.WindowsUiAutomationBroker.Identity;

internal sealed class ApplicationIdentityService
{
    internal IReadOnlyList<RunningApplicationIdentity> ListWindows()
    {
        var result = new List<RunningApplicationIdentity>();
        NativeMethods.EnumWindows((window, _) =>
        {
            if (!NativeMethods.IsWindowVisible(window)) return true;
            try
            {
                var identity = Read(window);
                if (!string.IsNullOrWhiteSpace(identity.WindowTitle)) result.Add(identity);
            }
            catch
            {
                // 无法读取的系统窗口不进入可操作集合。
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    internal RunningApplicationIdentity Read(IntPtr window)
    {
        var threadId = NativeMethods.GetWindowThreadProcessId(window, out var processId);
        if (processId == 0) throw new InvalidOperationException("窗口没有有效进程");
        using var process = Process.GetProcessById((int)processId);
        var executablePath = process.MainModule?.FileName ?? throw new InvalidOperationException("无法读取进程路径");
        var versionInfo = FileVersionInfo.GetVersionInfo(executablePath);
        var certificate = ReadCertificate(executablePath);
        return new RunningApplicationIdentity(
            (int)processId,
            executablePath,
            Path.GetFileName(executablePath),
            certificate?.Subject ?? string.Empty,
            certificate?.Thumbprint?.Replace(" ", string.Empty, StringComparison.Ordinal).ToUpperInvariant() ?? string.Empty,
            versionInfo.FileVersion ?? "0.0.0.0",
            Sha256File(executablePath),
            $"0x{window.ToInt64():x}",
            ReadWindowText(window),
            ReadWindowClass(window),
            ReadIntegrityLevel(process),
            !string.Equals(ReadDesktopName(threadId), "Default", StringComparison.OrdinalIgnoreCase));
    }

    private static X509Certificate2? ReadCertificate(string path)
    {
        try { return new X509Certificate2(X509Certificate.CreateFromSignedFile(path)); }
        catch (CryptographicException) { return null; }
    }

    private static string Sha256File(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static string ReadWindowText(IntPtr window)
    {
        var buffer = new StringBuilder(4096);
        NativeMethods.GetWindowText(window, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    private static string ReadWindowClass(IntPtr window)
    {
        var buffer = new StringBuilder(512);
        NativeMethods.GetClassName(window, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    private static string ReadDesktopName(uint threadId)
    {
        var desktop = NativeMethods.GetThreadDesktop(threadId);
        if (desktop == IntPtr.Zero) return string.Empty;
        var buffer = new StringBuilder(256);
        return NativeMethods.GetUserObjectInformation(desktop, 2, buffer, buffer.Capacity * sizeof(char), out _)
            ? buffer.ToString()
            : string.Empty;
    }

    private static string ReadIntegrityLevel(Process process)
    {
        const uint tokenQuery = 0x0008;
        const int tokenIntegrityLevel = 25;
        if (!NativeMethods.OpenProcessToken(process.Handle, tokenQuery, out var token)) return "unknown";
        try
        {
            NativeMethods.GetTokenInformation(token, tokenIntegrityLevel, IntPtr.Zero, 0, out var needed);
            var buffer = Marshal.AllocHGlobal(needed);
            try
            {
                if (!NativeMethods.GetTokenInformation(token, tokenIntegrityLevel, buffer, needed, out _)) return "unknown";
                var sid = Marshal.ReadIntPtr(buffer);
                var count = Marshal.ReadByte(sid, 1);
                var rid = Marshal.ReadInt32(sid, 8 + (count - 1) * 4);
                return rid switch
                {
                    < 0x1000 => "low",
                    < 0x3000 => "medium",
                    < 0x4000 => "high",
                    _ => "system",
                };
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        finally { NativeMethods.CloseHandle(token); }
    }
}
