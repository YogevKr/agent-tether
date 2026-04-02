import { getProviderConfig, normalizeAgentProvider } from "./config.js";
import { runClaudeTurn } from "./claude.js";
import { runCodexTurn } from "./codex.js";

export async function runAgentTurn({
  runtime,
  provider = "",
  prompt,
  cwd,
  threadId = "",
  model = "",
  attachments = null,
  signal,
  onEvent,
  onProgress,
}) {
  const selectedProvider = normalizeAgentProvider(provider || runtime.defaultProvider);
  const providerConfig = getProviderConfig(runtime, selectedProvider);

  if (selectedProvider === "claude") {
    return runClaudeTurn({
      claude: providerConfig,
      prompt,
      cwd,
      threadId,
      model,
      attachments,
      signal,
      onEvent,
      onProgress,
    });
  }

  return runCodexTurn({
    codex: providerConfig,
    prompt,
    cwd,
    threadId,
    model,
    attachments,
    signal,
    onEvent,
    onProgress,
  });
}
