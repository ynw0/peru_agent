using IndependentAiIde.WindowsSandboxBroker.Protocol;

namespace IndependentAiIde.WindowsSandboxBroker.PowerShell;

internal static class WindowsPathPolicy
{
    private static readonly System.Text.RegularExpressions.Regex ProviderPath = new(
        @"^[A-Za-z][A-Za-z0-9.-]*:(?![\\/])",
        System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    private static readonly string[] CredentialSegments =
    {
        @"\.ssh\", @"\AppData\", @"\Microsoft\Credentials\", @"\Microsoft\Vault\",
    };

    public static void ValidateRoot(string cwd, IReadOnlyList<string> allowedPaths)
    {
        var fullCwd = Path.GetFullPath(cwd);
        if (!Path.IsPathFullyQualified(fullCwd))
        {
            throw new BrokerException("CWD_NOT_ABSOLUTE", "cwd 必须是绝对 Windows 路径");
        }
        if (!allowedPaths.Any(path => IsInside(Path.GetFullPath(path), fullCwd)))
        {
            throw new BrokerException("CWD_OUTSIDE_ALLOWED_PATHS", "cwd 不在允许路径内");
        }
        foreach (var path in allowedPaths)
        {
            var full = Path.GetFullPath(path);
            if (!Path.IsPathFullyQualified(full) || full.StartsWith(@"\\", StringComparison.Ordinal))
            {
                throw new BrokerException("INVALID_ALLOWED_PATH", "允许路径必须是本机绝对路径，禁止 UNC");
            }
            if (CredentialSegments.Any(segment => full.Contains(segment, StringComparison.OrdinalIgnoreCase)))
            {
                throw new BrokerException("CREDENTIAL_PATH_DENIED", $"禁止把凭据目录加入沙箱：{full}");
            }
        }
    }

    public static string ValidateAndRelativize(
        string input,
        string cwd,
        IReadOnlyList<string> allowedPaths)
    {
        if (string.IsNullOrWhiteSpace(input) || input.IndexOf('\0') >= 0)
        {
            throw new BrokerException("INVALID_PATH", "路径为空或包含空字符");
        }
        if (input.StartsWith(@"\\", StringComparison.Ordinal) || input.StartsWith("//", StringComparison.Ordinal))
        {
            throw new BrokerException("UNC_PATH_DENIED", $"禁止 UNC 路径：{input}");
        }
        if (ProviderPath.IsMatch(input))
        {
            throw new BrokerException("PROVIDER_PATH_DENIED", $"禁止 PowerShell Provider 路径：{input}");
        }
        if (input.IndexOfAny(new[] { '*', '?', '[', ']' }) >= 0)
        {
            throw new BrokerException("WILDCARD_PATH_DENIED", $"Phase 5 禁止无法精确归一化的通配路径：{input}");
        }
        var full = Path.GetFullPath(Path.IsPathFullyQualified(input) ? input : Path.Combine(cwd, input));
        var root = allowedPaths.Select(Path.GetFullPath)
            .FirstOrDefault(path => IsInside(path, full));
        if (root is null)
        {
            throw new BrokerException("PATH_OUTSIDE_WORKSPACE", $"路径超出允许工作区：{input}");
        }
        var relative = Path.GetRelativePath(root, full).Replace('\\', '/');
        if (relative == ".")
        {
            throw new BrokerException("WORKSPACE_ROOT_AS_FILE", "命令参数不能把工作区根目录当作文件");
        }
        return relative;
    }

    private static bool IsInside(string root, string candidate)
    {
        var relative = Path.GetRelativePath(root, candidate);
        return relative == "."
            || (!relative.Equals("..", StringComparison.Ordinal)
                && !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && !Path.IsPathFullyQualified(relative));
    }
}
