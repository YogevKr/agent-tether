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
const store = new StateStore(botConfig.stateFile, {
  fallbackReadPaths: botConfig.stateFallbackReadPaths,
});
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

logStartup();
await app.run();

function logStartup() {
  for (const warning of botConfig.startupWarnings || []) {
    console.warn(`warning: ${warning}`);
  }

  console.log(
    `relay up host=${botConfig.hostId} source=${botConfig.hostIdSource} state=${botConfig.stateFile}`,
  );
}
