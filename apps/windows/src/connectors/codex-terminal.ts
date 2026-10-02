import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { AgentRpc } from "../../../../packages/connectors/rpc.js";
import { ConnectorMonitor } from "../../../../packages/connectors/monitor.js";
import { CodexEvents } from "../../../../packages/connectors/codex-events.js";
import { connectorKey } from "../../../../packages/connectors/identity.js";
import { resolveAgent } from "../../../../packages/connectors/command.js";
import { readCodexHistory } from "../../../../packages/connectors/catalog.js";
import { codexTerminalLink } from "../../../../packages/connectors/codex-terminal-link.js";
import { codexInteraction } from "../../../../packages/connectors/codex-interactions.js";
import { codexInput } from "../../../../packages/connectors/slash-commands.js";

async function freePort() {
  const server = createServer();
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(done => server.close(() => done())); return port;
}
export async function codexTerminal(options: { data: string; cwd: string; id?: string; launchId?: string; name?: string;
  verify?: (rpc: AgentRpc, monitor: ConnectorMonitor) => Promise<void> }) {
  const command = resolveAgent("codex"), token = randomBytes(32).toString("base64url");
  const directory = join(options.data, "connector-runtime"); await mkdir(directory, { recursive: true });
  const tokenFile = join(directory, process.pid + ".token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const url = "ws://127.0.0.1:" + await freePort();
  const server = spawn(command.command, [...command.args, "app-server", "--listen", url, "--ws-auth", "capability-token", "--ws-token-file", tokenFile],
    { cwd: options.cwd, stdio: ["ignore", "ignore", "ignore"], windowsHide: true, shell: false });
  let failed = false; server.on("error", () => { failed = true; });
  let socket: WebSocket | undefined, rpc: AgentRpc | undefined, monitor: ConnectorMonitor | undefined;
  let childPoll: NodeJS.Timeout | undefined, pollingChildren = false;
  let link: Awaited<ReturnType<typeof codexTerminalLink>> | undefined;
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (failed || server.exitCode !== null) throw new Error("Codex App Server could not start");
      socket = await new Promise<WebSocket | undefined>(done => {
        const candidate = new WebSocket(url, { headers: { Authorization: "Bearer " + token }, handshakeTimeout: 500 });
        candidate.once("open", () => done(candidate));
        candidate.once("error", () => { candidate.terminate(); done(undefined); });
      });
      if (socket) break; await delay(200);
    }
    if (!socket) throw new Error("Codex App Server did not become ready");
    const connection = socket;
    rpc = new AgentRpc(message => connection.send(message), () => connection.close());
    connection.on("message", data => rpc!.receive(data.toString())); connection.on("close", () => rpc!.disconnect());
    await rpc.initialize();
    const result = options.verify ? await rpc.request("thread/start", { cwd: options.cwd }) : undefined;
    let id = (result?.thread.id || options.id) as string | undefined;
    let terminalPid: number | undefined;
    let events: CodexEvents;
    const attach = (result: any) => {
      id = result.thread.id;
      monitor = new ConnectorMonitor(join(options.data, "native"), {
        key: connectorKey("codex", id!), id, cwd: result.thread.cwd || options.cwd,
        name: result.thread.name, model: result.model || result.thread.model, tunnel: "codex",
      }, {
        prompt: text => codexInput(text, id!, (method, params) => rpc!.request(method, params)),
        interrupt: async () => {
          if (!events.turnId) throw new Error("No active Codex turn");
          await rpc!.request("turn/interrupt", { threadId: id, turnId: events.turnId });
        },
      });
      events = new CodexEvents(id!, monitor);
      monitor.snapshot.launchId = options.launchId;
      monitor.snapshot.terminalPid = terminalPid; monitor.start();
      if (options.name) void rpc!.request("thread/name/set", { threadId: id, name: options.name }).catch(() => {});
    };
    if (result) attach(result);
    if (options.verify) rpc.on("event", message => events?.receive(message));
    rpc.on("disconnect", () => monitor?.stop());
    childPoll = setInterval(async () => {
      if (pollingChildren || !monitor?.subagents.size || rpc?.closed) return;
      pollingChildren = true;
      try {
        for (const childId of [...monitor.subagents]) {
          const child = (await rpc!.request("thread/read", { threadId: childId, includeTurns: false }, 3000)).thread;
          if (["idle", "systemError"].includes(child.status?.type)) monitor.child(childId, false);
        }
      } catch { /* A missing status is not proof that an agent completed. */ }
      finally { pollingChildren = false; }
    }, 1000);
    try {
      if (!id || !monitor) throw new Error("Waiting for native session");
      const history = await readCodexHistory(rpc, id);
      monitor.store.dispatch({ type: "session.history", transcript: history.messages.map((m, index) => ({ ...m, id: index, at: m.at || 0 })) });
    } catch { /* Paginated histories are fetched through the catalog; live streaming still starts. */ }
    if (options.verify) { monitor!.start(); await options.verify(rpc, monitor!); return; }
    link = await codexTerminalLink(url, token, result => {
      if (!result?.thread?.id) return;
      if (!monitor) attach(result);
      else if (result.thread.id !== id) {
        id = result.thread.id;
        monitor.changeSession({ key: connectorKey("codex", id!), id, cwd: result.thread.cwd || options.cwd,
          name: result.thread.name, model: result.model, tunnel: "codex" });
        events = new CodexEvents(id!, monitor);
      } else monitor.store.dispatch({ type: "session.updated", session: { model: result.model } });
      if (!monitor?.store.state.transcript.length) {
        void readCodexHistory(rpc!, id!).then(history => {
          if (monitor?.store.state.session.id === history.session.id && !monitor.store.state.transcript.length) monitor.store.dispatch({ type: "session.history",
            transcript: history.messages.map((m, index) => ({ ...m, id: index, at: m.at || 0 })) });
        }).catch(() => {});
      }
    }, message => {
      events?.receive(message);
      if (message.method === "serverRequest/resolved" && message.params?.threadId === id)
        monitor?.interactions.remove("codex:" + String(message.params.requestId));
      if (message.method === "turn/completed" && message.params?.threadId === id) monitor?.interactions.clear();
    }, (message, respond) => monitor && id ? codexInteraction(message, id, monitor.interactions, respond) : undefined);
    rpc.on("event", message => {
      if (!monitor || !id) return;
      if (message.method === "serverRequest/resolved" && message.params?.threadId === id)
        monitor.interactions.remove("codex:" + String(message.params.requestId));
      try { codexInteraction(message, id, monitor.interactions, result => rpc!.respond(message.id, result)); } catch {}
    });
    const terminal = spawn(command.command, [...command.args, ...(id ? ["resume", id] : []), "--remote", link.url, "--remote-auth-token-env", "EVEN_PILOT_CODEX_SESSION_TOKEN"],
      { cwd: options.cwd, env: { ...process.env, EVEN_PILOT_CODEX_SESSION_TOKEN: token }, stdio: "inherit", shell: false, windowsHide: false });
    terminalPid = terminal.pid;
    if (monitor) monitor.snapshot.terminalPid = terminalPid;
    await new Promise<void>((done, fail) => { terminal.once("error", fail); terminal.once("exit", code => code ? fail(new Error("Codex terminal exited with code " + code)) : done()); });
  } finally {
    clearInterval(childPoll);
    link?.close();
    monitor?.stop(); rpc?.close(); socket?.close();
    // This server belongs to this visible terminal, never to the tray process.
    if (server.exitCode === null && !server.killed) server.kill();
    await unlink(tokenFile).catch(() => {});
  }
}
