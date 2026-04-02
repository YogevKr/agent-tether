import fs from "node:fs/promises";
import { getLaunchAgentPaths, LAUNCH_AGENT_LABEL, launchctlRemove } from "./launch-agent.js";

async function main() {
  const paths = getLaunchAgentPaths();

  await launchctlRemove(LAUNCH_AGENT_LABEL);
  await fs.unlink(paths.plistPath).catch(() => {});

  console.log(`removed: ${paths.plistPath}`);
}

await main();
