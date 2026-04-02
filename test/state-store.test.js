import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state-store.js";

test("When binding a session to a topic, then it becomes retrievable by forum topic", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-store-"));
  const store = new StateStore(path.join(tempDir, "state.json"));

  await store.saveSession({
    id: "session-1",
    label: "Auth fix",
    threadId: "thread-1",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
  });

  await store.bindSession("session-1", {
    forumChatId: "-1001",
    topicId: 9,
    topicName: "Auth fix",
    topicLink: "https://t.me/c/1001/9",
  });

  const session = await store.getSessionByTopic("-1001", 9);

  assert.equal(session?.id, "session-1");
  assert.equal(session?.status, "bound");
  assert.equal(session?.topicLink, "https://t.me/c/1001/9");
});

test("When detaching a bound session, then its topic binding is removed", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-store-"));
  const store = new StateStore(path.join(tempDir, "state.json"));

  await store.saveSession({
    id: "session-2",
    label: "Docs",
    threadId: "thread-2",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "bound",
    forumChatId: "-1001",
    topicId: 12,
    topicName: "Docs",
    topicLink: "https://t.me/c/1001/12",
  });

  await store.detachSession("session-2");

  const byTopic = await store.getSessionByTopic("-1001", 12);
  const session = await store.getSession("session-2");

  assert.equal(byTopic, null);
  assert.equal(session?.status, "headless");
  assert.equal(session?.topicId, null);
});

test("When upserting an indexed session, then existing topic binding is preserved", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-store-"));
  const store = new StateStore(path.join(tempDir, "state.json"));

  await store.saveSession({
    id: "session-3",
    label: "Relay",
    threadId: "thread-3",
    cwd: "/repo",
    createdVia: "codex-hook",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "bound",
    forumChatId: "-1001",
    topicId: 25,
    topicName: "Relay",
    topicLink: "https://t.me/c/1001/25",
  });

  await store.upsertSession("session-3", {
    latestAssistantMessage: "Updated from local Codex",
    updatedAt: "2026-04-02T10:05:00.000Z",
  });

  const byTopic = await store.getSessionByTopic("-1001", 25);
  const session = await store.getSession("session-3");

  assert.equal(byTopic?.id, "session-3");
  assert.equal(session?.latestAssistantMessage, "Updated from local Codex");
  assert.equal(session?.status, "bound");
});
