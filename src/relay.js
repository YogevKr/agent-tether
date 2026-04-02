import { getBotConfig, getCodexConfig } from "./config.js";
import { createHubServer } from "./hub-server.js";
import { createRelayApp } from "./relay-app.js";
import { StateStore } from "./state-store.js";
import { TelegramClient } from "./telegram.js";

const botConfig = getBotConfig();
const codexConfig = getCodexConfig();
const telegram = new TelegramClient({
  token: botConfig.telegramToken,
  apiBaseUrl: botConfig.telegramApiBaseUrl,
});
const store = new StateStore(botConfig.stateFile);
const hubServer = createHubServer({
  botConfig,
  codexConfig,
  store,
  telegram,
});

const app = createRelayApp({
  botConfig,
  codexConfig,
  telegram,
  store,
  hubServer,
});

await app.run();
