import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadEnvFiles } from "./env.js";

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

loadEnvFiles(PROJECT_ROOT);

export function getBotConfig() {
  const stateStore = getStateStoreConfig();
  const hostId = getHostIdConfig(stateStore);

  return {
    telegramToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    telegramApiBaseUrl:
      process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org",
    authorizedUserIds: parseCsv(
      process.env.AUTHORIZED_TELEGRAM_USER_IDS || process.env.AUTHORIZED_CHAT_IDS,
    ),
    forumChatId: requireEnv("TELEGRAM_FORUM_CHAT_ID"),
    stateFile: stateStore.filePath,
    stateFallbackReadPaths: stateStore.fallbackReadPaths,
    pollTimeoutSeconds: parsePositiveInt(
      process.env.POLL_TIMEOUT_SECONDS,
      30,
    ),
    hostId: hostId.value,
    hostIdSource: hostId.source,
    hostIdFile: hostId.filePath,
    startRoots: getStartRoots(),
    hubToken: process.env.RELAY_HUB_TOKEN || "",
    hubBindHost: process.env.RELAY_HUB_BIND_HOST || "127.0.0.1",
    hubPort: parsePositiveInt(process.env.RELAY_HUB_PORT, 8787),
    startupWarnings: buildStartupWarnings({
      stateStore,
      hostId,
    }),
    sessionRetention: {
      autoArchiveAfterMs:
        parseNonNegativeInt(process.env.RELAY_AUTO_ARCHIVE_AFTER_DAYS, 14) * 24 * 60 * 60 * 1000,
      autoPruneAfterMs:
        parseNonNegativeInt(process.env.RELAY_AUTO_PRUNE_AFTER_DAYS, 60) * 24 * 60 * 60 * 1000,
    },
    stateCompaction: {
      terminalJobRetentionMs:
        parseNonNegativeInt(process.env.RELAY_TERMINAL_JOB_PRUNE_AFTER_DAYS, 14) * 24 * 60 * 60 * 1000,
      maxTerminalJobs:
        parseNonNegativeInt(process.env.RELAY_MAX_TERMINAL_JOBS, 5000),
    },
  };
}

export function getRuntimeConfig() {
  const defaultProvider = normalizeAgentProvider(process.env.AGENT_PROVIDER || "codex");
  const stateStore = getStateStoreConfig();
  const hostId = getHostIdConfig(stateStore);
  const shared = {
    defaultProvider,
    defaultCwd: resolveExistingDir(
      process.env.CODEX_DEFAULT_CWD || process.cwd(),
      "CODEX_DEFAULT_CWD",
    ),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramApiBaseUrl:
      process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org",
    whisperBin: process.env.WHISPER_BIN || "whisper",
    hostId: hostId.value,
    hostIdSource: hostId.source,
    hostIdFile: hostId.filePath,
    stateFile: stateStore.filePath,
    stateFallbackReadPaths: stateStore.fallbackReadPaths,
    startupWarnings: buildStartupWarnings({
      stateStore,
      hostId,
    }),
    startRoots: getStartRoots(),
    workerConcurrency: parsePositiveInt(process.env.RELAY_WORKER_CONCURRENCY, 4),
    hubUrl: process.env.RELAY_HUB_URL || "",
    hubToken: process.env.RELAY_HUB_TOKEN || "",
    providers: {
      codex: {
        provider: "codex",
        bin: process.env.CODEX_BIN || "codex",
        model: process.env.CODEX_MODEL || "",
        approvalPolicy: process.env.CODEX_APPROVAL_POLICY || "never",
        sandboxMode: process.env.CODEX_SANDBOX_MODE || "workspace-write",
        defaultArgs: parseCommandArgs(process.env.CODEX_DEFAULT_ARGS || "--yolo"),
        skipGitRepoCheck: parseBoolean(
          process.env.CODEX_SKIP_GIT_REPO_CHECK,
          true,
        ),
      },
      claude: {
        provider: "claude",
        bin: process.env.CLAUDE_BIN || "claude",
        model: process.env.CLAUDE_MODEL || "",
        permissionMode: process.env.CLAUDE_PERMISSION_MODE || "",
        defaultArgs: parseCommandArgs(
          process.env.CLAUDE_DEFAULT_ARGS || "--dangerously-skip-permissions",
        ),
      },
    },
  };

  return {
    ...shared,
    ...shared.providers[defaultProvider],
  };
}

export function getCodexConfig() {
  return getRuntimeConfig();
}

export function getProviderConfig(runtimeConfig, provider = "") {
  const selectedProvider = normalizeAgentProvider(provider || runtimeConfig.defaultProvider);
  const selected = runtimeConfig.providers?.[selectedProvider];

  if (!selected) {
    throw new Error(`Unsupported agent provider: ${provider}`);
  }

  return selected;
}

export function getProviderModel(runtimeConfig, provider = "") {
  return getProviderConfig(runtimeConfig, provider).model || runtimeConfig.model || "";
}

export function normalizeAgentProvider(provider) {
  if (String(provider || "").toLowerCase() === "claude") {
    return "claude";
  }

  return "codex";
}

export function getLegacyCodexConfig() {
  const stateStore = getStateStoreConfig();
  const hostId = getHostIdConfig(stateStore);

  return {
    bin: process.env.CODEX_BIN || "codex",
    defaultCwd: resolveExistingDir(
      process.env.CODEX_DEFAULT_CWD || process.cwd(),
      "CODEX_DEFAULT_CWD",
    ),
    model: process.env.CODEX_MODEL || "",
    approvalPolicy: process.env.CODEX_APPROVAL_POLICY || "never",
    sandboxMode: process.env.CODEX_SANDBOX_MODE || "workspace-write",
    defaultArgs: parseCommandArgs(process.env.CODEX_DEFAULT_ARGS || "--yolo"),
    skipGitRepoCheck: parseBoolean(
      process.env.CODEX_SKIP_GIT_REPO_CHECK,
      true,
    ),
    hostId: hostId.value,
    hostIdSource: hostId.source,
    hostIdFile: hostId.filePath,
    stateFile: stateStore.filePath,
    stateFallbackReadPaths: stateStore.fallbackReadPaths,
    startupWarnings: buildStartupWarnings({
      stateStore,
      hostId,
    }),
    startRoots: getStartRoots(),
    hubUrl: process.env.RELAY_HUB_URL || "",
    hubToken: process.env.RELAY_HUB_TOKEN || "",
  };
}

export function getStateFile() {
  return getStateStoreConfig().filePath;
}

export function getStateStoreConfig() {
  if (process.env.STATE_FILE) {
    return {
      filePath: resolveProjectPath(process.env.STATE_FILE),
      fallbackReadPaths: [],
      source: "env",
      isExplicit: true,
    };
  }

  const filePath = getDefaultStateFile();
  const legacyFilePath = getLegacyStateFile();

  return {
    filePath,
    fallbackReadPaths: filePath === legacyFilePath ? [] : [legacyFilePath],
    source: "default",
    isExplicit: false,
  };
}

export function getHostIdConfig(stateStoreConfig = getStateStoreConfig()) {
  if (process.env.RELAY_HOST_ID) {
    return {
      value: process.env.RELAY_HOST_ID,
      source: "env",
      filePath: getDefaultHostIdFile(stateStoreConfig.filePath),
    };
  }

  const filePath = getDefaultHostIdFile(stateStoreConfig.filePath);
  const persisted = readPersistedHostId(filePath);

  if (persisted) {
    return {
      value: persisted,
      source: "state-file",
      filePath,
    };
  }

  const generated = buildGeneratedHostId();

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${generated}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return {
      value: generated,
      source: "generated",
      filePath,
    };
  } catch (error) {
    if (error.code === "EEXIST") {
      const settled = readPersistedHostId(filePath);

      if (settled) {
        return {
          value: settled,
          source: "state-file",
          filePath,
        };
      }
    }

    return {
      value: os.hostname(),
      source: "hostname",
      filePath,
    };
  }
}

export function assertAuthorizedUser(userId, authorizedUserIds) {
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

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseCsv(value) {
  if (!value) {
    return new Set();
  }

  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function resolveProjectPath(filePath) {
  if (String(filePath).startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.resolve(PROJECT_ROOT, filePath);
}

function getDefaultStateFile() {
  return path.join(getDefaultStateDir(), "state.json");
}

function getDefaultHostIdFile(stateFilePath) {
  return path.join(path.dirname(stateFilePath), "host-id");
}

function getLegacyStateFile() {
  return resolveProjectPath("./data/state.json");
}

function getDefaultStateDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "agent-tether");
  }

  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "agent-tether",
    );
  }

  return path.join(
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
    "agent-tether",
  );
}

function readPersistedHostId(filePath) {
  try {
    const persisted = fs.readFileSync(filePath, "utf8").trim();
    return persisted || "";
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

function buildGeneratedHostId() {
  const hostnamePart = String(os.hostname() || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "host";

  return `${hostnamePart}-${randomUUID().slice(0, 8)}`;
}

function buildStartupWarnings({ stateStore, hostId }) {
  const warnings = [];

  if (!stateStore.isExplicit) {
    warnings.push(
      `STATE_FILE is not set. Using ${stateStore.filePath}. In stateless deploys, mount this path or set STATE_FILE to persistent storage.`,
    );
  }

  if (hostId.source === "generated") {
    warnings.push(
      `RELAY_HOST_ID is not set. Generated stable host id ${hostId.value} and persisted it to ${hostId.filePath}. Set RELAY_HOST_ID explicitly if you need a fixed cross-deploy node name.`,
    );
  } else if (hostId.source === "state-file") {
    warnings.push(
      `RELAY_HOST_ID is not set. Reusing persisted host id ${hostId.value} from ${hostId.filePath}. Set RELAY_HOST_ID explicitly if you need a fixed cross-deploy node name.`,
    );
  } else if (hostId.source === "hostname") {
    warnings.push(
      `RELAY_HOST_ID is not set and ${hostId.filePath} was not writable. Falling back to hostname ${hostId.value}; this can drift across deploys.`,
    );
  }

  return warnings;
}

function resolveExistingDir(dirPath, envName) {
  const resolved = resolveProjectPath(dirPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`${envName} does not exist: ${resolved}`);
  }

  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`${envName} is not a directory: ${resolved}`);
  }

  return resolved;
}

function parseBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parsePositiveInt(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseNonNegativeInt(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function getStartRoots() {
  const configured = parseCsv(process.env.RELAY_START_ROOTS || "");
  const fallback = [
    "~/repos",
    "~/projects",
    process.env.CODEX_DEFAULT_CWD || process.cwd(),
  ];

  const candidates = (configured.size > 0 ? [...configured] : fallback)
    .map((item) => resolveProjectPath(item))
    .filter((item, index, items) => item && items.indexOf(item) === index);

  return candidates.filter((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
}

function parseCommandArgs(value) {
  const trimmed = String(value || "").trim();

  if (!trimmed) {
    return [];
  }

  return trimmed.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) || [];
}
