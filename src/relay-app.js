import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runAgentTurn } from "./agent-runtime.js";
import {
  MAX_PANEL_SESSIONS,
  SESSIONS_PAGE_SIZE,
  buildDmHomeKeyboard,
  buildSessionDetailKeyboard,
  buildSessionsKeyboard,
  buildTopicKeyboard,
  dmHelpText,
  formatDmStatus,
  formatLatestReply,
  formatProviderName,
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
const RETENTION_SWEEP_INTERVAL_MS = 60_000;

export function createRelayApp({
  botConfig,
  codexConfig,
  telegram,
  store,
  hubServer = null,
  runTurn = runAgentTurn,
  now = () => new Date().toISOString(),
  clock = () => Date.now(),
  logger = console,
  sleep = defaultSleep,
}) {
  const sessionQueues = new Map();
  const sessionQueueDepths = new Map();
  const uiTokens = new Map();

  let offset = 0;
  let botUsername = "";
  let forumChat = null;
  let lastRetentionSweepAt = 0;

  async function initialize() {
    const me = await telegram.getMe();
    botUsername = me.username?.toLowerCase() || "";
    forumChat = await telegram.getChat(botConfig.forumChatId);

    await store.upsertHost(botConfig.hostId, {
      label: botConfig.hostId,
      defaultCwd: codexConfig.defaultCwd,
      roots: codexConfig.startRoots,
      lastSeenAt: now(),
    });

    if (!forumChat.is_forum) {
      throw new Error(
        `TELEGRAM_FORUM_CHAT_ID is not a forum-enabled supergroup: ${botConfig.forumChatId}`,
      );
    }

    await maybeApplySessionRetention(true);

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
      await renderDmHome(chatId);
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

    if (isCommand(text, "archived", botUsername)) {
      await renderArchivedSessionsPanel(chatId);
      return;
    }

    if (isCommand(text, "new", botUsername)) {
      await renderProviderPicker(chatId);
      return;
    }

    if (isCommand(text, "status", botUsername)) {
      await renderDmStatus(chatId);
      return;
    }

    await renderDmHome(chatId);
  }

  async function handleForumMessage(message) {
    const userId = String(message.from.id);

    try {
      assertAuthorizedUser(userId, botConfig.authorizedUserIds);
    } catch {
      return;
    }

    const text = message.text.trim();

    if (!text) {
      return;
    }

    const topicId = message.message_thread_id;

    if (isGeneralTopicId(topicId)) {
      await handleGeneralForumMessage(message);
      return;
    }

    const session = await store.getSessionByTopic(forumChat.id, topicId);

    if (isCommand(text, "start", botUsername) || isCommand(text, "help", botUsername)) {
      await telegram.sendMessage(forumChat.id, topicHelpText(session), {
        message_thread_id: topicId,
        reply_markup: buildTopicKeyboard(session, topicKeyboardActions()),
      });
      return;
    }

    if (isCommand(text, "status", botUsername)) {
      await telegram.sendMessage(
        forumChat.id,
        session
          ? formatSessionDetails(session)
          : unboundTopicText("create or bind"),
        {
          message_thread_id: topicId,
          reply_markup: buildTopicKeyboard(session, topicKeyboardActions()),
        },
      );
      return;
    }

    if (isCommand(text, "latest", botUsername)) {
      if (!session) {
        await telegram.sendMessage(
          forumChat.id,
          unboundTopicText("create or bind"),
          { message_thread_id: topicId },
        );
        return;
      }

      await sendLatestReply(forumChat.id, session, {
        message_thread_id: topicId,
        reply_markup: buildTopicKeyboard(session, topicKeyboardActions()),
      });
      return;
    }

    if (isCommand(text, "reset", botUsername)) {
      if (!session) {
        await telegram.sendMessage(
          forumChat.id,
          unboundTopicText(),
          { message_thread_id: topicId },
        );
        return;
      }

      await store.detachSession(session.id);
      await telegram.sendMessage(
        forumChat.id,
        "Session detached from this topic. It is headless again and can be rebound from Sessions in General or DM.",
        {
          message_thread_id: topicId,
          reply_markup: buildTopicKeyboard(null, topicKeyboardActions()),
        },
      );
      return;
    }

    if (isCommand(text, "archive", botUsername)) {
      if (!session) {
        await telegram.sendMessage(
          forumChat.id,
          unboundTopicText(),
          { message_thread_id: topicId },
        );
        return;
      }

      await archiveSession(session.id);
      await telegram.sendMessage(
        forumChat.id,
        "Session archived. Restore it from Sessions or Archived.",
        { message_thread_id: topicId },
      );
      return;
    }

    if (!session) {
      await telegram.sendMessage(
        forumChat.id,
        unboundTopicText("create or bind"),
        { message_thread_id: topicId },
      );
      return;
    }

    const pendingAhead = await countPendingTurns(session);
    await acknowledgeAcceptedTopicMessage(message);

    if (hubServer && session.hostId && session.hostId !== botConfig.hostId) {
      await hubServer.queueRemoteJob(session, {
        prompt: text,
        chatId: forumChat.id,
        messageThreadId: topicId,
        pendingAhead,
      });
      return;
    }

    enqueueSession(session.id, () =>
      continueBoundSession(session.id, {
        prompt: text,
        messageThreadId: topicId,
      }),
    );
  }

  async function handleGeneralForumMessage(message) {
    const chatId = String(message.chat.id);
    const userId = String(message.from.id);
    const text = message.text.trim();

    if (isCommand(text, "start", botUsername) || isCommand(text, "help", botUsername)) {
      await renderDmHome(chatId, null, { userId });
      return;
    }

    if (isCommand(text, "chatid", botUsername)) {
      await telegram.sendMessage(chatId, `user_id: ${userId}`);
      return;
    }

    if (isCommand(text, "sessions", botUsername)) {
      await renderSessionsPanel(chatId);
      return;
    }

    if (isCommand(text, "archived", botUsername)) {
      await renderArchivedSessionsPanel(chatId);
      return;
    }

    if (isCommand(text, "new", botUsername)) {
      await renderProviderPicker(chatId);
      return;
    }

    if (isCommand(text, "status", botUsername)) {
      await renderDmStatus(chatId);
      return;
    }
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

    const chatId = String(query.message.chat.id);
    const messageId = query.message.message_id;
    const topicId = query.message.message_thread_id;

    if (String(query.message.chat.id) === String(forumChat.id)) {
      if (isGeneralTopicId(topicId)) {
        await handleControlCallbackQuery(query, { chatId, messageId, userId });
        return;
      }

      await handleTopicCallbackQuery(query, topicId);
      return;
    }

    if (query.message.chat.type !== "private") {
      await telegram.answerCallbackQuery(query.id, {
        text: "Use General or DM for session management.",
      });
      return;
    }

    await handleControlCallbackQuery(query, { chatId, messageId, userId });
  }

  async function handleControlCallbackQuery(query, { chatId, messageId, userId }) {
    if (query.data === "dm:new") {
      await renderProviderPicker(chatId, messageId);
      await telegram.answerCallbackQuery(query.id, {
        text: "Choose a provider.",
      });
      return;
    }

    if (query.data === "dm:help") {
      await renderDmHome(chatId, messageId, { userId });
      await telegram.answerCallbackQuery(query.id, {
        text: "Help loaded.",
      });
      return;
    }

    if (query.data === "dm:chatid") {
      await telegram.answerCallbackQuery(query.id, {
        text: `user_id: ${userId}`,
        show_alert: true,
      });
      return;
    }

    if (query.data === "dm:status") {
      await renderDmStatus(chatId, messageId);
      await telegram.answerCallbackQuery(query.id, {
        text: "Status loaded.",
      });
      return;
    }

    if (query.data === "dm:sessions") {
      await renderSessionsPanel(chatId, messageId);
      await telegram.answerCallbackQuery(query.id, {
        text: "Sessions loaded.",
      });
      return;
    }

    if (query.data === "dm:archived") {
      await renderArchivedSessionsPanel(chatId, messageId);
      await telegram.answerCallbackQuery(query.id, {
        text: "Archived sessions loaded.",
      });
      return;
    }

    if (query.data.startsWith("new:provider:")) {
      const provider = normalizeProviderChoice(codexConfig, query.data.slice("new:provider:".length));
      await renderHostPicker(chatId, messageId, provider);
      await telegram.answerCallbackQuery(query.id, {
        text: "Choose a node.",
      });
      return;
    }

    if (query.data.startsWith("new:host:")) {
      const token = query.data.slice("new:host:".length);
      const context = uiTokens.get(token);

      if (!context) {
        await telegram.answerCallbackQuery(query.id, {
          text: "Node selection expired. Start again.",
          show_alert: true,
        });
        return;
      }

      await renderRootPicker(chatId, messageId, context);
      await telegram.answerCallbackQuery(query.id, {
        text: "Choose a starting place.",
      });
      return;
    }

    if (query.data.startsWith("new:roots:")) {
      const token = query.data.slice("new:roots:".length);
      const context = uiTokens.get(token);

      if (!context) {
        await telegram.answerCallbackQuery(query.id, {
          text: "Place selection expired. Start again.",
          show_alert: true,
        });
        return;
      }

      await renderRootPicker(chatId, messageId, context);
      await telegram.answerCallbackQuery(query.id, {
        text: "Choose a starting place.",
      });
      return;
    }

    if (query.data.startsWith("new:browse:")) {
      const token = query.data.slice("new:browse:".length);
      const context = uiTokens.get(token);

      if (!context) {
        await telegram.answerCallbackQuery(query.id, {
          text: "Directory view expired. Start again.",
          show_alert: true,
        });
        return;
      }

      try {
        await renderDirectoryPicker(chatId, messageId, context);
        await telegram.answerCallbackQuery(query.id, {
          text: "Directory loaded.",
        });
      } catch (error) {
        await telegram.answerCallbackQuery(query.id, {
          text: error.message,
          show_alert: true,
        });
      }
      return;
    }

    if (query.data.startsWith("new:use:")) {
      const token = query.data.slice("new:use:".length);
      const context = uiTokens.get(token);

      if (!context) {
        await telegram.answerCallbackQuery(query.id, {
          text: "Directory selection expired. Start again.",
          show_alert: true,
        });
        return;
      }

      try {
        await createSessionFromDirectory(chatId, messageId, query.id, context);
      } catch (error) {
        await telegram.answerCallbackQuery(query.id, {
          text: error.message,
          show_alert: true,
        });
      }
      return;
    }

    if (query.data.startsWith("session:ui:")) {
      const token = query.data.slice("session:ui:".length);
      const context = uiTokens.get(token);

      if (!context || context.kind !== "session-action") {
        await telegram.answerCallbackQuery(query.id, {
          text: "Session controls expired. Refresh Sessions.",
          show_alert: true,
        });
        return;
      }

      if (context.action === "details") {
        await renderSessionDetails(chatId, messageId, context.sessionId, {
          mode: context.mode || "open",
          page: context.page || 0,
        });
        await telegram.answerCallbackQuery(query.id, {
          text: "Session details loaded.",
        });
        return;
      }

      if (context.action === "latest") {
        const session = await store.getSession(context.sessionId);

        if (!session) {
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

      if (context.action === "create") {
        await createTopicForSession(context.sessionId, {
          controlChatId: chatId,
          panelMessageId: messageId,
          callbackQueryId: query.id,
          mode: context.mode || "open",
          page: context.page || 0,
        });
        return;
      }

      if (context.action === "archive") {
        await archiveSession(context.sessionId);
        await renderSessionsPanel(chatId, messageId, context.page || 0);
        await telegram.answerCallbackQuery(query.id, {
          text: "Session archived.",
        });
        return;
      }

      if (context.action === "restore") {
        await restoreSession(context.sessionId);
        await renderSessionDetails(chatId, messageId, context.sessionId, {
          mode: context.mode || "archived",
          page: context.page || 0,
        });
        await telegram.answerCallbackQuery(query.id, {
          text: "Session restored.",
        });
        return;
      }
    }

    if (query.data === "sessions:refresh") {
      await renderSessionsPanel(chatId, messageId);
      await telegram.answerCallbackQuery(query.id, {
        text: "Session list refreshed.",
      });
      return;
    }

    if (query.data === "sessions:archived") {
      await renderArchivedSessionsPanel(chatId, messageId);
      await telegram.answerCallbackQuery(query.id, {
        text: "Archived sessions loaded.",
      });
      return;
    }

    if (query.data.startsWith("sessions:page:")) {
      const [, , mode, rawPage] = query.data.split(":");
      const page = Number.parseInt(rawPage || "0", 10);
      const currentPage = Number.isNaN(page) ? 0 : page;

      if (mode === "archived") {
        await renderArchivedSessionsPanel(chatId, messageId, currentPage);
        await telegram.answerCallbackQuery(query.id, {
          text: "Archived sessions loaded.",
        });
        return;
      }

      await renderSessionsPanel(chatId, messageId, currentPage);
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

  async function handleTopicCallbackQuery(query, topicId) {
    if (query.data === "topic:unbound") {
      await telegram.answerCallbackQuery(query.id, {
        text: "Open General or DM, then tap Sessions.",
        show_alert: true,
      });
      return;
    }

    if (!topicId) {
      await telegram.answerCallbackQuery(query.id, {
        text: "Topic context missing.",
        show_alert: true,
      });
      return;
    }

    const session = await store.getSessionByTopic(forumChat.id, topicId);

    if (query.data.startsWith("topic:ui:")) {
      const token = query.data.slice("topic:ui:".length);
      const context = uiTokens.get(token);

      if (!context || context.kind !== "topic-action") {
        await telegram.answerCallbackQuery(query.id, {
          text: "Topic controls expired. Send /status.",
          show_alert: true,
        });
        return;
      }

      if (context.action === "status") {
        await telegram.sendMessage(
          forumChat.id,
          session
            ? formatSessionDetails(session)
            : unboundTopicText("bind"),
          {
            message_thread_id: topicId,
            reply_markup: buildTopicKeyboard(session, topicKeyboardActions()),
          },
        );
        await telegram.answerCallbackQuery(query.id, {
          text: session ? "Session status sent." : "No session bound.",
        });
        return;
      }

      if (context.action === "latest") {
        if (!session) {
          await telegram.answerCallbackQuery(query.id, {
            text: "No session bound.",
            show_alert: true,
          });
          return;
        }

        await sendLatestReply(forumChat.id, session, {
          message_thread_id: topicId,
          reply_markup: buildTopicKeyboard(session, topicKeyboardActions()),
        });
        await telegram.answerCallbackQuery(query.id, {
          text: "Latest reply sent.",
        });
        return;
      }

      if (context.action === "reset") {
        if (!session) {
          await telegram.answerCallbackQuery(query.id, {
            text: "No session bound.",
            show_alert: true,
          });
          return;
        }

        await store.detachSession(session.id);
        await telegram.sendMessage(
          forumChat.id,
          "Session detached from this topic. It is headless again and can be rebound from Sessions in General or DM.",
          {
            message_thread_id: topicId,
            reply_markup: buildTopicKeyboard(null, topicKeyboardActions()),
          },
        );
        await telegram.answerCallbackQuery(query.id, {
          text: "Session detached.",
        });
        return;
      }

      if (context.action === "archive") {
        if (!session) {
          await telegram.answerCallbackQuery(query.id, {
            text: "No session bound.",
            show_alert: true,
          });
          return;
        }

        await archiveSession(session.id);
        await telegram.answerCallbackQuery(query.id, {
          text: "Session archived.",
        });
        return;
      }
    }

    if (query.data.startsWith("topic:status:")) {
      await telegram.sendMessage(
        forumChat.id,
        session
          ? formatSessionDetails(session)
          : unboundTopicText("bind"),
        {
          message_thread_id: topicId,
          reply_markup: buildTopicKeyboard(session, topicKeyboardActions()),
        },
      );
      await telegram.answerCallbackQuery(query.id, {
        text: session ? "Session status sent." : "No session bound.",
      });
      return;
    }

    if (query.data.startsWith("topic:latest:")) {
      if (!session) {
        await telegram.answerCallbackQuery(query.id, {
          text: "No session bound.",
          show_alert: true,
        });
        return;
      }

      await sendLatestReply(forumChat.id, session, {
        message_thread_id: topicId,
        reply_markup: buildTopicKeyboard(session, topicKeyboardActions()),
      });
      await telegram.answerCallbackQuery(query.id, {
        text: "Latest reply sent.",
      });
      return;
    }

    if (query.data.startsWith("topic:reset:")) {
      if (!session) {
        await telegram.answerCallbackQuery(query.id, {
          text: "No session bound.",
          show_alert: true,
        });
        return;
      }

      await store.detachSession(session.id);
      await telegram.sendMessage(
        forumChat.id,
        "Session detached from this topic. It is headless again and can be rebound from Sessions in General or DM.",
        {
          message_thread_id: topicId,
          reply_markup: buildTopicKeyboard(null, topicKeyboardActions()),
        },
      );
      await telegram.answerCallbackQuery(query.id, {
        text: "Session detached.",
      });
    }

    if (query.data.startsWith("topic:archive:")) {
      if (!session) {
        await telegram.answerCallbackQuery(query.id, {
          text: "No session bound.",
          show_alert: true,
        });
        return;
      }

      await archiveSession(session.id);
      await telegram.answerCallbackQuery(query.id, {
        text: "Session archived.",
      });
    }
  }

  async function renderSessionsPanel(chatId, messageId = null, page = 0) {
    await maybeApplySessionRetention();
    const sessions = (await store.listSessions()).slice(0, MAX_PANEL_SESSIONS);
    const totalPages = Math.max(Math.ceil(sessions.length / SESSIONS_PAGE_SIZE), 1);
    const currentPage = Math.max(0, Math.min(page, totalPages - 1));
    const text = formatSessionsPanel({
      forumTitle: forumChat.title || String(forumChat.id),
      sessions,
      page: currentPage,
      pageSize: SESSIONS_PAGE_SIZE,
    });
    const replyMarkup = buildSessionsKeyboard(
      sessions,
      {
        ...sessionKeyboardActions({
          mode: "open",
          page: currentPage,
        }),
        mode: "open",
        page: currentPage,
        pageSize: SESSIONS_PAGE_SIZE,
      },
    );

    if (!messageId) {
      return telegram.sendMessage(chatId, text, {
        reply_markup: replyMarkup,
      });
    }

    return editOrSend(chatId, messageId, text, {
      reply_markup: replyMarkup,
    });
  }

  async function renderArchivedSessionsPanel(chatId, messageId = null, page = 0) {
    await maybeApplySessionRetention();
    const sessions = (await store.listSessions({ includeClosed: true }))
      .filter((session) => session.status === "closed")
      .slice(0, MAX_PANEL_SESSIONS);
    const totalPages = Math.max(Math.ceil(sessions.length / SESSIONS_PAGE_SIZE), 1);
    const currentPage = Math.max(0, Math.min(page, totalPages - 1));
    const text = formatSessionsPanel({
      forumTitle: forumChat.title || String(forumChat.id),
      sessions,
      mode: "archived",
      page: currentPage,
      pageSize: SESSIONS_PAGE_SIZE,
    });
    const replyMarkup = buildSessionsKeyboard(sessions, {
      ...sessionKeyboardActions({
        mode: "archived",
        page: currentPage,
      }),
      mode: "archived",
      page: currentPage,
      pageSize: SESSIONS_PAGE_SIZE,
    });

    if (!messageId) {
      return telegram.sendMessage(chatId, text, {
        reply_markup: replyMarkup,
      });
    }

    return editOrSend(chatId, messageId, text, {
      reply_markup: replyMarkup,
    });
  }

  async function renderDmHome(chatId, messageId = null, { userId = chatId } = {}) {
    return editOrSend(
      chatId,
      messageId,
      dmHelpText({
        userId,
        forumTitle: forumChat.title || String(forumChat.id),
      }),
      {
        reply_markup: buildDmHomeKeyboard(),
      },
    );
  }

  async function renderProviderPicker(chatId, messageId = null) {
    const providers = listAvailableProviders(codexConfig);
    const text = [
      "New session",
      "",
      "Choose which agent to start.",
    ].join("\n");

    const replyMarkup = {
      inline_keyboard: [
        ...providers.map((provider) => ([
          {
            text: formatProviderName(provider),
            callback_data: `new:provider:${provider}`,
          },
        ])),
        [
          {
            text: "Back",
            callback_data: "dm:help",
          },
        ],
      ],
    };

    return editOrSend(chatId, messageId, text, {
      reply_markup: replyMarkup,
    });
  }

  async function renderHostPicker(chatId, messageId = null, provider = codexConfig.defaultProvider) {
    const hosts = (await store.listHosts()).filter((host) => host.roots.length > 0);
    const providerName = formatProviderName(provider);

    const text = hosts.length === 0
      ? [
          "New session",
          "",
          "No nodes are available yet.",
          "Wait for the hub or a worker to heartbeat, then try again.",
        ].join("\n")
      : [
          "New session",
          "",
          `provider: ${providerName}`,
          "Choose where to start the new agent session.",
        ].join("\n");

    const replyMarkup = hosts.length === 0
      ? buildDmHomeKeyboard()
      : {
          inline_keyboard: [
            ...hosts.map((host) => {
      const token = issueUiToken({
        provider,
        hostId: host.id,
      });

              return [{
                text: formatHostButtonLabel(host),
                callback_data: `new:host:${token}`,
              }];
            }),
            [
              {
                text: "Providers",
                callback_data: "dm:new",
              },
            ],
          ],
        };

    return editOrSend(chatId, messageId, text, {
      reply_markup: replyMarkup,
    });
  }

  async function renderRootPicker(chatId, messageId, context) {
    const provider = normalizeProviderChoice(codexConfig, context.provider);
    const host = await store.getHost(context.hostId);
    const providerName = formatProviderName(provider);

    if (!host) {
      return editOrSend(chatId, messageId, "Node not found. Start again from New Session.", {
        reply_markup: buildDmHomeKeyboard(),
      });
    }

    const rows = host.roots.map((rootPath) => {
      const token = issueUiToken({
        provider,
        hostId: host.id,
        rootPath,
        path: rootPath,
        page: 0,
      });

      return [{
        text: displayPath(rootPath),
        callback_data: `new:browse:${token}`,
      }];
    });

    rows.push([
      {
        text: "Nodes",
        callback_data: `new:provider:${provider}`,
      },
    ]);

    return editOrSend(
      chatId,
      messageId,
      [
        "New session",
        "",
        `provider: ${providerName}`,
        `node: ${host.label}`,
        "Choose a starting place.",
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: rows,
        },
      },
    );
  }

  async function renderDirectoryPicker(chatId, messageId, context) {
    const entries = await listBrowsableDirectories(context.hostId, context.rootPath, context.path);
    const pageSize = 10;
    const maxPage = Math.max(Math.ceil(entries.length / pageSize) - 1, 0);
    const page = Math.max(0, Math.min(context.page || 0, maxPage));
    const pageEntries = entries.slice(page * pageSize, (page + 1) * pageSize);
    const host = await store.getHost(context.hostId);
    const rows = pageEntries.map((entry) => {
      const token = issueUiToken({
        provider: normalizeProviderChoice(codexConfig, context.provider),
        hostId: context.hostId,
        rootPath: context.rootPath,
        path: entry.path,
        page: 0,
      });

      return [{
        text: entry.name,
        callback_data: `new:browse:${token}`,
      }];
    });

    rows.push([
      {
        text: "Use This Folder",
        callback_data: `new:use:${issueUiToken({
          provider: normalizeProviderChoice(codexConfig, context.provider),
          hostId: context.hostId,
          rootPath: context.rootPath,
          path: context.path,
          page,
        })}`,
      },
    ]);

    const navRow = [];

    if (context.path !== context.rootPath) {
      navRow.push({
        text: "Up",
        callback_data: `new:browse:${issueUiToken({
          provider: normalizeProviderChoice(codexConfig, context.provider),
          hostId: context.hostId,
          rootPath: context.rootPath,
          path: path.dirname(context.path),
          page: 0,
        })}`,
      });
    }

    if (page > 0) {
      navRow.push({
        text: "Prev",
        callback_data: `new:browse:${issueUiToken({
          provider: normalizeProviderChoice(codexConfig, context.provider),
          hostId: context.hostId,
          rootPath: context.rootPath,
          path: context.path,
          page: page - 1,
        })}`,
      });
    }

    if (page < maxPage) {
      navRow.push({
        text: "Next",
        callback_data: `new:browse:${issueUiToken({
          provider: normalizeProviderChoice(codexConfig, context.provider),
          hostId: context.hostId,
          rootPath: context.rootPath,
          path: context.path,
          page: page + 1,
        })}`,
      });
    }

    if (navRow.length > 0) {
      rows.push(navRow);
    }

    rows.push([
      {
        text: "Places",
        callback_data: `new:roots:${issueUiToken({
          provider: normalizeProviderChoice(codexConfig, context.provider),
          hostId: context.hostId,
        })}`,
      },
      {
        text: "Providers",
        callback_data: "dm:new",
      },
    ]);

    const lines = [
      "New session",
      "",
      `provider: ${formatProviderName(context.provider)}`,
      `node: ${host?.label || context.hostId}`,
      `root: ${displayPath(context.rootPath)}`,
      `folder: ${displayPath(context.path)}`,
    ];

    if (entries.length === 0) {
      lines.push("", "No subdirectories here. Use This Folder to start here.");
    } else if (maxPage > 0) {
      lines.push("", `subdirs: ${entries.length} total, page ${page + 1}/${maxPage + 1}`);
    }

    return editOrSend(chatId, messageId, lines.join("\n"), {
      reply_markup: {
        inline_keyboard: rows,
      },
    });
  }

  async function renderDmStatus(chatId, messageId = null) {
    await maybeApplySessionRetention();
    const sessions = await store.listSessions({ includeClosed: true });
    return editOrSend(
      chatId,
      messageId,
      formatDmStatus({
        forumTitle: forumChat.title || String(forumChat.id),
        sessions,
      }),
      {
        reply_markup: buildDmHomeKeyboard(),
      },
    );
  }

  async function renderSessionDetails(chatId, messageId, sessionId, panelContext = {}) {
    const session = await store.getSession(sessionId);

    if (!session) {
      return editOrSend(chatId, messageId, "Session not found.");
    }

    return editOrSend(chatId, messageId, formatSessionDetails(session), {
      reply_markup: buildSessionDetailKeyboard(
        session,
        sessionKeyboardActions(panelContext),
      ),
    });
  }

  async function createTopicForSession(
    sessionId,
    { controlChatId, panelMessageId, callbackQueryId, mode = "open", page = 0 },
  ) {
    const session = await store.getSession(sessionId);

    if (!session || session.status === "closed") {
      await telegram.answerCallbackQuery(callbackQueryId, {
        text: "Session not found.",
        show_alert: true,
      });
      await renderSessionsPanel(controlChatId, panelMessageId, page);
      return;
    }

    if (session.status === "bound" && session.topicLink) {
      await telegram.answerCallbackQuery(callbackQueryId, {
        text: "Session already has a topic.",
      });
      await renderSessionDetails(controlChatId, panelMessageId, session.id, { mode, page });
      return;
    }

    await createTopicForNewSession(session);
    await renderSessionDetails(controlChatId, panelMessageId, session.id, { mode, page });
    await telegram.answerCallbackQuery(callbackQueryId, {
      text: "Topic created. Open Topic.",
    });
  }

  async function createSessionFromDirectory(chatId, messageId, callbackQueryId, context) {
    const host = await store.getHost(context.hostId);

    if (!host) {
      await telegram.answerCallbackQuery(callbackQueryId, {
        text: "Node not found. Start again.",
        show_alert: true,
      });
      return;
    }

    const provider = normalizeProviderChoice(codexConfig, context.provider);
    const defaultModel = resolveProviderModel(codexConfig, provider);
    const resolvedPath = await fs.realpath(context.path).catch(() => context.path);
    const sessionId = randomUUID();
    const session = await store.saveSession({
      id: sessionId,
      label: path.basename(resolvedPath) || resolvedPath,
      threadId: "",
      provider,
      cwd: resolvedPath,
      model: defaultModel,
      latestAssistantMessage: "",
      latestUserPrompt: "",
      createdVia: `${provider}-telegram-ui`,
      createdAt: now(),
      updatedAt: now(),
      status: "headless",
      hostId: context.hostId,
    });

    const boundSession = await createTopicForNewSession(session);

    await renderSessionDetails(chatId, messageId, boundSession.id);
    await telegram.answerCallbackQuery(callbackQueryId, {
      text: "Topic created. Send the first prompt there.",
    });
  }

  async function createTopicForNewSession(session) {
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
        reply_markup: buildTopicKeyboard(session, topicKeyboardActions()),
      },
      );

    return store.bindSession(session.id, {
      forumChatId: forumChat.id,
      topicId: topic.message_thread_id,
      topicName: topic.name || session.label,
      topicLink,
      bootstrapMessageId: bootstrapMessages[0]?.message_id || null,
      updatedAt: now(),
    });
  }

  async function continueBoundSession(sessionId, { prompt, messageThreadId }) {
    let session = await store.getSession(sessionId);

    if (!session || session.status !== "bound") {
      await telegram.sendMessage(
        forumChat.id,
        "This topic is no longer bound to an agent session.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    await waitForSessionAvailability(sessionId);
    session = await store.getSession(sessionId);

    if (!session || session.status !== "bound") {
      await telegram.sendMessage(
        forumChat.id,
        "This topic is no longer bound to an agent session.",
        { message_thread_id: messageThreadId },
      );
      return;
    }

    await store.updateSession(session.id, {
      isBusy: true,
      activeRunSource: "telegram",
      updatedAt: now(),
    });

    try {
      const provider = session.provider || codexConfig.defaultProvider || "codex";
      const result = await runTurn({
        runtime: codexConfig,
        provider,
        prompt,
        cwd: session.cwd || codexConfig.defaultCwd,
        threadId: session.threadId,
        model: session.model || resolveProviderModel(codexConfig, provider),
        onProgress: (update) => {
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

      await telegram.sendLongMessage(forumChat.id, result.message, {
        message_thread_id: messageThreadId,
      });
    } catch (error) {
      await store.updateSession(session.id, {
        isBusy: false,
        activeRunSource: "",
        updatedAt: now(),
      });
      await telegram.sendLongMessage(
        forumChat.id,
        `${formatProviderName(session.provider || codexConfig.defaultProvider || "codex")} failed.\n\n${error.message}`,
        {
        message_thread_id: messageThreadId,
        },
      );
    }
  }

  async function sendLatestReply(chatId, session, options = {}) {
    await telegram.sendLongMessage(chatId, formatLatestReply(session), options);
  }

  async function acknowledgeAcceptedTopicMessage(message) {
    try {
      await telegram.setMessageReaction(
        message.chat.id,
        message.message_id,
        [{ type: "emoji", emoji: "👀" }],
        {
          is_big: false,
        },
      );
    } catch {
      // Best effort only; acceptance must not depend on reaction support.
    }
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

  async function listBrowsableDirectories(hostId, rootPath, directoryPath) {
    if (hostId === botConfig.hostId) {
      return listLocalDirectories(directoryPath, rootPath, codexConfig.startRoots);
    }

    if (!hubServer) {
      throw new Error("Remote directory browsing is not available in single-host mode.");
    }

    return hubServer.requestDirectoryBrowse(hostId, {
      directoryPath,
      rootPath,
    });
  }

  function issueUiToken(payload) {
    const token = randomUUID().slice(0, 12);
    uiTokens.set(token, payload);
    return token;
  }

  function issueSessionActionToken(action, sessionId, extra = {}) {
    return `session:ui:${issueUiToken({
      kind: "session-action",
      action,
      sessionId,
      ...extra,
    })}`;
  }

  function issueTopicActionToken(action, sessionId) {
    return `topic:ui:${issueUiToken({
      kind: "topic-action",
      action,
      sessionId,
    })}`;
  }

  function sessionKeyboardActions({ mode = "open", page = 0 } = {}) {
    return {
      bindSession: (session) => issueSessionActionToken("create", session.id, { mode, page }),
      showSessionDetails: (session) => issueSessionActionToken("details", session.id, { mode, page }),
      showLatestSessionReply: (session) => issueSessionActionToken("latest", session.id, { mode, page }),
      archiveSession: (session) => issueSessionActionToken("archive", session.id, { mode, page }),
      restoreSession: (session) => issueSessionActionToken("restore", session.id, { mode, page }),
      backToSessions: () => `sessions:page:${mode}:${page}`,
      goToPage: (targetMode, targetPage) => `sessions:page:${targetMode}:${targetPage}`,
    };
  }

  function topicKeyboardActions() {
    return {
      showTopicStatus: (session) => issueTopicActionToken("status", session.id),
      showLatestTopicReply: (session) => issueTopicActionToken("latest", session.id),
      detachTopicSession: (session) => issueTopicActionToken("reset", session.id),
      archiveTopicSession: (session) => issueTopicActionToken("archive", session.id),
    };
  }

  async function archiveSession(sessionId, { touchUpdatedAt = true } = {}) {
    const session = await store.getSession(sessionId);

    if (!session || session.status === "closed") {
      return session;
    }

    const archived = await store.updateSession(session.id, {
      status: "closed",
      updatedAt: touchUpdatedAt ? now() : session.updatedAt,
    });

    if (session.forumChatId && session.topicId) {
      try {
        await telegram.closeForumTopic(session.forumChatId, session.topicId);
      } catch (error) {
        logger.error(error);
      }
    }

    return archived;
  }

  async function restoreSession(sessionId) {
    const session = await store.getSession(sessionId);

    if (!session || session.status !== "closed") {
      return session;
    }

    const nextStatus = session.forumChatId && session.topicId ? "bound" : "headless";
    const restored = await store.updateSession(session.id, {
      status: nextStatus,
      updatedAt: now(),
    });

    if (nextStatus === "bound") {
      try {
        await telegram.reopenForumTopic(session.forumChatId, session.topicId);
      } catch (error) {
        logger.error(error);
      }
    }

    return restored;
  }

  async function maybeApplySessionRetention(force = false) {
    const autoArchiveAfterMs = botConfig.sessionRetention?.autoArchiveAfterMs || 0;
    const autoPruneAfterMs = botConfig.sessionRetention?.autoPruneAfterMs || 0;

    if (!autoArchiveAfterMs && !autoPruneAfterMs) {
      return;
    }

    if (!force && clock() - lastRetentionSweepAt < RETENTION_SWEEP_INTERVAL_MS) {
      return;
    }

    lastRetentionSweepAt = clock();

    const sessions = await store.listSessions({ includeClosed: true });
    let archivedCount = 0;
    let prunedCount = 0;

    for (const session of sessions) {
      if (session.isBusy) {
        continue;
      }

      const updatedAtMs = Date.parse(session.updatedAt || session.createdAt || "");

      if (Number.isNaN(updatedAtMs)) {
        continue;
      }

      const ageMs = clock() - updatedAtMs;
      const pendingJobs = await store.listJobsForSession(session.id, {
        statuses: ["queued", "running"],
      });

      if (pendingJobs.length > 0) {
        continue;
      }

      if (session.status === "closed") {
        if (autoPruneAfterMs && ageMs >= autoPruneAfterMs) {
          await pruneSession(session);
          prunedCount += 1;
        }
        continue;
      }

      if (autoArchiveAfterMs && ageMs >= autoArchiveAfterMs) {
        await archiveSession(session.id, {
          touchUpdatedAt: false,
        });
        archivedCount += 1;
      }
    }

    if (archivedCount > 0 || prunedCount > 0) {
      logger.log(`session retention archived=${archivedCount} pruned=${prunedCount}`);
    }
  }

  async function pruneSession(session) {
    if (session.forumChatId && session.topicId && !isGeneralTopicId(session.topicId)) {
      try {
        await telegram.deleteForumTopic(session.forumChatId, session.topicId);
      } catch (error) {
        logger.error(error);
      }
    }

    await store.deleteSession(session.id);
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
    phase: "waiting for agent",
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
    return `Continuing session: ${session.label}\nstate: waiting for agent`;
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

async function listLocalDirectories(directoryPath, rootPath, allowedRoots) {
  const target = await fs.realpath(directoryPath);
  const root = await fs.realpath(rootPath);
  const normalizedRoots = await Promise.all(
    allowedRoots.map((candidate) => fs.realpath(candidate).catch(() => null)),
  );

  if (!normalizedRoots.filter(Boolean).some((candidate) => isInsideRoot(root, candidate))) {
    throw new Error(`Root is not allowed: ${rootPath}`);
  }

  if (!isInsideRoot(target, root)) {
    throw new Error(`Path is outside the selected root: ${directoryPath}`);
  }

  const entries = await fs.readdir(target, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      path: path.join(target, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

  function isInsideRoot(targetPath, rootPath) {
    return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);
  }

  function isGeneralTopicId(topicId) {
    return topicId === undefined || topicId === null || Number(topicId) === 1;
  }

function formatHostButtonLabel(host) {
  const primary = host.label || host.id;
  const roots = host.roots.length > 0 ? displayPath(host.roots[0]) : "no roots";
  return `${truncateButtonText(primary, 16)} • ${truncateButtonText(roots, 18)}`;
}

function resolveProviderModel(runtimeConfig, provider) {
  return runtimeConfig.providers?.[provider]?.model || runtimeConfig.model || "";
}

function listAvailableProviders(runtimeConfig) {
  const providers = Object.keys(runtimeConfig.providers || {});

  if (providers.length > 0) {
    return providers;
  }

  return [runtimeConfig.defaultProvider || "codex"];
}

function normalizeProviderChoice(runtimeConfig, provider) {
  const value = String(provider || "").toLowerCase();
  return listAvailableProviders(runtimeConfig).includes(value)
    ? value
    : (runtimeConfig.defaultProvider || "codex");
}

function unboundTopicText(action = "") {
  const suffix = action ? ` Use Sessions in General or DM to ${action} one.` : "";
  return `No agent session is bound to this topic.${suffix}`;
}

function displayPath(value) {
  const home = process.env.HOME || "";
  const normalized = String(value || "");

  if (home && normalized.startsWith(home)) {
    return `~${normalized.slice(home.length)}`;
  }

  return normalized;
}

function truncateButtonText(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}
