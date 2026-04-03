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
  const primaryButtons = sent.options.reply_markup.inline_keyboard
    .slice(0, 2)
    .map((row) => row[0]);

  assert.match(sent.text, /Agent sessions/);
  assert.match(sent.text, /Tap the row number to bind, open, or restore that session/);
  assert.ok(buttons.some((button) => button.callback_data?.startsWith("session:ui:")));
  assert.ok(buttons.some((button) => button.url === "https://t.me/c/1001/4"));
  assert.ok(buttons.some((button) => button.callback_data === "dm:new"));
  assert.deepEqual(primaryButtons.map((button) => button.text), ["1", "2"]);
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

test("When more than five sessions exist, then /sessions paginates with next and prev controls", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({ store, telegram });

  for (let index = 1; index <= 6; index += 1) {
    await store.saveSession({
      id: `session-page-${index}`,
      label: `Task ${index}`,
      threadId: `thread-${index}`,
      cwd: "/repo",
      createdAt: `2026-04-02T0${index}:00:00.000Z`,
      updatedAt: `2026-04-02T0${index}:30:00.000Z`,
      status: "headless",
    });
  }

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "/sessions",
      chat: { id: TEST_USER_ID, type: "private" },
      from: { id: TEST_USER_ID },
    },
  });

  const firstPage = telegram.calls.sendMessage.at(-1);
  const nextButton = firstPage.options.reply_markup.inline_keyboard
    .flat()
    .find((button) => button.callback_data === "sessions:page:open:1");
  const firstPrimaryButton = firstPage.options.reply_markup.inline_keyboard[0][0];

  assert.match(firstPage.text, /Page 1\/2/);
  assert.match(firstPage.text, /Task 6/);
  assert.doesNotMatch(firstPage.text, /Task 1/);
  assert.ok(nextButton);
  assert.equal(firstPrimaryButton.text, "1");

  await app.handleUpdate({
    callback_query: {
      id: "cb-next-page",
      data: "sessions:page:open:1",
      from: { id: TEST_USER_ID },
      message: {
        message_id: firstPage.message.message_id,
        chat: { id: TEST_USER_ID, type: "private" },
      },
    },
  });

  const secondPage = telegram.calls.editMessage.at(-1);
  const prevButton = secondPage.options.reply_markup.inline_keyboard
    .flat()
    .find((button) => button.callback_data === "sessions:page:open:0");
  const secondPagePrimaryButton = secondPage.options.reply_markup.inline_keyboard[0][0];

  assert.match(secondPage.text, /Page 2\/2/);
  assert.match(secondPage.text, /Task 1/);
  assert.ok(prevButton);
  assert.equal(secondPagePrimaryButton.text, "6");
});

test("When session details toggle intermediate steps, then the setting is updated for that session", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({ store, telegram });

  await store.saveSession({
    id: "session-steps-toggle",
    label: "Toggle steps",
    threadId: "thread-toggle",
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

  const sessionsPanel = telegram.calls.sendMessage.at(-1);
  const detailsButton = sessionsPanel.options.reply_markup.inline_keyboard
    .flat()
    .find((button) => button.text === "Details");

  await app.handleUpdate({
    callback_query: {
      id: "cb-session-details",
      data: detailsButton.callback_data,
      from: { id: TEST_USER_ID },
      message: {
        message_id: sessionsPanel.message.message_id,
        chat: { id: TEST_USER_ID, type: "private" },
      },
    },
  });

  const detailsPanel = telegram.calls.editMessage.at(-1);
  const toggleButton = detailsPanel.options.reply_markup.inline_keyboard
    .flat()
    .find((button) => button.text === "Show Steps");

  assert.match(detailsPanel.text, /intermediate_steps: off/);
  assert.ok(toggleButton?.callback_data);

  await app.handleUpdate({
    callback_query: {
      id: "cb-session-toggle-steps",
      data: toggleButton.callback_data,
      from: { id: TEST_USER_ID },
      message: {
        message_id: sessionsPanel.message.message_id,
        chat: { id: TEST_USER_ID, type: "private" },
      },
    },
  });

  const updated = await store.getSession("session-steps-toggle");
  const updatedPanel = telegram.calls.editMessage.at(-1);
  const answer = telegram.calls.answerCallbackQuery.at(-1);
  const hideButton = updatedPanel.options.reply_markup.inline_keyboard
    .flat()
    .find((button) => button.text === "Hide Steps");

  assert.equal(updated?.showIntermediateSteps, true);
  assert.match(updatedPanel.text, /intermediate_steps: on/);
  assert.equal(answer.options.text, "Intermediate steps enabled.");
  assert.ok(hideButton?.callback_data);
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

test("When /new is requested in the General topic, then relay shows provider selection there", async () => {
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

  const buttons = sent.options.reply_markup.inline_keyboard.flat();

  assert.match(sent.text, /Choose which agent to start/);
  assert.equal(sent.chatId, "-1001");
  assert.equal(sent.options.message_thread_id, undefined);
  assert.ok(buttons.some((button) => button.text === "Codex"));
  assert.ok(buttons.some((button) => button.text === "Claude Code"));
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
      defaultProvider: "codex",
      defaultCwd: rootDir,
      startRoots: [rootDir],
      model: "",
      defaultArgs: ["--yolo"],
      providers: {
        codex: {
          provider: "codex",
          model: "gpt-5.4",
        },
        claude: {
          provider: "claude",
          model: "claude-sonnet-4-5",
        },
      },
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

  const providerPanel = telegram.calls.editMessage.at(-1);
  const providerButton = providerPanel.options.reply_markup.inline_keyboard[1][0];

  await app.handleUpdate({
    callback_query: {
      id: "cb-provider",
      data: providerButton.callback_data,
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
  assert.equal(session?.provider, "claude");
  assert.equal(session?.createdVia, "claude-telegram-ui");
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

  const sent = telegram.calls.sendMarkdownMessage.at(-1);
  const answer = telegram.calls.answerCallbackQuery.at(-1);

  assert.match(sent.text, /Latest from button/);
  assert.match(sent.options.prefixText, /^Latest Codex reply/);
  assert.equal(sent.options.message_thread_id, 15);
  assert.ok(sent.options.reply_markup);
  assert.equal(answer.options.text, "Latest reply sent.");
});

test("When the topic keyboard toggles intermediate steps, then the session is updated and the keyboard label flips", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({ store, telegram });

  await store.saveSession({
    id: "session-topic-steps-1",
    label: "Topic steps",
    threadId: "thread-topic-steps-1",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "bound",
    forumChatId: "-1001",
    topicId: 16,
    topicName: "Topic steps",
    topicLink: "https://t.me/c/1001/16",
  });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "/status",
      chat: { id: -1001, type: "supergroup" },
      from: { id: TEST_USER_ID },
      message_thread_id: 16,
    },
  });

  const statusMessage = telegram.calls.sendMessage.at(-1);
  const toggleButton = statusMessage.options.reply_markup.inline_keyboard
    .flat()
    .find((button) => button.text === "Show Steps");

  await app.handleUpdate({
    callback_query: {
      id: "cb-topic-steps",
      data: toggleButton.callback_data,
      from: { id: TEST_USER_ID },
      message: {
        message_id: statusMessage.message.message_id,
        message_thread_id: 16,
        chat: { id: -1001, type: "supergroup" },
      },
    },
  });

  const session = await store.getSession("session-topic-steps-1");
  const replyMarkupEdit = telegram.calls.editMessageReplyMarkup.at(-1);
  const answer = telegram.calls.answerCallbackQuery.at(-1);
  const hideButton = replyMarkupEdit.replyMarkup.inline_keyboard
    .flat()
    .find((button) => button.text === "Hide Steps");

  assert.equal(session?.showIntermediateSteps, true);
  assert.equal(replyMarkupEdit.chatId, -1001);
  assert.equal(replyMarkupEdit.messageId, statusMessage.message.message_id);
  assert.equal(answer.options.text, "Intermediate steps enabled.");
  assert.ok(hideButton?.callback_data);
});

test("When /status is requested in a bound topic, then the git branch is shown when it exists", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({
    store,
    telegram,
    getGitBranch: async (cwd) => (cwd === "/repo" ? "feature/topic-status" : ""),
  });

  await store.saveSession({
    id: "session-topic-status-branch-1",
    label: "Topic status branch",
    threadId: "thread-topic-status-branch-1",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "bound",
    forumChatId: "-1001",
    topicId: 17,
    topicName: "Topic status branch",
    topicLink: "https://t.me/c/1001/17",
  });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "/status",
      chat: { id: -1001, type: "supergroup" },
      from: { id: TEST_USER_ID },
      message_thread_id: 17,
    },
  });

  const sent = telegram.calls.sendMessage.at(-1);

  assert.match(sent.text, /branch: feature\/topic-status/);
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
      message_id: 1,
      text: "continue from telegram",
      chat: { id: -1001, type: "supergroup" },
      from: { id: TEST_USER_ID },
      message_thread_id: 8,
    },
  });
  await app.waitForIdle();

  const session = await store.getSession("session-2");
  const finalMessage = telegram.calls.sendMarkdownMessage.at(-1);
  const topicNames = telegram.calls.editForumTopic.map((call) => call.options.name);

  assert.equal(session?.threadId, "thread-2");
  assert.equal(session?.latestAssistantMessage, "Final reply");
  assert.equal(telegram.calls.replaceProgressMessage.length, 0);
  assert.equal(finalMessage.text, "Final reply");
  assert.deepEqual(topicNames, ["⏳ Streaming", "Streaming"]);
  assert.deepEqual(telegram.calls.setMessageReaction.at(-1), {
    chatId: -1001,
    messageId: 1,
    reaction: [{ type: "emoji", emoji: "👀" }],
    options: { is_big: false },
  });
  assert.ok(telegram.calls.sendChatAction.length >= 1);
});

test("When intermediate steps are enabled for a topic session, then relay replaces a live progress message before the final reply", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  let tick = 0;
  const app = createTestApp({
    store,
    telegram,
    clock: () => {
      tick += 1000;
      return tick;
    },
    runTurn: async ({ onProgress }) => {
      onProgress({ type: "command_started", command: "npm test" });
      onProgress({ type: "command_output_delta", delta: "running\n" });
      onProgress({ type: "agent_message_delta", delta: "Partial" });
      onProgress({ type: "agent_message_delta", delta: " reply" });
      return {
        threadId: "thread-steps-2",
        message: "Final reply",
      };
    },
  });

  await store.saveSession({
    id: "session-steps-2",
    label: "Streaming steps",
    threadId: "thread-steps-1",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "bound",
    forumChatId: "-1001",
    topicId: 28,
    topicName: "Streaming steps",
    topicLink: "https://t.me/c/1001/28",
    showIntermediateSteps: true,
  });

  await app.initialize();
  await app.handleUpdate({
    message: {
      message_id: 1,
      text: "continue with steps",
      chat: { id: -1001, type: "supergroup" },
      from: { id: TEST_USER_ID },
      message_thread_id: 28,
    },
  });
  await app.waitForIdle();

  const session = await store.getSession("session-steps-2");
  const pendingMessage = telegram.calls.sendMessage.at(-1);
  const progressUpdate = telegram.calls.replaceProgressMessage.at(-1);
  const finalMessage = telegram.calls.replaceProgressMessageWithMarkdown.at(-1);

  assert.equal(session?.threadId, "thread-steps-2");
  assert.equal(session?.latestAssistantMessage, "Final reply");
  assert.match(pendingMessage.text, /Continuing session: Streaming steps/);
  assert.match(pendingMessage.text, /state: waiting for agent/);
  assert.match(progressUpdate.text, /command: npm test/);
  assert.match(progressUpdate.text, /draft reply:/);
  assert.equal(finalMessage.text, "Final reply");
  assert.equal(telegram.calls.sendMarkdownMessage.length, 0);
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

  const replies = telegram.calls.sendMarkdownMessage.map((call) => call.text);

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
      message_id: 1,
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
  assert.equal(telegram.calls.editForumTopic.length, 0);
  assert.deepEqual(telegram.calls.setMessageReaction.at(-1), {
    chatId: -1001,
    messageId: 1,
    reaction: [{ type: "emoji", emoji: "👀" }],
    options: { is_big: false },
  });
  assert.equal(telegram.calls.sendMessage.length, 0);
  assert.equal(telegram.calls.replaceProgressMessage.length, 0);
});

test("When intermediate steps are enabled for a remote host session, then relay queues a progress message id with the remote job", async () => {
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
    id: "session-remote-steps",
    label: "Remote steps",
    threadId: "thread-remote-steps",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "bound",
    hostId: "desktop",
    forumChatId: "-1001",
    topicId: 29,
    topicName: "Remote steps",
    topicLink: "https://t.me/c/1001/29",
    showIntermediateSteps: true,
  });

  await app.initialize();
  await app.handleUpdate({
    message: {
      message_id: 1,
      text: "continue remotely with steps",
      chat: { id: -1001, type: "supergroup" },
      from: { id: TEST_USER_ID },
      message_thread_id: 29,
    },
  });
  await app.waitForIdle();

  assert.equal(hubServer.calls.length, 1);
  assert.equal(hubServer.calls[0].payload.progressMessageId, 1);
  assert.match(telegram.calls.sendMessage.at(-1).text, /Continuing session: Remote steps/);
});

test("When a Claude topic turn runs without a saved model, then the Claude provider default model is used", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const runCalls = [];
  const app = createTestApp({
    store,
    telegram,
    runTurn: async (input) => {
      runCalls.push(input);
      return {
        threadId: "claude-thread-2",
        message: "Claude final reply",
      };
    },
  });

  await store.saveSession({
    id: "claude-bound-1",
    label: "Claude task",
    threadId: "claude-thread-1",
    provider: "claude",
    cwd: "/repo",
    model: "",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "bound",
    forumChatId: "-1001",
    topicId: 19,
    topicName: "Claude task",
    topicLink: "https://t.me/c/1001/19",
  });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "continue with claude",
      chat: { id: -1001, type: "supergroup" },
      from: { id: TEST_USER_ID },
      message_thread_id: 19,
    },
  });
  await app.waitForIdle();

  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].provider, "claude");
  assert.equal(runCalls[0].model, "claude-sonnet-4-5");
  assert.equal(telegram.calls.sendMarkdownMessage.at(-1).text, "Claude final reply");
});

test("When /queue is requested in a bound topic, then relay shows running and queued prompts", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const app = createTestApp({ store, telegram });

  await store.saveSession({
    id: "queue-topic-1",
    label: "Queue topic",
    threadId: "thread-queue-topic-1",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "bound",
    forumChatId: "-1001",
    topicId: 22,
    topicName: "Queue topic",
    topicLink: "https://t.me/c/1001/22",
    isBusy: true,
    activeRunSource: "local-cli",
  });
  await store.createJob({
    id: "queue-job-1",
    sessionId: "queue-topic-1",
    hostId: "mbp",
    prompt: "queued follow-up",
    status: "queued",
    createdAt: "2026-04-02T10:01:00.000Z",
    updatedAt: "2026-04-02T10:01:00.000Z",
  });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "/queue",
      chat: { id: -1001, type: "supergroup" },
      from: { id: TEST_USER_ID },
      message_thread_id: 22,
    },
  });

  const sent = telegram.calls.sendMessage.at(-1);
  assert.match(sent.text, /Queue: Queue topic/);
  assert.match(sent.text, /running: 0/);
  assert.match(sent.text, /queued: 1/);
  assert.match(sent.text, /Local CLI run is still active/);
});

test("When /stop is requested in a bound topic, then the running turn is aborted and queued prompts are cleared", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram();
  const runCalls = [];
  let markRunStarted = () => {};
  const runStarted = new Promise((resolve) => {
    markRunStarted = resolve;
  });
  const app = createTestApp({
    store,
    telegram,
    runTurn: async (input) => {
      runCalls.push(input);
      markRunStarted();
      return new Promise((resolve, reject) => {
        input.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    },
  });

  await store.saveSession({
    id: "stop-topic-1",
    label: "Stop topic",
    threadId: "thread-stop-topic-1",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "bound",
    forumChatId: "-1001",
    topicId: 23,
    topicName: "Stop topic",
    topicLink: "https://t.me/c/1001/23",
  });

  await app.initialize();
  await app.handleUpdate({
    message: {
      text: "run forever",
      chat: { id: -1001, type: "supergroup" },
      from: { id: TEST_USER_ID },
      message_thread_id: 23,
      message_id: 1,
    },
  });
  await runStarted;

  await app.handleUpdate({
    message: {
      text: "queued prompt",
      chat: { id: -1001, type: "supergroup" },
      from: { id: TEST_USER_ID },
      message_thread_id: 23,
      message_id: 2,
    },
  });

  await app.handleUpdate({
    message: {
      text: "/stop",
      chat: { id: -1001, type: "supergroup" },
      from: { id: TEST_USER_ID },
      message_thread_id: 23,
      message_id: 3,
    },
  });
  await app.waitForIdle();

  const jobs = await store.listJobsForSession("stop-topic-1", {
    statuses: ["cancelled"],
  });
  const session = await store.getSession("stop-topic-1");
  const stopMessage = telegram.calls.sendMessage.at(-1);

  assert.equal(runCalls.length, 1);
  assert.equal(jobs.length, 2);
  assert.equal(session?.isBusy, false);
  assert.match(stopMessage.text, /Stopping the current Telegram-run turn/);
  assert.match(stopMessage.text, /Cleared 1 queued prompt/);
  assert.equal(telegram.calls.sendLongMessage.length, 0);
});

test("When a topic message includes Telegram attachments, then relay downloads them and passes attachment context into the turn", async () => {
  const store = await createTempStore();
  const telegram = createFakeTelegram({
    files: {
      photo1: {
        file_path: "photos/topic-photo.jpg",
        content: "image-bytes",
      },
      doc1: {
        file_path: "docs/spec.txt",
        content: "hello from the attached document",
      },
    },
  });
  const runCalls = [];
  const app = createTestApp({
    store,
    telegram,
    runTurn: async (input) => {
      runCalls.push({
        prompt: input.prompt,
        imagePaths: [...input.attachments.imagePaths],
        extraDirs: [...input.attachments.extraDirs],
        documentText: await fs.readFile(
          path.join(input.attachments.extraDirs[0], "spec.txt"),
          "utf8",
        ),
      });
      return {
        threadId: "thread-attachments-1",
        message: "Attachment reply",
      };
    },
  });

  await store.saveSession({
    id: "attachments-topic-1",
    label: "Attachments topic",
    threadId: "thread-attachments-0",
    cwd: "/repo",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    status: "bound",
    forumChatId: "-1001",
    topicId: 24,
    topicName: "Attachments topic",
    topicLink: "https://t.me/c/1001/24",
  });

  await app.initialize();
  await app.handleUpdate({
    message: {
      caption: "Review these files",
      photo: [
        {
          file_id: "photo1",
          file_unique_id: "photo-unique-1",
          file_size: 25,
        },
      ],
      document: {
        file_id: "doc1",
        file_unique_id: "doc-unique-1",
        file_name: "spec.txt",
        mime_type: "text/plain",
        file_size: 30,
      },
      chat: { id: -1001, type: "supergroup" },
      from: { id: TEST_USER_ID },
      message_thread_id: 24,
      message_id: 4,
    },
  });
  await app.waitForIdle();

  assert.equal(runCalls.length, 1);
  assert.match(runCalls[0].prompt, /Telegram attachment context/);
  assert.match(runCalls[0].prompt, /Review these files/);
  assert.equal(runCalls[0].imagePaths.length, 1);
  assert.equal(runCalls[0].extraDirs.length, 1);
  assert.equal(runCalls[0].documentText, "hello from the attached document");
  assert.deepEqual(
    telegram.calls.getFile.map((call) => call.fileId),
    ["photo1", "doc1"],
  );
});

async function createTempStore() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-app-"));
  return new StateStore(path.join(tempDir, "state.json"));
}

function createTestApp({
  store,
  telegram,
  runTurn,
  getGitBranch,
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
      defaultProvider: "codex",
      defaultCwd: "/repo",
      startRoots: ["/repo"],
      model: "",
      defaultArgs: ["--yolo"],
      providers: {
        codex: {
          provider: "codex",
          model: "gpt-5.4",
        },
        claude: {
          provider: "claude",
          model: "claude-sonnet-4-5",
        },
      },
    },
    telegram,
    store,
    runTurn,
    clock,
    hubServer,
    now,
    getGitBranch,
    logger: {
      log() {},
      error() {},
    },
    sleep: async () => {},
  });
}

function createFakeTelegram({ files = {} } = {}) {
  let nextMessageId = 1;
  const calls = {
    answerCallbackQuery: [],
    closeForumTopic: [],
    createForumTopic: [],
    deleteForumTopic: [],
    downloadFile: [],
    editForumTopic: [],
    editMessage: [],
    editMessageReplyMarkup: [],
    getFile: [],
    replaceProgressMessage: [],
    reopenForumTopic: [],
    replaceProgressMessageWithMarkdown: [],
    setMessageReaction: [],
    sendChatAction: [],
    sendMarkdownMessage: [],
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
    async getFile(fileId) {
      calls.getFile.push({ fileId });
      const file = files[fileId];

      if (!file?.file_path) {
        throw new Error(`Unknown Telegram file id: ${fileId}`);
      }

      return {
        file_id: fileId,
        file_path: file.file_path,
      };
    },
    async downloadFile(filePath) {
      calls.downloadFile.push({ filePath });
      const file = Object.values(files).find((candidate) => candidate.file_path === filePath);

      if (!file) {
        throw new Error(`Unknown Telegram file path: ${filePath}`);
      }

      return Buffer.from(file.content || "", "utf8");
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
    async editForumTopic(chatId, topicId, options = {}) {
      calls.editForumTopic.push({ chatId, topicId, options });
      return true;
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
    async setMessageReaction(chatId, messageId, reaction, options = {}) {
      calls.setMessageReaction.push({ chatId, messageId, reaction, options });
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
    async editMessageReplyMarkup(chatId, messageId, replyMarkup) {
      calls.editMessageReplyMarkup.push({ chatId, messageId, replyMarkup });
      return {
        message_id: messageId,
        chat: { id: chatId },
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
    async sendMarkdownMessage(chatId, text, options = {}) {
      const message = {
        message_id: nextMessageId,
        chat: { id: chatId },
        text,
      };

      nextMessageId += 1;
      calls.sendMarkdownMessage.push({ chatId, text, options, message });
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
    async replaceProgressMessageWithMarkdown(chatId, progressMessage, text, options = {}) {
      calls.replaceProgressMessageWithMarkdown.push({
        chatId,
        progressMessage,
        text,
        options,
      });
      return true;
    },
  };
}
