import { ensureLocalConfig } from "./config.js";

if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Even-Pilot requires Node.js 22 or newer.");
ensureLocalConfig();
console.log("Even-Pilot local configuration is ready.");
