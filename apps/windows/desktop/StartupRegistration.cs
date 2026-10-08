using System;
using System.IO;
using Microsoft.Win32;

// Per-user startup: no administrator rights, scheduled task, or service.
sealed class StartupRegistration {
    internal const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    // Retain the existing value so an upgrade updates one login entry and its preference.
    internal const string ValueName = "Even-Pilot";
    readonly string keyPath;
    internal readonly string Command;

    internal StartupRegistration(string executable, string registryPath = RunKey) {
        Command = "\"" + Path.GetFullPath(executable) + "\" --autostart";
        keyPath = registryPath;
    }
    internal bool IsEnabled() {
        using (var key = Registry.CurrentUser.OpenSubKey(keyPath)) {
            return key != null && String.Equals(key.GetValue(ValueName) as string, Command, StringComparison.OrdinalIgnoreCase);
        }
    }
    internal void SetEnabled(bool enabled) {
        using (var key = Registry.CurrentUser.CreateSubKey(keyPath)) {
            if (enabled) key.SetValue(ValueName, Command, RegistryValueKind.String);
            else key.DeleteValue(ValueName, false);
        }
    }
}
