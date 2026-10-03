using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

[assembly: AssemblyTitle("Even-Pilot Setup")]
[assembly: AssemblyFileVersion("1.1.4.0")]
[assembly: AssemblyVersion("1.1.4.0")]

class ReleaseFile { public string path { get; set; } public string sha256 { get; set; } public long bytes { get; set; } }
class ReleasePayload { public string version { get; set; } public string buildId { get; set; } public ReleaseFile[] files { get; set; } }
class InstalledRecord { public string version; public string current; public string[] versions; }

class PilotInstaller : Form {
    readonly bool uninstall, noLaunch, noShortcuts;
    readonly TextBox location = new TextBox();
    readonly Button action = new Button();
    readonly Label status = new Label();
    readonly ProgressBar progress = new ProgressBar();
    bool busy;
    PilotInstaller(string root, bool removing, bool skipLaunch, bool skipShortcuts) {
        uninstall = removing; noLaunch = skipLaunch; noShortcuts = skipShortcuts;
        Text = removing ? "Uninstall Even-Pilot" : "Install Even-Pilot";
        ClientSize = new Size(520, 255); FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen; BackColor = Color.White;
        Font = new Font("Segoe UI", 10);
        using (var image = Assembly.GetExecutingAssembly().GetManifestResourceStream("Even-Pilot.ico")) Icon = new Icon(image);
        Controls.Add(new Label { Text = "Even-Pilot 1.1.4", Font = new Font("Segoe UI", 18, FontStyle.Bold), AutoSize = true, Location = new Point(24, 20) });
        Controls.Add(new Label { Text = removing ? "Remove the app. Connection settings will be retained.\nClose connected native terminals before uninstalling."
            : "Desktop monitor for Pi, Codex and Claude.\nRuntime included. No Node.js installation or setup commands.", AutoSize = true, Location = new Point(24, 65) });
        location.Text = root; location.Location = new Point(24, 124); location.Size = new Size(388, 28); location.ReadOnly = true; Controls.Add(location);
        var browse = new Button { Text = "Browse…", Location = new Point(420, 121), Size = new Size(76, 30), Enabled = !removing };
        browse.Click += (s, e) => { using (var dialog = new FolderBrowserDialog { SelectedPath = location.Text, Description = "Choose an Even-Pilot folder" }) if (dialog.ShowDialog(this) == DialogResult.OK) location.Text = dialog.SelectedPath; };
        Controls.Add(browse);
        status.Location = new Point(24, 160); status.Size = new Size(472, 30); Controls.Add(status);
        progress.Location = new Point(24, 204); progress.Size = new Size(335, 24); progress.Visible = false; progress.Style = ProgressBarStyle.Marquee; Controls.Add(progress);
        action.Text = removing ? "Uninstall" : "Install"; action.Location = new Point(380, 198); action.Size = new Size(116, 36);
        action.BackColor = Color.Black; action.ForeColor = Color.White; Controls.Add(action); AcceptButton = action;
        action.Click += async (s, e) => {
            if (busy) return;
            busy = true; action.Enabled = false; browse.Enabled = false; progress.Visible = true;
            try {
                string destination = location.Text;
                await Task.Run(() => Run(destination, uninstall, noLaunch, noShortcuts, text => BeginInvoke(new Action(() => status.Text = text))));
                Environment.ExitCode = 0; busy = false; Close();
            } catch (Exception error) {
                status.Text = "Could not complete setup.";
                MessageBox.Show(this, error.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
                Environment.ExitCode = 1; busy = false; action.Enabled = true; browse.Enabled = !uninstall; progress.Visible = false;
            }
        };
        FormClosing += (s, e) => { if (busy) e.Cancel = true; };
    }
    static string Quote(string value) { return "\"" + value + "\""; }
    static string SafeVersion(string name) {
        if (name == null || !Regex.IsMatch(name, @"^\d+\.\d+\.\d+-[a-f0-9]{12}$")) throw new Exception("Invalid installation version record.");
        return name;
    }
    static InstalledRecord Record(string root) {
        string path = Path.Combine(root, "install.json");
        if (!File.Exists(path)) return new InstalledRecord { versions = new string[0] };
        var record = InstallerSupport.Json.Deserialize<InstalledRecord>(File.ReadAllText(path));
        SafeVersion(record.current);
        foreach (string version in record.versions) SafeVersion(version);
        return record;
    }
    static void Verify(string directory, ReleasePayload release) {
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new Exception("The installation version must not be a directory link.");
        foreach (var file in release.files) {
            string path = Path.GetFullPath(Path.Combine(directory, file.path));
            string parent = path;
            while (InstallerSupport.Inside(parent, directory)) {
                if ((File.GetAttributes(parent) & FileAttributes.ReparsePoint) != 0) throw new Exception("Linked installation files are not supported.");
                parent = Path.GetDirectoryName(parent);
            }
            if (!InstallerSupport.Inside(path, directory) || !File.Exists(path) || new FileInfo(path).Length != file.bytes
                || InstallerSupport.HashFile(path) != file.sha256) throw new Exception("Installation file verification failed: " + file.path);
        }
    }
    static void RemoveClaudeMonitoring(string root, string payload) {
        if (!File.Exists(Path.Combine(InstallerSupport.Data(root), "claude-monitor-registration.json"))) return;
        string hookRemoval = Path.Combine(payload, "apps", "windows", "src", "install-claude-monitor.ts");
        if (!File.Exists(hookRemoval)) throw new Exception("Claude monitoring cleanup is unavailable. Reinstall the current package before uninstalling.");
        string node = Path.Combine(payload, "runtime", "node.exe");
        string loader = new Uri(Path.Combine(payload, "node_modules", "tsx", "dist", "loader.mjs")).AbsoluteUri;
        using (var cleanup = Process.Start(new ProcessStartInfo(node, "--import " + Quote(loader) + " " + Quote(hookRemoval)
            + " --remove --data " + Quote(InstallerSupport.Data(root))) {
            WorkingDirectory = payload, UseShellExecute = false, CreateNoWindow = true
        })) {
            if (!cleanup.WaitForExit(20000) || cleanup.ExitCode != 0) throw new Exception("Claude monitoring cleanup failed. Application files and user settings were retained; repair the settings before retrying.");
        }
    }
    static void Run(string root, bool removing, bool noLaunch, bool noShortcuts, Action<string> status, bool backgroundUpdate = false) {
        root = InstallerSupport.Full(root); InstallerSupport.ValidateRoot(root);
        bool first;
        using (var mutex = new Mutex(true, DesktopPaths.InstallationMutexName(root), out first)) {
            if (!first) throw new Exception("Another installer is already using this folder.");
            if (removing) { Uninstall(root, status); return; }
            if (!Environment.Is64BitOperatingSystem) throw new Exception("This package requires 64-bit Windows.");
            ReleasePayload release;
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("release.json")) {
                if (stream == null) throw new Exception("Run the Even-Pilot setup download to install the application.");
                using (var reader = new StreamReader(stream)) release = InstallerSupport.Json.Deserialize<ReleasePayload>(reader.ReadToEnd());
            }
            string version = SafeVersion(release.version + "-" + release.buildId);
            var previous = Record(root);
            string target = Path.Combine(root, "versions", version);
            string temporary = Path.Combine(root, ".install-" + Guid.NewGuid().ToString("N"));
            bool stopped = false, committed = false;
            string previousExe = previous.current == null ? Path.Combine(root, "Even-Pilot.exe") : Path.Combine(root, "versions", previous.current, "Even-Pilot.exe");
            string oldRecord = File.Exists(Path.Combine(root, "install.json")) ? File.ReadAllText(Path.Combine(root, "install.json")) : null;
            try {
                status("Extracting the application and bundled runtime…");
                Directory.CreateDirectory(temporary);
                using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
                using (var zip = new ZipArchive(stream, ZipArchiveMode.Read)) {
                    var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var entry in zip.Entries) {
                        string path = Path.GetFullPath(Path.Combine(temporary, entry.FullName));
                        if (!InstallerSupport.Inside(path, temporary) || !names.Add(path)) throw new Exception("Invalid archive path.");
                        if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(path); continue; }
                        Directory.CreateDirectory(Path.GetDirectoryName(path));
                        using (var source = entry.Open()) using (var destination = new FileStream(path, FileMode.CreateNew, FileAccess.Write)) source.CopyTo(destination);
                    }
                }
                Verify(temporary, release);
                if (Directory.Exists(target)) Verify(target, release);
                else { Directory.CreateDirectory(Path.GetDirectoryName(target)); Directory.Move(temporary, target); }
                File.WriteAllText(Path.Combine(target, "installed.json"), "{\"format\":1}\n");
                status("Updating the monitor; native terminals stay running…");
                InstallerSupport.StopMonitor(root); stopped = true;
                using (var prepare = Process.Start(new ProcessStartInfo(Path.Combine(target, "Even-Pilot.exe"), "--prepare") {
                    WorkingDirectory = target, UseShellExecute = false, CreateNoWindow = true
                })) {
                    if (!prepare.WaitForExit(20000) || prepare.ExitCode != 0) throw new Exception("Local setup failed. Existing connection settings were retained.");
                }
                File.Copy(Path.Combine(target, "Uninstall.exe"), Path.Combine(root, "Uninstall.exe"), true);
                string recordPath = Path.Combine(root, "install.json"), pendingRecord = recordPath + ".new";
                File.WriteAllText(pendingRecord, InstallerSupport.Json.Serialize(new InstalledRecord {
                    version = release.version, current = version, versions = previous.versions.Concat(new[] { version }).Distinct().ToArray()
                }));
                if (File.Exists(recordPath)) File.Replace(pendingRecord, recordPath, recordPath + ".bak");
                else File.Move(pendingRecord, recordPath);
                InstallerSupport.Register(root, target, release.version, !noShortcuts);
                if (backgroundUpdate) {
                    Process.Start(new ProcessStartInfo(Path.Combine(target, "Even-Pilot.exe"), "--autostart --installer-start") { WorkingDirectory = target, UseShellExecute = false, CreateNoWindow = true });
                    InstallerSupport.WaitForVersion(root, release.version);
                }
                committed = true;
                status("Installed.");
                if (!noLaunch && !backgroundUpdate) Process.Start(new ProcessStartInfo(Path.Combine(target, "Even-Pilot.exe"), "--installer-start") { WorkingDirectory = target, UseShellExecute = false, CreateNoWindow = true });
            } catch {
                if (stopped && !committed && File.Exists(previousExe)) {
                    InstallerSupport.StopMonitor(root);
                    Exception cleanupError = null;
                    if (!File.Exists(Path.Combine(Path.GetDirectoryName(previousExe), "apps", "windows", "src", "install-claude-monitor.ts"))) {
                        try { RemoveClaudeMonitoring(root, target); } catch (Exception error) { cleanupError = error; }
                    }
                    if (oldRecord != null) {
                        File.WriteAllText(Path.Combine(root, "install.json"), oldRecord);
                        InstallerSupport.Register(root, Path.GetDirectoryName(previousExe), previous.version, !noShortcuts);
                    } else if (File.Exists(Path.Combine(root, "install.json"))) File.Delete(Path.Combine(root, "install.json"));
                    using (var prepare = Process.Start(new ProcessStartInfo(previousExe, "--prepare") { WorkingDirectory = Path.GetDirectoryName(previousExe), UseShellExecute = false, CreateNoWindow = true })) prepare.WaitForExit(20000);
                    Process.Start(new ProcessStartInfo(previousExe, "--autostart --installer-start") { WorkingDirectory = Path.GetDirectoryName(previousExe), UseShellExecute = false, CreateNoWindow = true });
                    if (cleanupError != null) throw new Exception("The previous monitor was restored, but Claude monitoring settings need repair before removing the new payload.", cleanupError);
                } else if (stopped && !committed) {
                    RemoveClaudeMonitoring(root, target);
                }
                throw;
            } finally { InstallerSupport.DeleteOwnedTree(temporary, root); }
        }
    }
    static void Uninstall(string root, Action<string> status) {
        if (!File.Exists(Path.Combine(root, "install.json"))) throw new Exception("No installed Even-Pilot was found in this folder.");
        var record = Record(root);
        if (InstallerSupport.HasNativeTerminals(root)) throw new Exception("Close connected native terminal windows before uninstalling. No session or process has been stopped.");
        status("Stopping the monitor…"); InstallerSupport.StopMonitor(root);
        Thread.Sleep(500);
        foreach (var process in Process.GetProcesses()) using (process) {
            string path = null; try { path = process.MainModule.FileName; } catch { }
            if (path != null && InstallerSupport.Inside(path, Path.Combine(root, "versions"))) throw new Exception("A terminal still uses this installation. Close it and retry. It has not been stopped.");
        }
        string payload = Path.Combine(root, "versions", SafeVersion(record.current));
        RemoveClaudeMonitoring(root, payload);
        status("Removing application files; keeping connection settings…");
        foreach (string version in record.versions) InstallerSupport.DeleteOwnedTree(Path.Combine(root, "versions", SafeVersion(version)), root);
        InstallerSupport.RemoveRegistration(root);
        File.Delete(Path.Combine(root, "install.json")); File.Delete(Path.Combine(root, "install.json.bak")); File.Delete(Path.Combine(root, "Uninstall.exe"));
        string versions = Path.Combine(root, "versions");
        if (Directory.Exists(versions) && !Directory.EnumerateFileSystemEntries(versions).Any()) Directory.Delete(versions);
    }
    [STAThread]
    static void Main(string[] args) {
        bool quiet = args.Contains("--quiet"), removing = args.Contains("--uninstall");
        try {
            string root = null;
            int index = Array.IndexOf(args, "--dir");
            if (index >= 0) { if (index + 1 >= args.Length) throw new Exception("--dir needs a folder."); root = InstallerSupport.Full(args[index + 1]); }
            root = root ?? (removing ? Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) : InstallerSupport.DefaultRoot());
            // Run uninstall from a temporary copy so Windows can remove the registered EXE.
            if (removing && InstallerSupport.Inside(Assembly.GetExecutingAssembly().Location, root)) {
                string copy = Path.Combine(Path.GetTempPath(), "Even-Pilot-uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
                File.Copy(Assembly.GetExecutingAssembly().Location, copy);
                Process.Start(new ProcessStartInfo(copy, "--uninstall --dir " + Quote(root) + (quiet ? " --quiet" : "")) { UseShellExecute = false, CreateNoWindow = true });
                return;
            }
            if (quiet) Run(root, removing, args.Contains("--no-launch"), args.Contains("--no-shortcuts"), _ => { }, args.Contains("--update"));
            else { Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new PilotInstaller(root, removing, args.Contains("--no-launch"), args.Contains("--no-shortcuts"))); }
        } catch (Exception error) {
            Environment.ExitCode = 1;
            if (!quiet) MessageBox.Show(error.Message, "Even-Pilot setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            else Console.Error.WriteLine(error.Message);
        }
    }
}
