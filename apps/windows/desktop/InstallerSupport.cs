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
using System.Web.Script.Serialization;
using Microsoft.Win32;

static class InstallerSupport {
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
            || root == Full(Environment.GetFolderPath(Environment.SpecialFolder.Windows))) throw new Exception("Choose a dedicated Even-Pilot installation folder.");
        // Never traverse a junction supplied as an existing installer-owned path.
        foreach (string path in new[] { root, Path.Combine(root, "versions"), Path.Combine(root, ".local") })
            if (Directory.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new Exception("Installation folders must not be directory links.");
        if (File.Exists(Path.Combine(root, "Uninstall.exe")) && !File.Exists(Path.Combine(root, "install.json")))
            throw new Exception("This folder contains another application's uninstaller. Choose a different folder.");
    }
    internal static string DefaultRoot() {
        string besideSetup = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        if (File.Exists(Path.Combine(besideSetup, "Even-Pilot.exe")) && File.Exists(Path.Combine(besideSetup, "apps", "windows", "src", "cli.ts")))
            return DesktopPaths.InstallRoot(besideSetup);
        // Updating an open portable copy in place retains the original data directory,
        // including snapshots written by native terminals which are still running.
        foreach (var process in Process.GetProcessesByName("Even-Pilot")) using (process) {
            try {
                if (process.SessionId != Process.GetCurrentProcess().SessionId) continue;
                string payload = Path.GetDirectoryName(process.MainModule.FileName);
                if (File.Exists(Path.Combine(payload, "apps", "windows", "src", "cli.ts"))) return DesktopPaths.InstallRoot(payload);
            } catch { }
        }
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
    internal static void StopMonitor(string root) {
        string configPath = Path.Combine(Data(root), "bridge-config.json");
        if (File.Exists(configPath)) {
            var config = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(configPath));
            string token = Environment.GetEnvironmentVariable("EVEN_PILOT_TOKEN");
            if (String.IsNullOrEmpty(token)) token = Convert.ToString(config["controlToken"]);
            int port = 4317; string configuredPort = Environment.GetEnvironmentVariable("EVEN_PILOT_PORT");
            if (!String.IsNullOrEmpty(configuredPort) && (!Int32.TryParse(configuredPort, out port) || port < 1 || port > 65535)) throw new Exception("Invalid bridge port.");
            using (var http = new HttpClient(new HttpClientHandler { UseProxy = false })) {
                http.BaseAddress = new Uri("http://127.0.0.1:" + port); http.Timeout = TimeSpan.FromSeconds(3);
                http.DefaultRequestHeaders.ConnectionClose = true;
                http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
                HttpResponseMessage state = null;
                try { state = http.GetAsync("/api/monitoring").GetAwaiter().GetResult(); } catch (HttpRequestException) { } catch (System.Threading.Tasks.TaskCanceledException) { throw new Exception("The bridge did not respond. Installation has not stopped any terminal."); }
                if (state != null) using (state) {
                    if (!state.IsSuccessStatusCode) throw new Exception("Port " + port + " belongs to another bridge. Close that monitoring backend before continuing; keep native terminals running.");
                    var body = Json.Deserialize<Dictionary<string, object>>(state.Content.ReadAsStringAsync().GetAwaiter().GetResult());
                    if (!body.ContainsKey("nativeTerminals") || !Convert.ToBoolean(body["nativeTerminals"])) throw new Exception("Refusing to stop a backend that may own agent processes.");
                    using (var response = http.PostAsync("/api/shutdown", new StringContent("{}", Encoding.UTF8, "application/json")).GetAwaiter().GetResult()) response.EnsureSuccessStatusCode();
                    bool stopped = false;
                    for (int n = 0; n < 80; n++) {
                        Thread.Sleep(100);
                        bool listening = false;
                        foreach (var endpoint in IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
                            if (endpoint.Port == port) { listening = true; break; }
                        if (!listening) { stopped = true; break; }
                    }
                    if (!stopped) throw new Exception("The monitoring backend did not exit. No terminal was force-closed.");
                }
            }
        }
        // Only the tray in this installation. Never use process trees or kill Node/CLI processes.
        foreach (var process in Process.GetProcessesByName("Even-Pilot")) using (process) {
            try {
                if (process.SessionId != Process.GetCurrentProcess().SessionId) continue;
                string path = process.MainModule.FileName;
                if (String.Equals(path, Path.Combine(root, "Even-Pilot.exe"), StringComparison.OrdinalIgnoreCase)
                    || Inside(path, Path.Combine(root, "versions"))) { process.Kill(); process.WaitForExit(5000); }
            } catch (InvalidOperationException) { }
        }
    }
    internal static string RegistryKey(string root) { return @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Even-Pilot-" + RootId(root); }
    internal static bool OwnStartup(string command, string root) {
        return command != null && command.StartsWith("\"" + Full(root) + "\\", StringComparison.OrdinalIgnoreCase)
            && command.EndsWith("Even-Pilot.exe\" --autostart", StringComparison.OrdinalIgnoreCase);
    }
    internal static void Register(string root, string payload, string version, bool shortcuts) {
        string executable = Path.Combine(payload, "Even-Pilot.exe");
        using (var key = Registry.CurrentUser.CreateSubKey(RegistryKey(root))) {
            key.SetValue("DisplayName", "Even-Pilot"); key.SetValue("DisplayVersion", version); key.SetValue("Publisher", "Even-Pilot");
            key.SetValue("InstallLocation", root); key.SetValue("DisplayIcon", executable);
            string uninstall = "\"" + Path.Combine(root, "Uninstall.exe") + "\" --uninstall --dir \"" + root + "\"";
            key.SetValue("UninstallString", uninstall); key.SetValue("QuietUninstallString", uninstall + " --quiet");
            key.SetValue("NoModify", 1, RegistryValueKind.DWord); key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
        using (var key = Registry.CurrentUser.OpenSubKey(StartupRegistration.RunKey, true)) {
            if (key != null && OwnStartup(key.GetValue(StartupRegistration.ValueName) as string, root))
                key.SetValue(StartupRegistration.ValueName, "\"" + executable + "\" --autostart");
        }
        if (shortcuts) {
            Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Even-Pilot.lnk"), executable, payload);
            Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Even-Pilot.lnk"), executable, payload);
        }
    }
    internal static void Shortcut(string path, string executable, string cwd) {
        var shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        try {
            dynamic link = shell.GetType().InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { path });
            try { link.TargetPath = executable; link.WorkingDirectory = cwd; link.IconLocation = executable; link.Description = "Even-Pilot session monitor"; link.Save(); }
            finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(link); }
        } finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell); }
    }
    internal static void RemoveRegistration(string root) {
        Registry.CurrentUser.DeleteSubKeyTree(RegistryKey(root), false);
        using (var key = Registry.CurrentUser.OpenSubKey(StartupRegistration.RunKey, true))
            if (key != null && OwnStartup(key.GetValue(StartupRegistration.ValueName) as string, root)) key.DeleteValue(StartupRegistration.ValueName, false);
        foreach (string parent in new[] { Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Environment.GetFolderPath(Environment.SpecialFolder.Programs) }) {
            string path = Path.Combine(parent, "Even-Pilot.lnk"); if (!File.Exists(path)) continue;
            var shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            try {
                dynamic link = shell.GetType().InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { path });
                try { if (Inside((string)link.TargetPath, root)) File.Delete(path); }
                finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(link); }
            } finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell); }
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
