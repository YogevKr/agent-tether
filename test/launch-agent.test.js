import test from "node:test";
import assert from "node:assert/strict";
import { buildLaunchAgentPlist, LAUNCH_AGENT_LABEL } from "../src/launch-agent.js";

test("When generating the launch agent plist, then it starts the relay at login and keeps it alive", () => {
  const plist = buildLaunchAgentPlist({
    nodeBin: "/opt/homebrew/bin/node",
    projectRoot: "/Users/yogev/projects/agent-tether",
    stdoutPath: "/Users/yogev/Library/Logs/agent-tether.stdout.log",
    stderrPath: "/Users/yogev/Library/Logs/agent-tether.stderr.log",
  });

  assert.match(plist, new RegExp(`<string>${LAUNCH_AGENT_LABEL}</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/Users\/yogev\/projects\/agent-tether\/src\/relay.js<\/string>/);
});
