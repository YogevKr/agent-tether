import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { applyHookEvent, stopHookResponse } from "./hook-index.js";
import { StateStore } from "./state-store.js";

const HOOK_WORKER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "hook-worker.js",
);
const QUEUE_LOCK_FILE = ".drain.lock";
const QUEUE_LOCK_TIMEOUT_MS = 5000;
const QUEUE_LOCK_RETRY_MS = 25;
const QUEUE_STALE_LOCK_MS = 60 * 1000;

export async function runProviderHook(provider, runtimeConfig, {
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  spawnWorker = spawnHookWorker,
} = {}) {
  const input = await readJsonStdin(stdin);
  const enrichedInput = buildHookPayload(input, {
    provider,
    hostId: runtimeConfig.hostId,
  });

  try {
    if (runtimeConfig.hookMode === "sync") {
      await dispatchHookEvent(runtimeConfig, enrichedInput);
    } else {
      await enqueueHookEvent(runtimeConfig, enrichedInput);
      spawnWorker();
    }
  } catch (error) {
    stderr.write(`[agent-tether] hook indexing failed: ${error.message}\n`);

    if (runtimeConfig.hookMode !== "sync") {
      await dispatchHookEvent(runtimeConfig, enrichedInput).catch((fallbackError) => {
        stderr.write(`[agent-tether] fallback hook indexing failed: ${fallbackError.message}\n`);
      });
    }
  }

  if (isStopHook(enrichedInput)) {
    stdout.write(`${JSON.stringify(stopHookResponse())}\n`);
  }
}

export function buildHookPayload(input, { provider, hostId }) {
  return {
    ...input,
    host_id: input.host_id || hostId,
    provider,
  };
}

export async function dispatchHookEvent(runtimeConfig, payload) {
  if (runtimeConfig.hubUrl) {
    await postHookToHub(runtimeConfig.hubUrl, runtimeConfig.hubToken, payload, {
      timeoutMs: runtimeConfig.hookTimeoutMs,
    });
    return;
  }

  const store = new StateStore(runtimeConfig.stateFile, {
    fallbackReadPaths: runtimeConfig.stateFallbackReadPaths,
  });
  await applyHookEvent(store, payload);
}

export async function enqueueHookEvent(runtimeConfig, payload) {
  await fs.mkdir(runtimeConfig.hookQueueDir, { recursive: true });

  const fileName = buildQueueFileName();
  const finalPath = path.join(runtimeConfig.hookQueueDir, fileName);
  const tempPath = path.join(
    runtimeConfig.hookQueueDir,
    `.${fileName}.${process.pid}.tmp`,
  );

  try {
    await fs.writeFile(tempPath, `${JSON.stringify(payload)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tempPath, finalPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }

  return finalPath;
}

export async function drainHookQueue(runtimeConfig, {
  dispatch = dispatchHookEvent,
  logger = console,
} = {}) {
  await fs.mkdir(runtimeConfig.hookQueueDir, { recursive: true });
  const releaseLock = await acquireQueueLock(runtimeConfig.hookQueueDir);

  if (!releaseLock) {
    return false;
  }

  try {
    while (true) {
      const files = await listQueuedHookFiles(runtimeConfig.hookQueueDir);

      if (files.length === 0) {
        return true;
      }

      for (const filePath of files) {
        await processQueuedHookFile(filePath, runtimeConfig, { dispatch, logger });
      }
    }
  } finally {
    await releaseLock();
  }
}

export function spawnHookWorker() {
  const child = spawn(process.execPath, [HOOK_WORKER_PATH], {
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.unref();
}

export async function postHookToHub(hubUrl, hubToken, payload, { timeoutMs = 2000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetch(`${hubUrl.replace(/\/+$/, "")}/api/hooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(hubToken ? { "x-relay-token": hubToken } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`hub hook ingest failed with HTTP ${response.status}`);
    }
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`hub hook ingest timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonStdin(stdin) {
  const chunks = [];

  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();

  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

function isStopHook(input) {
  return String(input.hook_event_name || "") === "Stop";
}

function buildQueueFileName() {
  const now = String(Date.now()).padStart(13, "0");
  const monotonic = process.hrtime.bigint().toString().padStart(20, "0");
  return `${now}-${monotonic}-${randomUUID()}.json`;
}

async function acquireQueueLock(queueDir, {
  timeoutMs = QUEUE_LOCK_TIMEOUT_MS,
  retryMs = QUEUE_LOCK_RETRY_MS,
  staleLockMs = QUEUE_STALE_LOCK_MS,
} = {}) {
  const lockPath = path.join(queueDir, QUEUE_LOCK_FILE);
  const startedAt = Date.now();

  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
      } finally {
        await handle.close();
      }
      return () => fs.rm(lockPath, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      await removeStaleQueueLock(lockPath, staleLockMs);

      if (Date.now() - startedAt >= timeoutMs) {
        return null;
      }

      await sleep(retryMs);
    }
  }
}

async function removeStaleQueueLock(lockPath, staleLockMs) {
  const stat = await fs.stat(lockPath).catch((error) => {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  });

  if (!stat || Date.now() - stat.mtimeMs < staleLockMs) {
    return;
  }

  await fs.rm(lockPath, { force: true });
}

async function listQueuedHookFiles(queueDir) {
  const entries = await fs.readdir(queueDir).catch((error) => {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  });

  return entries
    .filter((entry) => entry.endsWith(".json") && !entry.startsWith("."))
    .sort()
    .map((entry) => path.join(queueDir, entry));
}

async function processQueuedHookFile(filePath, runtimeConfig, { dispatch, logger }) {
  let payload;

  try {
    payload = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.error(`[agent-tether] failed to read queued hook ${filePath}: ${error.message}`);
      await fs.rm(filePath, { force: true }).catch(() => {});
    }
    return;
  }

  try {
    await dispatch(runtimeConfig, payload);
  } catch (error) {
    logger.error(`[agent-tether] hook indexing failed: ${error.message}`);
  } finally {
    await fs.rm(filePath, { force: true }).catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
