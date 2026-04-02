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
      });

      if (!pulled?.job || !pulled?.session) {
        await sleep(1500);
        continue;
      }

      await executeJob(pulled.job, pulled.session);
    } catch (error) {
      console.error("worker poll failed:", error.message);
      await sleep(3000);
    }
  }
}

async function executeJob(job, session) {
  try {
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

await main();
