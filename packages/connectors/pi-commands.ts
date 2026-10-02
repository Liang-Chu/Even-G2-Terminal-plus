import { slashCommand, unsupportedCommand } from "./slash-commands.js";
import type { InteractionBroker } from "./interactions.js";

interface Model { provider: string; id: string; name?: string }
export interface PiCommandContext {
  isIdle(): boolean;
  compact?(options: { customInstructions?: string; onComplete: () => void; onError: (error: Error) => void }): void;
  modelRegistry?: { getAvailable(): Model[] };
}
export async function piCommand(text: string, context: PiCommandContext, api: { setModel?(model: Model): Promise<boolean> },
  broker: InteractionBroker, status: (text: string) => void, stillCurrent: () => boolean): Promise<boolean> {
  const command = slashCommand(text); if (!command) return false;
  if (command.name === "compact") {
    if (!context.compact) throw new Error("Update Pi to use remote /compact");
    status("Compacting context…");
    try {
      context.compact({ customInstructions: command.args || undefined,
        onComplete: () => { if (stillCurrent()) status("Context compacted."); },
        onError: () => { if (stillCurrent()) status("Compaction failed. Check Terminal."); },
      });
    } catch (error) { status("Compaction failed. Check Terminal."); throw error; }
    return true;
  }
  if (command.name === "model") {
    if (!context.modelRegistry || !api.setModel) throw new Error("Update Pi to choose models remotely");
    const models = context.modelRegistry.getAvailable();
    const set = async (model: Model) => {
      if (!stillCurrent() || !context.isIdle()) throw new Error("Session changed or is busy. Open /model again.");
      if (!await api.setModel!(model)) throw new Error("This model is not available with Pi's current credentials");
      status(`Model: ${model.provider}/${model.id}`);
    };
    if (command.args) {
      const model = models.find(m => `${m.provider}/${m.id}` === command.args);
      if (!model) throw new Error("Model not found. Send /model to choose an available model.");
      await set(model);
    } else {
      if (!models.length) throw new Error("No authenticated models available in Pi");
      broker.remove("model");
      broker.add("model", { kind: "menu", title: "Choose Pi model", cancelable: true,
        questions: [{ id: "model", text: "Available models", options: models.map((m, i) => ({ id: String(i), label: `${m.provider}/${m.id}` })) }],
      }, async answer => { if (!answer.cancel) await set(models[Number(answer.answers.model)]); });
      status("Choose a model below.");
    }
    return true;
  }
  return unsupportedCommand(command.name);
}
