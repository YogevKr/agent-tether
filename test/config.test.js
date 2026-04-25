import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROJECT_ROOT,
  getHostIdConfig,
  getRuntimeConfig,
  getStateFile,
  getStateStoreConfig,
} from "../src/config.js";

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

test("When RELAY_HOST_ID is unset, then a stable host id is persisted next to STATE_FILE", () => {
  const previousStateFile = process.env.STATE_FILE;
  const previousHostId = process.env.RELAY_HOST_ID;

  try {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-config-"));
    process.env.STATE_FILE = path.join(tempDir, "state.json");
    delete process.env.RELAY_HOST_ID;

    const first = getHostIdConfig();
    const second = getHostIdConfig();
    const persisted = fs.readFileSync(first.filePath, "utf8").trim();

    assert.equal(first.source, "generated");
    assert.equal(second.source, "state-file");
    assert.equal(second.value, first.value);
    assert.equal(persisted, first.value);
  } finally {
    restoreEnv("STATE_FILE", previousStateFile);
    restoreEnv("RELAY_HOST_ID", previousHostId);
  }
});

test("When RELAY_HOST_ID is set, then the explicit value wins without creating a host-id file", () => {
  const previousStateFile = process.env.STATE_FILE;
  const previousHostId = process.env.RELAY_HOST_ID;

  try {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-config-"));
    process.env.STATE_FILE = path.join(tempDir, "state.json");
    process.env.RELAY_HOST_ID = "mini-explicit";

    const config = getHostIdConfig();

    assert.equal(config.value, "mini-explicit");
    assert.equal(config.source, "env");
    assert.equal(fs.existsSync(config.filePath), false);
  } finally {
    restoreEnv("STATE_FILE", previousStateFile);
    restoreEnv("RELAY_HOST_ID", previousHostId);
  }
});

test("When worker idle sleep is configured, then runtime config uses it", () => {
  const previousWorkerIdleSleepMs = process.env.RELAY_WORKER_IDLE_SLEEP_MS;

  try {
    process.env.RELAY_WORKER_IDLE_SLEEP_MS = "9000";

    const config = getRuntimeConfig();

    assert.equal(config.workerIdleSleepMs, 9000);
  } finally {
    restoreEnv("RELAY_WORKER_IDLE_SLEEP_MS", previousWorkerIdleSleepMs);
  }
});

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
