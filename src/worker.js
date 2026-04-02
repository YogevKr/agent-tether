import fs from "node:fs/promises";
import path from "node:path";
import { getCodexConfig } from "./config.js";
import { runCodexTurn } from "./codex.js";

const codexConfig = getCodexConfig();

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
  try {
    if (job.kind === "browse-dir") {
      const entries = await listDirectories(job.browsePath, job.rootPath, codexConfig.startRoots);
      await postJson(`${codexConfig.hubUrl}/api/jobs/${job.id}/complete`, {
        entries,
      });
      return;
    }

    await postJson(`${codexConfig.hubUrl}/api/jobs/${job.id}/progress`, {
      update: {
        type: "status",
        phase: "waiting for Codex",
      },
    });

    const result = await runCodexTurn({
      codex: codexConfig,
      prompt: job.prompt,
      cwd: session.cwd || codexConfig.defaultCwd,
      threadId: session.threadId,
      model: session.model || codexConfig.model,
      onProgress: async (update) => {
        await postJson(`${codexConfig.hubUrl}/api/jobs/${job.id}/progress`, {
          update,
        });
      },
    });

    await postJson(`${codexConfig.hubUrl}/api/jobs/${job.id}/complete`, {
      threadId: result.threadId,
      message: result.message,
    });
  } catch (error) {
    await postJson(`${codexConfig.hubUrl}/api/jobs/${job.id}/complete`, {
      error: error.message,
    });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
