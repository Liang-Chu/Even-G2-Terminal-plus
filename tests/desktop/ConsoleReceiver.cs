using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

// Isolated hidden test console. It never attaches to an existing user terminal.
class ConsoleReceiver {
    [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr handle, out uint mode);
    [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr handle, uint mode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll")] static extern bool SetStdHandle(int kind, IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    static int Main(string[] args) {
        if (args.Length == 2 && args[0] == "launch") {
            Process.Start(new ProcessStartInfo(typeof(ConsoleReceiver).Assembly.Location, "receive \"" + args[1] + "\"") {
                // Bypass ShellExecute/Windows Terminal delegation entirely.
                // Do not inherit the launcher's captured pipes: Node waits for
                // their EOF and would otherwise block until this child exits.
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true, RedirectStandardError = true
            }).Dispose();
            return 0;
        }
        if (args.Length != 2 || args[0] != "receive") return 2;
        string root = args[1]; uint original;
        // Redirected launcher pipes are not a console input buffer. Open the
        // fixture's own windowless console explicitly, as the production helper does.
        var input = CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (input == new IntPtr(-1) || !SetStdHandle(-10, input) || !GetConsoleMode(input, out original) || !SetConsoleMode(input, original & ~7u)) {
            File.WriteAllText(Path.Combine(root, "ready.error"), "Windowless fixture console unavailable: " + Marshal.GetLastWin32Error());
            return 3;
        }
        var self = Process.GetCurrentProcess();
        File.WriteAllText(Path.Combine(root, "ready.json"), "{\"pid\":" + self.Id + ",\"started\":\"" + self.StartTime.ToUniversalTime().Ticks
            + "\",\"visible\":" + IsWindowVisible(GetConsoleWindow()).ToString().ToLowerInvariant() + "}");
        var deadline = DateTime.UtcNow.AddSeconds(25);
        try {
            while (!File.Exists(Path.Combine(root, "close")) && DateTime.UtcNow < deadline) {
                if (Console.KeyAvailable) {
                    var key = Console.ReadKey(true);
                    File.AppendAllText(Path.Combine(root, "keys.txt"), ((int)key.KeyChar).ToString() + "\n");
                }
                Thread.Sleep(10);
            }
        } finally { SetConsoleMode(input, original); CloseHandle(input); }
        return 0;
    }
}
