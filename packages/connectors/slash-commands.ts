export function slashCommand(text: string): { name: string; args: string } | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { name: match[1].toLowerCase(), args: (match[2] || "").trim() } : undefined;
}
export function unsupportedCommand(name: string): never {
  throw new Error(`/${name} is not available remotely for this CLI. Run it in Terminal; it was not sent as a prompt.`);
}

export async function codexInput(text: string, threadId: string, request: (method: string, params: unknown) => Promise<unknown>) {
  const command = slashCommand(text);
  if (command) {
    if (command.name !== "compact") unsupportedCommand(command.name);
    if (command.args) throw new Error("Codex /compact does not accept extra instructions");
    await request("thread/compact/start", { threadId });
  } else await request("turn/start", { threadId, input: [{ type: "text", text }] });
}
