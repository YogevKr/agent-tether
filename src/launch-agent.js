import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PROJECT_ROOT } from "./config.js";

const execFileAsync = promisify(execFile);

export const LAUNCH_AGENT_MODE = {
  hub: {
    label: "dev.agent-tether.hub",
    script: "src/relay.js",
    stdoutLog: "agent-tether-hub.stdout.log",
    stderrLog: "agent-tether-hub.stderr.log",
  },
  worker: {
    label: "dev.agent-tether.worker",
    script: "src/worker.js",
    stdoutLog: "agent-tether-worker.stdout.log",
    stderrLog: "agent-tether-worker.stderr.log",
  },
};

export const LAUNCH_AGENT_LABEL = LAUNCH_AGENT_MODE.hub.label;

export function buildLaunchctlServiceTarget(label = LAUNCH_AGENT_LABEL, uid = process.getuid()) {
  return `gui/${uid}/${label}`;
}

export function getLaunchAgentPaths({
  homeDir = os.homedir(),
  mode = "hub",
} = {}) {
  const config = getLaunchAgentModeConfig(mode);
  const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
  const logsDir = path.join(homeDir, "Library", "Logs");

  return {
    launchAgentsDir,
    logsDir,
    plistPath: path.join(launchAgentsDir, `${config.label}.plist`),
    stdoutPath: path.join(logsDir, config.stdoutLog),
    stderrPath: path.join(logsDir, config.stderrLog),
  };
}

export function buildLaunchAgentPlist({
  mode = "hub",
  label = getLaunchAgentModeConfig(mode).label,
  launcherBin = "/usr/bin/env",
  nodeBin = "node",
  projectRoot = PROJECT_ROOT,
  homeDir = os.homedir(),
  pathEnv = buildDefaultLaunchAgentPath(homeDir),
  stdoutPath = getLaunchAgentPaths({ mode }).stdoutPath,
  stderrPath = getLaunchAgentPaths({ mode }).stderrPath,
} = {}) {
  const config = getLaunchAgentModeConfig(mode);

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${escapeXml(label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${escapeXml(launcherBin)}</string>`,
    `    <string>${escapeXml(nodeBin)}</string>`,
    `    <string>${escapeXml(path.join(projectRoot, config.script))}</string>`,
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${escapeXml(projectRoot)}</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>PATH</key>`,
    `    <string>${escapeXml(pathEnv)}</string>`,
    `  </dict>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${escapeXml(stdoutPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXml(stderrPath)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

export function buildDefaultLaunchAgentPath(homeDir = os.homedir()) {
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(homeDir, ".local", "bin"),
    path.join(homeDir, ".npm-global", "bin"),
    path.join(homeDir, "bin"),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
}

export async function writeLaunchAgentPlist(options = {}) {
  const paths = getLaunchAgentPaths({ mode: options.mode });

  await fs.mkdir(paths.launchAgentsDir, { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.writeFile(paths.plistPath, buildLaunchAgentPlist(options));

  return paths;
}

export async function launchctlBootout(label = LAUNCH_AGENT_LABEL) {
  try {
    await execFileAsync("launchctl", ["bootout", buildLaunchctlServiceTarget(label)]);
  } catch (error) {
    const output = `${error.stdout || ""}\n${error.stderr || ""}\n${error.message || ""}`;

    if (
      !output.includes("Could not find service") &&
      !output.includes("No such process") &&
      !output.includes("Boot-out failed: 5")
    ) {
      throw error;
    }
  }
}

export async function launchctlBootstrap(plistPath) {
  await execFileAsync("launchctl", ["bootstrap", launchDomain(), plistPath]);
}

export async function launchctlPrint(label = LAUNCH_AGENT_LABEL) {
  return execFileAsync("launchctl", ["print", buildLaunchctlServiceTarget(label)]);
}

export async function launchctlKickstart(label = LAUNCH_AGENT_LABEL) {
  await execFileAsync("launchctl", ["kickstart", "-k", buildLaunchctlServiceTarget(label)]);
}

export async function launchctlRemove(label = LAUNCH_AGENT_LABEL) {
  await launchctlBootout(label);
}

function launchDomain() {
  return `gui/${process.getuid()}`;
}

export function getLaunchAgentModeConfig(mode = "hub") {
  const config = LAUNCH_AGENT_MODE[mode];

  if (!config) {
    throw new Error(`Unknown launch agent mode: ${mode}`);
  }

  return config;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
