import { runCodexTurn } from "./codex.js";
import {
  MAX_PANEL_SESSIONS,
  buildSessionDetailKeyboard,
  buildSessionsKeyboard,
  dmHelpText,
  formatDmStatus,
  formatLatestReply,
  formatSessionDetails,
  formatSessionsPanel,
  formatTopicBootstrap,
  toTopicName,
  topicHelpText,
} from "./session-view.js";
import { buildForumTopicUrl } from "./telegram.js";

const STREAM_EDIT_THROTTLE_MS = 900;
const MAX_REASONING_CHARS = 700;
const MAX_COMMAND_OUTPUT_CHARS = 1000;
const MAX_DRAFT_REPLY_CHARS = 2200;

export function createRelayApp({
  botConfig,
  codexConfig,
  telegram,
  store,
  hubServer = null,
  runTurn = runCodexTurn,
  now = () => new Date().toISOString(),
  clock = () => Date.now(),
  logger = console,
  sleep = defaultSleep,
}) {
  const sessionQueues = new Map();
  const sessionQueueDepths = new Map();

  let offset = 0;
  let botUsername = "";
  let forumChat = null;

  async function initialize() {
    const me = await telegram.getMe();
    botUsername = me.username?.toLowerCase() || "";
    forumChat = await telegram.getChat(botConfig.forumChatId);

    if (!forumChat.is_forum) {
      throw new Error(
        `TELEGRAM_FORUM_CHAT_ID is not a forum-enabled supergroup: ${botConfig.forumChatId}`,
      );
    }

    return {
      botUsername,
      forumChat,
    };
  }

  async function run() {
    await initialize();

    if (hubServer) {
      await hubServer.start();
    }

    logger.log(
      `agent tether up bot=@${botUsername || "unknown"} forum=${forumChat.title || forumChat.id}`,
    );

    while (true) {
      try {
        const updates = await telegram.getUpdates({
          offset,
          timeoutSeconds: botConfig.pollTimeoutSeconds,
        });

        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            await handleUpdate(update);
          } catch (error) {
            logger.error(error);
          }
        }
      } catch (error) {
        logger.error("poll failed:", error.message);
        await sleep(2000);
      }
    }
  }

  async function handleUpdate(update) {
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return;
    }

    const message = update.message;

    if (!message?.text || !message.chat?.id || !message.from?.id) {
      return;
    }

    if (String(message.chat.id) === String(forumChat.id)) {
      await handleForumMessage(message);
      return;
    }

    if (message.chat.type === "private") {
      await handleDmMessage(message);
    }
  }

  async function handleDmMessage(message) {
    const userId = String(message.from.id);
    const chatId = String(message.chat.id);
    const text = message.text.trim();

    if (!text) {
      return;
    }

    if (isCommand(text, "start", botUsername) || isCommand(text, "help", botUsername)) {
      await telegram.sendMessage(
        chatId,
        dmHelpText({
          userId,
          forumTitle: forumChat.title || String(forumChat.id),
        }),
      );
      return;
    }

    if (isCommand(text, "chatid", botUsername)) {
      const authState =
        botConfig.authorizedUserIds.size === 0
          ? "No users authorized yet. Add this id to AUTHORIZED_TELEGRAM_USER_IDS."
          : botConfig.authorizedUserIds.has(userId)
            ? "This Telegram user is authorized."
            : "This Telegram user is not authorized yet.";
      await telegram.sendMessage(chatId, `user_id: ${userId}\n${authState}`);
      return;
    }

    try {
      assertAuthorizedUser(userId, botConfig.authorizedUserIds);
    } catch (error) {
      await telegram.sendMessage(chatId, error.message);
      return;
    }

    if (isCommand(text, "sessions", botUsername)) {
      await renderSessionsPanel(chatId);
      return;
    }

    if (isCommand(text, "status", botUsername)) {
      const sessions = await store.listSessions();
      await telegram.sendMessage(
        chatId,
        formatDmStatus({
          forumTitle: forumChat.title || String(forumChat.id),
          sessions,
        }),
      );
      return;
    }

    await telegram.sendMessage(
      chatId,
      dmHelpText({
        userId,
        forumTitle: forumChat.title || String(forumChat.id),
      }),
    );
  }

  async function handleForumMessage(message) {
    const userId = String(message.from.id);

    try {
      assertAuthorizedUser(userId, botConfig.authorizedUserIds);
    } catch {
      return;
    }

    const topicId = message.message_thread_id;

    if (!topicId) {
      return;
    }

    const text = message.text.trim();

    if (!text) {
      return;
    }

    const session = await store.getSessionByTopic(forumChat.id, topicId);

    if (isCommand(text, "start", botUsername) || isCommand(text, "help", botUsername)) {
      await telegram.sendMessage(forumChat.id, topicHelpText(session), {
        message_thread_id: topicId,
      });
      return;
    }

    if (isCommand(text, "status", botUsername)) {
      await telegram.sendMessage(
        forumChat.id,
        session
          ? formatSessionDetails(session)
          : "No Codex session is bound to this topic. Use DM /sessions to create or bind one.",
        { message_thread_id: topicId },
      );
      return;
    }

    if (isCommand(text, "latest", botUsername)) {
      if (!session) {
        await telegram.sendMessage(
          forumChat.id,
          "No Codex session is bound to this topic. Use DM /sessions to create or bind one.",
          { message_thread_id: topicId },
        );
        return;
      }

      await sendLatestReply(forumChat.id, session, {
        message_thread_id: topicId,
      });
      return;
    }

    if (isCommand(text, "reset", botUsername)) {
      if (!session) {
        await telegram.sendMessage(
          forumChat.id,
          "No Codex session is bound to this topic.",
          { message_thread_id: topicId },
        );
        return;
      }

      await store.detachSession(session.id);
      await telegram.sendMessage(
        forumChat.id,
        "Session detached from this topic. It is headless again and can be rebound from DM /sessions.",
        { message_thread_id: topicId },
      );
      return;
    }

    if (!session) {
      await telegram.sendMessage(
        forumChat.id,
        "No Codex session is bound to this topic. Use DM /sessions to create or bind one.",
        { message_thread_id: topicId },
      );
      return;
    }

    const pendingAhead = await countPendingTurns(session);
    const progressMessage = await telegram.sendMessage(
      forumChat.id,
      formatPendingMessage(session, pendingAhead),
      { message_thread_id: topicId },
    );

    if (hubServer && session.hostId && session.hostId !== botConfig.hostId) {
      await hubServer.queueRemoteJob(session, {
        prompt: text,
        chatId: forumChat.id,
        messageThreadId: topicId,
        progressMessageId: progressMessage.message_id,
        pendingAhead,
      });
      return;
    }

    enqueueSession(session.id, () =>
      continueBoundSession(session.id, {
        prompt: text,
        messageThreadId: topicId,
        progressMessage,
      }),
    );
  }

  async function handleCallbackQuery(query) {
    if (!query.data || !query.from?.id || !query.message?.chat?.id) {
      return;
    }

    const userId = String(query.from.id);

    try {
      assertAuthorizedUser(userId, botConfig.authorizedUserIds);
    } catch (error) {
      await telegram.answerCallbackQuery(query.id, {
        text: error.message,
        show_alert: true,
      });
      return;
    }

    if (query.message.chat.type !== "private") {
      await telegram.answerCallbackQuery(query.id, {
        text: "Use DM controls for session management.",
      });
      return;
    }

    const chatId = String(query.message.chat.id);
    const messageId = query.message.message_id;

    if (query.data === "sessions:refresh") {
      await renderSessionsPanel(chatId, messageId);
      await telegram.answerCallbackQuery(query.id, {
        text: "Session list refreshed.",
      });
      return;
    }

    if (query.data.startsWith("session:details:")) {
      const sessionId = query.data.slice("session:details:".length);
      await renderSessionDetails(chatId, messageId, sessionId);
      await telegram.answerCallbackQuery(query.id, {
        text: "Session details loaded.",
      });
      return;
    }

    if (query.data.startsWith("session:latest:")) {
      const sessionId = query.data.slice("session:latest:".length);
      const session = await store.getSession(sessionId);

      if (!session || session.status === "closed") {
        await telegram.answerCallbackQuery(query.id, {
          text: "Session not found.",
          show_alert: true,
        });
        return;
      }

      await sendLatestReply(chatId, session);
      await telegram.answerCallbackQuery(query.id, {
        text: "Latest reply sent.",
      });
      return;
    }

    if (query.data.startsWith("session:create:")) {
      const sessionId = query.data.slice("session:create:".length);
      await createTopicForSession(sessionId, {
        controlChatId: chatId,
        panelMessageId: messageId,
        callbackQueryId: query.id,
      });
    }
  }

  async function renderSessionsPanel(chatId, messageId = null) {
    const sessions = (await store.listSessions()).slice(0, MAX_PANEL_SESSIONS);
    const text = formatSessionsPanel({
      forumTitle: forumChat.title || String(forumChat.id),
      sessions,
    });
    const replyMarkup = buildSessionsKeyboard(sessions);

    if (!messageId) {
      return telegram.sendMessage(chatId, text, {
        reply_markup: replyMarkup,
      });
    }

    return editOrSend(chatId, messageId, text, {
      reply_markup: replyMarkup,
    });
  }

  async function renderSessionDetails(chatId, messageId, sessionId) {
    const session = await store.getSession(sessionId);

    if (!session || session.status === "closed") {
      return editOrSend(chatId, messageId, "Session not found.");
    }

    return editOrSend(chatId, messageId, formatSessionDetails(session), {
      reply_markup: buildSessionDetailKeyboard(session),
    });
  }

  async function createTopicForSession(
    sessionId,
    { controlChatId, panelMessageId, callbackQueryId },
  ) {
    const session = await store.getSession(sessionId);

    if (!session || session.status === "closed") {
      await telegram.answerCallbackQuery(callbackQueryId, {
        text: "Session not found.",
        show_alert: true,
      });
      await renderSessionsPanel(controlChatId, panelMessageId);
      return;
    }

    if (session.status === "bound" && session.topicLink) {
      await telegram.answerCallbackQuery(callbackQueryId, {
        text: "Session already has a topic.",
      });
      await renderSessionDetails(controlChatId, panelMessageId, session.id);
      return;
    }

    const topic = await telegram.createForumTopic(
      forumChat.id,
      toTopicName(session.label),
    );
    const topicLink = buildForumTopicUrl(forumChat, topic.message_thread_id);
    const bootstrapText = formatTopicBootstrap(session, topicLink);
    const bootstrapMessages = await telegram.sendLongMessage(
      forumChat.id,
      bootstrapText,
      {
        message_thread_id: topic.message_thread_id,
      },
    );

    await store.bindSession(session.id, {
      forumChatId: forumChat.id,
      topicId: topic.message_thread_id,
      topicName: topic.name || session.label,
      topicLink,
      bootstrapMessageId: bootstrapMessages[0]?.message_id || null,
      updatedAt: now(),
    });

    await renderSessionDetails(controlChatId, panelMessageId, session.id);
    await telegram.answerCallbackQuery(callbackQueryId, {
      text: "Topic created. Open Topic.",
    });
  }

  async function continueBoundSession(sessionId, { prompt, messageThreadId, progressMessage }) {
    let session = await store.getSession(sessionId);

    if (!session || session.status !== "bound") {
      await telegram.sendMessage(
        forumChat.id,
        "This topic is no longer bound to a Codex session.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    await waitForSessionAvailability(sessionId);
    session = await store.getSession(sessionId);

    if (!session || session.status !== "bound") {
      await telegram.sendMessage(
        forumChat.id,
        "This topic is no longer bound to a Codex session.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    await store.updateSession(session.id, {
      isBusy: true,
      activeRunSource: "telegram",
      updatedAt: now(),
    });

    if (progressMessage) {
      await safeEditMessage(
        forumChat.id,
        progressMessage.message_id,
        `Continuing session: ${session.label}\nstate: waiting for Codex`,
        { message_thread_id: messageThreadId },
      );
    }

    const activeProgressMessage =
      progressMessage ||
      (await telegram.sendMessage(
        forumChat.id,
        `Continuing session: ${session.label}\nstate: waiting for Codex`,
        { message_thread_id: messageThreadId },
      ));

    const progressState = createProgressState(session);
    let dirty = false;
    let lastEditAt = 0;
    let editChain = Promise.resolve();

    const flushProgress = async (force = false) => {
      if (!dirty && !force) {
        return editChain;
      }

      const nowMs = clock();

      if (!force && nowMs - lastEditAt < STREAM_EDIT_THROTTLE_MS) {
        return editChain;
      }

      const preview = formatProgressMessage(progressState);
      dirty = false;
      lastEditAt = nowMs;
      editChain = editChain
        .catch(() => {})
        .then(() =>
          safeEditMessage(
            forumChat.id,
            activeProgressMessage.message_id,
            preview,
            { message_thread_id: messageThreadId },
          ),
        );
      return editChain;
    };

    try {
      const result = await runTurn({
        codex: codexConfig,
        prompt,
        cwd: session.cwd || codexConfig.defaultCwd,
        threadId: session.threadId,
        model: session.model || codexConfig.model,
        onProgress: (update) => {
          applyProgressUpdate(progressState, update);
          dirty = true;

          if (
            update.type === "command_started" ||
            update.type === "agent_message_delta"
          ) {
            void telegram
              .sendChatAction(forumChat.id, "typing", {
                message_thread_id: messageThreadId,
              })
              .catch(() => {});
          }

          const force = update.type === "command_started" || update.type === "command_completed";
          void flushProgress(force).catch(() => {});
        },
      });

      await store.updateSession(session.id, {
        threadId: result.threadId,
        latestUserPrompt: prompt,
        latestAssistantMessage: result.message,
        isBusy: false,
        activeRunSource: "",
        updatedAt: now(),
      });

      await editChain.catch(() => {});
      await telegram.replaceProgressMessage(
        forumChat.id,
        activeProgressMessage,
        result.message,
        { message_thread_id: messageThreadId },
      );
    } catch (error) {
      await store.updateSession(session.id, {
        isBusy: false,
        activeRunSource: "",
        updatedAt: now(),
      });
      await editChain.catch(() => {});
      await telegram.replaceProgressMessage(
        forumChat.id,
        activeProgressMessage,
        `Codex failed.\n\n${error.message}`,
        { message_thread_id: messageThreadId },
      );
    }
  }

  async function sendLatestReply(chatId, session, options = {}) {
    await telegram.sendLongMessage(chatId, formatLatestReply(session), options);
  }

  function enqueueSession(sessionId, task) {
    sessionQueueDepths.set(sessionId, (sessionQueueDepths.get(sessionId) || 0) + 1);
    const previous = sessionQueues.get(sessionId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(task)
      .finally(() => {
        const remaining = Math.max((sessionQueueDepths.get(sessionId) || 1) - 1, 0);

        if (remaining === 0) {
          sessionQueueDepths.delete(sessionId);
        } else {
          sessionQueueDepths.set(sessionId, remaining);
        }

        if (sessionQueues.get(sessionId) === next) {
          sessionQueues.delete(sessionId);
        }
      });

    sessionQueues.set(sessionId, next);
    return next;
  }

  async function waitForIdle() {
    await Promise.all([...sessionQueues.values()].map((job) => job.catch(() => {})));
  }

  async function editOrSend(chatId, messageId, text, options = {}) {
    if (!messageId) {
      return telegram.sendMessage(chatId, text, options);
    }

    try {
      return await telegram.editMessage(chatId, messageId, text, options);
    } catch (error) {
      if (String(error.message).includes("message is not modified")) {
        return null;
      }

      return telegram.sendMessage(chatId, text, options);
    }
  }

  async function safeEditMessage(chatId, messageId, text, options = {}) {
    try {
      await telegram.editMessage(chatId, messageId, text, options);
    } catch (error) {
      if (!String(error.message).includes("message is not modified")) {
        throw error;
      }
    }
  }

  async function countPendingTurns(session) {
    const queueDepth = sessionQueueDepths.get(session.id) || 0;
    const sessionBusy = session.isBusy ? 1 : 0;

    if (hubServer && session.hostId && session.hostId !== botConfig.hostId) {
      const pendingJobs = await store.listJobsForSession(session.id, {
        statuses: ["queued", "running"],
      });
      return Math.max(pendingJobs.length, sessionBusy);
    }

    return Math.max(queueDepth, sessionBusy);
  }

  async function waitForSessionAvailability(sessionId) {
    while (true) {
      const session = await store.getSession(sessionId);

      if (!session || !session.isBusy) {
        return session;
      }

      await sleep(500);
    }
  }

  return {
    initialize,
    run,
    handleUpdate,
    waitForIdle,
  };
}

export function isCommand(text, command, botUsername = "") {
  const match = text.trim().match(/^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s|$)/i);

  if (!match) {
    return false;
  }

  if (match[1].toLowerCase() !== command.toLowerCase()) {
    return false;
  }

  if (!match[2]) {
    return true;
  }

  return !botUsername || match[2].toLowerCase() === botUsername.toLowerCase();
}

export function createProgressState(session) {
  return {
    label: session.label,
    phase: "waiting for Codex",
    command: "",
    reasoning: "",
    commandOutput: "",
    draftReply: "",
  };
}

export function applyProgressUpdate(state, update) {
  if (update.type === "status") {
    if (update.phase) {
      state.phase = update.phase;
    }

    if (update.command !== undefined) {
      state.command = update.command || "";
    }

    if (update.reasoning !== undefined) {
      state.reasoning = tailText(update.reasoning || "", MAX_REASONING_CHARS);
    }

    if (update.commandOutput !== undefined) {
      state.commandOutput = tailText(update.commandOutput || "", MAX_COMMAND_OUTPUT_CHARS);
    }

    if (update.draftReply !== undefined) {
      state.draftReply = tailText(update.draftReply || "", MAX_DRAFT_REPLY_CHARS);
    }

    return state;
  }

  if (update.type === "thread_started") {
    state.phase = "thread ready";
  }

  if (update.type === "command_started") {
    state.phase = "running command";
    state.command = update.command || state.command;
    return state;
  }

  if (update.type === "command_output_delta") {
    state.phase = "running command";
    state.commandOutput = appendTail(
      state.commandOutput,
      update.delta || "",
      MAX_COMMAND_OUTPUT_CHARS,
    );
    return state;
  }

  if (update.type === "command_completed") {
    state.phase =
      update.exitCode === 0 || update.exitCode === null
        ? "command finished"
        : "command failed";
    state.command = update.command || state.command;
    state.commandOutput = tailText(
      update.output || state.commandOutput,
      MAX_COMMAND_OUTPUT_CHARS,
    );
    return state;
  }

  if (update.type === "reasoning_summary_delta") {
    state.phase = "thinking";
    state.reasoning = appendTail(
      state.reasoning,
      update.delta || "",
      MAX_REASONING_CHARS,
    );
    return state;
  }

  if (update.type === "agent_message_delta") {
    state.phase = "writing reply";
    state.draftReply = appendTail(
      state.draftReply,
      update.delta || "",
      MAX_DRAFT_REPLY_CHARS,
    );
    return state;
  }

  if (update.type === "agent_message") {
    state.phase = "reply ready";
    state.draftReply = tailText(update.text || "", MAX_DRAFT_REPLY_CHARS);
  }

  return state;
}

export function formatProgressMessage(state) {
  const lines = [
    `Continuing session: ${state.label}`,
    `state: ${state.phase}`,
  ];

  if (state.command) {
    lines.push(`command: ${tailText(state.command, 140)}`);
  }

  if (state.reasoning) {
    lines.push("");
    lines.push("thinking:");
    lines.push(state.reasoning);
  }

  if (state.commandOutput) {
    lines.push("");
    lines.push("command output:");
    lines.push(state.commandOutput);
  }

  if (state.draftReply) {
    lines.push("");
    lines.push("draft reply:");
    lines.push(state.draftReply);
  }

  return lines.join("\n");
}

export function formatPendingMessage(session, pendingAhead = 0) {
  if (pendingAhead <= 0) {
    return `Continuing session: ${session.label}\nstate: waiting for Codex`;
  }

  const turnLabel = pendingAhead === 1 ? "turn" : "turns";
  return [
    `Continuing session: ${session.label}`,
    "state: queued",
    `ahead: ${pendingAhead} ${turnLabel}`,
  ].join("\n");
}

export function appendTail(current, delta, maxChars) {
  return tailText(`${current}${delta}`, maxChars);
}

export function tailText(text, maxChars) {
  const normalized = String(text || "");

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `...${normalized.slice(-(maxChars - 3))}`;
}

function assertAuthorizedUser(userId, authorizedUserIds) {
  if (authorizedUserIds.size === 0) {
    throw new Error(
      "No authorized Telegram users configured. Add your user id to AUTHORIZED_TELEGRAM_USER_IDS.",
    );
  }

  if (!authorizedUserIds.has(String(userId))) {
    throw new Error(
      `Telegram user ${userId} is not authorized. Add it to AUTHORIZED_TELEGRAM_USER_IDS.`,
    );
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
