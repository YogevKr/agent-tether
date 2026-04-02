import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRelayApp } from "../src/relay-app.js";
import { StateStore } from "../src/state-store.js";

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
      chat: { id: 344735105, type: "private" },
      from: { id: 344735105 },
    },
  });

  const sent = telegram.calls.sendMessage.at(-1);
  const buttons = sent.options.reply_markup.inline_keyboard.flat();

  assert.match(sent.text, /Agent sessions/);
  assert.ok(buttons.some((button) => button.callback_data === "session:create:headless-1"));
  assert.ok(buttons.some((button) => button.url === "https://t.me/c/1001/4"));
});

test("When /start is requested in DM, then relay shows the home buttons", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({ store, telegram });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "/start",
      chat: { id: 344735105, type: "private" },
      from: { id: 344735105 },
    },
  });

  const sent = telegram.calls.sendMessage.at(-1);
  const buttons = sent.options.reply_markup.inline_keyboard.flat();

  assert.match(sent.text, /Agent Tether/);
  assert.ok(buttons.some((button) => button.callback_data === "dm:sessions"));
  assert.ok(buttons.some((button) => button.callback_data === "dm:status"));
  assert.ok(buttons.some((button) => button.callback_data === "dm:help"));
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
    callback_query: {
      id: "cb-1",
      data: "session:create:session-1",
      from: { id: 344735105 },
      message: {
        message_id: 9,
        chat: { id: 344735105, type: "private" },
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
      from: { id: 344735105 },
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

test("When a topic message continues a bound session, then relay streams progress and stores the final reply", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  let nowMs = 0;
  const app = createTestApp({
    store,
    telegram,
    clock: () => nowMs,
    runTurn: async ({ onProgress }) => {
      onProgress({ type: "command_started", command: "npm test" });
      nowMs = 1000;
      onProgress({ type: "command_output_delta", delta: "running\n" });
      nowMs = 2000;
      onProgress({ type: "agent_message_delta", delta: "Partial" });
      nowMs = 3000;
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
      from: { id: 344735105 },
      message_thread_id: 8,
    },
  });
  await app.waitForIdle();

  const session = await store.getSession("session-2");
  const progressEdit = telegram.calls.editMessage.find((call) =>
    call.text.includes("draft reply:"),
  );
  const finalMessage = telegram.calls.replaceProgressMessage.at(-1);

  assert.equal(session?.threadId, "thread-2");
  assert.equal(session?.latestAssistantMessage, "Final reply");
  assert.ok(progressEdit);
  assert.equal(finalMessage.text, "Final reply");
  assert.ok(telegram.calls.sendChatAction.length >= 1);
});

test("When a second topic prompt arrives while Codex is still running, then it is acknowledged as queued", async () => {
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
      from: { id: 344735105 },
      message_thread_id: 18,
    },
  });
  await app.handleUpdate({
    message: {
      text: "second prompt",
      chat: { id: -1001, type: "supergroup" },
      from: { id: 344735105 },
      message_thread_id: 18,
    },
  });

  const queuedNotice = telegram.calls.sendMessage.at(-1);

  assert.match(queuedNotice.text, /state: queued/);
  assert.match(queuedNotice.text, /ahead: 1 turn/);

  await firstTurnStarted;
  releaseFirstTurn();
  await app.waitForIdle();
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
      from: { id: 344735105 },
      message_thread_id: 11,
    },
  });
  await app.waitForIdle();

  assert.equal(hubServer.calls.length, 1);
  assert.equal(hubServer.calls[0].session.hostId, "desktop");
  assert.equal(hubServer.calls[0].payload.prompt, "continue remotely");
  assert.equal(telegram.calls.replaceProgressMessage.length, 0);
});

async function createTempStore() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-app-"));
  return new StateStore(path.join(tempDir, "state.json"));
}

function createTestApp({ store, telegram, runTurn, clock, hubServer = null }) {
  return createRelayApp({
    botConfig: {
      authorizedUserIds: new Set(["344735105"]),
      forumChatId: "-1001",
      pollTimeoutSeconds: 1,
      hostId: "mbp",
    },
    codexConfig: {
      defaultCwd: "/repo",
      model: "",
    },
    telegram,
    store,
    runTurn,
    clock,
    hubServer,
    now: () => "2026-04-02T12:00:00.000Z",
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
    createForumTopic: [],
    editMessage: [],
    replaceProgressMessage: [],
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
