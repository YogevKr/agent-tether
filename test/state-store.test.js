import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state-store.js";

const TEST_REPOS_ROOT = "/workspace/repos";
const TEST_PROJECTS_ROOT = "/workspace/projects";

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

test("When pulling queued jobs, then busy sessions are skipped until they become idle", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-store-"));
  const store = new StateStore(path.join(tempDir, "state.json"));

  await store.saveSession({
    id: "session-4",
    label: "Queued",
    threadId: "thread-4",
    cwd: "/repo",
    hostId: "mbp",
    isBusy: true,
    activeRunSource: "local-cli",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
  });

  await store.createJob({
    id: "job-1",
    sessionId: "session-4",
    hostId: "mbp",
    prompt: "queued prompt",
    status: "queued",
    createdAt: "2026-04-02T10:01:00.000Z",
    updatedAt: "2026-04-02T10:01:00.000Z",
  });

  const skipped = await store.pullQueuedJob("mbp", {
    now: "2026-04-02T10:02:00.000Z",
  });

  assert.equal(skipped, null);

  await store.updateSession("session-4", {
    isBusy: false,
    activeRunSource: "",
    updatedAt: "2026-04-02T10:03:00.000Z",
  });

  const claimed = await store.pullQueuedJob("mbp", {
    now: "2026-04-02T10:04:00.000Z",
  });
  const session = await store.getSession("session-4");

  assert.equal(claimed?.id, "job-1");
  assert.equal(claimed?.status, "running");
  assert.equal(session?.isBusy, true);
  assert.equal(session?.activeRunSource, "telegram");
});

test("When hosts heartbeat, then the newest hosts are listed with their browse roots", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-store-"));
  const store = new StateStore(path.join(tempDir, "state.json"));

  await store.upsertHost("mbp", {
    label: "MacBook",
    roots: [TEST_REPOS_ROOT, TEST_PROJECTS_ROOT],
    lastSeenAt: "2026-04-02T10:00:00.000Z",
  });
  await store.upsertHost("mini", {
    label: "Mac mini",
    roots: [TEST_REPOS_ROOT],
    lastSeenAt: "2026-04-02T11:00:00.000Z",
  });

  const hosts = await store.listHosts();

  assert.equal(hosts[0]?.id, "mini");
  assert.deepEqual(hosts[0]?.roots, [TEST_REPOS_ROOT]);
  assert.equal(hosts[1]?.id, "mbp");
});
