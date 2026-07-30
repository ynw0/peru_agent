using System.Management.Automation;
using System.Management.Automation.Language;
using System.Security.AccessControl;
using IndependentAiIde.WindowsSandboxBroker.Protocol;

namespace IndependentAiIde.WindowsSandboxBroker.Sandbox;

internal sealed class SandboxCapabilityProbe
{
    public BrokerHelloResult CreateHello()
    {
        var windowsX64 = OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000) && Environment.Is64BitProcess;
        var powerShellPath = ResolvePowerShellExecutable();
        var nativeApis = NativeMethods.RequiredEntryPointsAvailable();
        var filesystemAcl = CanRoundTripAcl();
        var features = new WindowsSandboxFeatures(
            PowerShellAst: CanParsePowerShellAst(),
            RestrictedToken: windowsX64 && nativeApis,
            AppContainer: windowsX64 && nativeApis,
            JobObject: windowsX64 && nativeApis,
            FilesystemAcl: windowsX64 && filesystemAcl,
            NetworkIsolation: windowsX64 && nativeApis,
            ProcessTreeTermination: windowsX64 && nativeApis,
            Utf8Protocol: true);
        return new BrokerHelloResult(
            ProtocolConstants.Version,
            typeof(SandboxCapabilityProbe).Assembly.GetName().Version?.ToString() ?? "0.0.0",
            "windows",
            "x64",
            PSVersionInfo.PSVersion.ToString(),
            powerShellPath,
            features);
    }

    public void AssertProductionReady()
    {
        var hello = CreateHello();
        var missing = new List<string>();
        if (!hello.Features.PowerShellAst) missing.Add("powerShellAst");
        if (!hello.Features.RestrictedToken) missing.Add("restrictedToken");
        if (!hello.Features.AppContainer) missing.Add("appContainer");
        if (!hello.Features.JobObject) missing.Add("jobObject");
        if (!hello.Features.FilesystemAcl) missing.Add("filesystemAcl");
        if (!hello.Features.NetworkIsolation) missing.Add("networkIsolation");
        if (!hello.Features.ProcessTreeTermination) missing.Add("processTreeTermination");
        if (!hello.Features.Utf8Protocol) missing.Add("utf8Protocol");
        if (missing.Count > 0)
        {
            throw new BrokerException("SANDBOX_NOT_READY", $"Windows 沙箱能力不完整：{string.Join(", ", missing)}");
        }
    }

    public string ResolvePowerShellExecutable()
    {
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var candidates = new List<string>
        {
            Path.Combine(programFiles, "PowerShell", "7", "pwsh.exe"),
        };
        var storeRoot = Path.Combine(programFiles, "WindowsApps");
        try
        {
            candidates.AddRange(Directory.EnumerateDirectories(storeRoot, "Microsoft.PowerShell_*_x64__8wekyb3d8bbwe")
                .OrderByDescending(Path.GetFileName, StringComparer.OrdinalIgnoreCase)
                .Select(packageDirectory => Path.Combine(packageDirectory, "pwsh.exe")));
        }
        catch (UnauthorizedAccessException)
        {
            // 无权枚举 WindowsApps 时，只接受传统 MSI 安装路径。
        }
        foreach (var candidate in candidates)
        {
            if (File.Exists(candidate)) return candidate;
        }
        throw new BrokerException("POWERSHELL_7_NOT_FOUND", $"未找到官方 PowerShell 7：{string.Join("; ", candidates)}");
    }

    private static bool CanParsePowerShellAst()
    {
        try
        {
            _ = Parser.ParseInput("Get-Date", out _, out var errors);
            return errors.Length == 0;
        }
        catch (Exception error) when (error is InvalidOperationException or TypeInitializationException)
        {
            return false;
        }
    }

    private static bool CanRoundTripAcl()
    {
        var root = Path.Combine(Path.GetTempPath(), $"independent-ai-ide-acl-probe-{Guid.NewGuid():N}");
        try
        {
            var directory = Directory.CreateDirectory(root);
            var security = directory.GetAccessControl(AccessControlSections.Access);
            var sddl = security.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
            var clone = new DirectorySecurity();
            clone.SetSecurityDescriptorSddlForm(sddl, AccessControlSections.Access);
            directory.SetAccessControl(clone);
            return true;
        }
        catch (Exception error) when (error is UnauthorizedAccessException or IOException or PlatformNotSupportedException)
        {
            return false;
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
}
