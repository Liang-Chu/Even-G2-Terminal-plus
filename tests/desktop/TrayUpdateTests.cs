using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

class TrayUpdateTests {
    class Captured { internal string path, method, body, authorization; }
    class Monitor : HttpMessageHandler {
        internal readonly List<Captured> requests = new List<Captured>();
        internal HttpStatusCode status = HttpStatusCode.Accepted;
        internal string response = "{\"automaticChecks\":true,\"available\":{\"version\":\"1.1.1\"},\"phase\":\"downloading\",\"progress\":47,\"installSupported\":true,\"error\":null}";
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
            requests.Add(new Captured { path = request.RequestUri.AbsolutePath, method = request.Method.Method,
                body = request.Content == null ? "" : await request.Content.ReadAsStringAsync(),
                authorization = request.Headers.Authorization == null ? "" : request.Headers.Authorization.ToString() });
            return new HttpResponseMessage(status) { Content = new StringContent(response) };
        }
    }
    static void Expect(bool value, string reason) { if (!value) throw new Exception(reason); }
    static async Task Run() {
        var json = new JavaScriptSerializer();
        using (var monitor = new Monitor())
        using (var http = new HttpClient(monitor)) {
            http.BaseAddress = new Uri("http://127.0.0.1:4317");
            http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", "isolated-test-control");
            var state = await TrayUpdateActions.Perform(http, json, "1.1.1", true);
            Expect(monitor.requests.Count == 1 && monitor.requests[0].path == "/api/updates/install" && monitor.requests[0].method == "POST", "Available version click must send one install request directly");
            Expect(monitor.requests[0].authorization == "Bearer isolated-test-control", "Tray update uses its existing control authentication");
            Expect(Convert.ToString(json.Deserialize<Dictionary<string, object>>(monitor.requests[0].body)["version"]) == "1.1.1", "Install sends the exact checked version");
            Expect(TrayUpdateActions.Working(Convert.ToString(state["phase"])) && TrayUpdateActions.Label(Convert.ToString(state["phase"]), Convert.ToInt32(state["progress"]), "1.1.1", true) == "Downloading update: 47%", "Installer response provides tray progress without opening management UI");
            await TrayUpdateActions.Perform(http, json, null, true);
            Expect(monitor.requests[1].path == "/api/updates/check" && monitor.requests[1].body == "{}", "Check action calls the backend immediately without installation");
            await TrayUpdateActions.Perform(http, json, "1.1.1", false);
            Expect(monitor.requests[2].path == "/api/updates/check", "Source checkout cannot invoke the installer");
            monitor.status = HttpStatusCode.Conflict; monitor.response = "{\"error\":\"The checked release changed. Check updates again.\"}";
            try { await TrayUpdateActions.Perform(http, json, "1.1.1", true); throw new Exception("A rejected install must report failure"); }
            catch (InvalidOperationException error) { Expect(TrayUpdateActions.Error(error) == "The checked release changed. Check updates again.", "Backend error can be shown in the tray without another browser click"); }
            monitor.response = "invalid private response body";
            try { await TrayUpdateActions.Perform(http, json, null, true); throw new Exception("Invalid metadata must be rejected"); }
            catch (InvalidOperationException error) { Expect(!TrayUpdateActions.Error(error).Contains("private response"), "Invalid transport response must not be echoed"); }
            Expect(TrayUpdateActions.Label("installing", 100, "1.1.1", true) == "Installing update…", "Installing remains distinct from download progress");
            Expect(!TrayUpdateActions.StartAllowed("installing", false, false), "An expected update disconnect cannot restart the old backend");
            Expect(!TrayUpdateActions.StartAllowed("idle", true, false), "The installer lock blocks startup before update information has loaded");
            Expect(TrayUpdateActions.StartAllowed("idle", false, false), "Ordinary reconnect can still start monitoring");
            Expect(TrayUpdateActions.StartAllowed("downloading", false, false), "An interrupted download does not permanently disable monitor recovery");
            Expect(TrayUpdateActions.StartAllowed("installing", true, true), "Only the replacement tray's initial startup can perform the installer's health check");
        }
    }
    static int Main() {
        try { Run().GetAwaiter().GetResult(); Console.WriteLine("PASS: Direct authenticated tray check/install, exact checked version, download/install status, source-checkout guard and tray errors."); return 0; }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
