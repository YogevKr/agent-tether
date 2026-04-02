import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyHookEvent, stopHookResponse } from "../src/hook-index.js";
import { StateStore } from "../src/state-store.js";

const TEST_WORKSPACE = "/workspace/agent-tether";

test("When SessionStart fires, then the local Codex session is indexed as headless", async () => {
  const store = await createTempStore();

  await applyHookEvent(
    store,
    {
      hook_event_name: "SessionStart",
      session_id: "session-1",
      cwd: TEST_WORKSPACE,
      model: "gpt-5.4",
      source: "startup",
      host_id: "mbp",
    },
    {
      now: () => "2026-04-02T12:00:00.000Z",
    },
  );

  const session = await store.getSession("session-1");

  assert.equal(session?.id, "session-1");
  assert.equal(session?.threadId, "session-1");
  assert.equal(session?.label, "agent-tether");
  assert.equal(session?.status, "headless");
  assert.equal(session?.lastStartSource, "startup");
  assert.equal(session?.hostId, "mbp");
});

test("When Stop fires, then the latest assistant reply is saved without clearing bindings", async () => {
  const store = await createTempStore();

  await store.saveSession({
    id: "session-2",
    label: "agent-tether",
    threadId: "session-2",
    cwd: "/repo",
    createdVia: "codex-hook",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "bound",
    isBusy: true,
    activeRunSource: "local-cli",
    forumChatId: "-1001",
    topicId: 12,
    topicName: "relay",
    topicLink: "https://t.me/c/1001/12",
  });

  await applyHookEvent(
    store,
    {
      hook_event_name: "Stop",
      session_id: "session-2",
      cwd: "/repo",
      last_assistant_message: "Done locally.",
    },
    {
      now: () => "2026-04-02T12:00:00.000Z",
    },
  );

  const session = await store.getSession("session-2");

  assert.equal(session?.latestAssistantMessage, "Done locally.");
  assert.equal(session?.status, "bound");
  assert.equal(session?.isBusy, false);
  assert.equal(session?.activeRunSource, "");
  assert.equal(stopHookResponse().continue, true);
});

test("When UserPromptSubmit fires, then the session is marked busy until Stop", async () => {
  const store = await createTempStore();

  await applyHookEvent(
    store,
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-3",
      cwd: "/repo",
      prompt: "continue from laptop",
      host_id: "mbp",
    },
    {
      now: () => "2026-04-02T12:00:00.000Z",
    },
  );

  const session = await store.getSession("session-3");

  assert.equal(session?.latestUserPrompt, "continue from laptop");
  assert.equal(session?.isBusy, true);
  assert.equal(session?.activeRunSource, "local-cli");
});

async function createTempStore() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-hook-"));
  return new StateStore(path.join(tempDir, "state.json"));
}
