import fs from "node:fs/promises";
import path from "node:path";
import { prepareTelegramAttachments } from "./attachments.js";
import { getProviderModel, getRuntimeConfig } from "./config.js";
import { runAgentTurn } from "./agent-runtime.js";
import { TelegramClient } from "./telegram.js";

const codexConfig = getRuntimeConfig();
const telegram = codexConfig.telegramToken
  ? new TelegramClient({
      token: codexConfig.telegramToken,
      apiBaseUrl: codexConfig.telegramApiBaseUrl,
    })
  : null;

async function main() {
  if (!codexConfig.hubUrl) {
    throw new Error("RELAY_HUB_URL is required for worker mode.");
  }

  console.log(`worker up host=${codexConfig.hostId} hub=${codexConfig.hubUrl}`);

  while (true) {
    try {
      const pulled = await postJson(`${codexConfig.hubUrl}/api/jobs/pull`, {
        hostId: codexConfig.hostId,
        label: codexConfig.hostId,
        defaultCwd: codexConfig.defaultCwd,
        roots: codexConfig.startRoots,
      });

      if (!pulled?.job) {
        await sleep(1500);
        continue;
      }

      if (pulled.job.kind === "run-turn" && !pulled?.session) {
        await sleep(1500);
        continue;
      }

      await executeJob(pulled.job, pulled.session || null);
    } catch (error) {
      console.error("worker poll failed:", formatError(error));
      await sleep(3000);
    }
  }
}

async function executeJob(job, session) {
  let attachments = null;
  let stopMonitor = async () => {};
  const controller = new AbortController();

  try {
    if (job.kind === "browse-dir") {
      const entries = await listDirectories(job.browsePath, job.rootPath, codexConfig.startRoots);
      await postJson(`${codexConfig.hubUrl}/api/jobs/${job.id}/complete`, {
        entries,
      });
      return;
    }

    attachments = await prepareAttachments(job);
    stopMonitor = monitorJobCancellation(job.id, controller);

    const result = await runAgentTurn({
      runtime: codexConfig,
      provider: session.provider || codexConfig.defaultProvider || "codex",
      prompt: attachments.prompt,
      cwd: session.cwd || codexConfig.defaultCwd,
      threadId: session.threadId,
      model: session.model || getProviderModel(codexConfig, session.provider),
      attachments,
      signal: controller.signal,
    });

    await postJson(`${codexConfig.hubUrl}/api/jobs/${job.id}/complete`, {
      threadId: result.threadId,
      message: result.message,
    });
  } catch (error) {
    await postJson(`${codexConfig.hubUrl}/api/jobs/${job.id}/complete`, {
      cancelled: controller.signal.aborted,
      error: controller.signal.aborted ? "Stopped from Telegram." : error.message,
    });
  } finally {
    await stopMonitor();
    await attachments?.cleanup?.().catch(() => {});
  }
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(codexConfig.hubToken ? { "x-relay-token": codexConfig.hubToken } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} calling ${url}`);
  }

  return response.json();
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      ...(codexConfig.hubToken ? { "x-relay-token": codexConfig.hubToken } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} calling ${url}`);
  }

  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

await main();
