using System.Security.AccessControl;
using System.Security.Principal;

namespace IndependentAiIde.WindowsSandboxBroker.Sandbox;

internal sealed class AppContainerAclScope : IDisposable
{
    private readonly List<(DirectoryInfo Directory, FileSystemAccessRule Rule)> _rules = new();
    private bool _disposed;

    public AppContainerAclScope(SecurityIdentifier appContainerSid, IEnumerable<string> readOnlyPaths, string writablePath)
    {
        foreach (var path in readOnlyPaths.Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            Grant(path, appContainerSid, FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize);
        }
        Grant(Path.GetFullPath(writablePath), appContainerSid,
            FileSystemRights.Modify | FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        // 只移除 Broker 自己添加的精确 ACE，不恢复整份 ACL，避免覆盖执行期间的外部 ACL 修改。
        foreach (var (directory, rule) in _rules.AsEnumerable().Reverse())
        {
            var security = directory.GetAccessControl(AccessControlSections.Access);
            security.RemoveAccessRuleSpecific(rule);
            directory.SetAccessControl(security);
        }
    }

    private void Grant(string path, SecurityIdentifier sid, FileSystemRights rights)
    {
        var directory = Directory.CreateDirectory(path);
        var rule = new FileSystemAccessRule(
            sid,
            rights,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow);
        var security = directory.GetAccessControl(AccessControlSections.Access);
        security.AddAccessRule(rule);
        directory.SetAccessControl(security);
        _rules.Add((directory, rule));
    }
}
