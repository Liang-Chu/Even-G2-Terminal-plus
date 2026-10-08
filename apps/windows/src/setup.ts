import { ensureLocalConfig } from "./config.js";
import { prepareMonitorExtensions } from "./install-extension.js";

if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Terminal+ requires Node.js 22 or newer.");
ensureLocalConfig();
prepareMonitorExtensions();
console.log("Terminal+ local configuration is ready.");
