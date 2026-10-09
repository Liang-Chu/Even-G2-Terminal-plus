using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Terminal+")]
[assembly: System.Reflection.AssemblyFileVersion("1.1.16.0")]
[assembly: System.Reflection.AssemblyVersion("1.1.16.0")]

// Native tray UI. The bridge and its Pi sessions have an independent lifetime.
class PilotTray : ApplicationContext {
    readonly string root = AppDomain.CurrentDomain.BaseDirectory;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly NotifyIcon icon = new NotifyIcon();
    readonly HttpClient http = new HttpClient(new HttpClientHandler { UseProxy = false });
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly StartupRegistration startup = new StartupRegistration(Application.ExecutablePath);
    readonly Icon appIcon;
    string token, node;
    readonly EventWaitHandle showRequested;
    bool checking, exiting, starting, opening;
    Task<bool> startTask;
    DateTime retryAt = DateTime.MinValue;
    readonly ToolStripMenuItem status = new ToolStripMenuItem("Background: Starting…");
    readonly ToolStripMenuItem activity = new ToolStripMenuItem("Checking monitored sessions…");
    readonly ToolStripMenuItem startBackground = new ToolStripMenuItem("Start background");
    readonly ToolStripMenuItem autoStart = new ToolStripMenuItem("Start with Windows");
    readonly ToolStripMenuItem autoUpdates = new ToolStripMenuItem("Automatic updates");
    readonly ToolStripMenuItem updateAction = new ToolStripMenuItem("Check for updates");
    DateTime updatesAt = DateTime.MinValue;
    string availableVersion, notifiedVersion;
    string updatePhase = "idle";
    int updateProgress;
    bool installSupported;
    bool updating;
    bool installerStartup;
    static int Port() {
        int value; string configured = Environment.GetEnvironmentVariable("EVEN_PILOT_PORT");
        if (String.IsNullOrEmpty(configured)) return 4317;
        if (!Int32.TryParse(configured, out value) || value < 1 || value > 65535) throw new Exception("Invalid bridge port");
        return value;
    }
    PilotTray(EventWaitHandle show, bool quietLaunch, bool installerLaunch) {
        showRequested = show;
        installerStartup = installerLaunch;
        node = PrepareDesktop(root);
        var config = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(DesktopPaths.DataDirectory(root), "bridge-config.json")));
        token = Environment.GetEnvironmentVariable("EVEN_PILOT_TOKEN");
        if (String.IsNullOrEmpty(token)) token = (string)config["controlToken"];
        http.BaseAddress = new Uri("http://127.0.0.1:" + Port());
        http.Timeout = TimeSpan.FromSeconds(30);
        http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        var menu = new ContextMenuStrip();
        status.Enabled = false; menu.Items.Add(status);
        activity.Enabled = false; menu.Items.Add(activity);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Open Terminal+", null, async (s, e) => await OpenManager());
        startBackground.Click += async (s, e) => await Start(true);
        menu.Items.Add(startBackground);
        autoStart.CheckOnClick = false;
        autoStart.Click += (s, e) => ToggleStartup();
        menu.Items.Add(autoStart);
        updateAction.Click += async (s, e) => await UpdateAction(); menu.Items.Add(updateAction);
        autoUpdates.Click += async (s, e) => await ToggleAutomaticUpdates();
        menu.Items.Add(autoUpdates);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit Terminal+", null, (s, e) => Quit());
        menu.Opening += (s, e) => ReadStartup();
        using (var stream = typeof(PilotTray).Assembly.GetManifestResourceStream("Terminal-plus.ico")) {
            appIcon = new Icon(stream, SystemInformation.SmallIconSize);
        }
        icon.Icon = appIcon; icon.Text = "Terminal+";
        icon.ContextMenuStrip = menu; icon.Visible = true;
        icon.DoubleClick += async (s, e) => await OpenManager();
        timer.Interval = 1000;
        int ticks = 0;
        timer.Tick += async (s, e) => {
            if (exiting) return;
            if (showRequested.WaitOne(0)) await OpenManager();
            if (++ticks % 3 == 0 && !starting && !await Refresh() && !BackendStartBlocked() && DateTime.UtcNow >= retryAt) await Start(false);
            if (DateTime.UtcNow >= updatesAt && !updating && !starting) await ReadUpdates(false);
        };
        timer.Start();
        Application.ApplicationExit += (s, e) => { icon.Visible = false; icon.Dispose(); appIcon.Dispose(); menu.Dispose(); http.Dispose(); timer.Dispose(); };
        Begin(quietLaunch);
    }
    async void Begin(bool quietLaunch) {
        await ReadUpdates(false);
        if (quietLaunch) await Start(false);
        else await OpenManager();
    }
    bool BackendStartBlocked() {
        return !TrayUpdateActions.StartAllowed(updatePhase, DesktopPaths.InstallationInProgress(root), installerStartup);
    }
    void ReadStartup() {
        try { autoStart.Checked = startup.IsEnabled(); autoStart.Enabled = true; }
        catch { autoStart.Checked = false; autoStart.Enabled = false; }
    }
    void ToggleStartup() {
        try { startup.SetEnabled(!startup.IsEnabled()); ReadStartup(); }
        catch (Exception error) {
            ReadStartup();
            MessageBox.Show(error.Message, "Could not change Windows startup", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
    async Task<Dictionary<string, object>> UpdateRequest(string path, object body = null) {
        return await TrayUpdateActions.Request(http, json, path, body);
    }
    void ApplyUpdates(Dictionary<string, object> data, bool manual) {
        string previousPhase = updatePhase;
        bool automatic = Convert.ToBoolean(data["automaticChecks"]);
        autoUpdates.Checked = automatic;
        var available = data["available"] as Dictionary<string, object>;
        availableVersion = available == null ? null : Convert.ToString(available["version"]);
        if (!automatic && !manual) availableVersion = null;
        updatePhase = Convert.ToString(data["phase"]);
        updateProgress = Convert.ToInt32(data["progress"]);
        installSupported = Convert.ToBoolean(data["installSupported"]);
        bool working = TrayUpdateActions.Working(updatePhase);
        updatesAt = DateTime.UtcNow.AddSeconds(working ? 2 : 60);
        updateAction.Text = TrayUpdateActions.Label(updatePhase, updateProgress, availableVersion, installSupported);
        updateAction.Enabled = autoUpdates.Enabled = !working;
        if (working) icon.Text = "Terminal+ · " + updateAction.Text;
        if (BackendStartBlocked()) startBackground.Enabled = false;
        string error = data["error"] == null ? null : Convert.ToString(data["error"]);
        if (!working && (manual || TrayUpdateActions.Working(previousPhase)) && !String.IsNullOrEmpty(error))
            icon.ShowBalloonTip(7000, TrayUpdateActions.Working(previousPhase) ? "Terminal+ update failed" : "Terminal+ updates", error, ToolTipIcon.Warning);
        else if (!working && availableVersion != null && (manual || automatic && notifiedVersion != availableVersion)) {
            notifiedVersion = availableVersion;
            icon.ShowBalloonTip(7000, "Terminal+ update available", "Version " + availableVersion + ". Right-click the tray icon and choose Update to install.", ToolTipIcon.Info);
        } else if (manual && availableVersion == null && !working)
            icon.ShowBalloonTip(5000, "Terminal+ updates", String.IsNullOrEmpty(error) ? "No newer release available." : error, ToolTipIcon.Info);
    }
    async Task ReadUpdates(bool manual) {
        if (updating) return; updating = true; updatesAt = DateTime.UtcNow.AddSeconds(60);
        try {
            ApplyUpdates(await UpdateRequest("/api/updates"), manual);
        } catch {
            updatesAt = DateTime.UtcNow.AddSeconds(TrayUpdateActions.Working(updatePhase) ? 2 : 60);
            if (!TrayUpdateActions.Working(updatePhase)) updateAction.Text = "Check for updates";
        }
        finally { updating = false; }
    }
    async Task UpdateAction() {
        if (updating || TrayUpdateActions.Working(updatePhase)) return;
        updating = true; updateAction.Enabled = autoUpdates.Enabled = false;
        bool installing = availableVersion != null && installSupported;
        updateAction.Text = installing ? "Starting update…" : "Checking for updates…";
        try {
            // This click is the explicit install action. Never open the browser
            // or install a version that has not been offered by the backend.
            ApplyUpdates(await TrayUpdateActions.Perform(http, json, availableVersion, installSupported), true);
        } catch (Exception error) {
            updatesAt = DateTime.UtcNow.AddSeconds(2);
            updateAction.Text = TrayUpdateActions.Label(updatePhase, updateProgress, availableVersion, installSupported);
            updateAction.Enabled = autoUpdates.Enabled = !TrayUpdateActions.Working(updatePhase);
            icon.ShowBalloonTip(7000, "Terminal+ updates", TrayUpdateActions.Error(error), ToolTipIcon.Warning);
        } finally { updating = false; }
    }
    async Task ToggleAutomaticUpdates() {
        if (updating || TrayUpdateActions.Working(updatePhase)) return;
        updating = true; updateAction.Enabled = autoUpdates.Enabled = false;
        try { ApplyUpdates(await UpdateRequest("/api/updates/settings", new { automaticChecks = !autoUpdates.Checked }), false); }
        catch (Exception error) {
            updateAction.Enabled = autoUpdates.Enabled = true;
            icon.ShowBalloonTip(7000, "Terminal+ update settings", TrayUpdateActions.Error(error), ToolTipIcon.Warning);
        } finally { updating = false; }
    }
    async Task<bool> Refresh() {
        if (checking || exiting) return false;
        checking = true;
        try {
            using (var timeout = new CancellationTokenSource(2000))
            using (var response = await http.GetAsync("/api/monitoring", timeout.Token)) {
                response.EnsureSuccessStatusCode();
                var data = json.Deserialize<Dictionary<string, object>>(await response.Content.ReadAsStringAsync());
                if (exiting) return false;
                string label = Convert.ToString(data["running"]) + " running / " + Convert.ToString(data["watched"]) + " watched";
                status.Text = "Background: Running"; activity.Text = label;
                string tooltip = "Terminal+ · " + (TrayUpdateActions.Working(updatePhase) ? TrayUpdateActions.Label(updatePhase, updateProgress, null, false) : label);
                icon.Text = tooltip.Substring(0, Math.Min(63, tooltip.Length));
                startBackground.Enabled = false;
                return true;
            }
        } catch {
            if (!exiting) {
                bool installing = BackendStartBlocked();
                status.Text = installing ? "Background: Updating…" : starting ? "Background: Starting…" : "Background: Reconnecting";
                activity.Text = installing ? "Monitor will reconnect; terminals keep running" : "Watch settings retained";
                icon.Text = installing ? "Terminal+ · installing update" : "Terminal+ · reconnecting";
                startBackground.Enabled = !starting && !installing;
            }
            return false;
        }
        finally { checking = false; }
    }
    Task<bool> Start(bool notifyErrors) {
        if (exiting) return Task.FromResult(false);
        if (startTask == null || startTask.IsCompleted) startTask = StartCore(notifyErrors);
        return startTask;
    }
    async Task<bool> StartCore(bool notifyErrors) {
        if (BackendStartBlocked()) {
            if (notifyErrors) icon.ShowBalloonTip(5000, "Terminal+ update", "Installation is in progress. The monitor will reconnect; native terminals keep running.", ToolTipIcon.Info);
            return false;
        }
        starting = true;
        startBackground.Enabled = false;
        try {
            LogStartup("background.check");
            while (checking) await Task.Delay(50);
            if (exiting) return false;
            if (await Refresh()) { installerStartup = false; LogStartup("background.ready"); return true; }
            if (BackendStartBlocked()) return false;
            // Detach stdio too: quitting the UI cannot break a backend pipe.
            // The backend's exclusive lock prevents duplicate session owners.
            using (var launcher = Process.Start(new ProcessStartInfo(node, "--import tsx apps/windows/src/desktop-launch.ts --port " + Port()) {
                WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true
            })) {
                await Task.Run(() => launcher.WaitForExit(5000));
                if (launcher.HasExited && launcher.ExitCode != 0) throw new Exception("The background launcher could not start.");
            }
            status.Text = "Background: Starting…";
            var deadline = DateTime.UtcNow.AddSeconds(30);
            do {
                if (exiting) return false;
                if (await Refresh()) { installerStartup = false; LogStartup("background.ready"); return true; }
                if (BackendStartBlocked()) return false;
                await Task.Delay(300);
            } while (DateTime.UtcNow < deadline);
            throw new Exception("The bridge is not ready on port " + Port() + ". Existing sessions have not been stopped.");
        } catch (Exception error) {
            if (BackendStartBlocked()) { LogStartup("background.update-wait"); return false; }
            LogStartup("background.failed", error);
            if (!exiting) {
                status.Text = "Background: Unavailable";
                activity.Text = "Watch settings retained";
                icon.Text = "Terminal+ · background unavailable";
                startBackground.Enabled = true;
                if (notifyErrors) MessageBox.Show(error.Message, "Terminal+ could not start", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            return false;
        } finally { retryAt = DateTime.UtcNow.AddSeconds(30); starting = false; }
    }
    async Task OpenManager() {
        if (opening || exiting) return;
        opening = true;
        try {
            if (!await Start(true) || exiting) return;
            using (var content = new StringContent(json.Serialize(new { openId = Guid.NewGuid().ToString() }), Encoding.UTF8, "application/json"))
            using (var response = await http.PostAsync("/api/desktop/open", content)) {
                if (!response.IsSuccessStatusCode) throw new Exception("Could not apply the last 24 hours watch defaults. Restart the Terminal+ backend, then open the manager again. Existing terminals remain running.");
            }
            Process.Start(new ProcessStartInfo(http.BaseAddress + "?desktop=1#pilot-token=" + Uri.EscapeDataString(token)) { UseShellExecute = true });
        } catch (Exception error) { if (!exiting) MessageBox.Show(error.Message, "Terminal+", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        finally { opening = false; }
    }
    void Quit() {
        if (exiting) return; exiting = true; timer.Stop();
        // Quit only the tray. No shutdown request, process kill, or watch changes.
        icon.Visible = false; ExitThread();
    }
    static string PrepareDesktop(string root) {
        LogStartup("prepare.files");
        if (!File.Exists(Path.Combine(root, "node_modules", "tsx", "package.json")) || !File.Exists(Path.Combine(root, "apps", "evenhub", "dist", "index.html")))
            throw new Exception("Reinstall Terminal+ to restore its application files. Source checkouts should run Setup.cmd first.");
        string nodePath = DesktopPaths.Node(root);
        LogStartup("prepare.config");
        Environment.SetEnvironmentVariable("EVEN_PILOT_DATA_DIR", DesktopPaths.DataDirectory(root));
        using (var setup = Process.Start(new ProcessStartInfo(nodePath, "--import tsx apps/windows/src/setup.ts") {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        })) {
            var output = setup.StandardOutput.ReadToEndAsync();
            var errors = setup.StandardError.ReadToEndAsync();
            if (!setup.WaitForExit(15000)) { setup.Kill(); throw new Exception("Local setup timed out. Existing terminals were not stopped."); }
            if (setup.ExitCode != 0) throw new Exception("Local setup failed. Run Setup.cmd in this folder to see the error.");
        }
        return nodePath;
    }
    static void LogStartup(string stage, Exception error = null) {
        try {
            string directory = DesktopPaths.DataDirectory(AppDomain.CurrentDomain.BaseDirectory);
            Directory.CreateDirectory(directory);
            string path = Path.Combine(directory, "desktop-startup.log");
            if (File.Exists(path) && new FileInfo(path).Length > 65536) File.WriteAllText(path, "");
            // Fixed stage + exception type only: never serialize config, tokens or HTTP bodies.
            File.AppendAllText(path, DateTime.UtcNow.ToString("o") + " " + stage +
                (error == null ? "" : " " + error.GetType().Name + " (" + error.HResult + ")") + Environment.NewLine);
        } catch { }
    }
    [STAThread]
    static void Main(string[] args) {
        bool quietLaunch = Array.IndexOf(args, "--autostart") >= 0;
        bool installerLaunch = Array.IndexOf(args, "--installer-start") >= 0;
        try {
            string installed = DesktopPaths.InstalledExecutable(AppDomain.CurrentDomain.BaseDirectory);
            if (installed != null) {
                var forwarded = new List<string>();
                foreach (string arg in args) if (arg == "--autostart" || arg == "--prepare" || arg == "--check" || arg == "--installer-start") forwarded.Add(arg);
                using (var child = Process.Start(new ProcessStartInfo(installed, String.Join(" ", forwarded.ToArray())) { WorkingDirectory = Path.GetDirectoryName(installed), UseShellExecute = false, CreateNoWindow = true })) {
                    if (forwarded.Contains("--prepare") || forwarded.Contains("--check")) {
                        child.WaitForExit(); Environment.ExitCode = child.ExitCode;
                    }
                }
                return;
            }
        } catch (Exception error) {
            LogStartup("delegate.failed", error); Environment.ExitCode = 1;
            if (!quietLaunch && Array.IndexOf(args, "--prepare") < 0 && Array.IndexOf(args, "--check") < 0)
                MessageBox.Show(error.Message, "Terminal+", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (args.Length > 0 && args[0] == "--prepare") {
            try { PrepareDesktop(AppDomain.CurrentDomain.BaseDirectory); }
            catch (Exception error) { LogStartup("prepare.failed", error); Environment.Exit(1); }
            return;
        }
        if (args.Length > 0 && args[0] == "--check") {
            var root = AppDomain.CurrentDomain.BaseDirectory;
            if (!File.Exists(Path.Combine(DesktopPaths.DataDirectory(root), "bridge-config.json"))
                || !File.Exists(Path.Combine(root, "node_modules", "tsx", "package.json"))) Environment.Exit(1);
            return;
        }
        if (!installerLaunch && DesktopPaths.InstallationInProgress(AppDomain.CurrentDomain.BaseDirectory)) {
            if (!quietLaunch) MessageBox.Show("Installation is in progress. Open Terminal+ again when it finishes; native terminals keep running.", "Terminal+ update", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        bool first;
        string instance = Port() == 4317 ? "" : "-" + Port();
        using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\Even-PIlot-Show" + instance))
        using (var mutex = new Mutex(true, "Local\\Even-PIlot-Tray" + instance, out first)) {
            if (!first) { if (!quietLaunch) show.Set(); return; }
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            for (int attempt = 0; ; attempt++) {
                try { LogStartup(quietLaunch ? "tray.autostart" : "tray.open"); Application.Run(new PilotTray(show, quietLaunch, installerLaunch)); break; }
                catch (Exception error) {
                    LogStartup("tray.failed", error);
                    if (quietLaunch && attempt < 2) { Thread.Sleep(3000); continue; }
                    if (!quietLaunch) MessageBox.Show(error.Message, "Terminal+", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    break;
                }
            }
        }
    }
}

// Kept separate from the tray lifetime so transport and explicit install
// behavior can be verified without launching a browser or touching sessions.
internal static class TrayUpdateActions {
    internal static bool Working(string phase) { return phase == "downloading" || phase == "installing"; }
    internal static bool StartAllowed(string phase, bool installerActive, bool installerStartup) {
        // The replacement tray must start the new monitor while its installer
        // still owns the lock and checks health. This exception ends on readiness.
        return installerStartup || phase != "installing" && !installerActive;
    }
    internal static string Label(string phase, int progress, string version, bool supported) {
        if (phase == "downloading") return "Downloading update: " + Math.Max(0, Math.Min(100, progress)) + "%";
        if (phase == "installing") return "Installing update…";
        return version != null && supported ? "Update to " + version : "Check for updates";
    }
    internal static async Task<Dictionary<string, object>> Request(HttpClient http, JavaScriptSerializer json, string path, object body = null) {
        using (var content = body == null ? null : new StringContent(json.Serialize(body), Encoding.UTF8, "application/json"))
        using (var response = body == null ? await http.GetAsync(path) : await http.PostAsync(path, content)) {
            string text = await response.Content.ReadAsStringAsync();
            Dictionary<string, object> data;
            try { data = json.Deserialize<Dictionary<string, object>>(text); }
            catch { throw new InvalidOperationException("The monitor returned invalid update information. Try again."); }
            if (!response.IsSuccessStatusCode) {
                object message;
                throw new InvalidOperationException(data != null && data.TryGetValue("error", out message) && message is string
                    ? (string)message : "Update request returned HTTP " + (int)response.StatusCode + ". Try again.");
            }
            if (data == null) throw new InvalidOperationException("The monitor returned invalid update information. Try again.");
            return data;
        }
    }
    internal static Task<Dictionary<string, object>> Perform(HttpClient http, JavaScriptSerializer json, string version, bool supported) {
        if (version != null && supported) return Request(http, json, "/api/updates/install", new { version = version });
        return Request(http, json, "/api/updates/check", new { });
    }
    internal static string Error(Exception error) {
        return error is InvalidOperationException ? error.Message : "Could not reach the monitoring backend. Use Start background in the tray, then try again.";
    }
}
