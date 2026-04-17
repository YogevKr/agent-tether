import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  buildHookPayload,
  drainHookQueue,
  enqueueHookEvent,
  runProviderHook,
} from "../src/hook-runtime.js";

test("When building a hook payload, then host and provider are normalized by caller", () => {
  assert.deepEqual(
    buildHookPayload(
      {
        hook_event_name: "SessionStart",
        session_id: "session-1",
      },
      {
        provider: "claude",
        hostId: "mini",
      },
    ),
    {
      hook_event_name: "SessionStart",
      session_id: "session-1",
      host_id: "mini",
      provider: "claude",
    },
  );
});

test("When draining the hook queue, then queued events are processed in write order", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hook-queue-"));
  const runtimeConfig = buildRuntimeConfig(tempDir);
  const processed = [];

  await enqueueHookEvent(runtimeConfig, {
    hook_event_name: "UserPromptSubmit",
    session_id: "session-1",
  });
  await enqueueHookEvent(runtimeConfig, {
    hook_event_name: "Stop",
    session_id: "session-1",
  });

  const drained = await drainHookQueue(runtimeConfig, {
    dispatch: async (_config, payload) => {
      processed.push(payload.hook_event_name);
    },
  });
  const remaining = await fs.readdir(runtimeConfig.hookQueueDir);

  assert.equal(drained, true);
  assert.deepEqual(processed, ["UserPromptSubmit", "Stop"]);
  assert.deepEqual(remaining, []);
});

test("When async provider hook runs, then it queues work and writes Stop response without dispatching inline", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hook-run-"));
  const runtimeConfig = buildRuntimeConfig(tempDir);
  const stdout = captureWritable();
  const stderr = captureWritable();
  let spawned = false;

  await runProviderHook("codex", runtimeConfig, {
    stdin: Readable.from([
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: "session-1",
      }),
    ]),
    stdout,
    stderr,
    spawnWorker: () => {
      spawned = true;
    },
  });

  const queuedFiles = await fs.readdir(runtimeConfig.hookQueueDir);

  assert.equal(spawned, true);
  assert.equal(stdout.content, "{\"continue\":true}\n");
  assert.equal(stderr.content, "");
  assert.equal(queuedFiles.length, 1);
});

function buildRuntimeConfig(tempDir) {
  return {
    hostId: "host-1",
    stateFile: path.join(tempDir, "state.json"),
    stateFallbackReadPaths: [],
    hubUrl: "",
    hubToken: "",
    hookMode: "async",
    hookTimeoutMs: 2000,
    hookQueueDir: path.join(tempDir, "hook-queue"),
  };
}

function captureWritable() {
  const output = new Writable({
    write(chunk, _encoding, callback) {
      output.content += chunk.toString("utf8");
      callback();
    },
  });
  output.content = "";
  return output;
}
