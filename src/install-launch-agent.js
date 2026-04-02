import {
  LAUNCH_AGENT_LABEL,
  launchctlBootstrap,
  launchctlBootout,
  launchctlKickstart,
  writeLaunchAgentPlist,
} from "./launch-agent.js";

async function main() {
  const paths = await writeLaunchAgentPlist();

  await launchctlBootout(LAUNCH_AGENT_LABEL);
  await launchctlBootstrap(paths.plistPath);
  await launchctlKickstart(LAUNCH_AGENT_LABEL);

  console.log(`installed: ${paths.plistPath}`);
  console.log(`stdout: ${paths.stdoutPath}`);
  console.log(`stderr: ${paths.stderrPath}`);
  console.log(`status: launchctl print gui/${process.getuid()}/${LAUNCH_AGENT_LABEL}`);
}

await main();
