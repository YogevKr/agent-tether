import { getCodexConfig, getStateFile } from "./config.js";
import { applyHookEvent, stopHookResponse } from "./hook-index.js";
import { StateStore } from "./state-store.js";

async function main() {
  const input = await readJsonStdin();
  const codexConfig = getCodexConfig();
  const enrichedInput = {
    ...input,
    host_id: input.host_id || codexConfig.hostId,
  };

  try {
    if (codexConfig.hubUrl) {
      await postHookToHub(codexConfig.hubUrl, codexConfig.hubToken, enrichedInput);
    } else {
      const store = new StateStore(getStateFile());
      await applyHookEvent(store, enrichedInput);
    }
  } catch (error) {
    console.error(`[agent-tether] hook indexing failed: ${error.message}`);
  }

  if (String(enrichedInput.hook_event_name || "") === "Stop") {
    process.stdout.write(`${JSON.stringify(stopHookResponse())}\n`);
  }
}

async function readJsonStdin() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();

  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

async function postHookToHub(hubUrl, hubToken, payload) {
  const response = await fetch(`${hubUrl.replace(/\/+$/, "")}/api/hooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(hubToken ? { "x-relay-token": hubToken } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`hub hook ingest failed with HTTP ${response.status}`);
  }
}

await main();
