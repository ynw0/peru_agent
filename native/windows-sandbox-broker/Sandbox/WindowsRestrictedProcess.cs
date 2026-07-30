using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;
using IndependentAiIde.WindowsSandboxBroker.Protocol;

namespace IndependentAiIde.WindowsSandboxBroker.Sandbox;

internal static class WindowsRestrictedProcess
{
    private const string AppContainerName = "IndependentAiIde.Sandbox";

    public static async Task<SandboxProcessResult> RunAsync(
        SandboxLaunchRequest request,
        CancellationToken cancellationToken)
    {
        ValidateLaunch(request);
        IntPtr originalToken = IntPtr.Zero;
        IntPtr restrictedToken = IntPtr.Zero;
        IntPtr appContainerSid = IntPtr.Zero;
        IntPtr capabilityArray = IntPtr.Zero;
        var allocatedCapabilitySids = new List<IntPtr>();
        IntPtr attributeList = IntPtr.Zero;
        IntPtr securityCapabilitiesPointer = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr stdinRead = IntPtr.Zero;
        IntPtr stdinWrite = IntPtr.Zero;
        IntPtr stdoutRead = IntPtr.Zero;
        IntPtr stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero;
        IntPtr stderrWrite = IntPtr.Zero;
        NativeMethods.PROCESS_INFORMATION process = default;
        AppContainerAclScope? aclScope = null;

        try
        {
            CreatePipes(
                out stdinRead, out stdinWrite,
                out stdoutRead, out stdoutWrite,
                out stderrRead, out stderrWrite);

            if (!NativeMethods.OpenProcessToken(System.Diagnostics.Process.GetCurrentProcess().Handle,
                NativeMethods.TOKEN_FOR_RESTRICTED_PROCESS,
                out originalToken))
            {
                NativeMethods.ThrowLastWin32("OpenProcessToken 失败");
            }
            if (!NativeMethods.CreateRestrictedToken(
                originalToken,
                NativeMethods.DISABLE_MAX_PRIVILEGE,
                0, IntPtr.Zero,
                0, IntPtr.Zero,
                0, IntPtr.Zero,
                out restrictedToken))
            {
                NativeMethods.ThrowLastWin32("CreateRestrictedToken 失败");
            }

            appContainerSid = CreateOrDeriveAppContainerSid();
            var managedSid = new SecurityIdentifier(appContainerSid);
            aclScope = new AppContainerAclScope(managedSid, request.ReadOnlyPaths, request.WritableTaskDirectory);

            var capabilities = CreateNetworkCapabilities(request.NetworkMode, allocatedCapabilitySids);
            if (capabilities.Count > 0)
            {
                var itemSize = Marshal.SizeOf<NativeMethods.SID_AND_ATTRIBUTES>();
                capabilityArray = Marshal.AllocHGlobal(itemSize * capabilities.Count);
                for (var index = 0; index < capabilities.Count; index++)
                {
                    Marshal.StructureToPtr(capabilities[index], capabilityArray + index * itemSize, false);
                }
            }

            var securityCapabilities = new NativeMethods.SECURITY_CAPABILITIES
            {
                AppContainerSid = appContainerSid,
                Capabilities = capabilityArray,
                CapabilityCount = (uint)capabilities.Count,
                Reserved = 0,
            };
            securityCapabilitiesPointer = Marshal.AllocHGlobal(Marshal.SizeOf<NativeMethods.SECURITY_CAPABILITIES>());
            Marshal.StructureToPtr(securityCapabilities, securityCapabilitiesPointer, false);

            var attributeSize = IntPtr.Zero;
            NativeMethods.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            attributeList = Marshal.AllocHGlobal(attributeSize);
            if (!NativeMethods.InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize))
            {
                NativeMethods.ThrowLastWin32("InitializeProcThreadAttributeList 失败");
            }
            if (!NativeMethods.UpdateProcThreadAttribute(
                attributeList,
                0,
                new IntPtr(NativeMethods.PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES),
                securityCapabilitiesPointer,
                new IntPtr(Marshal.SizeOf<NativeMethods.SECURITY_CAPABILITIES>()),
                IntPtr.Zero,
                IntPtr.Zero))
            {
                NativeMethods.ThrowLastWin32("UpdateProcThreadAttribute 失败");
            }

            environment = BuildSanitizedEnvironment(request.WritableTaskDirectory, request.Executable);
            var startup = new NativeMethods.STARTUPINFOEX
            {
                StartupInfo = new NativeMethods.STARTUPINFO
                {
                    cb = Marshal.SizeOf<NativeMethods.STARTUPINFOEX>(),
                    dwFlags = NativeMethods.STARTF_USESTDHANDLES,
                    hStdInput = stdinRead,
                    hStdOutput = stdoutWrite,
                    hStdError = stderrWrite,
                },
                lpAttributeList = attributeList,
            };

            var commandLine = new StringBuilder(BuildCommandLine(request.Executable, request.Arguments));
            if (!NativeMethods.CreateProcessAsUser(
                restrictedToken,
                request.Executable,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                NativeMethods.CREATE_UNICODE_ENVIRONMENT
                    | NativeMethods.CREATE_SUSPENDED
                    | NativeMethods.CREATE_NO_WINDOW
                    | NativeMethods.EXTENDED_STARTUPINFO_PRESENT,
                environment,
                request.WorkingDirectory,
                ref startup,
                out process))
            {
                NativeMethods.ThrowLastWin32("CreateProcessAsUser 失败");
            }

            job = CreateAndConfigureJob();
            if (!NativeMethods.AssignProcessToJobObject(job, process.hProcess))
            {
                NativeMethods.ThrowLastWin32("AssignProcessToJobObject 失败");
            }
            if (NativeMethods.ResumeThread(process.hThread) == uint.MaxValue)
            {
                NativeMethods.ThrowLastWin32("ResumeThread 失败");
            }

            // 父进程不再使用子进程一侧的管道句柄，必须立即关闭以保证 EOF 正常传播。
            Close(ref stdinRead);
            Close(ref stdoutWrite);
            Close(ref stderrWrite);

            using var stdinStream = new FileStream(new SafeFileHandle(stdinWrite, ownsHandle: true), FileAccess.Write, 4096, isAsync: false);
            stdinWrite = IntPtr.Zero;
            using var stdoutStream = new FileStream(new SafeFileHandle(stdoutRead, ownsHandle: true), FileAccess.Read, 4096, isAsync: false);
            stdoutRead = IntPtr.Zero;
            using var stderrStream = new FileStream(new SafeFileHandle(stderrRead, ownsHandle: true), FileAccess.Read, 4096, isAsync: false);
            stderrRead = IntPtr.Zero;

            var writeInput = WriteStandardInputAsync(stdinStream, request.StandardInput, cancellationToken);
            var readStdout = ReadUtf8Async(stdoutStream, cancellationToken);
            var readStderr = ReadUtf8Async(stderrStream, cancellationToken);

            var waitTask = Task.Run(() => NativeMethods.WaitForSingleObject(process.hProcess, NativeMethods.INFINITE));
            var timeoutTask = Task.Delay(request.TimeoutMs);
            var cancellationTask = Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            var completed = await Task.WhenAny(waitTask, timeoutTask, cancellationTask).ConfigureAwait(false);

            var timedOut = completed == timeoutTask;
            var interrupted = completed == cancellationTask;
            if (timedOut || interrupted)
            {
                if (!NativeMethods.TerminateJobObject(job, interrupted ? 0xC000013A : 0xDEAD0001))
                {
                    NativeMethods.ThrowLastWin32("TerminateJobObject 失败");
                }
                await waitTask.ConfigureAwait(false);
            }
            else
            {
                var waitCode = await waitTask.ConfigureAwait(false);
                if (waitCode != NativeMethods.WAIT_OBJECT_0)
                {
                    throw new InvalidOperationException($"等待沙箱进程失败，waitCode={waitCode}");
                }
            }

            await writeInput.ConfigureAwait(false);
            var stdout = await readStdout.ConfigureAwait(false);
            var stderr = await readStderr.ConfigureAwait(false);
            if (!NativeMethods.GetExitCodeProcess(process.hProcess, out var exitCode))
            {
                NativeMethods.ThrowLastWin32("GetExitCodeProcess 失败");
            }
            return new SandboxProcessResult(stdout, stderr, unchecked((int)exitCode), timedOut, interrupted);
        }
        finally
        {
            aclScope?.Dispose();
            if (attributeList != IntPtr.Zero)
            {
                NativeMethods.DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            if (securityCapabilitiesPointer != IntPtr.Zero) Marshal.FreeHGlobal(securityCapabilitiesPointer);
            if (capabilityArray != IntPtr.Zero) Marshal.FreeHGlobal(capabilityArray);
            foreach (var sid in allocatedCapabilitySids)
            {
                if (sid != IntPtr.Zero) NativeMethods.LocalFree(sid);
            }
            if (appContainerSid != IntPtr.Zero) NativeMethods.FreeSid(appContainerSid);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            Close(ref process.hThread);
            Close(ref process.hProcess);
            Close(ref job);
            Close(ref originalToken);
            Close(ref restrictedToken);
            Close(ref stdinRead);
            Close(ref stdinWrite);
            Close(ref stdoutRead);
            Close(ref stdoutWrite);
            Close(ref stderrRead);
            Close(ref stderrWrite);
        }
    }

    // 后台会话复用与 RunAsync 相同的受限 Token、AppContainer、ACL 与 Job Object 创建路径；
    // 唯一区别是 stdin/stdout/stderr 管道不会在启动后立即关闭。
    public static Task<RestrictedPowerShellTerminal> StartTerminalAsync(SandboxLaunchRequest request, string terminalId)
    {
        ValidateLaunch(request);
        IntPtr originalToken = IntPtr.Zero;
        IntPtr restrictedToken = IntPtr.Zero;
        IntPtr appContainerSid = IntPtr.Zero;
        IntPtr capabilityArray = IntPtr.Zero;
        var allocatedCapabilitySids = new List<IntPtr>();
        IntPtr attributeList = IntPtr.Zero;
        IntPtr securityCapabilitiesPointer = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr stdinRead = IntPtr.Zero;
        IntPtr stdinWrite = IntPtr.Zero;
        IntPtr stdoutRead = IntPtr.Zero;
        IntPtr stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero;
        IntPtr stderrWrite = IntPtr.Zero;
        NativeMethods.PROCESS_INFORMATION process = default;
        AppContainerAclScope? aclScope = null;
        try
        {
            CreatePipes(out stdinRead, out stdinWrite, out stdoutRead, out stdoutWrite, out stderrRead, out stderrWrite);
            if (!NativeMethods.OpenProcessToken(System.Diagnostics.Process.GetCurrentProcess().Handle,
                NativeMethods.TOKEN_FOR_RESTRICTED_PROCESS, out originalToken))
                NativeMethods.ThrowLastWin32("OpenProcessToken 失败");
            if (!NativeMethods.CreateRestrictedToken(originalToken, NativeMethods.DISABLE_MAX_PRIVILEGE,
                0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out restrictedToken))
                NativeMethods.ThrowLastWin32("CreateRestrictedToken 失败");
            appContainerSid = CreateOrDeriveAppContainerSid();
            var managedSid = new SecurityIdentifier(appContainerSid);
            aclScope = new AppContainerAclScope(managedSid, request.ReadOnlyPaths, request.WritableTaskDirectory);
            var capabilities = CreateNetworkCapabilities(request.NetworkMode, allocatedCapabilitySids);
            if (capabilities.Count > 0)
            {
                var itemSize = Marshal.SizeOf<NativeMethods.SID_AND_ATTRIBUTES>();
                capabilityArray = Marshal.AllocHGlobal(itemSize * capabilities.Count);
                for (var index = 0; index < capabilities.Count; index++)
                    Marshal.StructureToPtr(capabilities[index], capabilityArray + index * itemSize, false);
            }
            var securityCapabilities = new NativeMethods.SECURITY_CAPABILITIES { AppContainerSid = appContainerSid, Capabilities = capabilityArray, CapabilityCount = (uint)capabilities.Count, Reserved = 0 };
            securityCapabilitiesPointer = Marshal.AllocHGlobal(Marshal.SizeOf<NativeMethods.SECURITY_CAPABILITIES>());
            Marshal.StructureToPtr(securityCapabilities, securityCapabilitiesPointer, false);
            var attributeSize = IntPtr.Zero;
            NativeMethods.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            attributeList = Marshal.AllocHGlobal(attributeSize);
            if (!NativeMethods.InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize)) NativeMethods.ThrowLastWin32("InitializeProcThreadAttributeList 失败");
            if (!NativeMethods.UpdateProcThreadAttribute(attributeList, 0, new IntPtr(NativeMethods.PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES), securityCapabilitiesPointer, new IntPtr(Marshal.SizeOf<NativeMethods.SECURITY_CAPABILITIES>()), IntPtr.Zero, IntPtr.Zero)) NativeMethods.ThrowLastWin32("UpdateProcThreadAttribute 失败");
            environment = BuildSanitizedEnvironment(request.WritableTaskDirectory, request.Executable);
            var startup = new NativeMethods.STARTUPINFOEX { StartupInfo = new NativeMethods.STARTUPINFO { cb = Marshal.SizeOf<NativeMethods.STARTUPINFOEX>(), dwFlags = NativeMethods.STARTF_USESTDHANDLES, hStdInput = stdinRead, hStdOutput = stdoutWrite, hStdError = stderrWrite }, lpAttributeList = attributeList };
            var commandLine = new StringBuilder(BuildCommandLine(request.Executable, request.Arguments));
            if (!NativeMethods.CreateProcessAsUser(restrictedToken, request.Executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                NativeMethods.CREATE_UNICODE_ENVIRONMENT | NativeMethods.CREATE_SUSPENDED | NativeMethods.CREATE_NO_WINDOW | NativeMethods.EXTENDED_STARTUPINFO_PRESENT,
                environment, request.WorkingDirectory, ref startup, out process)) NativeMethods.ThrowLastWin32("CreateProcessAsUser 失败");
            job = CreateAndConfigureJob();
            if (!NativeMethods.AssignProcessToJobObject(job, process.hProcess)) NativeMethods.ThrowLastWin32("AssignProcessToJobObject 失败");
            if (NativeMethods.ResumeThread(process.hThread) == uint.MaxValue) NativeMethods.ThrowLastWin32("ResumeThread 失败");
            Close(ref stdinRead); Close(ref stdoutWrite); Close(ref stderrWrite);
            var terminal = new RestrictedPowerShellTerminal(terminalId, request.TimeoutMs, job, process, stdinWrite, stdoutRead, stderrRead, aclScope, attributeList, securityCapabilitiesPointer, capabilityArray, allocatedCapabilitySids, appContainerSid, environment, originalToken, restrictedToken);
            job = stdinWrite = stdoutRead = stderrRead = originalToken = restrictedToken = appContainerSid = capabilityArray = attributeList = securityCapabilitiesPointer = environment = IntPtr.Zero;
            process = default; aclScope = null;
            return Task.FromResult(terminal);
        }
        catch
        {
            aclScope?.Dispose(); if (attributeList != IntPtr.Zero) { NativeMethods.DeleteProcThreadAttributeList(attributeList); Marshal.FreeHGlobal(attributeList); }
            if (securityCapabilitiesPointer != IntPtr.Zero) Marshal.FreeHGlobal(securityCapabilitiesPointer); if (capabilityArray != IntPtr.Zero) Marshal.FreeHGlobal(capabilityArray);
            foreach (var sid in allocatedCapabilitySids) if (sid != IntPtr.Zero) NativeMethods.LocalFree(sid); if (appContainerSid != IntPtr.Zero) NativeMethods.FreeSid(appContainerSid); if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            Close(ref process.hThread); Close(ref process.hProcess); Close(ref job); Close(ref originalToken); Close(ref restrictedToken); Close(ref stdinRead); Close(ref stdinWrite); Close(ref stdoutRead); Close(ref stdoutWrite); Close(ref stderrRead); Close(ref stderrWrite); throw;
        }
    }

    internal sealed class RestrictedPowerShellTerminal : IAsyncDisposable
    {
        private readonly IntPtr _job; private NativeMethods.PROCESS_INFORMATION _process; private readonly AppContainerAclScope? _aclScope; private readonly IntPtr _attributeList; private readonly IntPtr _securityCapabilitiesPointer; private readonly IntPtr _capabilityArray; private readonly List<IntPtr> _capabilitySids; private readonly IntPtr _appContainerSid; private readonly IntPtr _environment; private readonly IntPtr _originalToken; private readonly IntPtr _restrictedToken;
        private readonly SandboxTerminalSession _session; private readonly Task _completion; private int _interrupted; private bool _disposed;
        public SandboxTerminalSession Session => _session;
        public RestrictedPowerShellTerminal(string terminalId, int timeoutMs, IntPtr job, NativeMethods.PROCESS_INFORMATION process, IntPtr stdinWrite, IntPtr stdoutRead, IntPtr stderrRead, AppContainerAclScope? aclScope, IntPtr attributeList, IntPtr securityCapabilitiesPointer, IntPtr capabilityArray, List<IntPtr> capabilitySids, IntPtr appContainerSid, IntPtr environment, IntPtr originalToken, IntPtr restrictedToken)
        {
            _job = job; _process = process; _aclScope = aclScope; _attributeList = attributeList; _securityCapabilitiesPointer = securityCapabilitiesPointer; _capabilityArray = capabilityArray; _capabilitySids = capabilitySids; _appContainerSid = appContainerSid; _environment = environment; _originalToken = originalToken; _restrictedToken = restrictedToken;
            var stdin = new FileStream(new SafeFileHandle(stdinWrite, true), FileAccess.Write, 4096, false);
            var stdout = new FileStream(new SafeFileHandle(stdoutRead, true), FileAccess.Read, 4096, false);
            var stderr = new FileStream(new SafeFileHandle(stderrRead, true), FileAccess.Read, 4096, false);
            _session = new SandboxTerminalSession(terminalId, stdin, TerminateAsync);
            _completion = MonitorAsync(stdout, stderr, timeoutMs);
        }
        public async Task WriteInitialAsync(string script, CancellationToken token) { if (!await _session.WriteAsync(script + Environment.NewLine, token).ConfigureAwait(false)) throw new BrokerException("TERMINAL_NOT_RUNNING", "后台终端未运行"); }
        private async Task MonitorAsync(Stream stdout, Stream stderr, int timeoutMs)
        {
            var stdoutTask = PumpAsync(stdout, _session.AppendStdout); var stderrTask = PumpAsync(stderr, _session.AppendStderr); var wait = Task.Run(() => NativeMethods.WaitForSingleObject(_process.hProcess, NativeMethods.INFINITE)); var completed = await Task.WhenAny(wait, Task.Delay(timeoutMs)).ConfigureAwait(false); var timedOut = completed != wait; if (timedOut) await TerminateAsync().ConfigureAwait(false); await wait.ConfigureAwait(false); await Task.WhenAll(stdoutTask, stderrTask).ConfigureAwait(false); NativeMethods.GetExitCodeProcess(_process.hProcess, out var exitCode); _session.Complete(unchecked((int)exitCode), timedOut, Interlocked.CompareExchange(ref _interrupted, 0, 0) != 0);
        }
        private async Task PumpAsync(Stream stream, Action<string> append) { using var reader = new StreamReader(stream, new UTF8Encoding(false, true), false, 4096, false); var buffer = new char[4096]; while (true) { var count = await reader.ReadAsync(buffer.AsMemory()).ConfigureAwait(false); if (count == 0) return; append(new string(buffer, 0, count)); } }
        private Task TerminateAsync()
        {
            Interlocked.Exchange(ref _interrupted, 1);
            if (NativeMethods.WaitForSingleObject(_process.hProcess, 0) == NativeMethods.WAIT_OBJECT_0)
                return Task.CompletedTask;
            if (!NativeMethods.TerminateJobObject(_job, 0xC000013A))
                NativeMethods.ThrowLastWin32("TerminateJobObject 失败");
            return Task.CompletedTask;
        }
        public async ValueTask DisposeAsync() { if (_disposed) return; _disposed = true; await _session.DisposeAsync().ConfigureAwait(false); await _completion.ConfigureAwait(false); _aclScope?.Dispose(); if (_attributeList != IntPtr.Zero) { NativeMethods.DeleteProcThreadAttributeList(_attributeList); Marshal.FreeHGlobal(_attributeList); } if (_securityCapabilitiesPointer != IntPtr.Zero) Marshal.FreeHGlobal(_securityCapabilitiesPointer); if (_capabilityArray != IntPtr.Zero) Marshal.FreeHGlobal(_capabilityArray); foreach (var sid in _capabilitySids) if (sid != IntPtr.Zero) NativeMethods.LocalFree(sid); if (_appContainerSid != IntPtr.Zero) NativeMethods.FreeSid(_appContainerSid); if (_environment != IntPtr.Zero) Marshal.FreeHGlobal(_environment); Close(ref _process.hThread); Close(ref _process.hProcess); var job = _job; Close(ref job); }
    }
    private static void ValidateLaunch(SandboxLaunchRequest request)
    {
        if (!Path.IsPathFullyQualified(request.Executable) || !File.Exists(request.Executable))
        {
            throw new FileNotFoundException("沙箱可执行文件不存在", request.Executable);
        }
        if (!Path.IsPathFullyQualified(request.WorkingDirectory) || !Directory.Exists(request.WorkingDirectory))
        {
            throw new DirectoryNotFoundException($"工作目录不存在：{request.WorkingDirectory}");
        }
        if (request.NetworkMode is not ("offline" or "lan" or "internet"))
        {
            throw new ArgumentOutOfRangeException(nameof(request.NetworkMode));
        }
    }

    private static void CreatePipes(
        out IntPtr stdinRead,
        out IntPtr stdinWrite,
        out IntPtr stdoutRead,
        out IntPtr stdoutWrite,
        out IntPtr stderrRead,
        out IntPtr stderrWrite)
    {
        stdinRead = stdinWrite = stdoutRead = stdoutWrite = stderrRead = stderrWrite = IntPtr.Zero;
        var attributes = new NativeMethods.SECURITY_ATTRIBUTES
        {
            nLength = Marshal.SizeOf<NativeMethods.SECURITY_ATTRIBUTES>(),
            bInheritHandle = true,
        };
        if (!NativeMethods.CreatePipe(out stdinRead, out stdinWrite, ref attributes, 0))
            NativeMethods.ThrowLastWin32("CreatePipe stdin 失败");
        if (!NativeMethods.CreatePipe(out stdoutRead, out stdoutWrite, ref attributes, 0))
            NativeMethods.ThrowLastWin32("CreatePipe stdout 失败");
        if (!NativeMethods.CreatePipe(out stderrRead, out stderrWrite, ref attributes, 0))
            NativeMethods.ThrowLastWin32("CreatePipe stderr 失败");
        if (!NativeMethods.SetHandleInformation(stdinWrite, NativeMethods.HANDLE_FLAG_INHERIT, 0)
            || !NativeMethods.SetHandleInformation(stdoutRead, NativeMethods.HANDLE_FLAG_INHERIT, 0)
            || !NativeMethods.SetHandleInformation(stderrRead, NativeMethods.HANDLE_FLAG_INHERIT, 0))
        {
            NativeMethods.ThrowLastWin32("SetHandleInformation 失败");
        }
    }

    private static IntPtr CreateOrDeriveAppContainerSid()
    {
        var result = NativeMethods.CreateAppContainerProfile(
            AppContainerName,
            "Independent AI IDE Sandbox",
            "Restricted process sandbox for Independent AI IDE",
            IntPtr.Zero,
            0,
            out var sid);
        if (result == 0)
        {
            return sid;
        }
        if (result == unchecked((int)0x800700B7))
        {
            var derive = NativeMethods.DeriveAppContainerSidFromAppContainerName(AppContainerName, out sid);
            if (derive == 0)
            {
                return sid;
            }
            Marshal.ThrowExceptionForHR(derive);
        }
        Marshal.ThrowExceptionForHR(result);
        throw new InvalidOperationException("无法创建 AppContainer SID");
    }

    private static List<NativeMethods.SID_AND_ATTRIBUTES> CreateNetworkCapabilities(
        string networkMode,
        List<IntPtr> allocatedSids)
    {
        _ = allocatedSids;
        if (networkMode != "offline")
        {
            throw new InvalidOperationException(
                "Phase 5 不向 AppContainer 授予直接网络 Capability；LAN/互联网必须经过后续 Egress Broker");
        }
        return new List<NativeMethods.SID_AND_ATTRIBUTES>();
    }

    private static IntPtr BuildSanitizedEnvironment(string taskDirectory, string executable)
    {
        var systemRoot = Environment.GetEnvironmentVariable("SystemRoot");
        if (string.IsNullOrWhiteSpace(systemRoot))
        {
            throw new BrokerException("SYSTEMROOT_MISSING", "系统环境缺少 SystemRoot，不能创建沙箱进程");
        }
        var powerShellDirectory = Path.GetDirectoryName(executable)
            ?? throw new InvalidOperationException("无法确定 PowerShell 目录");
        var variables = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var safeInheritedNames = new[]
        {
            "ALLUSERSPROFILE", "APPDATA", "CommonProgramFiles", "CommonProgramFiles(x86)",
            "CommonProgramW6432", "COMPUTERNAME", "ComSpec", "DriverData", "HOMEDRIVE", "HOMEPATH",
            "LOCALAPPDATA", "LOGONSERVER", "NUMBER_OF_PROCESSORS", "OS", "PATHEXT",
            "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION",
            "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PUBLIC", "SystemDrive",
            "USERDOMAIN", "USERDOMAIN_ROAMINGPROFILE", "USERNAME", "windir",
        };
        foreach (var name in safeInheritedNames)
        {
            var value = Environment.GetEnvironmentVariable(name);
            if (!string.IsNullOrWhiteSpace(value)) variables[name] = value;
        }
        variables["COMSPEC"] = Path.Combine(systemRoot, "System32", "cmd.exe");
        variables["HOME"] = taskDirectory;
        variables["PATH"] = string.Join(';', powerShellDirectory, Path.Combine(systemRoot, "System32"), systemRoot);
        variables["PSModulePath"] = Path.Combine(powerShellDirectory, "Modules");
        variables["SystemRoot"] = systemRoot;
        variables["TEMP"] = taskDirectory;
        variables["TMP"] = taskDirectory;
        variables["USERPROFILE"] = taskDirectory;
        // CreateProcessAsUser 要求环境块按键排序并以恰好两个 NUL 结束；
        // StringToHGlobalUni 会额外写入一个字符串终止符，因此这里只拼一个显式 NUL。
        var block = string.Join('\0', variables.Select(pair => $"{pair.Key}={pair.Value}")) + "\0";
        return Marshal.StringToHGlobalUni(block);
    }

    private static IntPtr CreateAndConfigureJob()
    {
        var job = NativeMethods.CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            NativeMethods.ThrowLastWin32("CreateJobObject 失败");
        }
        var information = new NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            BasicLimitInformation = new NativeMethods.JOBOBJECT_BASIC_LIMIT_INFORMATION
            {
                LimitFlags = NativeMethods.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    | NativeMethods.JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                    | NativeMethods.JOB_OBJECT_LIMIT_PROCESS_MEMORY,
                ActiveProcessLimit = 32,
            },
            ProcessMemoryLimit = new UIntPtr(2UL * 1024 * 1024 * 1024),
        };
        var pointer = Marshal.AllocHGlobal(Marshal.SizeOf<NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>());
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!NativeMethods.SetInformationJobObject(
                job,
                NativeMethods.JobObjectExtendedLimitInformation,
                pointer,
                (uint)Marshal.SizeOf<NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()))
            {
                NativeMethods.ThrowLastWin32("SetInformationJobObject 失败");
            }
            return job;
        }
        catch
        {
            NativeMethods.CloseHandle(job);
            throw;
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    private static string BuildCommandLine(string executable, IReadOnlyList<string> arguments)
    {
        return string.Join(' ', new[] { Quote(executable) }.Concat(arguments.Select(Quote)));
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.All(character => !char.IsWhiteSpace(character) && character != '"'))
        {
            return value;
        }
        var builder = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                builder.Append('\\', backslashes * 2 + 1).Append('"');
                backslashes = 0;
                continue;
            }
            builder.Append('\\', backslashes).Append(character);
            backslashes = 0;
        }
        builder.Append('\\', backslashes * 2).Append('"');
        return builder.ToString();
    }

    private static async Task WriteStandardInputAsync(
        Stream stream,
        string content,
        CancellationToken cancellationToken)
    {
        await using (var writer = new StreamWriter(stream, new UTF8Encoding(false), 4096, leaveOpen: true))
        {
            await writer.WriteAsync(content.AsMemory(), cancellationToken).ConfigureAwait(false);
            await writer.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        stream.Close();
    }

    private static async Task<string> ReadUtf8Async(Stream stream, CancellationToken cancellationToken)
    {
        using var reader = new StreamReader(stream, new UTF8Encoding(false, true), detectEncodingFromByteOrderMarks: false);
        return await reader.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
    }

    private static void Close(ref IntPtr handle)
    {
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return;
        NativeMethods.CloseHandle(handle);
        handle = IntPtr.Zero;
    }
}
