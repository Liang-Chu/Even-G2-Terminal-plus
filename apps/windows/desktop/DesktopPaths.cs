using System;
using System.IO;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

static class DesktopPaths {
    internal static string InstalledExecutable(string payload) {
        string record = Path.Combine(payload, "install.json");
        if (File.Exists(Path.Combine(payload, "installed.json")) || !File.Exists(record)) return null;
        var value = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(File.ReadAllText(record));
        string current = value.ContainsKey("current") ? Convert.ToString(value["current"]) : "";
        if (!Regex.IsMatch(current, @"^\d+\.\d+\.\d+-[a-f0-9]{12}$")) throw new Exception("Invalid installed version");
        string executable = Path.Combine(payload, "versions", current, "Even-Pilot.exe");
        if (!File.Exists(executable)) throw new Exception("Installed version is missing; run the installer again");
        return executable;
    }
    internal static string InstallRoot(string payload) {
        payload = Path.GetFullPath(payload).TrimEnd(Path.DirectorySeparatorChar);
        if (!File.Exists(Path.Combine(payload, "installed.json"))) return payload;
        var versions = Directory.GetParent(payload);
        if (versions == null || versions.Name != "versions" || versions.Parent == null) throw new Exception("Invalid installed application layout.");
        return versions.Parent.FullName;
    }
    internal static string DataDirectory(string payload) {
        string custom = Environment.GetEnvironmentVariable("EVEN_PILOT_DATA_DIR");
        return String.IsNullOrEmpty(custom) ? Path.Combine(InstallRoot(payload), ".local") : Path.GetFullPath(custom);
    }
    internal static string Node(string payload) {
        string bundled = Path.Combine(payload, "runtime", "node.exe");
        if (File.Exists(bundled)) return bundled;
        foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)) {
            try {
                string candidate = Path.Combine(directory.Trim().Trim('"'), "node.exe");
                if (Path.IsPathRooted(candidate) && File.Exists(candidate)) return candidate;
            } catch { }
        }
        throw new Exception("Reinstall Even-Pilot to restore its runtime. Source checkouts require Node.js 22 or newer.");
    }
}
