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
    command: "archived",
    description: "List archived sessions",
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
    command: "sessions",
    description: "List sessions in General; topic-safe elsewhere",
  },
  {
    command: "archived",
    description: "List archived sessions in General",
  },
  {
    command: "new",
    description: "Create a new session from General",
  },
  {
    command: "help",
    description: "Show General or topic controls",
  },
  {
    command: "status",
    description: "Show relay status or bound session details",
  },
  {
    command: "chatid",
    description: "Show your Telegram user id",
  },
  {
    command: "latest",
    description: "Resend the latest assistant reply",
  },
  {
    command: "reset",
    description: "Detach this topic from the session",
  },
  {
    command: "archive",
    description: "Archive this topic session",
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
