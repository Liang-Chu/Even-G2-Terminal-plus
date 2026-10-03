using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

// Isolated process fixture: no browser, terminal, monitor or user configuration.
class TrayRestartFixture {
    static void Main(string[] args) {
        if (args.Length == 0) { Thread.Sleep(60000); return; }
        int port = Int32.Parse(args[0]), trayPid = Int32.Parse(args[1]);
        string trace = args[2], mode = args.Length > 3 ? args[3] : "hang";
        var listener = new TcpListener(IPAddress.Loopback, port); listener.Start();
        File.WriteAllText(trace + ".ready", "ready");
        using (var stalled = new TcpClient()) {
            // A transport left open while shutdown removes the listener models
            // the old server.close/IPC-lock migration failure.
            stalled.Connect(IPAddress.Loopback, port);
            var held = listener.AcceptTcpClient();
            for (int n = 0; n < 2; n++) using (var client = listener.AcceptTcpClient()) using (var stream = client.GetStream()) {
                client.ReceiveTimeout = 5000;
                var request = new StringBuilder(); var buffer = new byte[4096];
                while (!request.ToString().Contains("\r\n\r\n")) { int read = stream.Read(buffer, 0, buffer.Length); if (read == 0) return; request.Append(Encoding.UTF8.GetString(buffer, 0, read)); }
                string text = request.ToString(), body;
                bool trayAlive;
                try { using (var tray = Process.GetProcessById(trayPid)) trayAlive = !tray.HasExited; } catch { trayAlive = false; }
                if (trayAlive) { File.AppendAllText(trace, "tray-was-alive\n"); return; }
                if (!text.Contains("Authorization: Bearer isolated-update-test-key")) { File.AppendAllText(trace, "wrong-authorization\n"); return; }
                if (n == 0) {
                    if (!text.StartsWith("GET /api/monitoring ")) return;
                    File.AppendAllText(trace, "probe\n");
                    body = "{\"nativeTerminals\":" + (mode == "unsafe" ? "false" : "true") + "}";
                } else {
                    if (!text.StartsWith("POST /api/shutdown ")) return;
                    File.AppendAllText(trace, "shutdown\n"); body = "{\"ok\":" + (mode == "falseack" ? "false" : "true") + "}";
                }
                string status = mode == "noack" && n == 1 ? "500 Refused" : "200 OK";
                byte[] response = Encoding.UTF8.GetBytes("HTTP/1.1 " + status + "\r\nContent-Type: application/json\r\nContent-Length: " + Encoding.UTF8.GetByteCount(body) + "\r\nConnection: close\r\n\r\n" + body);
                stream.Write(response, 0, response.Length);
            }
            listener.Stop();
            File.AppendAllText(trace, "listener-closed\n");
            Thread.Sleep(60000);
            held.Dispose();
        }
    }
}
