import fs from "node:fs/promises";
import {
  getLaunchAgentModeConfig,
  getLaunchAgentPaths,
  launchctlRemove,
} from "./launch-agent.js";

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const config = getLaunchAgentModeConfig(mode);
  const paths = getLaunchAgentPaths({ mode });

  await launchctlRemove(config.label);
  await fs.unlink(paths.plistPath).catch(() => {});

  console.log(`removed: ${paths.plistPath}`);
}

function parseMode(argv) {
  const index = argv.indexOf("--mode");

  if (index === -1) {
    return "hub";
  }

  return argv[index + 1] || "hub";
}

await main();
