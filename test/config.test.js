import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PROJECT_ROOT, getStateFile, getStateStoreConfig } from "../src/config.js";

test("When STATE_FILE is unset, then state defaults outside the repo and keeps the legacy repo path as a fallback", () => {
  const previousStateFile = process.env.STATE_FILE;

  try {
    delete process.env.STATE_FILE;

    const config = getStateStoreConfig();
    const legacyPath = path.resolve(PROJECT_ROOT, "./data/state.json");

    assert.equal(getStateFile(), config.filePath);
    assert.notEqual(config.filePath, legacyPath);
    assert.deepEqual(config.fallbackReadPaths, [legacyPath]);
  } finally {
    restoreEnv("STATE_FILE", previousStateFile);
  }
});

test("When STATE_FILE is set, then the configured path is used without legacy fallbacks", () => {
  const previousStateFile = process.env.STATE_FILE;

  try {
    process.env.STATE_FILE = "~/custom-agent-tether/state.json";

    const config = getStateStoreConfig();

    assert.match(config.filePath, /custom-agent-tether[\/\\]state\.json$/);
    assert.deepEqual(config.fallbackReadPaths, []);
  } finally {
    restoreEnv("STATE_FILE", previousStateFile);
  }
});

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
