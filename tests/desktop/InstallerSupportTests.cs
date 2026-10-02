using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Diagnostics;

class InstallerSupportTests {
    static void Assert(bool ok, string message) { if (!ok) throw new Exception(message); }
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
        } finally { Environment.SetEnvironmentVariable("EVEN_PILOT_DATA_DIR",original); InstallerSupport.DeleteOwnedTree(root,Path.GetDirectoryName(root)); }
        Console.WriteLine("PASS: bundled runtime selection, shared installed data, native Windows shortcuts, scoped startup handling and installation-root guard.");
    }
}
