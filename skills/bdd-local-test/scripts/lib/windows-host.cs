// Windows-only primitives used by the ESM worktree commands. Builds with the
// inbox .NET Framework compiler, System.Management and System.Web.Extensions.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class WindowsHost
{
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;

    private static FileStream Acquire(string file)
    {
        Stopwatch timer = Stopwatch.StartNew();
        for (;;)
        {
            try { return new FileStream(file, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException ex)
            {
                // Only contention is retryable. An invalid or inaccessible path
                // must never be mistaken for an available lock.
                int code = ex.HResult & 0xffff;
                if (code != 32 && code != 33) throw;
                if (timer.ElapsedMilliseconds >= 30000) throw new TimeoutException("Timed out locking " + file);
                Thread.Sleep(80);
            }
        }
    }

    private static void HoldLocks(string registryDir, string commonDir)
    {
        Directory.CreateDirectory(registryDir);
        using (Acquire(Path.Combine(registryDir, "allocation.lock")))
        using (Acquire(Path.Combine(commonDir, "bdd-loopback-allocation.lock")))
        {
            Console.WriteLine("ready");
            Console.Out.Flush();
            string line = Console.ReadLine();
            if (String.IsNullOrEmpty(line)) return; // Release without publishing, including on parent EOF.
            var serializer = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
            var request = serializer.Deserialize<Publication>(line);
            if (request == null || String.IsNullOrEmpty(request.gitDir) || !Path.IsPathRooted(request.gitDir))
                throw new InvalidDataException("Missing slot publication directory");
            string git = Path.GetFullPath(request.gitDir).TrimEnd(Path.DirectorySeparatorChar);
            string common = Path.GetFullPath(commonDir).TrimEnd(Path.DirectorySeparatorChar);
            string worktrees = Path.Combine(common, "worktrees");
            if (!String.Equals(git, common, StringComparison.OrdinalIgnoreCase) &&
                !String.Equals(Path.GetDirectoryName(git), worktrees, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Slot publication must belong to the locked Git directory");
            if (request.slot.HasValue && (request.slot < 2 || request.slot > 254))
                throw new InvalidDataException("Invalid slot publication");
            // The process performing both renames owns both OS locks. If it dies
            // between renames, legacy and ESM allocators can prune the lease
            // whose marker was never created.
            if (request.registryJson != null)
                Publish(Path.Combine(registryDir, "reservations.json"), request.registryJson);
            if (request.slot.HasValue)
                Publish(Path.Combine(git, "bdd-loopback-slot"), request.slot.Value.ToString(Invariant));
            Console.WriteLine("published");
            Console.Out.Flush();
            Console.ReadLine();
        }
    }

    private sealed class Publication
    {
        public string gitDir { get; set; }
        public string registryJson { get; set; }
        public int? slot { get; set; }
    }

    private static void Publish(string destination, string text)
    {
        string temp = Path.Combine(Path.GetDirectoryName(destination), ".bdd-slot-" + Guid.NewGuid().ToString("N") + ".tmp");
        using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            try
            {
                byte[] bytes = new UTF8Encoding(false).GetBytes(text);
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
            catch { stream.Dispose(); File.Delete(temp); throw; }
        }
        try
        {
            if (File.Exists(destination)) File.Replace(temp, destination, null);
            else File.Move(temp, destination);
        }
        finally { File.Delete(temp); }
    }

    [DllImport("iphlpapi.dll")]
    private static extern int GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, int reserved);

    private static void AddListeners(List<object> listeners, bool ipv6)
    {
        const int InsufficientBuffer = 122, OwnerPidListener = 3;
        int size = 0;
        IntPtr table = IntPtr.Zero;
        try
        {
            for (int attempt = 0; attempt < 8; attempt++)
            {
                int allocated = size;
                int result = GetExtendedTcpTable(table, ref size, false, ipv6 ? 23 : 2, OwnerPidListener, 0);
                if (result == InsufficientBuffer)
                {
                    if (table != IntPtr.Zero) Marshal.FreeHGlobal(table);
                    table = IntPtr.Zero;
                    table = Marshal.AllocHGlobal(size);
                    continue;
                }
                if (result != 0) throw new Win32Exception(result);
                // MIB_TCPROW_OWNER_PID / MIB_TCP6ROW_OWNER_PID. Both tables
                // start with a DWORD count followed by DWORD-aligned rows.
                int rowSize = ipv6 ? 56 : 24;
                int count = Marshal.ReadInt32(table);
                if (count < 0 || checked(4L + count * (long)rowSize) > allocated)
                    throw new InvalidDataException("Invalid Windows TCP table length");
                byte[] address = new byte[ipv6 ? 16 : 4];
                for (int index = 0; index < count; index++)
                {
                    IntPtr row = IntPtr.Add(table, 4 + index * rowSize);
                    Marshal.Copy(IntPtr.Add(row, ipv6 ? 0 : 4), address, 0, address.Length);
                    IPAddress ip = ipv6 ? new IPAddress(address, (uint)IPAddress.NetworkToHostOrder(Marshal.ReadInt32(row, 16))) : new IPAddress(address);
                    int portOffset = ipv6 ? 20 : 8;
                    int port = Marshal.ReadByte(row, portOffset) * 256 + Marshal.ReadByte(row, portOffset + 1);
                    listeners.Add(new { address = ip.ToString(), port = port, pid = Marshal.ReadInt32(row, rowSize - 4) });
                }
                return;
            }
            throw new IOException("TCP listener table changed repeatedly during enumeration");
        }
        finally { if (table != IntPtr.Zero) Marshal.FreeHGlobal(table); }
    }

    // DMTF timestamps have six fractional digits and a signed offset in minutes.
    // Comparing them against the creation time read from an open process handle
    // binds the WMI snapshot (including the command line) to the same process.
    private static long CreationTime(string dmtf)
    {
        if (String.IsNullOrEmpty(dmtf) || dmtf.Length != 25 || dmtf.Contains("*")) return 0;
        DateTime date = DateTime.ParseExact(dmtf.Substring(0, 21), "yyyyMMddHHmmss.ffffff", Invariant);
        int offset = Int32.Parse(dmtf.Substring(21), Invariant);
        return new DateTimeOffset(date, TimeSpan.FromMinutes(offset)).UtcDateTime.ToFileTimeUtc();
    }

    private sealed class ProcessRow
    {
        public int pid { get; set; }
        public int parentPid { get; set; }
        public string name { get; set; }
        public string executablePath { get; set; }
        public string commandLine { get; set; }
        public string created { get; set; }
    }

    private static List<ProcessRow> Processes(bool includeDetails)
    {
        string fields = "ProcessId, ParentProcessId, CreationDate";
        if (includeDetails) fields += ", Name, ExecutablePath, CommandLine";
        var rows = new List<ProcessRow>();
        using (var search = new ManagementObjectSearcher("SELECT " + fields + " FROM Win32_Process"))
        using (var result = search.Get())
        {
            foreach (ManagementObject row in result)
            using (row)
            {
                long created = CreationTime(row["CreationDate"] as string);
                rows.Add(new ProcessRow {
                    pid = Convert.ToInt32(row["ProcessId"]), parentPid = Convert.ToInt32(row["ParentProcessId"]),
                    name = includeDetails ? row["Name"] as string : null,
                    executablePath = includeDetails ? row["ExecutablePath"] as string : null,
                    commandLine = includeDetails ? row["CommandLine"] as string : null,
                    created = created == 0 ? null : created.ToString(Invariant)
                });
            }
        }
        return rows;
    }

    private static List<object> Names(string[] args)
    {
        var names = new List<object>();
        for (int i = 1; i < args.Length; i++)
        {
            int pid = Int32.Parse(args[i], Invariant);
            try
            {
                using (var p = Process.GetProcessById(pid))
                    names.Add(new { pid = pid, name = p.ProcessName });
            }
            catch (ArgumentException) { } // PID already exited
            catch (InvalidOperationException) { }
            catch (Win32Exception) { } // Protected process
        }
        return names;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeWaitHandle OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(SafeWaitHandle process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(SafeWaitHandle process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeWaitHandle process, uint timeout);

    private sealed class PinnedProcess : IDisposable
    {
        public readonly int Pid;
        public readonly long Created;
        private readonly SafeWaitHandle handle;

        private PinnedProcess(int pid, long created, SafeWaitHandle handle)
        {
            Pid = pid; Created = created; this.handle = handle;
        }

        public static PinnedProcess Open(int pid, long expected, bool root)
        {
            const int Terminate = 1, QueryLimited = 0x1000, Synchronize = 0x100000;
            if (pid <= 0 || expected <= 0) throw new InvalidDataException("Missing process identity");
            SafeWaitHandle handle = OpenProcess(Terminate | QueryLimited | Synchronize, false, pid);
            if (handle.IsInvalid)
            {
                int code = Marshal.GetLastWin32Error();
                handle.Dispose();
                if (code == 87) return null; // No such process
                throw new Win32Exception(code, "Cannot open PID " + pid + " (Windows error " + code + ")");
            }
            try
            {
                long created, exit, kernel, user;
                if (!GetProcessTimes(handle, out created, out exit, out kernel, out user))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot read creation time of PID " + pid);
                created -= created % 10; // WMI precision is one microsecond.
                if (created != expected && root) throw new InvalidOperationException("PID creation time changed; refusing to stop it.");
                if (exit != 0 || created != expected) return null;
                var pinned = new PinnedProcess(pid, created, handle);
                handle = null;
                return pinned;
            }
            finally { if (handle != null) handle.Dispose(); }
        }

        public void Stop()
        {
            if (WaitForSingleObject(handle, 0) == 0) return;
            if (!TerminateProcess(handle, 1))
            {
                int code = Marshal.GetLastWin32Error();
                // Closing a launcher's job can already be terminating its child.
                // TerminateProcess returns ACCESS_DENIED during that interval
                // even though the process handle is not signalled yet.
                if (code != 5 || WaitForSingleObject(handle, 5000) != 0)
                    throw new Win32Exception(code, "Cannot terminate PID " + Pid + " (Windows error " + code + ")");
            }
            if (WaitForSingleObject(handle, 5000) != 0) throw new IOException("PID did not exit: " + Pid);
        }

        public void Dispose() { handle.Dispose(); }
    }

    private static object StopTree(int pid, long created)
    {
        var known = new Dictionary<int, PinnedProcess>();
        var stopped = new List<int>();
        try
        {
            var root = PinnedProcess.Open(pid, created, true);
            if (root == null) return new { terminated = false, pids = stopped };
            known.Add(pid, root);
            var pending = new List<PinnedProcess> { root };
            for (int pass = 0; pass < 8; pass++)
            {
                // Pin children from one snapshot before stopping the parents.
                // A held process handle prevents its PID from being reused.
                var children = new Dictionary<int, List<ProcessRow>>();
                foreach (ProcessRow child in Processes(false))
                {
                    List<ProcessRow> siblings;
                    if (!children.TryGetValue(child.parentPid, out siblings))
                        children[child.parentPid] = siblings = new List<ProcessRow>();
                    siblings.Add(child);
                }
                var parents = new Queue<PinnedProcess>(known.Values);
                while (parents.Count > 0)
                {
                    PinnedProcess parent = parents.Dequeue();
                    List<ProcessRow> siblings;
                    if (!children.TryGetValue(parent.Pid, out siblings)) continue;
                    foreach (ProcessRow row in siblings)
                    {
                        if (known.ContainsKey(row.pid)) continue;
                        if (row.created == null) throw new IOException("Cannot verify child PID " + row.pid);
                        long birth = Int64.Parse(row.created, Invariant);
                        if (birth < parent.Created) continue; // Previous owner of the parent PID
                        var child = PinnedProcess.Open(row.pid, birth, false);
                        if (child == null) continue;
                        known.Add(row.pid, child);
                        pending.Add(child);
                        parents.Enqueue(child);
                    }
                }
                if (pending.Count == 0) return new { terminated = true, pids = stopped };
                foreach (PinnedProcess p in pending) { p.Stop(); stopped.Add(p.Pid); }
                pending.Clear(); // Check once more for children created between snapshot and termination.
            }
            throw new IOException("Process tree kept changing during cleanup");
        }
        finally { foreach (PinnedProcess pinned in known.Values) pinned.Dispose(); }
    }

    private static int Main(string[] args)
    {
        try
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            Console.InputEncoding = new UTF8Encoding(false, true);
            object result;
            if (args.Length == 3 && args[0] == "lock") { HoldLocks(args[1], args[2]); return 0; }
            if (args.Length == 1 && args[0] == "listeners")
            {
                var listeners = new List<object>();
                AddListeners(listeners, false);
                AddListeners(listeners, true);
                result = listeners;
            }
            else if (args.Length == 1 && args[0] == "processes") result = Processes(true);
            else if (args.Length >= 1 && args[0] == "names") result = Names(args);
            else if (args.Length == 3 && args[0] == "terminate")
                result = StopTree(Int32.Parse(args[1], Invariant), Int64.Parse(args[2], Invariant));
            else throw new ArgumentException("Expected lock, listeners, names, processes or terminate");
            Console.WriteLine(new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue }.Serialize(result));
            return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine(ex.Message); return 1; }
    }
}
