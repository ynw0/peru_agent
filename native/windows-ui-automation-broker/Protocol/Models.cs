using System.Text.Json;
using System.Text.Json.Serialization;

namespace IndependentAiIde.WindowsUiAutomationBroker.Protocol;

internal sealed record BrokerRequest(
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("method")] string Method,
    [property: JsonPropertyName("params")] JsonElement Params);

internal sealed record BrokerError(string Code, string Message);
internal sealed record BrokerResponse(string Kind, string Id, bool Ok, object? Result, BrokerError? Error);

internal sealed record BrokerFeatures(
    bool UiAutomationTree,
    bool AuthenticodeIdentity,
    bool WindowProcessBinding,
    bool ScreenshotEvidence,
    bool InvokePattern,
    bool ValuePattern,
    bool KeyboardInput,
    bool SecureDesktopDetection,
    bool PostActionVerification,
    bool Utf8Protocol);

internal sealed record BrokerHello(
    int ProtocolVersion,
    string BrokerVersion,
    string Platform,
    string Architecture,
    BrokerFeatures Features);

internal sealed record RunningApplicationIdentity(
    int ProcessId,
    string ExecutablePath,
    string ExecutableName,
    string PublisherSubject,
    string SignerThumbprint,
    string Version,
    string FileSha256,
    string WindowHandle,
    string WindowTitle,
    string WindowClass,
    string IntegrityLevel,
    bool SecureDesktop);

internal sealed record CertificationPlaceholder(
    string Status,
    string[] AllowedActions,
    string[] AllowedShortcuts,
    string[] Reasons);

internal sealed record Bounds(double X, double Y, double Width, double Height);

internal sealed record ElementSnapshot(
    string Id,
    int[] RuntimeId,
    string ControlType,
    string Role,
    string Name,
    string AutomationId,
    string ClassName,
    Bounds Bounds,
    bool Enabled,
    bool Offscreen,
    bool Focusable,
    bool HasKeyboardFocus,
    bool IsPassword,
    string[] Patterns);

internal sealed record UiSnapshot(
    string Id,
    RunningApplicationIdentity Identity,
    CertificationPlaceholder Certification,
    ElementSnapshot[] Elements,
    string? FocusedElementId,
    string Sha256,
    string CreatedAt);

internal sealed record ScreenshotResult(
    string SnapshotId,
    string WindowHandle,
    string MimeType,
    string Base64,
    int ByteLength,
    string Sha256);

internal sealed record ElementEvidence(
    string SnapshotId,
    string SnapshotSha256,
    string ElementId,
    int[] RuntimeId,
    string Role,
    string Name,
    string AutomationId,
    string ClassName,
    Bounds Bounds);

internal sealed record ComputerActionRequest(
    string ActionId,
    string Action,
    string IdentityFingerprint,
    string ManifestSha256,
    string SnapshotId,
    string SnapshotSha256,
    string WindowHandle,
    int ProcessId,
    ElementEvidence? Evidence,
    string? Text,
    string? Shortcut);

internal sealed record ComputerActionResult(
    string ActionId,
    string Action,
    bool Verified,
    string BeforeSnapshotId,
    UiSnapshot AfterSnapshot,
    string ReceiptSha256);
