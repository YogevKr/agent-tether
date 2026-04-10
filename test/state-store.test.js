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

test("When sessions are saved without an intermediate-steps flag, then it defaults off and persists when enabled", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-store-"));
  const store = new StateStore(path.join(tempDir, "state.json"));

  await store.saveSession({
    id: "session-steps-1",
    label: "Steps",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
  });

  const initial = await store.getSession("session-steps-1");

  assert.equal(initial?.showIntermediateSteps, false);

  await store.updateSession("session-steps-1", {
    showIntermediateSteps: true,
    updatedAt: "2026-04-02T10:01:00.000Z",
  });

  const updated = await store.getSession("session-steps-1");

  assert.equal(updated?.showIntermediateSteps, true);
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

test("When the primary state file moves, then legacy topic bindings still load and migrate on write", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-store-"));
  const legacyPath = path.join(tempDir, "project", "data", "state.json");
  const primaryPath = path.join(tempDir, "app-state", "state.json");

  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(
    legacyPath,
    JSON.stringify({
      sessions: {
        "session-migrated": {
          id: "session-migrated",
          label: "Deploy",
          threadId: "thread-migrated",
          cwd: "/repo",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
          status: "bound",
          forumChatId: "-1001",
          topicId: 17,
          topicName: "Deploy",
          topicLink: "https://t.me/c/1001/17",
        },
      },
      topicBindings: {},
      jobs: {},
      hosts: {},
    }),
  );

  const store = new StateStore(primaryPath, {
    fallbackReadPaths: [legacyPath],
  });

  const restored = await store.getSessionByTopic("-1001", 17);

  assert.equal(restored?.id, "session-migrated");
  assert.equal(restored?.status, "bound");

  await store.updateSession("session-migrated", {
    latestAssistantMessage: "Still bound after deploy.",
    updatedAt: "2026-04-02T10:05:00.000Z",
  });

  const migrated = JSON.parse(await fs.readFile(primaryPath, "utf8"));

  assert.equal(migrated.sessions["session-migrated"]?.topicId, 17);
  assert.equal(migrated.sessions["session-migrated"]?.latestAssistantMessage, "Still bound after deploy.");
  assert.equal(migrated.topicBindings["-1001:17"], "session-migrated");
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

test("When concurrent writes hit the store, then all updates persist without temp-file races", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-store-"));
  const store = new StateStore(path.join(tempDir, "state.json"));

  await Promise.all([
    store.upsertHost("mbp", {
      label: "MacBook",
      roots: [TEST_REPOS_ROOT],
      lastSeenAt: "2026-04-02T10:00:00.000Z",
    }),
    store.saveSession({
      id: "session-5",
      label: "Concurrent",
      cwd: "/repo",
      createdAt: "2026-04-02T10:00:00.000Z",
      updatedAt: "2026-04-02T10:00:00.000Z",
    }),
    store.createJob({
      id: "job-2",
      sessionId: "session-5",
      hostId: "mbp",
      prompt: "hello",
      status: "queued",
      createdAt: "2026-04-02T10:00:00.000Z",
      updatedAt: "2026-04-02T10:00:00.000Z",
    }),
  ]);

  const [hosts, session, job] = await Promise.all([
    store.listHosts(),
    store.getSession("session-5"),
    store.getJob("job-2"),
  ]);

  assert.equal(hosts[0]?.id, "mbp");
  assert.equal(session?.id, "session-5");
  assert.equal(job?.id, "job-2");
});

test("When listing sessions, then they are sorted by newest updatedAt first", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-store-"));
  const store = new StateStore(path.join(tempDir, "state.json"));

  await store.saveSession({
    id: "session-old",
    label: "Old",
    cwd: "/repo-old",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
  });
  await store.saveSession({
    id: "session-new",
    label: "New",
    cwd: "/repo-new",
    createdAt: "2026-04-02T11:00:00.000Z",
    updatedAt: "2026-04-02T12:00:00.000Z",
  });

  const sessions = await store.listSessions();

  assert.deepEqual(
    sessions.map((session) => session.id),
    ["session-new", "session-old"],
  );
});

test("When stopping a session, then queued jobs are cancelled and the running job gets a cancel request", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-store-"));
  const store = new StateStore(path.join(tempDir, "state.json"));

  await store.saveSession({
    id: "session-stop-1",
    label: "Stop me",
    cwd: "/repo",
    hostId: "mbp",
    isBusy: true,
    activeRunSource: "telegram",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
  });
  await store.createJob({
    id: "job-stop-running",
    sessionId: "session-stop-1",
    hostId: "mbp",
    prompt: "running prompt",
    status: "running",
    createdAt: "2026-04-02T10:01:00.000Z",
    updatedAt: "2026-04-02T10:01:00.000Z",
  });
  await store.createJob({
    id: "job-stop-queued",
    sessionId: "session-stop-1",
    hostId: "mbp",
    prompt: "queued prompt",
    status: "queued",
    createdAt: "2026-04-02T10:02:00.000Z",
    updatedAt: "2026-04-02T10:02:00.000Z",
  });

  const outcome = await store.requestStopForSession("session-stop-1", {
    now: "2026-04-02T10:03:00.000Z",
  });
  const running = await store.getJob("job-stop-running");
  const queued = await store.getJob("job-stop-queued");

  assert.equal(outcome.runningJob?.id, "job-stop-running");
  assert.equal(outcome.cancelledQueuedCount, 1);
  assert.equal(running?.cancelRequestedAt, "2026-04-02T10:03:00.000Z");
  assert.equal(queued?.status, "cancelled");
});

test("When recovering interrupted runs for one host, then running jobs fail and Telegram-run sessions are released", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-store-"));
  const store = new StateStore(path.join(tempDir, "state.json"));

  await store.saveSession({
    id: "session-recover-1",
    label: "Recover me",
    cwd: "/repo",
    hostId: "mbp",
    isBusy: true,
    activeRunSource: "telegram",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
  });
  await store.saveSession({
    id: "session-recover-2",
    label: "Leave me",
    cwd: "/repo",
    hostId: "mini",
    isBusy: true,
    activeRunSource: "telegram",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
  });
  await store.createJob({
    id: "job-recover-1",
    sessionId: "session-recover-1",
    hostId: "mbp",
    prompt: "hello",
    status: "running",
    createdAt: "2026-04-02T10:01:00.000Z",
    updatedAt: "2026-04-02T10:01:00.000Z",
  });
  await store.createJob({
    id: "job-recover-2",
    sessionId: "session-recover-2",
    hostId: "mini",
    prompt: "still running",
    status: "running",
    createdAt: "2026-04-02T10:02:00.000Z",
    updatedAt: "2026-04-02T10:02:00.000Z",
  });

  const recovery = await store.recoverInterruptedRuns({
    hostId: "mbp",
    now: "2026-04-02T10:03:00.000Z",
    errorMessage: "Interrupted by restart.",
  });
  const recoveredSession = await store.getSession("session-recover-1");
  const untouchedSession = await store.getSession("session-recover-2");
  const recoveredJob = await store.getJob("job-recover-1");
  const untouchedJob = await store.getJob("job-recover-2");

  assert.deepEqual(recovery.recoveredJobIds, ["job-recover-1"]);
  assert.deepEqual(recovery.recoveredSessionIds, ["session-recover-1"]);
  assert.equal(recoveredSession?.isBusy, false);
  assert.equal(recoveredSession?.activeRunSource, "");
  assert.equal(recoveredJob?.status, "failed");
  assert.equal(recoveredJob?.error, "Interrupted by restart.");
  assert.equal(untouchedSession?.isBusy, true);
  assert.equal(untouchedJob?.status, "running");
});

test("When cleaning stale local CLI runs, then old busy flags and stale queued prompts are cleared safely", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-store-"));
  const store = new StateStore(path.join(tempDir, "state.json"));

  await store.saveSession({
    id: "session-cleanup-stale",
    label: "Stale local",
    cwd: "/repo",
    hostId: "mbp",
    isBusy: true,
    activeRunSource: "local-cli",
    createdAt: "2026-04-02T07:00:00.000Z",
    updatedAt: "2026-04-02T08:00:00.000Z",
  });
  await store.saveSession({
    id: "session-cleanup-fresh",
    label: "Fresh local",
    cwd: "/repo",
    hostId: "mbp",
    isBusy: true,
    activeRunSource: "local-cli",
    createdAt: "2026-04-02T09:30:00.000Z",
    updatedAt: "2026-04-02T09:30:00.000Z",
  });
  await store.saveSession({
    id: "session-cleanup-telegram",
    label: "Telegram",
    cwd: "/repo",
    hostId: "mbp",
    isBusy: true,
    activeRunSource: "telegram",
    createdAt: "2026-04-02T07:00:00.000Z",
    updatedAt: "2026-04-02T08:00:00.000Z",
  });
  await store.saveSession({
    id: "session-cleanup-other-host",
    label: "Other host",
    cwd: "/repo",
    hostId: "mini",
    isBusy: true,
    activeRunSource: "local-cli",
    createdAt: "2026-04-02T07:00:00.000Z",
    updatedAt: "2026-04-02T08:00:00.000Z",
  });
  await store.createJob({
    id: "job-cleanup-stale",
    sessionId: "session-cleanup-stale",
    hostId: "mbp",
    prompt: "old queued prompt",
    status: "queued",
    createdAt: "2026-04-02T08:05:00.000Z",
    updatedAt: "2026-04-02T08:05:00.000Z",
  });
  await store.createJob({
    id: "job-cleanup-fresh",
    sessionId: "session-cleanup-stale",
    hostId: "mbp",
    prompt: "fresh queued prompt",
    status: "queued",
    createdAt: "2026-04-02T09:30:00.000Z",
    updatedAt: "2026-04-02T09:30:00.000Z",
  });

  const dryRun = await store.cleanupStaleLocalCliRuns({
    hostId: "mbp",
    olderThanMs: 60 * 60 * 1000,
    now: "2026-04-02T10:00:00.000Z",
    dryRun: true,
  });
  const dryRunSession = await store.getSession("session-cleanup-stale");

  assert.equal(dryRun.dryRun, true);
  assert.deepEqual(dryRun.clearedSessionIds, ["session-cleanup-stale"]);
  assert.deepEqual(dryRun.cancelledJobIds, ["job-cleanup-stale"]);
  assert.equal(dryRunSession?.isBusy, true);

  const cleanup = await store.cleanupStaleLocalCliRuns({
    hostId: "mbp",
    olderThanMs: 60 * 60 * 1000,
    now: "2026-04-02T10:00:00.000Z",
    dryRun: false,
  });
  const staleSession = await store.getSession("session-cleanup-stale");
  const freshSession = await store.getSession("session-cleanup-fresh");
  const telegramSession = await store.getSession("session-cleanup-telegram");
  const otherHostSession = await store.getSession("session-cleanup-other-host");
  const staleJob = await store.getJob("job-cleanup-stale");
  const freshJob = await store.getJob("job-cleanup-fresh");

  assert.equal(cleanup.dryRun, false);
  assert.deepEqual(cleanup.clearedSessionIds, ["session-cleanup-stale"]);
  assert.deepEqual(cleanup.cancelledJobIds, ["job-cleanup-stale"]);
  assert.equal(staleSession?.isBusy, false);
  assert.equal(staleSession?.activeRunSource, "");
  assert.equal(freshSession?.isBusy, true);
  assert.equal(telegramSession?.isBusy, true);
  assert.equal(otherHostSession?.isBusy, true);
  assert.equal(staleJob?.status, "cancelled");
  assert.equal(staleJob?.error, "Cancelled stale queued prompt after local CLI run timed out.");
  assert.equal(freshJob?.status, "queued");
});
