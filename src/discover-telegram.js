import { loadEnvFiles } from "./env.js";

loadEnvFiles();

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN in environment or .env.");
  process.exit(1);
}

const apiBaseUrl =
  (process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org").replace(
    /\/+$/,
    "",
  );

async function main() {
  const me = await request("getMe", {});
  const updates = await request("getUpdates", {
    offset: parseOffset(process.argv.slice(2)),
    timeout: 3,
    allowed_updates: ["message", "callback_query"],
  });

  console.log(`bot=@${me.username || "unknown"} id=${me.id}`);

  if (updates.length === 0) {
    console.log("No recent updates.");
    console.log("Next step:");
    console.log("1. DM the bot /chatid");
    console.log("2. Send a message in the target forum group");
    console.log("3. Run npm run discover-telegram again");
    return;
  }

  const seen = new Set();

  for (const update of updates) {
    const item = update.message || update.callback_query?.message;

    if (!item?.chat) {
      continue;
    }

    const from = update.message?.from || update.callback_query?.from || null;
    const chat = item.chat;
    const topicId = item.message_thread_id || null;
    const key = [
      chat.id,
      chat.type,
      from?.id || "",
      topicId || "",
      item.text || "",
    ].join("|");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    console.log("");
    console.log(formatUpdate({ update, chat, from, topicId }));
  }
}

function parseOffset(argv) {
  const index = argv.indexOf("--offset");
  if (index === -1) {
    return 0;
  }

  const raw = argv[index + 1];
  const parsed = Number.parseInt(raw || "0", 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatUpdate({ update, chat, from, topicId }) {
  const lines = [
    `update_id: ${update.update_id}`,
    `chat_type: ${chat.type}`,
    `chat_id: ${chat.id}`,
  ];

  if (chat.title) {
    lines.push(`chat_title: ${chat.title}`);
  }

  if (chat.username) {
    lines.push(`chat_username: @${chat.username}`);
  }

  if (from?.id) {
    lines.push(`from_user_id: ${from.id}`);
  }

  if (from?.username) {
    lines.push(`from_username: @${from.username}`);
  }

  if (topicId) {
    lines.push(`message_thread_id: ${topicId}`);
  }

  if (update.message?.is_topic_message) {
    lines.push("is_topic_message: true");
  }

  if (update.message?.text) {
    lines.push(`text: ${JSON.stringify(update.message.text)}`);
  }

  if (update.callback_query?.data) {
    lines.push(`callback_data: ${JSON.stringify(update.callback_query.data)}`);
  }

  return lines.join("\n");
}

async function request(method, payload) {
  const response = await fetch(`${apiBaseUrl}/bot${token}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(
      `Telegram HTTP ${response.status} calling ${method}: ${await response.text()}`,
    );
  }

  const body = await response.json();

  if (!body.ok) {
    throw new Error(
      `Telegram API error calling ${method}: ${body.description || "unknown error"}`,
    );
  }

  return body.result;
}

await main();
