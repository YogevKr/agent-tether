import fs from "node:fs/promises";
import { getBotConfig, getCodexConfig } from "./config.js";
import {
  CLAUDE_SETTINGS_PATH,
  HOOKS_PATH,
  hasClaudeHooksInstalled,
  hasCodexHooksInstalled,
} from "./hook-config.js";
import {
  findMissingRequiredHosts,
  parseRequiredHostRefs,
  partitionHostsByHeartbeat,
} from "./smoke-health.js";
import { TelegramClient } from "./telegram.js";

const botConfig = getBotConfig();
const codexConfig = getCodexConfig();
const telegram = new TelegramClient({
  token: botConfig.telegramToken,
  apiBaseUrl: botConfig.telegramApiBaseUrl,
});

const HEARTBEAT_MAX_AGE_MS = Number.parseInt(
  process.env.RELAY_SMOKE_HEARTBEAT_MAX_AGE_MS || "300000",
  10,
);

async function main() {
  const hubUrl = (codexConfig.hubUrl || `http://${botConfig.hubBindHost}:${botConfig.hubPort}`)
    .replace(/\/+$/, "");
  const [health, me, forumChat, privateCommands, groupCommands, hosts, hookStatus] = await Promise.all([
    fetchHubHealth(hubUrl),
    telegram.getMe(),
    telegram.getChat(botConfig.forumChatId),
    telegram.getMyCommands({
      scope: { type: "all_private_chats" },
    }),
    telegram.getMyCommands({
      scope: { type: "all_group_chats" },
    }),
    fetchHubHosts(hubUrl),
    readLocalHookStatus(),
  ]);

  const requiredHostRefs = parseRequiredHostRefs(
    process.env.RELAY_SMOKE_REQUIRED_HOSTS,
    codexConfig.hostId,
  );
  const { freshHosts, staleHosts } = partitionHostsByHeartbeat(hosts, {
    maxAgeMs: HEARTBEAT_MAX_AGE_MS,
  });
  const missingRequiredHosts = findMissingRequiredHosts(freshHosts, requiredHostRefs);

  assert(health.ok, "hub health check failed");
  assert(Boolean(me.username), "bot username missing");
  assert(Boolean(forumChat.is_forum), "forum chat is not a forum-enabled supergroup");
  assert(privateCommands.length > 0, "private bot commands are not configured");
  assert(groupCommands.length > 0, "group bot commands are not configured");
  assert(hookStatus.codex, `codex hooks missing in ${HOOKS_PATH}`);
  assert(hookStatus.claude, `claude hooks missing in ${CLAUDE_SETTINGS_PATH}`);
  assert(
    freshHosts.length > 0,
    `no fresh host heartbeats within ${Math.round(HEARTBEAT_MAX_AGE_MS / 1000)}s`,
  );
  assert(
    missingRequiredHosts.length === 0,
    [
      `missing fresh required host heartbeat(s) within ${Math.round(HEARTBEAT_MAX_AGE_MS / 1000)}s: ${missingRequiredHosts.join(", ")}`,
      `fresh hosts: ${freshHosts.map((host) => host.label || host.id).join(", ") || "(none)"}`,
    ].join("; "),
  );

  console.log(`smoke ok bot=@${me.username}`);
  console.log(`hub=${hubUrl}`);
  console.log(`forum=${forumChat.title || forumChat.id}`);
  console.log(`private_commands=${privateCommands.length}`);
  console.log(`group_commands=${groupCommands.length}`);
  console.log(`hooks=codex,claude`);
  console.log(`required_hosts=${requiredHostRefs.join(", ") || "(none)"}`);
  console.log(`fresh_hosts=${freshHosts.map((host) => host.label).join(", ")}`);

  if (staleHosts.length > 0) {
    console.log(`stale_hosts=${staleHosts.map((host) => host.label).join(", ")}`);
  }
}

async function fetchHubHealth(hubUrl) {
  const response = await fetch(`${hubUrl}/api/health`, {
    headers: buildHubHeaders(),
  });

  if (!response.ok) {
    throw new Error(`hub health failed with HTTP ${response.status}`);
  }

  return response.json();
}

async function readLocalHookStatus() {
  const [codexHooks, claudeSettings] = await Promise.all([
    readJsonFile(HOOKS_PATH),
    readJsonFile(CLAUDE_SETTINGS_PATH),
  ]);

  return {
    codex: hasCodexHooksInstalled(codexHooks),
    claude: hasClaudeHooksInstalled(claudeSettings),
  };
}

async function fetchHubHosts(hubUrl) {
  const response = await fetch(`${hubUrl}/api/status`, {
    headers: buildHubHeaders(),
  });

  if (!response.ok) {
    throw new Error(`hub status failed with HTTP ${response.status}`);
  }

  const body = await response.json();
  return body.hosts || [];
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");

  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function buildHubHeaders() {
  return codexConfig.hubToken
    ? {
        "x-relay-token": codexConfig.hubToken,
      }
    : {};
}

await main();
