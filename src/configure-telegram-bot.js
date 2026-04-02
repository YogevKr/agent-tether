import { getBotConfig } from "./config.js";
import { TelegramClient } from "./telegram.js";

const botConfig = getBotConfig();
const telegram = new TelegramClient({
  token: botConfig.telegramToken,
  apiBaseUrl: botConfig.telegramApiBaseUrl,
});

const PRIVATE_COMMANDS = [
  {
    command: "start",
    description: "Open the Agent Tether home panel",
  },
  {
    command: "help",
    description: "Show help and the home buttons",
  },
  {
    command: "sessions",
    description: "List indexed local agent sessions",
  },
  {
    command: "new",
    description: "Create a new session from Telegram",
  },
  {
    command: "status",
    description: "Show forum and session counts",
  },
  {
    command: "chatid",
    description: "Show your Telegram user id",
  },
];

const GROUP_COMMANDS = [
  {
    command: "help",
    description: "Show topic controls",
  },
  {
    command: "status",
    description: "Show the bound session details",
  },
  {
    command: "latest",
    description: "Resend the latest assistant reply",
  },
  {
    command: "reset",
    description: "Detach this topic from the session",
  },
];

async function main() {
  const me = await telegram.getMe();

  await telegram.setMyCommands(PRIVATE_COMMANDS, {
    scope: {
      type: "all_private_chats",
    },
  });

  await telegram.setMyCommands(GROUP_COMMANDS, {
    scope: {
      type: "all_group_chats",
    },
  });

  await telegram.setChatMenuButton({
    menu_button: {
      type: "commands",
    },
  });

  console.log(`configured bot commands for @${me.username}`);
}

await main();
