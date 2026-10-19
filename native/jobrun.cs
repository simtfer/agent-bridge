using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class JobRun
{
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
    private const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private static int Main(string[] args)
    {
        int timeoutSec = 0;
        int memoryMb = 4096;
        int processes = 128;
        string cwd = Directory.GetCurrentDirectory();
        int index = 0;

        while (index < args.Length && args[index] != "--")
        {
            string key = args[index];
            string value = index + 1 < args.Length ? args[index + 1] : "";
            if (key == "--timeout") { timeoutSec = ParseInt(value, 0); index += 2; }
            else if (key == "--memory-mb") { memoryMb = ParseInt(value, 4096); index += 2; }
            else if (key == "--processes") { processes = ParseInt(value, 128); index += 2; }
            else if (key == "--cwd") { cwd = value; index += 2; }
            else { break; }
        }

        if (index >= args.Length || args[index] != "--" || index + 1 >= args.Length)
        {
            Console.Error.WriteLine("jobrun: expected -- <command> [args...]");
            return 2;
        }

        index++;
        string file = args[index++];
        StringBuilder argumentBuilder = new StringBuilder();
        for (int i = index; i < args.Length; i++)
        {
            if (argumentBuilder.Length > 0) argumentBuilder.Append(' ');
            argumentBuilder.Append(Quote(args[i]));
        }

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job != IntPtr.Zero)
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            if (processes > 0)
            {
                info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
                info.BasicLimitInformation.ActiveProcessLimit = (uint)processes;
            }
            if (memoryMb > 0)
            {
                info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY;
                info.ProcessMemoryLimit = new UIntPtr((ulong)memoryMb * 1024 * 1024);
                info.JobMemoryLimit = new UIntPtr((ulong)memoryMb * 1024 * 1024);
            }

            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr infoPtr = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, infoPtr, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, infoPtr, (uint)size))
                {
                    Console.Error.WriteLine("jobrun: SetInformationJobObject failed " + Marshal.GetLastWin32Error());
                }
            }
            finally
            {
                Marshal.FreeHGlobal(infoPtr);
            }
        }
        else
        {
            Console.Error.WriteLine("jobrun: CreateJobObject failed " + Marshal.GetLastWin32Error());
        }

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = file;
        psi.Arguments = argumentBuilder.ToString();
        psi.WorkingDirectory = cwd;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.RedirectStandardInput = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;

        Process child;
        try
        {
            child = Process.Start(psi);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("jobrun: failed to start " + file + ": " + error.Message);
            if (job != IntPtr.Zero) CloseHandle(job);
            return 127;
        }

        if (job != IntPtr.Zero)
        {
            if (!AssignProcessToJobObject(job, child.Handle))
            {
                Console.Error.WriteLine("jobrun: AssignProcessToJobObject failed " + Marshal.GetLastWin32Error());
            }
        }

        Thread outThread = new Thread(delegate() { Pump(child.StandardOutput, Console.OpenStandardOutput()); });
        Thread errThread = new Thread(delegate() { Pump(child.StandardError, Console.OpenStandardError()); });
        Thread inThread = new Thread(delegate() { PumpInput(child); });
        outThread.IsBackground = true;
        errThread.IsBackground = true;
        inThread.IsBackground = true;
        outThread.Start();
        errThread.Start();
        inThread.Start();

        bool exited;
        if (timeoutSec > 0) exited = child.WaitForExit(timeoutSec * 1000);
        else { child.WaitForExit(); exited = true; }

        if (!exited)
        {
            if (job != IntPtr.Zero) TerminateJobObject(job, 124);
            else { try { child.Kill(); } catch { } }
            child.WaitForExit(5000);
            Console.Error.WriteLine("jobrun: timeout after " + timeoutSec + "s");
            if (job != IntPtr.Zero) CloseHandle(job);
            return 124;
        }

        outThread.Join(2000);
        errThread.Join(2000);

        int code = child.ExitCode;
        child.Dispose();
        if (job != IntPtr.Zero) CloseHandle(job);
        return code;
    }

    private static int ParseInt(string text, int fallback)
    {
        int value;
        return int.TryParse(text, out value) ? value : fallback;
    }

    private static void Pump(StreamReader reader, Stream output)
    {
        try
        {
            char[] buffer = new char[8192];
            int read;
            while ((read = reader.Read(buffer, 0, buffer.Length)) > 0)
            {
                byte[] bytes = Encoding.UTF8.GetBytes(new string(buffer, 0, read));
                output.Write(bytes, 0, bytes.Length);
                output.Flush();
            }
        }
        catch
        {
        }
    }

    private static void PumpInput(Process child)
    {
        try
        {
            Stream input = Console.OpenStandardInput();
            Stream target = child.StandardInput.BaseStream;
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                target.Write(buffer, 0, read);
                target.Flush();
            }
            try { target.Close(); } catch { }
        }
        catch
        {
        }
    }

    private static string Quote(string value)
    {
        if (value.Length == 0) return "\"\"";
        if (value.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return value;
        StringBuilder builder = new StringBuilder();
        builder.Append('"');
        int backslashes = 0;
        foreach (char c in value)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            if (c == '"')
            {
                builder.Append('\\', backslashes * 2 + 1);
                builder.Append('"');
                backslashes = 0;
                continue;
            }
            if (backslashes > 0)
            {
                builder.Append('\\', backslashes);
                backslashes = 0;
            }
            builder.Append(c);
        }
        builder.Append('\\', backslashes * 2);
        builder.Append('"');
        return builder.ToString();
    }
}
