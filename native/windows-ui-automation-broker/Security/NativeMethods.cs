using System.Runtime.InteropServices;
using System.Text;

namespace IndependentAiIde.WindowsUiAutomationBroker.Security;

internal static class NativeMethods
{
    internal delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);

    [DllImport("user32.dll")]
    internal static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetThreadDesktop(uint threadId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder info, int length, out int needed);

    [DllImport("user32.dll")]
    internal static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);

    [DllImport("user32.dll")]
    internal static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

    [DllImport("advapi32.dll", SetLastError = true)]
    internal static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    internal static extern bool GetTokenInformation(IntPtr tokenHandle, int tokenInformationClass, IntPtr tokenInformation, int tokenInformationLength, out int returnLength);

    [DllImport("kernel32.dll")]
    internal static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("kernel32.dll")]
    internal static extern bool CloseHandle(IntPtr handle);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern uint SendInput(uint count, Input[] inputs, int size);

    [StructLayout(LayoutKind.Sequential)]
    internal struct Rect { internal int Left; internal int Top; internal int Right; internal int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    internal struct Input
    {
        internal uint Type;
        internal InputUnion Union;
    }

    [StructLayout(LayoutKind.Explicit)]
    internal struct InputUnion
    {
        [FieldOffset(0)] internal KeyboardInput Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct KeyboardInput
    {
        internal ushort VirtualKey;
        internal ushort ScanCode;
        internal uint Flags;
        internal uint Time;
        internal IntPtr ExtraInfo;
    }
}
