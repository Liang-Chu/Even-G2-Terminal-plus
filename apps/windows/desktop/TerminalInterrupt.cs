using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Read-only identity/ancestry checks, or one helper per explicit Stop. Never uses
// foreground-window keys, process signals, console mode changes or termination.
class TerminalInterrupt {
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessBasicInformation {
        public IntPtr ExitStatus, Peb, Affinity, Priority, ProcessId, ParentId;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Explicit, Size = 20)]
    struct InputRecord {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(4)] public int Down;
        [FieldOffset(8)] public ushort Repeat;
        [FieldOffset(10)] public ushort VirtualKey;
        [FieldOffset(12)] public ushort ScanCode;
        [FieldOffset(14)] public char Character;
        [FieldOffset(16)] public uint Control;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetConsoleProcessList([Out] uint[] processes, uint count);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleMode(SafeFileHandle handle, out uint mode);
    [DllImport("kernel32.dll", EntryPoint = "WriteConsoleInputW", SetLastError = true)]
    static extern bool WriteConsoleInput(SafeFileHandle handle, InputRecord[] records, uint count, out uint written);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, IntPtr information, uint size, out uint returned);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CommandLineToArgvW(string line, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);

    static bool SameUser(IntPtr process) {
        IntPtr token;
        if (!OpenProcessToken(process, 8, out token)) return false;
        try {
            using (var user = new WindowsIdentity(token))
            using (var self = WindowsIdentity.GetCurrent())
                return user.User != null && self.User != null && user.User.Equals(self.User);
        } finally { CloseHandle(token); }
    }
    static int Parent(IntPtr process, int pid) {
        int size = Marshal.SizeOf(typeof(ProcessBasicInformation)); var memory = Marshal.AllocHGlobal(size);
        try {
            uint returned;
            if (NtQueryInformationProcess(process, 0, memory, (uint)size, out returned) < 0 || returned > size) return 0;
            var info = (ProcessBasicInformation)Marshal.PtrToStructure(memory, typeof(ProcessBasicInformation));
            long parent = info.ParentId.ToInt64();
            return info.ProcessId.ToInt64() == pid && parent > 0 && parent <= Int32.MaxValue ? (int)parent : 0;
        } finally { Marshal.FreeHGlobal(memory); }
    }
    static string[] Arguments(IntPtr process) {
        uint length;
        NtQueryInformationProcess(process, 60, IntPtr.Zero, 0, out length);
        if (length < Marshal.SizeOf(typeof(UnicodeString)) || length > 131072) return null;
        var memory = Marshal.AllocHGlobal((int)length);
        try {
            uint returned;
            if (NtQueryInformationProcess(process, 60, memory, length, out returned) < 0 || returned > length) return null;
            var value = (UnicodeString)Marshal.PtrToStructure(memory, typeof(UnicodeString));
            long offset = value.Buffer.ToInt64() - memory.ToInt64();
            if ((value.Length & 1) != 0 || offset < 0 || offset + value.Length > length) return null;
            string line = Marshal.PtrToStringUni(value.Buffer, value.Length / 2); int count;
            var argv = CommandLineToArgvW(line, out count);
            if (argv == IntPtr.Zero || count < 1 || count > 256) { if (argv != IntPtr.Zero) LocalFree(argv); return null; }
            try {
                var result = new string[count];
                for (int index = 0; index < count; index++) result[index] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, index * IntPtr.Size));
                return result;
            } finally { LocalFree(argv); }
        } finally { Marshal.FreeHGlobal(memory); }
    }
    static int ClaudeOwner(int first) {
        Console.OutputEncoding = new UTF8Encoding(false);
        var visited = new HashSet<int>(); long latest = DateTime.UtcNow.Ticks; int pid = first;
        for (int depth = 0; depth < 24 && pid > 0 && visited.Add(pid); depth++) {
            using (var target = Process.GetProcessById(pid)) {
                long started = target.StartTime.ToUniversalTime().Ticks;
                if (started > latest || target.HasExited) break;
                var handle = OpenProcess(0x1400, false, pid); // Query information only; no write/signal capability.
                if (handle == IntPtr.Zero) break;
                try {
                    if (!SameUser(handle)) break;
                    int parent = Parent(handle, pid); string name = target.ProcessName;
                    bool native = String.Equals(name, "claude", StringComparison.OrdinalIgnoreCase);
                    bool node = String.Equals(name, "node", StringComparison.OrdinalIgnoreCase) || String.Equals(name, "nodejs", StringComparison.OrdinalIgnoreCase);
                    string[] argv = native || node ? Arguments(handle) : null;
                    bool npm = false;
                    if (node && argv != null)
                        foreach (var arg in argv)
                            if (Regex.IsMatch(arg, @"(?:^|[\\/])@anthropic-ai[\\/]claude-code[\\/](?:cli\.js|cli\.mjs)$")) { npm = true; break; }
                    if (native || npm) {
                        if (argv == null || target.HasExited || target.StartTime.ToUniversalTime().Ticks != started) break;
                        // Captured by our hook only. argv is used for settings trust and is never persisted.
                        Console.Write(new JavaScriptSerializer().Serialize(new { pid = pid, started = started.ToString(), argv = argv }));
                        return 0;
                    }
                    if (target.HasExited || target.StartTime.ToUniversalTime().Ticks != started) break;
                    latest = started; pid = parent;
                } finally { CloseHandle(handle); }
            }
        }
        Console.Write("{}"); return 0;
    }
    static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
    static Dictionary<string, object> Object(object value) { return (Dictionary<string, object>)value; }
    static bool Matches(string path, string instance, string key, long run, int pid) {
        if (new FileInfo(path).Length > 512000) return false;
        var snapshot = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
        var state = Object(snapshot["state"]);
        var main = Object(state["main"]);
        var session = Object(state["session"]);
        long age = Now() - Convert.ToInt64(snapshot["at"]);
        return Convert.ToString(snapshot["instance"]) == instance && Convert.ToInt64(snapshot["runId"]) == run
            && Convert.ToInt32(snapshot["terminalPid"]) == pid && age >= -1000 && age < 3000
            && Convert.ToString(session["key"]) == key && Convert.ToBoolean(state["connected"])
            && (Convert.ToString(main["status"]) == "running" || Convert.ToString(main["status"]) == "waiting");
    }
    static int Main(string[] args) {
        try {
            int pid;
            if (args.Length < 2 || !Int32.TryParse(args[1], out pid) || pid <= 0) return 2;
            if (args[0] == "claude-owner" && args.Length == 2) return ClaudeOwner(pid);
            using (var target = Process.GetProcessById(pid)) {
                long started = target.StartTime.ToUniversalTime().Ticks;
                if (args[0] == "identity" && args.Length == 2) { Console.Write(started); return 0; }
                long expectedStart, expires, run;
                if (args[0] != "interrupt" || args.Length != 8 || !Int64.TryParse(args[2], out expectedStart)
                    || !Int64.TryParse(args[3], out expires) || !Int64.TryParse(args[7], out run)
                    || started != expectedStart || expires < Now() || expires > Now() + 5000) return 3;
                if (!Matches(args[4], args[5], args[6], run, pid)) return 4;
                FreeConsole();
                if (!AttachConsole((uint)pid)) return 5;
                try {
                    var ids = new uint[256]; uint count = GetConsoleProcessList(ids, (uint)ids.Length);
                    if (count == 0 || count > ids.Length || Array.IndexOf(ids, (uint)pid) < 0) return 5;
                    using (var input = CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
                        uint mode;
                        // Never inject into a normal shell prompt or a redirected stream.
                        if (input.IsInvalid || !GetConsoleMode(input, out mode) || (mode & 2) != 0) return 6;
                        if (target.HasExited || target.StartTime.ToUniversalTime().Ticks != started || expires < Now()
                            || !Matches(args[4], args[5], args[6], run, pid)) return 4;
                        var records = new[] {
                            new InputRecord { Type = 1, Down = 1, Repeat = 1, VirtualKey = 0x1B, ScanCode = 1, Character = '\x1B' },
                            new InputRecord { Type = 1, Down = 0, Repeat = 1, VirtualKey = 0x1B, ScanCode = 1, Character = '\x1B' }
                        };
                        uint written;
                        return WriteConsoleInput(input, records, 2, out written) && written == 2 ? 0 : 7;
                    }
                } finally { FreeConsole(); }
            }
        } catch { return 8; }
    }
}
