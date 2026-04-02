const TELEGRAM_LIMIT = 4096;

export class TelegramClient {
  constructor({ token, apiBaseUrl }) {
    this.token = token;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
  }

  async getMe() {
    return this.request("getMe", {});
  }

  async getChat(chatId) {
    return this.request("getChat", {
      chat_id: chatId,
    });
  }

  async getFile(fileId) {
    return this.request("getFile", {
      file_id: fileId,
    });
  }

  async getUpdates({ offset, timeoutSeconds }) {
    return this.request("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ["message", "callback_query"],
    });
  }

  async answerCallbackQuery(callbackQueryId, options = {}) {
    return this.request("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...options,
    });
  }

  async setMyCommands(commands, options = {}) {
    return this.request("setMyCommands", {
      commands,
      ...options,
    });
  }

  async getMyCommands(options = {}) {
    return this.request("getMyCommands", options);
  }

  async setChatMenuButton(options = {}) {
    return this.request("setChatMenuButton", options);
  }

  async createForumTopic(chatId, name, options = {}) {
    return this.request("createForumTopic", {
      chat_id: chatId,
      name,
      ...options,
    });
  }

  async closeForumTopic(chatId, topicId) {
    return this.request("closeForumTopic", {
      chat_id: chatId,
      message_thread_id: topicId,
    });
  }

  async reopenForumTopic(chatId, topicId) {
    return this.request("reopenForumTopic", {
      chat_id: chatId,
      message_thread_id: topicId,
    });
  }

  async deleteForumTopic(chatId, topicId) {
    return this.request("deleteForumTopic", {
      chat_id: chatId,
      message_thread_id: topicId,
    });
  }

  async sendChatAction(chatId, action = "typing", options = {}) {
    return this.request("sendChatAction", {
      chat_id: chatId,
      action,
      ...options,
    });
  }

  async setMessageReaction(chatId, messageId, reaction, options = {}) {
    return this.request("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction,
      ...options,
    });
  }

  async sendMessage(chatId, text, options = {}) {
    return this.request("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...options,
    });
  }

  async editMessage(chatId, messageId, text, options = {}) {
    return this.request("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      ...options,
    });
  }

  async editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    return this.request("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  }

  async sendLongMessage(chatId, text, options = {}) {
    const chunks = splitTelegramText(text);
    const sent = [];

    for (const chunk of chunks) {
      sent.push(await this.sendMessage(chatId, chunk, options));
    }

    return sent;
  }

  async replaceProgressMessage(chatId, progressMessage, text, options = {}) {
    const chunks = splitTelegramText(text);

    if (progressMessage) {
      try {
        await this.editMessage(
          chatId,
          progressMessage.message_id,
          chunks[0],
          options,
        );
      } catch (error) {
        if (!String(error.message).includes("message is not modified")) {
          await this.sendMessage(chatId, chunks[0], options);
        }
      }
    } else {
      await this.sendMessage(chatId, chunks[0], options);
    }

    for (const chunk of chunks.slice(1)) {
      await this.sendMessage(chatId, chunk, options);
    }
  }

  async downloadFile(filePath) {
    const response = await fetch(
      `${this.apiBaseUrl}/file/bot${this.token}/${String(filePath).replace(/^\/+/, "")}`,
    );

    if (!response.ok) {
      throw new Error(
        `Telegram HTTP ${response.status} downloading file ${filePath}: ${await response.text()}`,
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async request(method, payload) {
    const response = await fetch(
      `${this.apiBaseUrl}/bot${this.token}/${method}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

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
}

export function buildForumTopicUrl(chat, topicId) {
  if (chat.username) {
    return `https://t.me/${chat.username}/${topicId}`;
  }

  const internalChatId = normalizeInternalChatId(chat.id);
  return `https://t.me/c/${internalChatId}/${topicId}`;
}

export function splitTelegramText(text, limit = TELEGRAM_LIMIT) {
  if (text.length <= limit) {
    return [text];
  }

  const chunks = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitIndex = remaining.lastIndexOf("\n", limit);

    if (splitIndex < Math.floor(limit * 0.5)) {
      splitIndex = remaining.lastIndexOf(" ", limit);
    }

    if (splitIndex < Math.floor(limit * 0.5)) {
      splitIndex = limit;
    }

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function normalizeInternalChatId(chatId) {
  const raw = String(chatId);

  if (raw.startsWith("-100")) {
    return raw.slice(4);
  }

  if (raw.startsWith("-")) {
    return raw.slice(1);
  }

  if (raw) {
    return raw;
  }

  throw new Error(`Unable to build Telegram topic URL for chat id: ${chatId}`);
}
