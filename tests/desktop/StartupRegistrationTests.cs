using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using Microsoft.Win32;

class StartupRegistrationTests {
    static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
    static void Main(string[] args) {
        // Exercise real registry behavior under a unique disposable test key,
        // never the user's actual Windows Run key or startup preference.
        string keyPath = @"Software\Even-Pilot\Tests\" + Guid.NewGuid().ToString("N");
        try {
            var startup = new StartupRegistration(@"C:\My Apps\Even-Pilot.exe", keyPath);
            Assert(!startup.IsEnabled(), "Initially disabled");
            startup.SetEnabled(true); startup.SetEnabled(true);
            Assert(startup.IsEnabled(), "Enable must persist and be repeatable");
            using (var key = Registry.CurrentUser.OpenSubKey(keyPath, true)) {
                Assert((string)key.GetValue(StartupRegistration.ValueName) == "\"C:\\My Apps\\Even-Pilot.exe\" --autostart", "Spaces must be quoted and login must be quiet");
                key.SetValue("Other app", "Leave unchanged");
            }
            Assert(!new StartupRegistration(@"C:\Other\Even-Pilot.exe", keyPath).IsEnabled(), "A stale executable path must not appear enabled");
            startup.SetEnabled(false); startup.SetEnabled(false);
            Assert(!startup.IsEnabled(), "Disable must persist and be repeatable");
            using (var key = Registry.CurrentUser.OpenSubKey(keyPath)) Assert((string)key.GetValue("Other app") == "Leave unchanged", "Unrelated values must survive");
        } finally { Registry.CurrentUser.DeleteSubKeyTree(keyPath, false); }

        var assembly = Assembly.LoadFrom(Path.GetFullPath(args[0]));
        foreach (int size in new [] { 16, 20, 24, 32, 40, 48, 64 }) {
            using (var stream = assembly.GetManifestResourceStream("Even-Pilot.ico"))
            using (var icon = new Icon(stream, size, size))
            using (var bitmap = icon.ToBitmap()) {
                Assert(icon.Width == size && icon.Height == size, "Missing tray icon size " + size);
                int minX = size, minY = size, maxX = -1, maxY = -1;
                for (int y = 0; y < size; y++) for (int x = 0; x < size; x++) {
                    Color pixel = bitmap.GetPixel(x, y);
                    Assert(pixel.A == 255 && pixel.R == pixel.G && pixel.G == pixel.B
                        && (pixel.R == 0 || pixel.R == 255), "Icon must have opaque, crisp black/white pixels");
                    if (pixel.R == 255) {
                        minX = Math.Min(minX, x); minY = Math.Min(minY, y);
                        maxX = Math.Max(maxX, x); maxY = Math.Max(maxY, y);
                    }
                }
                Assert(maxX >= minX && maxY >= minY, "Arrow missing");
                Assert(minX >= size / 8 && minY >= size / 8, "Missing black padding");
                Assert(minX == size - maxX - 1 && minY == size - maxY - 1, "Uneven black padding");
                Assert(bitmap.GetPixel(maxX, minY).R == 255, "Arrow tip missing");
            }
        }
        using (var icon = Icon.ExtractAssociatedIcon(Path.GetFullPath(args[0]))) Assert(icon != null, "EXE has no shell icon");
        Console.WriteLine("PASS: startup enable/disable, quoted path, quiet login, stale path, unrelated registry values, embedded 16-64 px icons, EXE shell icon.");
    }
}
