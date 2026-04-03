import fs from "node:fs";
import path from "node:path";
import {
  assertAuthorizedUser,
  getBotConfig,
  getProviderModel,
  getRuntimeConfig,
} from "./config.js";
import { runAgentTurn } from "./agent-runtime.js";
import { formatTopicBootstrapHeader, toTopicName } from "./session-view.js";
import { StateStore } from "./state-store.js";
import { TelegramClient, buildForumTopicUrl } from "./telegram.js";

const botConfig = getBotConfig();
const runtimeConfig = getRuntimeConfig();
const store = new StateStore(botConfig.stateFile, {
  fallbackReadPaths: botConfig.stateFallbackReadPaths,
});
const telegram = new TelegramClient({
  token: botConfig.telegramToken,
  apiBaseUrl: botConfig.telegramApiBaseUrl,
});

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.prompt) {
    printUsage();
    process.exit(1);
  }

  const cwd = resolveCwd(args.cwd || runtimeConfig.defaultCwd);
  const label = args.label || deriveLabel(args.prompt, cwd);
  const defaultProvider = runtimeConfig.defaultProvider || "codex";

  const result = await runAgentTurn({
    runtime: runtimeConfig,
    provider: defaultProvider,
    prompt: args.prompt,
    cwd,
    model: args.model || getProviderModel(runtimeConfig, defaultProvider),
  });

  const now = new Date().toISOString();
  const session = await store.saveSession({
    id: result.threadId,
    label,
    threadId: result.threadId,
    provider: defaultProvider,
    cwd,
    model: args.model || getProviderModel(runtimeConfig, defaultProvider),
    latestAssistantMessage: result.message,
    latestUserPrompt: args.prompt,
    createdVia: `${defaultProvider}-non-interactive-cli`,
    createdAt: now,
    updatedAt: now,
    status: "headless",
    hostId: runtimeConfig.hostId,
  });

  let finalSession = session;

  if (args.createTopic) {
    finalSession = await createTopicForSession(session);
  }

  if (runtimeConfig.hubUrl) {
    await postSessionToHub(finalSession);
  }

  if (args.notifyChat) {
    assertAuthorizedUser(args.notifyChat, botConfig.authorizedUserIds);
    await notifyControlChat(args.notifyChat, finalSession);
  }

  console.log(`session_id=${finalSession.id}`);
  console.log(`thread_id=${finalSession.threadId}`);
  console.log(`provider=${finalSession.provider}`);
  console.log(`status=${finalSession.status}`);

  if (finalSession.topicLink) {
    console.log(`topic_link=${finalSession.topicLink}`);
  }
}

async function createTopicForSession(session) {
  const forumChat = await telegram.getChat(botConfig.forumChatId);

  if (!forumChat.is_forum) {
    throw new Error(
      `TELEGRAM_FORUM_CHAT_ID is not a forum-enabled supergroup: ${botConfig.forumChatId}`,
    );
  }

  const topic = await telegram.createForumTopic(
    forumChat.id,
    toTopicName(session.label),
  );
  const topicLink = buildForumTopicUrl(forumChat, topic.message_thread_id);
  const bootstrapText = formatTopicBootstrapHeader(session, topicLink);
  const bootstrapMessages = session.latestAssistantMessage
    ? await telegram.sendMarkdownMessage(
        forumChat.id,
        session.latestAssistantMessage,
        {
          message_thread_id: topic.message_thread_id,
          prefixText: bootstrapText,
        },
      )
    : await telegram.sendLongMessage(
        forumChat.id,
        bootstrapText,
        {
          message_thread_id: topic.message_thread_id,
        },
      );

  return store.bindSession(session.id, {
    forumChatId: forumChat.id,
    topicId: topic.message_thread_id,
    topicName: topic.name || session.label,
    topicLink,
    bootstrapMessageId: bootstrapMessages[0]?.message_id || null,
  });
}

async function notifyControlChat(chatId, session) {
  const text = [
    `Session: ${session.label}`,
    `id: ${session.id.slice(0, 8)}`,
    `state: ${session.status}`,
    `cwd: ${session.cwd}`,
    session.topicLink
      ? `Topic is ready.`
      : "Session is headless. Use /sessions in DM to create or open a topic.",
  ].join("\n");

  const replyMarkup = session.topicLink
    ? {
        inline_keyboard: [
          [
            {
              text: "Open Topic",
              url: session.topicLink,
            },
          ],
        ],
      }
    : undefined;

  await telegram.sendMessage(chatId, text, {
    reply_markup: replyMarkup,
  });
}

async function postSessionToHub(session) {
  const response = await fetch(`${runtimeConfig.hubUrl.replace(/\/+$/, "")}/api/sessions/upsert`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(runtimeConfig.hubToken ? { "x-relay-token": runtimeConfig.hubToken } : {}),
    },
    body: JSON.stringify(session),
  });

  if (!response.ok) {
    throw new Error(`hub session upsert failed with HTTP ${response.status}`);
  }
}

function parseArgs(argv) {
  const parsed = {
    label: "",
    cwd: "",
    model: "",
    prompt: "",
    notifyChat: "",
    createTopic: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--label") {
      parsed.label = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (value === "--cwd") {
      parsed.cwd = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (value === "--model") {
      parsed.model = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (value === "--notify-chat") {
      parsed.notifyChat = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (value === "--create-topic") {
      parsed.createTopic = true;
      continue;
    }

    if (value === "--prompt") {
      parsed.prompt = argv.slice(index + 1).join(" ").trim();
      break;
    }
  }

  return parsed;
}

function printUsage() {
  console.error(
    [
      "Usage:",
      'npm run start-session -- --label "auth fix" --cwd /abs/path --prompt "your prompt"',
      "Options:",
      "--create-topic   create and bind a Telegram topic immediately",
      "--notify-chat ID send a DM update to an authorized Telegram user",
    ].join("\n"),
  );
}

function resolveCwd(cwd) {
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`cwd does not exist or is not a directory: ${cwd}`);
  }

  return cwd;
}

function deriveLabel(prompt, cwd) {
  const compactPrompt = prompt.replace(/\s+/g, " ").trim();
  const stem = compactPrompt
    .split(" ")
    .slice(0, 6)
    .join(" ")
    .replace(/[^\w\s/-]/g, "")
    .trim();

  if (stem) {
    return stem;
  }

  return path.basename(cwd) || "Untitled session";
}

await main();
