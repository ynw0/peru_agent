using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

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

            using var stdinStream = new FileStream(new SafeFileHandle(stdinWrite, ownsHandle: true), FileAccess.Write, 4096, isAsync: true);
            stdinWrite = IntPtr.Zero;
            using var stdoutStream = new FileStream(new SafeFileHandle(stdoutRead, ownsHandle: true), FileAccess.Read, 4096, isAsync: true);
            stdoutRead = IntPtr.Zero;
            using var stderrStream = new FileStream(new SafeFileHandle(stderrRead, ownsHandle: true), FileAccess.Read, 4096, isAsync: true);
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
        var systemRoot = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var powerShellDirectory = Path.GetDirectoryName(executable)
            ?? throw new InvalidOperationException("无法确定 PowerShell 目录");
        var variables = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["COMSPEC"] = Path.Combine(systemRoot, "System32", "cmd.exe"),
            ["HOME"] = taskDirectory,
            ["PATH"] = string.Join(';', powerShellDirectory, Path.Combine(systemRoot, "System32"), systemRoot),
            ["PSModulePath"] = Path.Combine(powerShellDirectory, "Modules"),
            ["SystemRoot"] = systemRoot,
            ["TEMP"] = taskDirectory,
            ["TMP"] = taskDirectory,
            ["USERPROFILE"] = taskDirectory,
        };
        var block = string.Join('\0', variables.Select(pair => $"{pair.Key}={pair.Value}")) + "\0\0";
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
        await using var writer = new StreamWriter(stream, new UTF8Encoding(false), 4096, leaveOpen: true);
        await writer.WriteAsync(content.AsMemory(), cancellationToken).ConfigureAwait(false);
        await writer.FlushAsync(cancellationToken).ConfigureAwait(false);
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
