import {
  buildLaunchctlServiceTarget,
  getLaunchAgentModeConfig,
  launchctlBootstrap,
  launchctlBootout,
  launchctlKickstart,
  launchctlPrint,
  writeLaunchAgentPlist,
} from "./launch-agent.js";

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const config = getLaunchAgentModeConfig(mode);
  const paths = await writeLaunchAgentPlist({ mode });
  const target = buildLaunchctlServiceTarget(config.label);

  await launchctlBootout(config.label);
  await bootstrapWithRetry(paths.plistPath, config.label);
  await launchctlKickstart(config.label);
  const status = await launchctlPrint(config.label);

  console.log(`installed: ${paths.plistPath}`);
  console.log(`stdout: ${paths.stdoutPath}`);
  console.log(`stderr: ${paths.stderrPath}`);
  console.log(`status: launchctl print ${target}`);
  console.log(`active: ${summarizeLaunchctlStatus(status.stdout)}`);
}

function parseMode(argv) {
  const index = argv.indexOf("--mode");

  if (index === -1) {
    return "hub";
  }

  return argv[index + 1] || "hub";
}

async function bootstrapWithRetry(plistPath, label) {
  try {
    await launchctlBootstrap(plistPath);
    return;
  } catch (error) {
    if (!isRetryableBootstrapError(error)) {
      throw error;
    }
  }

  await launchctlBootout(label);
  await delay(250);
  await launchctlBootstrap(plistPath);
}

function isRetryableBootstrapError(error) {
  const output = `${error.stdout || ""}\n${error.stderr || ""}\n${error.message || ""}`;
  return output.includes("Bootstrap failed: 5") || output.includes("already loaded");
}

function summarizeLaunchctlStatus(stdout) {
  const pathLine = findLaunchctlValue(stdout, "path");
  const programLine = findLaunchctlValue(stdout, "program");

  return [
    pathLine ? `plist=${pathLine}` : "",
    programLine ? `program=${programLine}` : "loaded",
  ].filter(Boolean).join(" ");
}

function findLaunchctlValue(stdout, key) {
  const match = String(stdout || "").match(new RegExp(`\\b${key} = ([^\\n]+)`));
  return match?.[1]?.trim() || "";
}

async function delay(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

await main();
