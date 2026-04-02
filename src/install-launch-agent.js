import {
  getLaunchAgentModeConfig,
  launchctlBootstrap,
  launchctlBootout,
  launchctlKickstart,
  writeLaunchAgentPlist,
} from "./launch-agent.js";

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const config = getLaunchAgentModeConfig(mode);
  const paths = await writeLaunchAgentPlist({ mode });

  await launchctlBootout(config.label);
  await launchctlBootstrap(paths.plistPath);
  await launchctlKickstart(config.label);

  console.log(`installed: ${paths.plistPath}`);
  console.log(`stdout: ${paths.stdoutPath}`);
  console.log(`stderr: ${paths.stderrPath}`);
  console.log(`status: launchctl print gui/${process.getuid()}/${config.label}`);
}

function parseMode(argv) {
  const index = argv.indexOf("--mode");

  if (index === -1) {
    return "hub";
  }

  return argv[index + 1] || "hub";
}

await main();
