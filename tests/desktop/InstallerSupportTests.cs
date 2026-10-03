using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

class InstallerSupportTests {
    static void Assert(bool ok, string message) { if (!ok) throw new Exception(message); }
    static void RestartCoordination(string root, string fixture) {
        string payload = Path.Combine(root, "versions", "1.0.0-123456abcdef");
        string ownTray = Path.Combine(payload, "Even-Pilot.exe"), otherRoot = Path.Combine(root, "other-installation");
        Directory.CreateDirectory(otherRoot);
        string otherTray = Path.Combine(otherRoot, "Even-Pilot.exe"), native = Path.Combine(root, "native-fixture.exe");
        File.Copy(fixture, ownTray, true); File.Copy(fixture, otherTray); File.Copy(fixture, native);
        string node = Path.Combine(payload, "runtime", "node.exe"), cli = Path.Combine(payload, "apps", "windows", "src", "cli.ts");
        File.Copy(fixture, node, true); Directory.CreateDirectory(Path.GetDirectoryName(cli)); File.WriteAllText(cli, "isolated monitor fixture");
        Assert(InstallerSupport.OwnedMonitorExecutable(root, node), "A recorded installed payload's exact runtime is recognized");
        Assert(!InstallerSupport.OwnedMonitorExecutable(root, native), "A native executable is never a monitoring recovery target");
        Assert(!InstallerSupport.OwnedMonitorExecutable(otherRoot, node), "Another installation cannot claim this runtime");
        string unrecorded = Path.Combine(root, "versions", "8.8.8-abcdef123456");
        Directory.CreateDirectory(Path.Combine(unrecorded, "runtime")); Directory.CreateDirectory(Path.Combine(unrecorded, "apps", "windows", "src"));
        File.Copy(fixture, Path.Combine(unrecorded, "runtime", "node.exe")); File.WriteAllText(Path.Combine(unrecorded, "installed.json"), "{}"); File.WriteAllText(Path.Combine(unrecorded, "apps", "windows", "src", "cli.ts"), "fixture");
        Assert(!InstallerSupport.OwnedMonitorExecutable(root, Path.Combine(unrecorded, "runtime", "node.exe")), "Unrecorded payloads are not trusted recovery targets");
        using (var owned = Process.Start(new ProcessStartInfo(ownTray) { UseShellExecute = false, CreateNoWindow = true }))
        using (var unrelated = Process.Start(new ProcessStartInfo(otherTray) { UseShellExecute = false, CreateNoWindow = true }))
        using (var terminal = Process.Start(new ProcessStartInfo(native) { UseShellExecute = false, CreateNoWindow = true })) {
            string originalPort = Environment.GetEnvironmentVariable("EVEN_PILOT_PORT");
            string originalToken = Environment.GetEnvironmentVariable("EVEN_PILOT_TOKEN");
            var reservation = new TcpListener(IPAddress.Loopback, 0); reservation.Start();
            int port = ((IPEndPoint)reservation.LocalEndpoint).Port; reservation.Stop();
            Environment.SetEnvironmentVariable("EVEN_PILOT_PORT", port.ToString());
            Environment.SetEnvironmentVariable("EVEN_PILOT_TOKEN", null);
            string trace = Path.Combine(root, "monitor-trace.txt");
            using (var monitor = Process.Start(new ProcessStartInfo(node, port + " " + owned.Id + " \"" + trace + "\"") { UseShellExecute = false, CreateNoWindow = true }))
            try {
                File.WriteAllText(Path.Combine(root, ".local", "bridge-config.json"), "{\"controlToken\":\"isolated-update-test-key\"}");
                for (int n = 0; n < 100 && !File.Exists(trace + ".ready"); n++) Thread.Sleep(50);
                Assert(File.Exists(trace + ".ready"), "Isolated monitoring listener becomes ready");
                using (var captured = InstallerSupport.CaptureMonitor(root, port)) {
                    Assert(captured != null && captured.Pid == monitor.Id, "IPv4 TCP table captures the actual monitoring listener PID");
                    Assert(captured.MatchesIdentity(monitor.Id, monitor.StartTime, monitor.MainModule.FileName), "Captured PID, start time and executable identity match");
                    Assert(!captured.MatchesIdentity(terminal.Id, monitor.StartTime, monitor.MainModule.FileName), "A different PID cannot receive monitor recovery");
                    Assert(!captured.MatchesIdentity(monitor.Id, monitor.StartTime.AddSeconds(1), monitor.MainModule.FileName), "PID reuse or a changed start time cannot receive recovery");
                    Assert(!captured.MatchesIdentity(monitor.Id, monitor.StartTime, native), "A changed executable cannot receive recovery");
                }
                var elapsed = Stopwatch.StartNew();
                InstallerSupport.StopMonitor(root);
                Assert(elapsed.ElapsedMilliseconds >= 2900 && elapsed.ElapsedMilliseconds < 10000, "Acknowledged hung monitor gets a bounded graceful-exit wait before recovery");
                Assert(monitor.HasExited, "An old monitor with a closed listener and retained process is recovered");
                Assert(File.ReadAllText(trace) == "probe\nshutdown\nlistener-closed\n", "Old tray exits first; authenticated safe monitoring probe and acknowledged shutdown precede recovery");
                Assert(owned.HasExited && !unrelated.HasExited && !terminal.HasExited, "Only this installation's old tray and acknowledged monitor were stopped");
            } finally {
                Environment.SetEnvironmentVariable("EVEN_PILOT_PORT", originalPort); Environment.SetEnvironmentVariable("EVEN_PILOT_TOKEN", originalToken);
                foreach (var process in new[] { owned, unrelated, terminal, monitor }) if (!process.HasExited) { process.Kill(); process.WaitForExit(5000); }
            }
        }
    }
    static void RecoveryRefusals(string root, string fixture) {
        string payload = Path.Combine(root, "versions", "1.0.0-123456abcdef"), node = Path.Combine(payload, "runtime", "node.exe");
        string unrelated = Path.Combine(root, "unrelated-listener.exe"); File.Copy(fixture, unrelated);
        string originalPort = Environment.GetEnvironmentVariable("EVEN_PILOT_PORT"), originalToken = Environment.GetEnvironmentVariable("EVEN_PILOT_TOKEN");
        Environment.SetEnvironmentVariable("EVEN_PILOT_TOKEN", null);
        try {
            foreach (string mode in new[] { "unowned", "unsafe", "noack", "falseack" }) {
                var reservation = new TcpListener(IPAddress.Loopback, 0); reservation.Start();
                int port = ((IPEndPoint)reservation.LocalEndpoint).Port; reservation.Stop();
                Environment.SetEnvironmentVariable("EVEN_PILOT_PORT", port.ToString());
                string trace = Path.Combine(root, mode + "-trace.txt"), executable = mode == "unowned" ? unrelated : node;
                using (var process = Process.Start(new ProcessStartInfo(executable, port + " 0 \"" + trace + "\" " + mode) { UseShellExecute = false, CreateNoWindow = true })) {
                    try {
                        for (int n = 0; n < 100 && !File.Exists(trace + ".ready"); n++) Thread.Sleep(50);
                        Assert(File.Exists(trace + ".ready"), "Rejection fixture becomes ready");
                        bool refused = false; try { InstallerSupport.StopMonitor(root); } catch { refused = true; }
                        Assert(refused && !process.HasExited, "Unowned, unsafe or unacknowledged monitors must not be force-closed: " + mode);
                        if (mode == "unowned") Assert(!File.Exists(trace), "Unowned listener is rejected before sending monitoring controls");
                        if (mode == "unsafe") Assert(File.ReadAllText(trace) == "probe\n", "nativeTerminals=false never gets a shutdown request");
                    } finally { if (!process.HasExited) { process.Kill(); process.WaitForExit(5000); } }
                }
            }
        } finally { Environment.SetEnvironmentVariable("EVEN_PILOT_PORT", originalPort); Environment.SetEnvironmentVariable("EVEN_PILOT_TOKEN", originalToken); }
    }
    static void Main(string[] args) {
        string root = Path.Combine(Path.GetTempPath(), "pilot-paths-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        string original = Environment.GetEnvironmentVariable("EVEN_PILOT_DATA_DIR");
        try {
            Environment.SetEnvironmentVariable("EVEN_PILOT_DATA_DIR", null);
            string payload = Path.Combine(root,"versions","1.0.0-123456abcdef"); Directory.CreateDirectory(payload);
            File.WriteAllText(Path.Combine(payload,"installed.json"),"{}");
            Assert(DesktopPaths.InstallRoot(payload) == root,"Installed versions must share the base directory");
            Assert(DesktopPaths.DataDirectory(payload) == Path.Combine(root,".local"),"Shared key/watch directory");
            Assert(DesktopPaths.InstalledExecutable(root) == null,"Uninstalled checkout stays local");
            string selected = Path.Combine(payload,"Even-Pilot.exe"); File.WriteAllText(selected,"fixture");
            File.WriteAllText(Path.Combine(root,"install.json"),"{\"current\":\"1.0.0-123456abcdef\"}");
            Assert(DesktopPaths.InstalledExecutable(root) == selected,"Root launcher follows selected installed version");
            Assert(DesktopPaths.InstalledExecutable(payload) == null,"Installed payload does not delegate recursively");
            File.WriteAllText(Path.Combine(root,"install.json"),"{\"current\":\"../outside\"}");
            bool badSelection=false; try { DesktopPaths.InstalledExecutable(root); } catch { badSelection=true; }
            Assert(badSelection,"Reject traversal in selected installed version");
            Directory.CreateDirectory(Path.Combine(payload,"runtime"));
            File.WriteAllText(Path.Combine(payload,"runtime","node.exe"),"fixture");
            Assert(DesktopPaths.Node(payload) == Path.Combine(payload,"runtime","node.exe"),"Prefer bundled runtime to PATH");
            string shortcut = Path.Combine(root,"Even-Pilot fixture.lnk"), target = Path.Combine(root,"Space in target.exe");
            File.WriteAllText(target,"fixture"); InstallerSupport.Shortcut(shortcut,target,root);
            object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            try {
                dynamic link = shell.GetType().InvokeMember("CreateShortcut",BindingFlags.InvokeMethod,null,shell,new object[]{shortcut});
                try { Assert(String.Equals((string)link.TargetPath,target,StringComparison.OrdinalIgnoreCase),"Shortcut target"); Assert((string)link.WorkingDirectory == root,"Shortcut working folder"); }
                finally { Marshal.FinalReleaseComObject(link); }
            } finally { Marshal.FinalReleaseComObject(shell); }
            Assert(InstallerSupport.OwnStartup("\""+target.Replace("Space in target.exe","Even-Pilot.exe")+"\" --autostart",root),"Recognize this installation startup");
            Assert(!InstallerSupport.OwnStartup("\""+root+"-another\\Even-Pilot.exe\" --autostart",root),"Do not change another installation startup");
            bool refused=false; try { InstallerSupport.ValidateRoot(Path.GetPathRoot(root)); } catch { refused=true; }
            Assert(refused,"Reject a drive root as install directory");
            string launcher = Path.Combine(root,"Even-Pilot.exe");
            File.Copy(args[0],launcher); File.Copy(args[0],selected,true);
            Func<int> delegatedCheck = () => {
                using (var process = Process.Start(new ProcessStartInfo(launcher,"--check") { UseShellExecute=false, CreateNoWindow=true })) {
                    Assert(process.WaitForExit(10000),"Delegated check completes"); return process.ExitCode;
                }
            };
            Assert(delegatedCheck() == 1,"Invalid selection returns failure without a UI");
            File.WriteAllText(Path.Combine(root,"install.json"),"{\"current\":\"1.0.0-123456abcdef\"}");
            Assert(delegatedCheck() == 1,"Root launcher waits and propagates child check failure");
            Directory.CreateDirectory(Path.Combine(root,".local")); File.WriteAllText(Path.Combine(root,".local","bridge-config.json"),"{}");
            Directory.CreateDirectory(Path.Combine(payload,"node_modules","tsx")); File.WriteAllText(Path.Combine(payload,"node_modules","tsx","package.json"),"{}");
            Assert(delegatedCheck() == 0,"Root launcher propagates child check success");
            using (var ready = new ManualResetEventSlim()) using (var release = new ManualResetEventSlim()) {
                Assert(DesktopPaths.InstallationMutexName(root) == "Local\\Even-PIlot-Install-" + InstallerSupport.RootId(root), "Tray and existing installers use the same scoped lock");
                var installer = Task.Run(() => {
                    using (var mutex = new Mutex(true, DesktopPaths.InstallationMutexName(root))) {
                        ready.Set(); release.Wait(); mutex.ReleaseMutex();
                    }
                });
                try {
                    Assert(ready.Wait(5000), "Isolated installer takes its root lock");
                    Assert(DesktopPaths.InstallationInProgress(payload), "Installed tray detects its installer before a backend or update phase exists");
                    Assert(!DesktopPaths.InstallationInProgress(Path.Combine(root, "another-installation")), "Another installation's lock does not block this tray");
                    string log = Path.Combine(root, ".local", "desktop-startup.log"), before = File.Exists(log) ? File.ReadAllText(log) : null;
                    using (var tray = Process.Start(new ProcessStartInfo(selected, "--autostart") { UseShellExecute = false, CreateNoWindow = true })) {
                        Assert(tray.WaitForExit(5000) && tray.ExitCode == 0, "A newly launched old tray quietly waits instead of preparing or starting its backend");
                    }
                    Assert((File.Exists(log) ? File.ReadAllText(log) : null) == before, "Blocked initial launch does not mutate monitor setup or report a startup failure");
                } finally { release.Set(); Assert(installer.Wait(5000), "Installer lock is released"); }
                Assert(!DesktopPaths.InstallationInProgress(payload), "Normal tray startup resumes after installation");
            }
            RestartCoordination(root, args[1]);
            RecoveryRefusals(root, args[1]);
        } finally { Environment.SetEnvironmentVariable("EVEN_PILOT_DATA_DIR",original); InstallerSupport.DeleteOwnedTree(root,Path.GetDirectoryName(root)); }
        Console.WriteLine("PASS: bundled runtime selection, shared installed data, native Windows shortcuts, scoped startup handling and installation-root guard.");
    }
}
