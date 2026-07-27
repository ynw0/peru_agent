using System.Drawing;
using System.Drawing.Imaging;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using IndependentAiIde.WindowsUiAutomationBroker.Identity;
using IndependentAiIde.WindowsUiAutomationBroker.Protocol;
using IndependentAiIde.WindowsUiAutomationBroker.Security;

namespace IndependentAiIde.WindowsUiAutomationBroker.UiAutomation;

internal sealed class UiAutomationService
{
    private sealed record StoredSnapshot(UiSnapshot Snapshot, Dictionary<string, AutomationElement> Elements);
    private readonly Dictionary<string, StoredSnapshot> snapshots = new(StringComparer.Ordinal);
    private readonly ApplicationIdentityService identityService;

    internal UiAutomationService(ApplicationIdentityService identityService) => this.identityService = identityService;

    internal UiSnapshot Inspect(string handleText, int maxElements)
    {
        if (!TryParseHandle(handleText, out var window)) throw new InvalidOperationException("windowHandle 无效");
        if (maxElements is < 1 or > 5000) throw new InvalidOperationException("maxElements 必须为 1~5000");
        var identity = identityService.Read(window);
        var root = AutomationElement.FromHandle(window) ?? throw new InvalidOperationException("无法读取 UI Automation Root");
        var elements = new List<ElementSnapshot>();
        var elementMap = new Dictionary<string, AutomationElement>(StringComparer.Ordinal);
        string? focusedId = null;
        Walk(root, TreeWalker.RawViewWalker, elements, elementMap, maxElements, ref focusedId);
        var id = $"computer-snapshot-{Guid.NewGuid():N}";
        var createdAt = DateTimeOffset.UtcNow.ToString("O");
        var placeholder = new CertificationPlaceholder("inspect-only", [], [], ["认证由 Agent Runtime 决定"]);
        var unsigned = new { id, identity, certification = placeholder, elements, focusedElementId = focusedId, createdAt };
        var sha = Sha256Json(unsigned);
        var snapshot = new UiSnapshot(id, identity, placeholder, [.. elements], focusedId, sha, createdAt);
        snapshots[id] = new StoredSnapshot(snapshot, elementMap);
        return snapshot;
    }

    internal ScreenshotResult Screenshot(string snapshotId)
    {
        var stored = RequireSnapshot(snapshotId);
        if (!TryParseHandle(stored.Snapshot.Identity.WindowHandle, out var window)) throw new InvalidOperationException("Snapshot 窗口无效");
        if (!NativeMethods.GetWindowRect(window, out var rect)) throw new InvalidOperationException("无法读取窗口边界");
        var width = rect.Right - rect.Left;
        var height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0 || width > 16384 || height > 16384) throw new InvalidOperationException("窗口截图尺寸无效");
        using var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        using var graphics = Graphics.FromImage(bitmap);
        var hdc = graphics.GetHdc();
        try
        {
            if (!NativeMethods.PrintWindow(window, hdc, 2)) throw new InvalidOperationException("PrintWindow 失败");
        }
        finally { graphics.ReleaseHdc(hdc); }
        using var stream = new MemoryStream();
        bitmap.Save(stream, ImageFormat.Png);
        var bytes = stream.ToArray();
        return new ScreenshotResult(snapshotId, stored.Snapshot.Identity.WindowHandle, "image/png", Convert.ToBase64String(bytes), bytes.Length, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
    }

    internal ComputerActionResult Act(ComputerActionRequest request)
    {
        var stored = RequireSnapshot(request.SnapshotId);
        if (!string.Equals(stored.Snapshot.Sha256, request.SnapshotSha256, StringComparison.Ordinal)) throw new InvalidOperationException("Snapshot SHA-256 不匹配");
        if (!string.Equals(stored.Snapshot.Identity.WindowHandle, request.WindowHandle, StringComparison.OrdinalIgnoreCase)
            || stored.Snapshot.Identity.ProcessId != request.ProcessId) throw new InvalidOperationException("窗口与进程绑定不匹配");
        var currentIdentity = identityService.Read(ParseHandle(request.WindowHandle));
        if (!string.Equals(IdentityFingerprint(currentIdentity), request.IdentityFingerprint, StringComparison.Ordinal)) throw new InvalidOperationException("应用身份在动作前发生变化");
        if (currentIdentity.SecureDesktop || currentIdentity.IntegrityLevel is "high" or "system" or "unknown") throw new InvalidOperationException("安全桌面或高完整性窗口禁止交互");
        if (Sensitive(currentIdentity.WindowTitle)) throw new InvalidOperationException("敏感窗口禁止交互");

        switch (request.Action)
        {
            case "click": ExecuteClick(stored, request); break;
            case "type": ExecuteType(stored, request); break;
            case "shortcut": ExecuteShortcut(request); break;
            default: throw new InvalidOperationException("未知 Computer Use 动作");
        }

        var after = Inspect(request.WindowHandle, 2000);
        if (!string.Equals(IdentityFingerprint(after.Identity), request.IdentityFingerprint, StringComparison.Ordinal)) throw new InvalidOperationException("动作后应用身份发生变化");
        var receipt = Sha256Json(new { request.ActionId, request.Action, request.SnapshotId, afterSnapshotId = after.Id, request.IdentityFingerprint, request.ManifestSha256 });
        return new ComputerActionResult(request.ActionId, request.Action, true, request.SnapshotId, after, receipt);
    }

    private static void ExecuteClick(StoredSnapshot stored, ComputerActionRequest request)
    {
        var element = RequireEvidence(stored, request);
        if (!element.Current.IsEnabled || element.Current.IsOffscreen || element.Current.IsPassword) throw new InvalidOperationException("元素当前不可安全点击");
        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out var invoke)) ((InvokePattern)invoke).Invoke();
        else if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var selection)) ((SelectionItemPattern)selection).Select();
        else if (element.TryGetCurrentPattern(TogglePattern.Pattern, out var toggle)) ((TogglePattern)toggle).Toggle();
        else throw new InvalidOperationException("元素不支持安全点击 Pattern");
    }

    private static void ExecuteType(StoredSnapshot stored, ComputerActionRequest request)
    {
        if (string.IsNullOrEmpty(request.Text) || request.Text.Length > 4096) throw new InvalidOperationException("输入文本长度无效");
        var element = RequireEvidence(stored, request);
        if (!element.Current.IsEnabled || element.Current.IsOffscreen || element.Current.IsPassword) throw new InvalidOperationException("敏感或不可用元素禁止输入");
        if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out var valuePattern)) throw new InvalidOperationException("元素不支持 ValuePattern");
        ((ValuePattern)valuePattern).SetValue(request.Text);
    }

    private static readonly HashSet<string> SafeShortcuts = new(StringComparer.OrdinalIgnoreCase)
    {
        "CTRL+A", "CTRL+C", "CTRL+V", "CTRL+X", "CTRL+Z", "CTRL+Y", "CTRL+F", "CTRL+S"
    };

    private static void ExecuteShortcut(ComputerActionRequest request)
    {
        var shortcut = request.Shortcut?.ToUpperInvariant() ?? throw new InvalidOperationException("快捷键不能为空");
        if (!SafeShortcuts.Contains(shortcut)) throw new InvalidOperationException("Broker 全局快捷键白名单拒绝该组合");
        var parts = shortcut.Split('+');
        var inputs = new List<NativeMethods.Input>();
        foreach (var part in parts) inputs.Add(Key(part, false));
        for (var index = parts.Length - 1; index >= 0; index--) inputs.Add(Key(parts[index], true));
        if (NativeMethods.SendInput((uint)inputs.Count, [.. inputs], Marshal.SizeOf<NativeMethods.Input>()) != (uint)inputs.Count)
            throw new InvalidOperationException("SendInput 未完整发送快捷键");
    }

    private static NativeMethods.Input Key(string key, bool up) => new()
    {
        Type = 1,
        Union = new NativeMethods.InputUnion
        {
            Keyboard = new NativeMethods.KeyboardInput
            {
                VirtualKey = key switch { "CTRL" => 0x11, "ALT" => 0x12, "SHIFT" => 0x10, "WIN" => 0x5B, _ => (ushort)key[0] },
                Flags = up ? 0x0002u : 0u,
            }
        }
    };

    private static AutomationElement RequireEvidence(StoredSnapshot stored, ComputerActionRequest request)
    {
        var evidence = request.Evidence ?? throw new InvalidOperationException("元素动作缺少证据");
        if (!string.Equals(evidence.SnapshotId, stored.Snapshot.Id, StringComparison.Ordinal)
            || !string.Equals(evidence.SnapshotSha256, stored.Snapshot.Sha256, StringComparison.Ordinal)) throw new InvalidOperationException("元素证据不属于当前 Snapshot");
        if (!stored.Elements.TryGetValue(evidence.ElementId, out var element)) throw new InvalidOperationException("元素已不存在");
        var current = ToElementSnapshot(evidence.ElementId, element);
        if (!current.RuntimeId.SequenceEqual(evidence.RuntimeId)
            || !string.Equals(current.Role, evidence.Role, StringComparison.Ordinal)
            || !string.Equals(current.Name, evidence.Name, StringComparison.Ordinal)
            || !string.Equals(current.AutomationId, evidence.AutomationId, StringComparison.Ordinal)
            || !string.Equals(current.ClassName, evidence.ClassName, StringComparison.Ordinal)
            || !BoundsEqual(current.Bounds, evidence.Bounds)) throw new InvalidOperationException("元素证据在动作前发生变化");
        return element;
    }

    private static bool BoundsEqual(Bounds left, Bounds right) => Math.Abs(left.X - right.X) < 1 && Math.Abs(left.Y - right.Y) < 1 && Math.Abs(left.Width - right.Width) < 1 && Math.Abs(left.Height - right.Height) < 1;

    private static void Walk(AutomationElement element, TreeWalker walker, List<ElementSnapshot> result, Dictionary<string, AutomationElement> map, int max, ref string? focused)
    {
        if (result.Count >= max) return;
        var id = $"element-{result.Count + 1}";
        var snapshot = ToElementSnapshot(id, element);
        result.Add(snapshot);
        map[id] = element;
        if (snapshot.HasKeyboardFocus) focused = id;
        var child = walker.GetFirstChild(element);
        while (child is not null && result.Count < max)
        {
            Walk(child, walker, result, map, max, ref focused);
            child = walker.GetNextSibling(child);
        }
    }

    private static ElementSnapshot ToElementSnapshot(string id, AutomationElement element)
    {
        var current = element.Current;
        var rect = current.BoundingRectangle;
        var patterns = new List<string>();
        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out _)) patterns.Add("invoke");
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out _)) patterns.Add("value");
        if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out _)) patterns.Add("selection");
        if (element.TryGetCurrentPattern(TogglePattern.Pattern, out _)) patterns.Add("toggle");
        if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out _)) patterns.Add("expand-collapse");
        if (element.TryGetCurrentPattern(TextPattern.Pattern, out _)) patterns.Add("text");
        return new ElementSnapshot(
            id,
            element.GetRuntimeId() ?? [],
            current.ControlType.ProgrammaticName,
            Role(current.ControlType),
            current.Name ?? string.Empty,
            current.AutomationId ?? string.Empty,
            current.ClassName ?? string.Empty,
            new Bounds(rect.X, rect.Y, rect.Width, rect.Height),
            current.IsEnabled,
            current.IsOffscreen,
            current.IsKeyboardFocusable,
            current.HasKeyboardFocus,
            current.IsPassword,
            [.. patterns]);
    }

    private static string Role(ControlType type) => type.Id switch
    {
        50000 => "button", 50004 => "edit", 50005 => "hyperlink", 50006 => "image", 50007 => "listitem",
        50008 => "list", 50011 => "menuitem", 50018 => "tab", 50019 => "tabitem", 50020 => "text",
        50021 => "toolbar", 50022 => "tooltip", 50023 => "tree", 50024 => "treeitem", 50032 => "window",
        _ => type.ProgrammaticName.Replace("ControlType.", string.Empty, StringComparison.Ordinal).ToLowerInvariant(),
    };

    private StoredSnapshot RequireSnapshot(string id) => snapshots.TryGetValue(id, out var snapshot) ? snapshot : throw new InvalidOperationException("Snapshot 不存在或 Broker 已重启");
    private static bool TryParseHandle(string text, out IntPtr handle) { handle = IntPtr.Zero; return text.StartsWith("0x", StringComparison.OrdinalIgnoreCase) && long.TryParse(text[2..], System.Globalization.NumberStyles.HexNumber, null, out var value) && (handle = new IntPtr(value)) != IntPtr.Zero; }
    private static IntPtr ParseHandle(string text) => TryParseHandle(text, out var handle) ? handle : throw new InvalidOperationException("窗口句柄无效");
    private static bool Sensitive(string title) => System.Text.RegularExpressions.Regex.IsMatch(title, "credential|password|sign in|login|登录|密码|凭据|windows security|user account control|uac", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    private static string Sha256Json(object value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value)))).ToLowerInvariant();

    private static string IdentityFingerprint(RunningApplicationIdentity identity) => Sha256Json(new
    {
        processId = identity.ProcessId,
        executablePath = identity.ExecutablePath.Replace('/', '\\').TrimEnd('\\').ToLowerInvariant(),
        executableName = identity.ExecutableName.Trim().ToLowerInvariant(),
        publisherSubject = identity.PublisherSubject.Trim().ToLowerInvariant(),
        signerThumbprint = identity.SignerThumbprint.Replace(" ", string.Empty, StringComparison.Ordinal).ToUpperInvariant(),
        version = identity.Version,
        fileSha256 = identity.FileSha256.ToLowerInvariant(),
        windowHandle = identity.WindowHandle.ToLowerInvariant(),
        windowClass = identity.WindowClass.Trim().ToLowerInvariant(),
        integrityLevel = identity.IntegrityLevel,
        secureDesktop = identity.SecureDesktop,
    });
}
