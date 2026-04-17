import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDefaultLaunchAgentPath,
  buildLaunchctlServiceTarget,
  buildLaunchAgentPlist,
  getLaunchAgentPaths,
  LAUNCH_AGENT_MODE,
} from "../src/launch-agent.js";

const TEST_HOME = "/Users/example";
const TEST_PROJECT_ROOT = "/Users/example/projects/agent-tether";

test("When generating the hub launch agent plist, then it starts the relay at login and keeps it alive", () => {
  const plist = buildLaunchAgentPlist({
    mode: "hub",
    homeDir: TEST_HOME,
    nodeBin: "/opt/homebrew/bin/node",
    projectRoot: TEST_PROJECT_ROOT,
    stdoutPath: `${TEST_HOME}/Library/Logs/agent-tether-hub.stdout.log`,
    stderrPath: `${TEST_HOME}/Library/Logs/agent-tether-hub.stderr.log`,
  });

  assert.match(plist, new RegExp(`<string>${LAUNCH_AGENT_MODE.hub.label}</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<string>\/usr\/bin\/env<\/string>/);
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/Users\/example\/projects\/agent-tether\/src\/relay.js<\/string>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>[^<]*\/Users\/example\/\.local\/bin[^<]*<\/string>/);
});

test("When generating the worker launch agent plist, then it starts the worker with separate logs", () => {
  const paths = getLaunchAgentPaths({
    homeDir: TEST_HOME,
    mode: "worker",
  });
  const plist = buildLaunchAgentPlist({
    mode: "worker",
    homeDir: TEST_HOME,
    nodeBin: "/opt/homebrew/bin/node",
    projectRoot: TEST_PROJECT_ROOT,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
  });

  assert.equal(paths.plistPath, "/Users/example/Library/LaunchAgents/dev.agent-tether.worker.plist");
  assert.equal(paths.stdoutPath, "/Users/example/Library/Logs/agent-tether-worker.stdout.log");
  assert.equal(paths.stderrPath, "/Users/example/Library/Logs/agent-tether-worker.stderr.log");
  assert.match(plist, new RegExp(`<string>${LAUNCH_AGENT_MODE.worker.label}</string>`));
  assert.match(plist, /<string>\/usr\/bin\/env<\/string>/);
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/Users\/example\/projects\/agent-tether\/src\/worker.js<\/string>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>[^<]*\/Users\/example\/\.local\/bin[^<]*<\/string>/);
});

test("When building the default launch agent PATH, then user-local CLI installs are discoverable", () => {
  assert.equal(
    buildDefaultLaunchAgentPath(TEST_HOME),
    [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/Users/example/.local/bin",
      "/Users/example/.npm-global/bin",
      "/Users/example/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":"),
  );
});

test("When building a launchctl service target, then it includes the gui domain and label", () => {
  assert.equal(
    buildLaunchctlServiceTarget(LAUNCH_AGENT_MODE.worker.label, 501),
    "gui/501/dev.agent-tether.worker",
  );
});
