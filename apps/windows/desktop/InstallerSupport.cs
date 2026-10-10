using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32;

static class InstallerSupport {
    [DllImport("iphlpapi.dll", SetLastError = true)]
    static extern uint GetExtendedTcpTable(IntPtr table, ref int bytes, bool ordered, int family, int tableClass, uint reserved);
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4000000 };
    internal static string Full(string path) { return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar); }
    internal static bool Inside(string path, string directory) { return Full(path).StartsWith(Full(directory) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase); }
    internal static string HashFile(string path) {
        using (var sha = SHA256.Create()) using (var file = File.OpenRead(path)) return BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
    }
    internal static string RootId(string root) {
        using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Full(root).ToLowerInvariant()))).Replace("-", "").Substring(0, 16);
    }
    internal static void ValidateRoot(string root) {
        root = Full(root);
        if (root == Path.GetPathRoot(root).TrimEnd('\\') || root == Full(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile))
            || root == Full(Environment.GetFolderPath(Environment.SpecialFolder.Windows))) throw new Exception("Choose a dedicated Terminal+ installation folder.");
        // Never traverse a junction supplied as an existing installer-owned path.
        foreach (string path in new[] { root, Path.Combine(root, "versions"), Path.Combine(root, ".local") })
            if (Directory.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new Exception("Installation folders must not be directory links.");
        if (File.Exists(Path.Combine(root, "Uninstall.exe")) && !File.Exists(Path.Combine(root, "install.json")))
            throw new Exception("This folder contains another application's uninstaller. Choose a different folder.");
    }
    internal static string DefaultRoot() {
        string besideSetup = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        if (File.Exists(DesktopPaths.ApplicationExecutable(besideSetup)) && File.Exists(Path.Combine(besideSetup, "apps", "windows", "src", "cli.ts")))
            return DesktopPaths.InstallRoot(besideSetup);
        // Updating an open portable copy in place retains the original data directory,
        // including snapshots written by native terminals which are still running.
        foreach (var process in TrayProcesses()) using (process) {
            try {
                if (process.SessionId != Process.GetCurrentProcess().SessionId) continue;
                string payload = Path.GetDirectoryName(process.MainModule.FileName);
                if (File.Exists(Path.Combine(payload, "apps", "windows", "src", "cli.ts"))) return DesktopPaths.InstallRoot(payload);
            } catch { }
        }
        // Stable install root and registry IDs keep the existing keys, watches and native sessions.
        string defaultRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Even-Pilot");
        if (File.Exists(Path.Combine(defaultRoot, "install.json"))) return defaultRoot;
        // A custom installation is still the update target when its tray is closed.
        using (var uninstall = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall")) {
            if (uninstall != null) foreach (string name in uninstall.GetSubKeyNames()) {
                if (!name.StartsWith("Even-Pilot-", StringComparison.OrdinalIgnoreCase)) continue;
                using (var key = uninstall.OpenSubKey(name)) {
                    string path = key == null ? null : key.GetValue("InstallLocation") as string;
                    // Closed temporary installations (including isolated smoke
                    // tests) must not become a normal user's update destination.
                    if (!String.IsNullOrEmpty(path) && !Inside(path, Path.GetTempPath())
                        && File.Exists(Path.Combine(path, "install.json")) && String.Equals(name, "Even-Pilot-" + RootId(path), StringComparison.OrdinalIgnoreCase)) return path;
                }
            }
        }
        return defaultRoot;
    }
    internal static string Data(string root) {
        string custom = Environment.GetEnvironmentVariable("EVEN_PILOT_DATA_DIR");
        return String.IsNullOrEmpty(custom) ? Path.Combine(root, ".local") : Full(custom);
    }
    internal static bool Alive(int pid) { try { using (var p = Process.GetProcessById(pid)) return !p.HasExited; } catch { return false; } }
    internal static void WaitForVersion(string root, string version) {
        var config = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(Data(root), "bridge-config.json")));
        string token = Environment.GetEnvironmentVariable("EVEN_PILOT_TOKEN");
        if (String.IsNullOrEmpty(token)) token = Convert.ToString(config["controlToken"]);
        using (var http = new HttpClient(new HttpClientHandler { UseProxy = false })) {
            http.Timeout = TimeSpan.FromSeconds(2);
            http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
            string port = Environment.GetEnvironmentVariable("EVEN_PILOT_PORT") ?? "4317";
            var until = DateTime.UtcNow.AddSeconds(45);
            while (DateTime.UtcNow < until) {
                try { using (var response = http.GetAsync("http://127.0.0.1:" + port + "/api/updates").GetAwaiter().GetResult()) {
                    if (response.IsSuccessStatusCode) {
                        var value = Json.Deserialize<Dictionary<string, object>>(response.Content.ReadAsStringAsync().GetAwaiter().GetResult());
                        if (Convert.ToString(value["currentVersion"]) == version) return;
                    }
                } } catch (HttpRequestException) { } catch (System.Threading.Tasks.TaskCanceledException) { }
                Thread.Sleep(300);
            }
        }
        throw new Exception("Updated backend did not become healthy. Restoring the previous version.");
    }
    internal static bool HasNativeTerminals(string root) {
        string native = Path.Combine(Data(root), "native");
        if (!Directory.Exists(native)) return false;
        foreach (string path in Directory.GetFiles(native, "*.json")) {
            int pid; if (!Int32.TryParse(Path.GetFileNameWithoutExtension(path), out pid)) continue;
            try {
                var snapshot = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
                var state = snapshot["state"] as Dictionary<string, object>;
                if (state != null && Convert.ToBoolean(state["connected"]) && Alive(pid)) return true;
            } catch { if (Alive(pid)) return true; }
        }
        return false;
    }
    internal static bool OwnedMonitorExecutable(string root, string executable) {
        try {
            root = Full(root); executable = Full(executable);
            string checkedPath = executable;
            while (Inside(checkedPath, root)) {
                if ((File.GetAttributes(checkedPath) & FileAttributes.ReparsePoint) != 0) return false;
                checkedPath = Path.GetDirectoryName(checkedPath);
            }
            string runtime = Path.GetDirectoryName(executable), payload = Path.GetDirectoryName(runtime);
            if (!String.Equals(executable, Path.Combine(payload, "runtime", "node.exe"), StringComparison.OrdinalIgnoreCase)
                || !File.Exists(Path.Combine(payload, "apps", "windows", "src", "cli.ts"))) return false;
            if (String.Equals(payload, root, StringComparison.OrdinalIgnoreCase)) return true;
            string versions = Path.Combine(root, "versions"), version = Path.GetFileName(payload);
            if (!String.Equals(Path.GetDirectoryName(payload), versions, StringComparison.OrdinalIgnoreCase)
                || !Regex.IsMatch(version, @"^\d+\.\d+\.\d+-[a-f0-9]{12}$") || !File.Exists(Path.Combine(payload, "installed.json"))) return false;
            var record = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(root, "install.json")));
            object value;
            if (record.TryGetValue("current", out value) && String.Equals(value as string, version, StringComparison.Ordinal)) return true;
            if (record.TryGetValue("versions", out value)) {
                var recorded = value as System.Collections.IEnumerable;
                if (recorded != null) foreach (object item in recorded) if (String.Equals(item as string, version, StringComparison.Ordinal)) return true;
            }
        } catch { }
        return false;
    }
    internal sealed class MonitorProcess : IDisposable {
        readonly Process process;
        readonly string root, executable;
        readonly DateTime started;
        internal readonly int Pid;
        internal MonitorProcess(string installRoot, int pid) {
            root = installRoot; Pid = pid;
            process = Process.GetProcessById(pid);
            try {
                // Pin the kernel process object before retaining PID identity.
                // Recovery never looks up an arbitrary Node process by name.
                var handle = process.Handle;
                started = process.StartTime; executable = process.MainModule.FileName;
                if (!OwnedMonitorExecutable(root, executable)) throw new Exception("The listening process is not this installation's bundled monitoring runtime. Close that monitor explicitly before updating; no terminal was stopped.");
            } catch { process.Dispose(); throw; }
        }
        internal bool HasExited { get { return process.HasExited; } }
        internal bool MatchesIdentity(int pid, DateTime startTime, string path) {
            return Pid == pid && started.ToUniversalTime() == startTime.ToUniversalTime()
                && String.Equals(executable, path, StringComparison.OrdinalIgnoreCase);
        }
        internal bool SameProcess(MonitorProcess other) { return other != null && MatchesIdentity(other.Pid, other.started, other.executable); }
        internal void FinishAcknowledgedShutdown() {
            if (process.WaitForExit(3000)) return;
            bool same;
            try { same = !process.HasExited && MatchesIdentity(process.Id, process.StartTime, process.MainModule.FileName) && OwnedMonitorExecutable(root, process.MainModule.FileName); }
            catch { same = false; }
            if (!same) throw new Exception("The monitor closed its port but its process identity could not be confirmed. No process was force-closed.");
            // Older monitors can retain their IPC lock after acknowledging
            // shutdown and closing the listener. Only that proven PID is stopped;
            // native terminals and connector workers keep their own lifetimes.
            try { process.Kill(); }
            catch (InvalidOperationException) { if (process.HasExited) return; throw; }
            if (!process.WaitForExit(5000)) throw new Exception("The acknowledged monitoring process did not exit. No terminal was force-closed.");
        }
        public void Dispose() { process.Dispose(); }
    }
    internal static MonitorProcess CaptureMonitor(string root, int port) {
        const int ipv4 = 2, listenerOwnerPid = 3, rowBytes = 24;
        int bytes = 0;
        uint result = GetExtendedTcpTable(IntPtr.Zero, ref bytes, false, ipv4, listenerOwnerPid, 0);
        if ((result != 0 && result != 122) || bytes < 4 || bytes > 8 * 1024 * 1024) throw new Exception("Could not identify the local monitoring listener. No process was stopped.");
        IntPtr table = Marshal.AllocHGlobal(bytes);
        try {
            result = GetExtendedTcpTable(table, ref bytes, false, ipv4, listenerOwnerPid, 0);
            if (result != 0) throw new Exception("The local monitoring listener changed during identification. No process was stopped.");
            var data = new byte[bytes]; Marshal.Copy(table, data, 0, bytes);
            uint rows = BitConverter.ToUInt32(data, 0);
            if (rows > (bytes - 4) / rowBytes) throw new Exception("Invalid local listener information. No process was stopped.");
            var pids = new HashSet<int>();
            for (int n = 0; n < rows; n++) {
                int row = 4 + n * rowBytes;
                bool any = data[row + 4] == 0 && data[row + 5] == 0 && data[row + 6] == 0 && data[row + 7] == 0;
                bool loopback = data[row + 4] == 127 && data[row + 5] == 0 && data[row + 6] == 0 && data[row + 7] == 1;
                if (BitConverter.ToUInt32(data, row) != 2 || !any && !loopback || (data[row + 8] << 8 | data[row + 9]) != port) continue;
                uint pid = BitConverter.ToUInt32(data, row + 20);
                if (pid == 0 || pid > Int32.MaxValue) throw new Exception("The local listener owner could not be confirmed. No process was stopped.");
                pids.Add((int)pid);
            }
            if (pids.Count == 0) return null;
            if (pids.Count != 1) throw new Exception("Multiple processes own the local monitoring port. No process was stopped.");
            foreach (int pid in pids) return new MonitorProcess(root, pid);
            return null;
        } finally { Marshal.FreeHGlobal(table); }
    }
    internal static void StopMonitor(string root) {
        // Retire the old tray before its monitor goes offline. Otherwise its
        // automatic reconnect can launch the old payload during installation.
        StopTrays(root);
        string configPath = Path.Combine(Data(root), "bridge-config.json");
        if (File.Exists(configPath)) {
            var config = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(configPath));
            string token = Environment.GetEnvironmentVariable("EVEN_PILOT_TOKEN");
            if (String.IsNullOrEmpty(token)) token = Convert.ToString(config["controlToken"]);
            int port = 4317; string configuredPort = Environment.GetEnvironmentVariable("EVEN_PILOT_PORT");
            if (!String.IsNullOrEmpty(configuredPort) && (!Int32.TryParse(configuredPort, out port) || port < 1 || port > 65535)) throw new Exception("Invalid bridge port.");
            using (var monitor = CaptureMonitor(root, port))
            using (var http = new HttpClient(new HttpClientHandler { UseProxy = false })) {
                http.BaseAddress = new Uri("http://127.0.0.1:" + port); http.Timeout = TimeSpan.FromSeconds(3);
                http.DefaultRequestHeaders.ConnectionClose = true;
                http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
                HttpResponseMessage state = null;
                try { state = http.GetAsync("/api/monitoring").GetAwaiter().GetResult(); } catch (HttpRequestException) { } catch (System.Threading.Tasks.TaskCanceledException) { throw new Exception("The bridge did not respond. Installation has not stopped any terminal."); }
                if (state == null && monitor != null && !monitor.HasExited) throw new Exception("The listening monitor did not acknowledge shutdown. No process was force-closed.");
                if (state != null) using (state) {
                    if (!state.IsSuccessStatusCode) throw new Exception("Port " + port + " belongs to another bridge. Close that monitoring backend before continuing; keep native terminals running.");
                    var body = Json.Deserialize<Dictionary<string, object>>(state.Content.ReadAsStringAsync().GetAwaiter().GetResult());
                    if (!body.ContainsKey("nativeTerminals") || !Convert.ToBoolean(body["nativeTerminals"])) throw new Exception("Refusing to stop a backend that may own agent processes.");
                    if (monitor == null) throw new Exception("The monitoring listener owner could not be confirmed. No process was stopped.");
                    using (var current = CaptureMonitor(root, port)) {
                        if (!monitor.SameProcess(current)) throw new Exception("The monitoring listener changed before shutdown. No process was stopped.");
                    }
                    using (var response = http.PostAsync("/api/shutdown", new StringContent("{}", Encoding.UTF8, "application/json")).GetAwaiter().GetResult()) {
                        response.EnsureSuccessStatusCode();
                        var acknowledgment = Json.Deserialize<Dictionary<string, object>>(response.Content.ReadAsStringAsync().GetAwaiter().GetResult());
                        object accepted;
                        if (acknowledgment == null || !acknowledgment.TryGetValue("ok", out accepted) || !(accepted is bool) || !(bool)accepted)
                            throw new Exception("Monitoring shutdown was not acknowledged. No process was force-closed.");
                    }
                    bool stopped = false;
                    for (int n = 0; n < 80; n++) {
                        Thread.Sleep(100);
                        bool listening = false;
                        foreach (var endpoint in IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
                            if (endpoint.Port == port) { listening = true; break; }
                        if (!listening) { stopped = true; break; }
                    }
                    if (!stopped) throw new Exception("The monitoring backend did not exit. No terminal was force-closed.");
                    monitor.FinishAcknowledgedShutdown();
                }
            }
        }
    }
    static IEnumerable<Process> TrayProcesses() {
        foreach (string name in new[] { Path.GetFileNameWithoutExtension(DesktopPaths.ExecutableName), Path.GetFileNameWithoutExtension(DesktopPaths.LegacyExecutableName) })
            foreach (var process in Process.GetProcessesByName(name)) yield return process;
    }
    internal static bool OwnApplicationPath(string path, string root) {
        return path != null && Inside(path, root) && (String.Equals(Path.GetFileName(path), DesktopPaths.ExecutableName, StringComparison.OrdinalIgnoreCase)
            || String.Equals(Path.GetFileName(path), DesktopPaths.LegacyExecutableName, StringComparison.OrdinalIgnoreCase));
    }
    internal static void StopTrays(string root) {
        // Only the tray in this installation. Never use process trees or kill Node/CLI processes.
        foreach (var process in TrayProcesses()) using (process) {
            try {
                if (process.SessionId != Process.GetCurrentProcess().SessionId) continue;
                string path = process.MainModule.FileName;
                if (OwnApplicationPath(path, root) && (String.Equals(Path.GetDirectoryName(path), Full(root), StringComparison.OrdinalIgnoreCase)
                    || Inside(path, Path.Combine(root, "versions")))) {
                    process.Kill();
                    if (!process.WaitForExit(5000)) throw new Exception("The previous tray did not exit. No monitoring backend or terminal was stopped.");
                }
            } catch (InvalidOperationException) { }
        }
    }
    // Keep one existing Apps & features registration across branding changes.
    internal static string RegistryKey(string root) { return @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Even-Pilot-" + RootId(root); }
    internal static bool OwnStartup(string command, string root) {
        return command != null && command.StartsWith("\"" + Full(root) + "\\", StringComparison.OrdinalIgnoreCase)
            && (command.EndsWith("\\" + DesktopPaths.ExecutableName + "\" --autostart", StringComparison.OrdinalIgnoreCase)
                || command.EndsWith("\\" + DesktopPaths.LegacyExecutableName + "\" --autostart", StringComparison.OrdinalIgnoreCase));
    }
    internal static void Register(string root, string payload, string version, bool shortcuts, bool createMissingShortcuts) {
        string executable = DesktopPaths.ApplicationExecutable(payload);
        using (var key = Registry.CurrentUser.CreateSubKey(RegistryKey(root))) {
            key.SetValue("DisplayName", "Terminal+"); key.SetValue("DisplayVersion", version); key.SetValue("Publisher", "Terminal+");
            key.SetValue("InstallLocation", root); key.SetValue("DisplayIcon", executable);
            string uninstall = "\"" + Path.Combine(root, "Uninstall.exe") + "\" --uninstall --dir \"" + root + "\"";
            key.SetValue("UninstallString", uninstall); key.SetValue("QuietUninstallString", uninstall + " --quiet");
            key.SetValue("NoModify", 1, RegistryValueKind.DWord); key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
        UpdateStartup(root, executable);
        if (shortcuts) {
            RegisterShortcuts(root, payload, Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), createMissingShortcuts);
            RegisterShortcuts(root, payload, Environment.GetFolderPath(Environment.SpecialFolder.Programs), createMissingShortcuts);
        }
    }
    internal static void UpdateStartup(string root, string executable, string registryPath = StartupRegistration.RunKey) {
        using (var key = Registry.CurrentUser.OpenSubKey(registryPath, true)) {
            if (key != null && OwnStartup(key.GetValue(StartupRegistration.ValueName) as string, root))
                key.SetValue(StartupRegistration.ValueName, "\"" + executable + "\" --autostart");
        }
    }
    internal static bool OwnShortcut(string path, string root) {
        if (!File.Exists(path)) return false;
        var shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        try {
            dynamic link = shell.GetType().InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { path });
            try { return OwnShortcutTarget((string)link.TargetPath, root); }
            finally { Marshal.FinalReleaseComObject(link); }
        } finally { Marshal.FinalReleaseComObject(shell); }
    }
    internal static bool OwnShortcutTarget(string path, string root) {
        if (!OwnApplicationPath(path, root)) return false;
        string directory = Path.GetDirectoryName(Full(path));
        if (String.Equals(directory, Full(root), StringComparison.OrdinalIgnoreCase)) return true;
        // A nested installation can have the same executable name. Only this
        // root's launcher or a direct version payload owns its shortcuts.
        return String.Equals(Path.GetDirectoryName(directory), Path.Combine(Full(root), "versions"), StringComparison.OrdinalIgnoreCase)
            && Regex.IsMatch(Path.GetFileName(directory), @"^\d+\.\d+\.\d+-[a-f0-9]{12}$");
    }
    internal static void RemoveOwnedShortcut(string path, string root) {
        if (OwnShortcut(path, root)) File.Delete(path);
    }
    internal static void RegisterShortcuts(string root, string payload, string parent, bool createMissing) {
        string path = Path.Combine(parent, "Terminal+.lnk");
        string legacy = Path.Combine(parent, "Even-Pilot.lnk");
        // A same-named shortcut from another installation must remain owned by it.
        if (File.Exists(path) && !OwnShortcut(path, root)) return;
        // Only a first install creates missing links. Upgrades, reinstalls and
        // rollback refresh existing links without undoing the user's deletion.
        // An owned legacy link is still an existing shortcut to migrate.
        if (!File.Exists(path) && !createMissing && !OwnShortcut(legacy, root)) return;
        Shortcut(path, DesktopPaths.ApplicationExecutable(payload), payload);
        RemoveOwnedShortcut(legacy, root);
    }
    internal static void Shortcut(string path, string executable, string cwd) {
        var shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        try {
            dynamic link = shell.GetType().InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { path });
            try { link.TargetPath = executable; link.WorkingDirectory = cwd; link.IconLocation = executable; link.Description = "Terminal+ session monitor"; link.Save(); }
            finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(link); }
        } finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell); }
    }
    internal static void RemoveRegistration(string root) {
        Registry.CurrentUser.DeleteSubKeyTree(RegistryKey(root), false);
        using (var key = Registry.CurrentUser.OpenSubKey(StartupRegistration.RunKey, true))
            if (key != null && OwnStartup(key.GetValue(StartupRegistration.ValueName) as string, root)) key.DeleteValue(StartupRegistration.ValueName, false);
        foreach (string parent in new[] { Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Environment.GetFolderPath(Environment.SpecialFolder.Programs) }) {
            RemoveOwnedShortcut(Path.Combine(parent, "Terminal+.lnk"), root);
            RemoveOwnedShortcut(Path.Combine(parent, "Even-Pilot.lnk"), root);
        }
        string pi = Environment.GetEnvironmentVariable("PI_CODING_AGENT_DIR");
        string extension = Path.Combine(String.IsNullOrEmpty(pi) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".pi", "agent") : pi, "extensions", "even-pilot-monitor.ts");
        if (File.Exists(extension)) {
            string content = File.ReadAllText(extension);
            if (content.StartsWith("// Even-PIlot native terminal monitor\n") && content.Contains(root.Replace('\\', '/') + "/versions/")) File.Delete(extension);
        }
    }
    internal static void DeleteOwnedTree(string path, string root) {
        if (!Inside(path, root) || !Directory.Exists(path)) return;
        // Explicit walk: a malicious/replaced junction can never lead outside the installation.
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new Exception("Refusing to remove a linked installation directory.");
        foreach (string child in Directory.GetDirectories(path)) DeleteOwnedTree(child, root);
        foreach (string file in Directory.GetFiles(path)) {
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new Exception("Refusing to remove a linked installation file.");
            File.SetAttributes(file, FileAttributes.Normal); File.Delete(file);
        }
        Directory.Delete(path);
    }
}
