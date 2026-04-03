import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareTelegramAttachments } from "./attachments.js";
import { getProviderModel, getRuntimeConfig } from "./config.js";
import { applyProgressUpdate, createProgressState } from "./relay-app.js";
import { runAgentTurn } from "./agent-runtime.js";
import { TelegramClient } from "./telegram.js";

const codexConfig = getRuntimeConfig();
const telegram = codexConfig.telegramToken
  ? new TelegramClient({
      token: codexConfig.telegramToken,
      apiBaseUrl: codexConfig.telegramApiBaseUrl,
    })
  : null;
const TYPING_HEARTBEAT_MS = 4000;
const COMPLETE_RETRY_BASE_MS = 1000;
const COMPLETE_RETRY_MAX_MS = 5000;

async function main() {
  if (!codexConfig.hubUrl) {
    throw new Error("RELAY_HUB_URL is required for worker mode.");
  }

  console.log(
    `worker up host=${codexConfig.hostId} hub=${codexConfig.hubUrl} concurrency=${codexConfig.workerConcurrency}`,
  );

  await recoverInterruptedJobsOnHub().catch((error) => {
    console.error("worker recovery failed:", formatError(error));
  });

  await Promise.all(
    Array.from({ length: codexConfig.workerConcurrency }, () =>
      runWorkerLane({
        pullNextJob: pullNextJobFromHub,
        executeJob,
        sleep,
        onError(error) {
          console.error("worker poll failed:", formatError(error));
        },
      })),
  );
}

export async function runWorkerLane({
  pullNextJob,
  executeJob,
  sleep,
  onError = () => {},
  shouldContinue = () => true,
  idleSleepMs = 1500,
  errorSleepMs = 3000,
} = {}) {
  while (shouldContinue()) {
    try {
      const pulled = await pullNextJob();

      if (!pulled?.job) {
        if (shouldContinue()) {
          await sleep(idleSleepMs);
        }
        continue;
      }

      if (pulled.job.kind === "run-turn" && !pulled?.session) {
        if (shouldContinue()) {
          await sleep(idleSleepMs);
        }
        continue;
      }

      await executeJob(pulled.job, pulled.session || null);
    } catch (error) {
      onError(error);

      if (shouldContinue()) {
        await sleep(errorSleepMs);
      }
    }
  }
}

async function pullNextJobFromHub() {
  return postJson(`${codexConfig.hubUrl}/api/jobs/pull`, {
    hostId: codexConfig.hostId,
    label: codexConfig.hostId,
    defaultCwd: codexConfig.defaultCwd,
    roots: codexConfig.startRoots,
  });
}

async function executeJob(job, session) {
  let attachments = null;
  let stopMonitor = async () => {};
  let stopTypingHeartbeat = () => {};
  const controller = new AbortController();
  const progressReporter = createHubProgressReporter({ job, session });

  try {
    if (job.kind === "browse-dir") {
      const entries = await listDirectories(job.browsePath, job.rootPath, codexConfig.startRoots);
      await completeJobOnHub(job.id, {
        entries,
      });
      return;
    }

    attachments = await prepareAttachments(job);
    stopMonitor = monitorJobCancellation(job.id, controller);
    stopTypingHeartbeat = startTypingHeartbeat(job);

    const result = await runAgentTurn({
      runtime: codexConfig,
      provider: session.provider || codexConfig.defaultProvider || "codex",
      prompt: attachments.prompt,
      cwd: session.cwd || codexConfig.defaultCwd,
      threadId: session.threadId,
      model: session.model || getProviderModel(codexConfig, session.provider),
      attachments,
      signal: controller.signal,
      onProgress: (update) => {
        progressReporter.onProgress(update);
      },
    });

    await progressReporter.close();
    await completeJobOnHub(job.id, {
      threadId: result.threadId,
      message: result.message,
    });
  } catch (error) {
    await progressReporter.close();
    await completeJobOnHub(job.id, {
      cancelled: controller.signal.aborted,
      error: controller.signal.aborted ? "Stopped from Telegram." : error.message,
    });
  } finally {
    stopTypingHeartbeat();
    await stopMonitor();
    await attachments?.cleanup?.().catch(() => {});
  }
}

async function postJson(url, payload, { token = codexConfig.hubToken } = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-relay-token": token } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(detail || `HTTP ${response.status} calling ${url}`);
    error.statusCode = response.status;
    throw error;
  }

  return response.json();
}

async function getJson(url, { token = codexConfig.hubToken } = {}) {
  const response = await fetch(url, {
    headers: {
      ...(token ? { "x-relay-token": token } : {}),
    },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(detail || `HTTP ${response.status} calling ${url}`);
    error.statusCode = response.status;
    throw error;
  }

  return response.json();
}

export async function completeJobOnHub(
  jobId,
  payload,
  {
    hubUrl = codexConfig.hubUrl,
    hubToken = codexConfig.hubToken,
    sleep = defaultSleep,
    logger = console,
  } = {},
) {
  let delayMs = COMPLETE_RETRY_BASE_MS;
  let attempt = 0;

  while (true) {
    try {
      return await postJson(`${hubUrl}/api/jobs/${jobId}/complete`, payload, {
        token: hubToken,
      });
    } catch (error) {
      if (!shouldRetryHubRequest(error)) {
        throw error;
      }

      attempt += 1;
      logger.error(
        `worker completion retry job=${jobId} attempt=${attempt}: ${error.message || error}`,
      );
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, COMPLETE_RETRY_MAX_MS);
    }
  }
}

async function recoverInterruptedJobsOnHub() {
  return postJson(
    `${codexConfig.hubUrl}/api/hosts/${encodeURIComponent(codexConfig.hostId)}/recover`,
    {},
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSleep(ms) {
  return sleep(ms);
}

function startTypingHeartbeat(job) {
  if (!telegram || !job.chatId || !job.messageThreadId) {
    return () => {};
  }

  const sendTyping = () => {
    void telegram.sendChatAction(job.chatId, "typing", {
      message_thread_id: job.messageThreadId,
    }).catch(() => {});
  };

  sendTyping();
  const timer = setInterval(sendTyping, TYPING_HEARTBEAT_MS);
  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
}

function createHubProgressReporter({ job, session }) {
  if (!job.progressMessageId || !session) {
    return {
      onProgress() {},
      async close() {},
    };
  }

  const progressState = {
    ...createProgressState(session),
    ...(job.progressState || {}),
  };
  let lastFlushAt = 0;
  let flushPromise = Promise.resolve();
  let flushTimer = null;

  const flush = async () => {
    flushTimer = null;

    try {
      await postJson(`${codexConfig.hubUrl}/api/jobs/${job.id}/progress`, {
        update: progressState,
      });
      lastFlushAt = Date.now();
    } catch (error) {
      console.error("worker progress update failed:", formatError(error));
    }
  };

  const scheduleFlush = () => {
    if (flushTimer) {
      return;
    }

    const remainingMs = Math.max(0, 900 - (Date.now() - lastFlushAt));

    if (lastFlushAt === 0 || remainingMs === 0) {
      flushPromise = flushPromise.then(flush);
      return;
    }

    flushTimer = setTimeout(() => {
      flushPromise = flushPromise.then(flush);
    }, remainingMs);
  };

  return {
    onProgress(update) {
      applyProgressUpdate(progressState, update);
      scheduleFlush();
    },
    async close() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      await flushPromise;
    },
  };
}

async function prepareAttachments(job) {
  if (!telegram) {
    return {
      prompt: job.prompt,
      imagePaths: [],
      extraDirs: [],
      cleanup: async () => {},
    };
  }

  return prepareTelegramAttachments({
    job,
    telegram,
    runtime: codexConfig,
  });
}

function monitorJobCancellation(jobId, controller) {
  let stopped = false;
  const loop = (async () => {
    while (!stopped && !controller.signal.aborted) {
      await sleep(1000);

      if (stopped || controller.signal.aborted) {
        return;
      }

      try {
        const payload = await getJson(`${codexConfig.hubUrl}/api/jobs/${jobId}`);
        const latest = payload?.job;

        if (latest?.cancelRequestedAt || latest?.status === "cancelled") {
          controller.abort();
          return;
        }
      } catch (error) {
        console.error("worker cancel check failed:", formatError(error));
      }
    }
  })();

  return async () => {
    stopped = true;
    await loop.catch(() => {});
  };
}

function formatError(error) {
  if (!error) {
    return "unknown error";
  }

  const parts = [error.message || String(error)];
  if (error.cause?.message) {
    parts.push(`cause=${error.cause.message}`);
  }
  if (error.stack) {
    parts.push(error.stack);
  }

  return parts.join("\n");
}

function shouldRetryHubRequest(error) {
  if (!error) {
    return true;
  }

  if (!error.statusCode) {
    return true;
  }

  return error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500;
}

async function listDirectories(directoryPath, rootPath, allowedRoots) {
  const target = await fs.realpath(directoryPath);
  const root = await fs.realpath(rootPath);
  const normalizedRoots = await Promise.all(
    allowedRoots.map((candidate) => fs.realpath(candidate).catch(() => null)),
  );

  if (!normalizedRoots.filter(Boolean).some((candidate) => isInsideRoot(root, candidate))) {
    throw new Error(`Root is not allowed: ${rootPath}`);
  }

  if (!isInsideRoot(target, root)) {
    throw new Error(`Path is outside the selected root: ${directoryPath}`);
  }

  const entries = await fs.readdir(target, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      path: path.join(target, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function isInsideRoot(targetPath, rootPath) {
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);
}

function isMainModule() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  await main();
}
