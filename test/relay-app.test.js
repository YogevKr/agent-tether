import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRelayApp } from "../src/relay-app.js";
import { StateStore } from "../src/state-store.js";

const TEST_USER_ID = 123456789;

test("When /sessions is requested in DM, then relay shows create and open actions", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({ store, telegram });

  await store.saveSession({
    id: "headless-1",
    label: "Auth fix",
    threadId: "thread-1",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "headless",
  });
  await store.saveSession({
    id: "bound-1",
    label: "Docs",
    threadId: "thread-2",
    cwd: "/repo",
    createdAt: "2026-04-02T11:00:00.000Z",
    updatedAt: "2026-04-02T11:00:00.000Z",
    status: "bound",
    forumChatId: "-1001",
    topicId: 4,
    topicName: "Docs",
    topicLink: "https://t.me/c/1001/4",
  });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "/sessions",
      chat: { id: TEST_USER_ID, type: "private" },
      from: { id: TEST_USER_ID },
    },
  });

  const sent = telegram.calls.sendMessage.at(-1);
  const buttons = sent.options.reply_markup.inline_keyboard.flat();

  assert.match(sent.text, /Agent sessions/);
  assert.ok(buttons.some((button) => button.callback_data?.startsWith("session:ui:")));
  assert.ok(buttons.some((button) => button.url === "https://t.me/c/1001/4"));
  assert.ok(buttons.some((button) => button.callback_data === "dm:new"));
});

test("When /sessions includes long session ids, then button payloads stay within Telegram limits", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({ store, telegram });

  await store.saveSession({
    id: "deploy-session-2a92a111-31f8-4001-8715-4e9fa02ca830",
    label: "Deploy Smoke",
    threadId: "thread-1",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "headless",
  });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "/sessions",
      chat: { id: TEST_USER_ID, type: "private" },
      from: { id: TEST_USER_ID },
    },
  });

  const sent = telegram.calls.sendMessage.at(-1);
  const callbackButtons = sent.options.reply_markup.inline_keyboard
    .flat()
    .filter((button) => button.callback_data);

  assert.equal(callbackButtons.every((button) => button.callback_data.length <= 64), true);
});

test("When /start is requested in DM, then relay shows the home buttons", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({ store, telegram });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "/start",
      chat: { id: TEST_USER_ID, type: "private" },
      from: { id: TEST_USER_ID },
    },
  });

  const sent = telegram.calls.sendMessage.at(-1);
  const buttons = sent.options.reply_markup.inline_keyboard.flat();

  assert.match(sent.text, /Agent Tether/);
  assert.ok(buttons.some((button) => button.callback_data === "dm:sessions"));
  assert.ok(buttons.some((button) => button.callback_data === "dm:archived"));
  assert.ok(buttons.some((button) => button.callback_data === "dm:status"));
  assert.ok(buttons.some((button) => button.callback_data === "dm:help"));
  assert.ok(buttons.some((button) => button.callback_data === "dm:chatid"));
});

test("When /sessions is requested in the General topic, then relay shows the session management panel there", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({ store, telegram });

  await store.saveSession({
    id: "general-1",
    label: "General control",
    threadId: "thread-general-1",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "headless",
  });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "/sessions",
      chat: { id: -1001, type: "supergroup" },
      from: { id: TEST_USER_ID },
      message_thread_id: 1,
    },
  });

  const sent = telegram.calls.sendMessage.at(-1);
  const buttons = sent.options.reply_markup.inline_keyboard.flat();

  assert.match(sent.text, /Agent sessions/);
  assert.equal(sent.chatId, "-1001");
  assert.equal(sent.options.message_thread_id, undefined);
  assert.ok(buttons.some((button) => button.callback_data === "dm:new"));
});

test("When /new is requested in the General topic, then relay shows node selection there", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({ store, telegram });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "/new",
      chat: { id: -1001, type: "supergroup" },
      from: { id: TEST_USER_ID },
      message_thread_id: 1,
    },
  });

  const sent = telegram.calls.sendMessage.at(-1);

  assert.match(sent.text, /Choose where to start the new agent session/);
  assert.equal(sent.chatId, "-1001");
  assert.equal(sent.options.message_thread_id, undefined);
});

test("When plain text is sent in the General topic, then relay ignores it", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({ store, telegram });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "hello from general",
      chat: { id: -1001, type: "supergroup" },
      from: { id: TEST_USER_ID },
      message_thread_id: 1,
    },
  });

  assert.equal(telegram.calls.sendMessage.length, 0);
  assert.equal(telegram.calls.sendLongMessage.length, 0);
});

test("When the chat id button is tapped in DM, then relay shows the user id as an alert", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({ store, telegram });

  await app.initialize();
  await app.handleUpdate({
    callback_query: {
      id: "cb-chatid",
      data: "dm:chatid",
      from: { id: TEST_USER_ID },
      message: {
        message_id: 7,
        chat: { id: TEST_USER_ID, type: "private" },
      },
    },
  });

  const answer = telegram.calls.answerCallbackQuery.at(-1);

  assert.equal(answer.options.text, `user_id: ${TEST_USER_ID}`);
  assert.equal(answer.options.show_alert, true);
});

test("When starting a new session from DM, then relay lets the user browse folders and bind a fresh topic", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-root-"));
  const repoDir = path.join(rootDir, "sawmills-agent");
  await fs.mkdir(repoDir);
  const realRepoDir = await fs.realpath(repoDir);

  const app = createRelayApp({
    botConfig: {
      authorizedUserIds: new Set([String(TEST_USER_ID)]),
      forumChatId: "-1001",
      pollTimeoutSeconds: 1,
      hostId: "mbp",
    },
    codexConfig: {
      defaultCwd: rootDir,
      startRoots: [rootDir],
      model: "",
      defaultArgs: ["--yolo"],
    },
    telegram,
    store,
    runTurn: async () => {
      throw new Error("should not run during setup");
    },
    now: () => "2026-04-02T12:00:00.000Z",
    logger: {
      log() {},
      error() {},
    },
    sleep: async () => {},
  });

  await app.initialize();
  await app.handleUpdate({
    callback_query: {
      id: "cb-new",
      data: "dm:new",
      from: { id: TEST_USER_ID },
      message: {
        message_id: 3,
        chat: { id: TEST_USER_ID, type: "private" },
      },
    },
  });

  const hostPanel = telegram.calls.editMessage.at(-1);
  const hostButton = hostPanel.options.reply_markup.inline_keyboard[0][0];

  await app.handleUpdate({
    callback_query: {
      id: "cb-host",
      data: hostButton.callback_data,
      from: { id: TEST_USER_ID },
      message: {
        message_id: 3,
        chat: { id: TEST_USER_ID, type: "private" },
      },
    },
  });

  const rootPanel = telegram.calls.editMessage.at(-1);
  const rootButton = rootPanel.options.reply_markup.inline_keyboard[0][0];

  await app.handleUpdate({
    callback_query: {
      id: "cb-root",
      data: rootButton.callback_data,
      from: { id: TEST_USER_ID },
      message: {
        message_id: 3,
        chat: { id: TEST_USER_ID, type: "private" },
      },
    },
  });

  const directoryPanel = telegram.calls.editMessage.at(-1);
  const subdirButton = directoryPanel.options.reply_markup.inline_keyboard[0][0];

  await app.handleUpdate({
    callback_query: {
      id: "cb-subdir",
      data: subdirButton.callback_data,
      from: { id: TEST_USER_ID },
      message: {
        message_id: 3,
        chat: { id: TEST_USER_ID, type: "private" },
      },
    },
  });

  const selectedPanel = telegram.calls.editMessage.at(-1);
  const useButton = selectedPanel.options.reply_markup.inline_keyboard.find((row) =>
    row.some((button) => button.text === "Use This Folder"),
  )[0];

  await app.handleUpdate({
    callback_query: {
      id: "cb-use",
      data: useButton.callback_data,
      from: { id: TEST_USER_ID },
      message: {
        message_id: 3,
        chat: { id: TEST_USER_ID, type: "private" },
      },
    },
  });

  const sessions = await store.listSessions();
  const session = sessions.find((item) => item.cwd === realRepoDir);

  assert.ok(session);
  assert.equal(session?.createdVia, "telegram-ui");
  assert.equal(session?.threadId, "");
  assert.equal(session?.status, "bound");
  assert.equal(session?.topicId, 42);
});

test("When create-topic is tapped, then relay binds the session and refreshes the DM view", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({ store, telegram });

  await store.saveSession({
    id: "session-1",
    label: "Billing parser",
    threadId: "thread-1",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "headless",
  });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "/sessions",
      chat: { id: TEST_USER_ID, type: "private" },
      from: { id: TEST_USER_ID },
    },
  });

  const bindButton = telegram.calls.sendMessage
    .at(-1)
    .options.reply_markup.inline_keyboard[0][0];

  await app.handleUpdate({
    callback_query: {
      id: "cb-1",
      data: bindButton.callback_data,
      from: { id: TEST_USER_ID },
      message: {
        message_id: 9,
        chat: { id: TEST_USER_ID, type: "private" },
      },
    },
  });

  const session = await store.getSession("session-1");
  const answer = telegram.calls.answerCallbackQuery.at(-1);
  const edited = telegram.calls.editMessage.at(-1);

  assert.equal(session?.status, "bound");
  assert.equal(session?.topicId, 42);
  assert.equal(telegram.calls.createForumTopic.length, 1);
  assert.equal(answer.options.text, "Topic created. Open Topic.");
  assert.match(edited.text, /state: bound/);
});

test("When archive is tapped in DM, then the session is hidden from open sessions and its topic is closed", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({ store, telegram });

  await store.saveSession({
    id: "session-archive-1",
    label: "Old task",
    threadId: "thread-archive-1",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "bound",
    forumChatId: "-1001",
    topicId: 24,
    topicName: "Old task",
    topicLink: "https://t.me/c/1001/24",
  });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "/sessions",
      chat: { id: TEST_USER_ID, type: "private" },
      from: { id: TEST_USER_ID },
    },
  });

  const archiveButton = telegram.calls.sendMessage
    .at(-1)
    .options.reply_markup.inline_keyboard[0][2];

  await app.handleUpdate({
    callback_query: {
      id: "cb-archive",
      data: archiveButton.callback_data,
      from: { id: TEST_USER_ID },
      message: {
        message_id: 11,
        chat: { id: TEST_USER_ID, type: "private" },
      },
    },
  });

  const session = await store.getSession("session-archive-1");
  const openSessions = await store.listSessions();
  const archived = await store.listSessions({ includeClosed: true });

  assert.equal(session?.status, "closed");
  assert.equal(openSessions.some((item) => item.id === "session-archive-1"), false);
  assert.equal(archived.some((item) => item.id === "session-archive-1"), true);
  assert.equal(telegram.calls.closeForumTopic.length, 1);
});

test("When archived sessions are opened, then restore brings them back to the open list", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({ store, telegram });

  await store.saveSession({
    id: "session-restore-1",
    label: "Archived task",
    threadId: "thread-restore-1",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "closed",
    forumChatId: "-1001",
    topicId: 25,
    topicName: "Archived task",
    topicLink: "https://t.me/c/1001/25",
  });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "/archived",
      chat: { id: TEST_USER_ID, type: "private" },
      from: { id: TEST_USER_ID },
    },
  });

  const restoreButton = telegram.calls.sendMessage
    .at(-1)
    .options.reply_markup.inline_keyboard[0][0];

  await app.handleUpdate({
    callback_query: {
      id: "cb-restore",
      data: restoreButton.callback_data,
      from: { id: TEST_USER_ID },
      message: {
        message_id: 12,
        chat: { id: TEST_USER_ID, type: "private" },
      },
    },
  });

  const session = await store.getSession("session-restore-1");

  assert.equal(session?.status, "bound");
  assert.equal(telegram.calls.reopenForumTopic.length, 1);
});

test("When a topic keyboard latest button is tapped, then relay resends the latest reply", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({ store, telegram });

  await store.saveSession({
    id: "session-topic-1",
    label: "Topic buttons",
    threadId: "thread-topic-1",
    cwd: "/repo",
    latestAssistantMessage: "Latest from button",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "bound",
    forumChatId: "-1001",
    topicId: 15,
    topicName: "Topic buttons",
    topicLink: "https://t.me/c/1001/15",
  });

  await app.initialize();
  await app.handleUpdate({
    callback_query: {
      id: "cb-topic-latest",
      data: "topic:latest:session-topic-1",
      from: { id: TEST_USER_ID },
      message: {
        message_id: 15,
        message_thread_id: 15,
        chat: { id: -1001, type: "supergroup" },
      },
    },
  });

  const sent = telegram.calls.sendLongMessage.at(-1);
  const answer = telegram.calls.answerCallbackQuery.at(-1);

  assert.match(sent.text, /Latest from button/);
  assert.equal(sent.options.message_thread_id, 15);
  assert.ok(sent.options.reply_markup);
  assert.equal(answer.options.text, "Latest reply sent.");
});

test("When archive is tapped in a topic, then the session is archived and the topic is closed", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({ store, telegram });

  await store.saveSession({
    id: "session-topic-archive-1",
    label: "Topic archive",
    threadId: "thread-topic-archive-1",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "bound",
    forumChatId: "-1001",
    topicId: 26,
    topicName: "Topic archive",
    topicLink: "https://t.me/c/1001/26",
  });

  await app.initialize();
  await app.handleUpdate({
    callback_query: {
      id: "cb-topic-archive",
      data: "topic:archive:session-topic-archive-1",
      from: { id: TEST_USER_ID },
      message: {
        message_id: 26,
        message_thread_id: 26,
        chat: { id: -1001, type: "supergroup" },
      },
    },
  });

  const session = await store.getSession("session-topic-archive-1");
  const answer = telegram.calls.answerCallbackQuery.at(-1);

  assert.equal(session?.status, "closed");
  assert.equal(telegram.calls.closeForumTopic.length, 1);
  assert.equal(answer.options.text, "Session archived.");
});

test("When sessions are stale, then viewing sessions auto-archives open ones and prunes old archived ones", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({
    store,
    telegram,
    now: () => "2026-04-20T12:00:00.000Z",
    clock: () => Date.parse("2026-04-20T12:00:00.000Z"),
    botConfigOverrides: {
      sessionRetention: {
        autoArchiveAfterMs: 7 * 24 * 60 * 60 * 1000,
        autoPruneAfterMs: 30 * 24 * 60 * 60 * 1000,
      },
    },
  });

  await store.saveSession({
    id: "session-stale-open",
    label: "Stale open",
    threadId: "thread-stale-open",
    cwd: "/repo",
    createdAt: "2026-04-01T10:00:00.000Z",
    updatedAt: "2026-04-01T10:00:00.000Z",
    status: "bound",
    forumChatId: "-1001",
    topicId: 31,
    topicName: "Stale open",
    topicLink: "https://t.me/c/1001/31",
  });
  await store.saveSession({
    id: "session-stale-closed",
    label: "Stale closed",
    threadId: "thread-stale-closed",
    cwd: "/repo",
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
    status: "closed",
    forumChatId: "-1001",
    topicId: 32,
    topicName: "Stale closed",
    topicLink: "https://t.me/c/1001/32",
  });
  await store.saveSession({
    id: "session-fresh",
    label: "Fresh",
    threadId: "thread-fresh",
    cwd: "/repo",
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T10:00:00.000Z",
    status: "headless",
  });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "/sessions",
      chat: { id: TEST_USER_ID, type: "private" },
      from: { id: TEST_USER_ID },
    },
  });

  const sessions = await store.listSessions({ includeClosed: true });
  const openIds = sessions.filter((session) => session.status !== "closed").map((session) => session.id);
  const closedIds = sessions.filter((session) => session.status === "closed").map((session) => session.id);

  assert.deepEqual(openIds, ["session-fresh"]);
  assert.deepEqual(closedIds, ["session-stale-open"]);
  assert.equal(telegram.calls.closeForumTopic.length, 1);
  assert.equal(telegram.calls.deleteForumTopic.length, 1);
});

test("When a topic message continues a bound session, then relay sends only the final reply and stores it", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({
    store,
    telegram,
    runTurn: async ({ onProgress }) => {
      onProgress({ type: "command_started", command: "npm test" });
      onProgress({ type: "command_output_delta", delta: "running\n" });
      onProgress({ type: "agent_message_delta", delta: "Partial" });
      onProgress({ type: "agent_message_delta", delta: " reply" });
      return {
        threadId: "thread-2",
        message: "Final reply",
      };
    },
  });

  await store.saveSession({
    id: "session-2",
    label: "Streaming",
    threadId: "thread-1",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "bound",
    forumChatId: "-1001",
    topicId: 8,
    topicName: "Streaming",
    topicLink: "https://t.me/c/1001/8",
  });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "continue from telegram",
      chat: { id: -1001, type: "supergroup" },
      from: { id: TEST_USER_ID },
      message_thread_id: 8,
    },
  });
  await app.waitForIdle();

  const session = await store.getSession("session-2");
  const finalMessage = telegram.calls.sendLongMessage.at(-1);

  assert.equal(session?.threadId, "thread-2");
  assert.equal(session?.latestAssistantMessage, "Final reply");
  assert.equal(telegram.calls.replaceProgressMessage.length, 0);
  assert.equal(finalMessage.text, "Final reply");
  assert.ok(telegram.calls.sendChatAction.length >= 1);
});

test("When a second topic prompt arrives while Codex is still running, then replies are sent in order without progress messages", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  let releaseFirstTurn = () => {};
  let markFirstTurnStarted = () => {};
  const firstTurnStarted = new Promise((resolve) => {
    markFirstTurnStarted = resolve;
  });
  let runCount = 0;
  const app = createTestApp({
    store,
    telegram,
    runTurn: async () => {
      runCount += 1;

      if (runCount === 1) {
        markFirstTurnStarted();
        await new Promise((resolve) => {
          releaseFirstTurn = resolve;
        });

        return {
          threadId: "thread-queued",
          message: "First reply",
        };
      }

      return {
        threadId: "thread-queued",
        message: "Second reply",
      };
    },
  });

  await store.saveSession({
    id: "session-queued",
    label: "Queued session",
    threadId: "thread-queued",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "bound",
    forumChatId: "-1001",
    topicId: 18,
    topicName: "Queued session",
    topicLink: "https://t.me/c/1001/18",
  });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "first prompt",
      chat: { id: -1001, type: "supergroup" },
      from: { id: TEST_USER_ID },
      message_thread_id: 18,
    },
  });
  await app.handleUpdate({
    message: {
      text: "second prompt",
      chat: { id: -1001, type: "supergroup" },
      from: { id: TEST_USER_ID },
      message_thread_id: 18,
    },
  });

  await firstTurnStarted;
  releaseFirstTurn();
  await app.waitForIdle();

  const replies = telegram.calls.sendLongMessage.map((call) => call.text);

  assert.deepEqual(replies, ["First reply", "Second reply"]);
  assert.equal(telegram.calls.replaceProgressMessage.length, 0);
});

test("When a topic message targets a remote host session, then relay queues the job instead of running it locally", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const hubServer = {
    calls: [],
    async start() {},
    async queueRemoteJob(session, payload) {
      this.calls.push({ session, payload });
    },
  };
  const app = createTestApp({
    store,
    telegram,
    hubServer,
    runTurn: async () => {
      throw new Error("should not run locally");
    },
  });

  await store.saveSession({
    id: "session-3",
    label: "Remote host",
    threadId: "thread-3",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "bound",
    hostId: "desktop",
    forumChatId: "-1001",
    topicId: 11,
    topicName: "Remote host",
    topicLink: "https://t.me/c/1001/11",
  });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "continue remotely",
      chat: { id: -1001, type: "supergroup" },
      from: { id: TEST_USER_ID },
      message_thread_id: 11,
    },
  });
  await app.waitForIdle();

  assert.equal(hubServer.calls.length, 1);
  assert.equal(hubServer.calls[0].session.hostId, "desktop");
  assert.equal(hubServer.calls[0].payload.prompt, "continue remotely");
  assert.equal(hubServer.calls[0].payload.progressMessageId, undefined);
  assert.equal(telegram.calls.sendMessage.length, 0);
  assert.equal(telegram.calls.replaceProgressMessage.length, 0);
});

async function createTempStore() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-app-"));
  return new StateStore(path.join(tempDir, "state.json"));
}

function createTestApp({
  store,
  telegram,
  runTurn,
  clock,
  now = () => "2026-04-02T12:00:00.000Z",
  hubServer = null,
  botConfigOverrides = {},
}) {
  return createRelayApp({
    botConfig: {
      authorizedUserIds: new Set([String(TEST_USER_ID)]),
      forumChatId: "-1001",
      pollTimeoutSeconds: 1,
      hostId: "mbp",
      sessionRetention: {
        autoArchiveAfterMs: 14 * 24 * 60 * 60 * 1000,
        autoPruneAfterMs: 60 * 24 * 60 * 60 * 1000,
      },
      ...botConfigOverrides,
    },
    codexConfig: {
      defaultCwd: "/repo",
      startRoots: ["/repo"],
      model: "",
      defaultArgs: ["--yolo"],
    },
    telegram,
    store,
    runTurn,
    clock,
    hubServer,
    now,
    logger: {
      log() {},
      error() {},
    },
    sleep: async () => {},
  });
}

function createFakeTelegram() {
  let nextMessageId = 1;
  const calls = {
    answerCallbackQuery: [],
    closeForumTopic: [],
    createForumTopic: [],
    deleteForumTopic: [],
    editMessage: [],
    replaceProgressMessage: [],
    reopenForumTopic: [],
    sendChatAction: [],
    sendLongMessage: [],
    sendMessage: [],
  };

  return {
    calls,
    async getMe() {
      return { username: "CodingAgentRelayBot" };
    },
    async getChat(chatId) {
      return {
        id: Number(chatId),
        is_forum: true,
        title: "Coding Agent",
      };
    },
    async getUpdates() {
      return [];
    },
    async answerCallbackQuery(id, options = {}) {
      calls.answerCallbackQuery.push({ id, options });
      return true;
    },
    async createForumTopic(chatId, name) {
      calls.createForumTopic.push({ chatId, name });
      return {
        message_thread_id: 42,
        name,
      };
    },
    async closeForumTopic(chatId, topicId) {
      calls.closeForumTopic.push({ chatId, topicId });
      return true;
    },
    async deleteForumTopic(chatId, topicId) {
      calls.deleteForumTopic.push({ chatId, topicId });
      return true;
    },
    async reopenForumTopic(chatId, topicId) {
      calls.reopenForumTopic.push({ chatId, topicId });
      return true;
    },
    async sendChatAction(chatId, action, options = {}) {
      calls.sendChatAction.push({ chatId, action, options });
      return true;
    },
    async sendMessage(chatId, text, options = {}) {
      const message = {
        message_id: nextMessageId,
        chat: { id: chatId },
        text,
      };

      nextMessageId += 1;
      calls.sendMessage.push({ chatId, text, options, message });
      return message;
    },
    async editMessage(chatId, messageId, text, options = {}) {
      calls.editMessage.push({ chatId, messageId, text, options });
      return {
        message_id: messageId,
        chat: { id: chatId },
        text,
      };
    },
    async sendLongMessage(chatId, text, options = {}) {
      const message = {
        message_id: nextMessageId,
        chat: { id: chatId },
        text,
      };

      nextMessageId += 1;
      calls.sendLongMessage.push({ chatId, text, options, message });
      return [message];
    },
    async replaceProgressMessage(chatId, progressMessage, text, options = {}) {
      calls.replaceProgressMessage.push({
        chatId,
        progressMessage,
        text,
        options,
      });
      return true;
    },
  };
}
