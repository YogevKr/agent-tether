import path from "node:path";
import { normalizeAgentProvider } from "./config.js";

export async function applyHookEvent(store, input, { now = () => new Date().toISOString() } = {}) {
  const hook = normalizeHookInput(input, { now });

  if (!hook) {
    return null;
  }

  const { targetSessionId, duplicateSessionId } = await resolveIndexedSessionTarget(
    store,
    hook,
  );
  const updates = buildHookSessionUpdates(hook, { targetSessionId });

  if (!updates) {
    return null;
  }

  const session = await store.upsertSession(
    targetSessionId,
    updates,
    buildHookSessionDefaults(hook, { targetSessionId }),
  );

  if (duplicateSessionId && duplicateSessionId !== session.id) {
    await store.deleteSession(duplicateSessionId);
  }

  return session;
}

export function deriveSessionLabel(input) {
  const cwd = String(input.cwd || "").trim();
  const provider = normalizeAgentProvider(input.provider || "");

  if (!cwd) {
    return provider === "claude" ? "Local Claude Code session" : "Local Codex session";
  }

  return path.basename(cwd) || cwd;
}

export function stopHookResponse() {
  return {
    continue: true,
  };
}

function normalizeHookInput(input, { now }) {
  const eventName = String(input.hook_event_name || "");
  const sessionId = String(input.session_id || "").trim();

  if (!eventName || !sessionId) {
    return null;
  }

  return {
    eventName,
    sessionId,
    label: deriveSessionLabel(input),
    cwd: String(input.cwd || ""),
    model: String(input.model || ""),
    provider: normalizeAgentProvider(input.provider || ""),
    timestamp: now(),
    transcriptPath: String(input.transcript_path || ""),
    hostId: String(input.host_id || ""),
    prompt: String(input.prompt || ""),
    lastAssistantMessage: String(input.last_assistant_message || ""),
    source: String(input.source || ""),
  };
}

function buildHookSessionDefaults(hook, { targetSessionId }) {
  return {
    id: targetSessionId,
    label: hook.label,
    threadId: hook.sessionId,
    cwd: hook.cwd,
    model: hook.model,
    provider: hook.provider,
    createdVia: `${hook.provider}-hook`,
    createdAt: hook.timestamp,
    updatedAt: hook.timestamp,
    status: "headless",
    transcriptPath: hook.transcriptPath,
    hostId: hook.hostId,
  };
}

function buildHookSessionUpdates(hook, { targetSessionId }) {
  const baseUpdate = buildBaseHookSessionUpdate(hook, { targetSessionId });

  if (hook.eventName === "SessionStart") {
    return {
      ...baseUpdate,
      lastStartSource: hook.source,
      isBusy: false,
    };
  }

  if (hook.eventName === "UserPromptSubmit") {
    return {
      ...baseUpdate,
      latestUserPrompt: hook.prompt,
      isBusy: true,
      activeRunSource: "local-cli",
    };
  }

  if (hook.eventName === "Stop") {
    return {
      ...baseUpdate,
      latestAssistantMessage: hook.lastAssistantMessage,
      isBusy: false,
      activeRunSource: "",
    };
  }

  return null;
}

function buildBaseHookSessionUpdate(hook, { targetSessionId }) {
  return {
    label: hook.label,
    threadId: hook.sessionId,
    cwd: hook.cwd,
    model: hook.model,
    provider: hook.provider,
    ...(targetSessionId === hook.sessionId ? { createdVia: `${hook.provider}-hook` } : {}),
    updatedAt: hook.timestamp,
    transcriptPath: hook.transcriptPath,
    lastHookEvent: hook.eventName,
    hostId: hook.hostId,
  };
}

async function resolveIndexedSessionTarget(store, { sessionId, provider, cwd, hostId }) {
  const existingProviderSession = await store.getSession(sessionId);
  const mergeCandidate = await findTelegramUiCandidate(store, {
    sessionId,
    provider,
    cwd,
    hostId,
  });

  if (!mergeCandidate) {
    return {
      targetSessionId: sessionId,
      duplicateSessionId: "",
    };
  }

  if (existingProviderSession && !isHookSession(existingProviderSession)) {
    return {
      targetSessionId: sessionId,
      duplicateSessionId: "",
    };
  }

  return {
    targetSessionId: mergeCandidate.id,
    duplicateSessionId:
      existingProviderSession && existingProviderSession.id !== mergeCandidate.id
        ? existingProviderSession.id
        : "",
  };
}

async function findTelegramUiCandidate(store, { sessionId, provider, cwd, hostId }) {
  if (!cwd || !hostId) {
    return null;
  }

  const sessions = await store.listSessions({ includeClosed: true });
  const candidates = sessions.filter((session) =>
    session.status !== "closed" &&
    normalizeAgentProvider(session.provider || "") === provider &&
    String(session.hostId || "") === hostId &&
    String(session.cwd || "") === cwd &&
    isTelegramUiSession(session) &&
    session.id !== sessionId &&
    shouldReuseTelegramUiSession(session, { sessionId, provider }));

  return candidates.length === 1 ? candidates[0] : null;
}

function isTelegramUiSession(session) {
  return String(session.createdVia || "").endsWith("-telegram-ui");
}

function isHookSession(session) {
  return String(session.createdVia || "").endsWith("-hook");
}

function shouldReuseTelegramUiSession(session, { sessionId, provider }) {
  const threadId = String(session.threadId || "").trim();

  if (!threadId || threadId === sessionId) {
    return true;
  }

  return provider === "claude" && isActiveTelegramTurn(session);
}

function isActiveTelegramTurn(session) {
  return Boolean(session.isBusy) && String(session.activeRunSource || "") === "telegram";
}
