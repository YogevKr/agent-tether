import fs from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "./config.js";
import { drainHookQueue } from "./hook-runtime.js";

const runtimeConfig = getRuntimeConfig();
const logger = createHookWorkerLogger(runtimeConfig);

try {
  await drainHookQueue(runtimeConfig, { logger });
} catch (error) {
  logger.error(error);
}

function createHookWorkerLogger({ stateFile }) {
  const logPath = path.join(path.dirname(stateFile), "hook-worker.log");

  return {
    error(error) {
      const message = error?.stack || error?.message || String(error);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(
        logPath,
        `${new Date().toISOString()} ${message}\n`,
        "utf8",
      );
    },
  };
}
