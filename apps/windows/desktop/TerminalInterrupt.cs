using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// One short-lived helper per explicit Stop. Never uses foreground-window keys,
// process signals, console mode changes, or process termination.
class TerminalInterrupt {
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
