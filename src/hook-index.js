import path from "node:path";
import { normalizeAgentProvider } from "./config.js";

export async function applyHookEvent(store, input, { now = () => new Date().toISOString() } = {}) {
  const eventName = String(input.hook_event_name || "");
  const sessionId = String(input.session_id || "").trim();

  if (!eventName || !sessionId) {
    return null;
  }

  const timestamp = now();
  const provider = normalizeAgentProvider(input.provider || "");
  const cwd = String(input.cwd || "");
  const hostId = String(input.host_id || "");
  const { targetSessionId, duplicateSessionId } = await resolveIndexedSessionTarget(
    store,
    {
      sessionId,
      provider,
      cwd,
      hostId,
    },
  );
  const defaults = {
    id: targetSessionId,
    label: deriveSessionLabel(input),
    threadId: sessionId,
    cwd,
    model: String(input.model || ""),
    provider,
    createdVia: `${provider}-hook`,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "headless",
    transcriptPath: String(input.transcript_path || ""),
    hostId,
  };
  const createdViaUpdate =
    targetSessionId === sessionId
      ? `${provider}-hook`
      : undefined;

  let session = null;

  if (eventName === "SessionStart") {
    session = await store.upsertSession(
      targetSessionId,
      {
        label: deriveSessionLabel(input),
        threadId: sessionId,
        cwd,
        model: String(input.model || ""),
        provider,
        ...(createdViaUpdate ? { createdVia: createdViaUpdate } : {}),
        updatedAt: timestamp,
        transcriptPath: String(input.transcript_path || ""),
        lastHookEvent: eventName,
        lastStartSource: String(input.source || ""),
        hostId,
        isBusy: false,
      },
      defaults,
    );
  } else if (eventName === "UserPromptSubmit") {
    session = await store.upsertSession(
      targetSessionId,
      {
        label: deriveSessionLabel(input),
        threadId: sessionId,
        cwd,
        model: String(input.model || ""),
        provider,
        ...(createdViaUpdate ? { createdVia: createdViaUpdate } : {}),
        latestUserPrompt: String(input.prompt || ""),
        updatedAt: timestamp,
        transcriptPath: String(input.transcript_path || ""),
        lastHookEvent: eventName,
        hostId,
        isBusy: true,
        activeRunSource: "local-cli",
      },
      defaults,
    );
  } else if (eventName === "Stop") {
    session = await store.upsertSession(
      targetSessionId,
      {
        label: deriveSessionLabel(input),
        threadId: sessionId,
        cwd,
        model: String(input.model || ""),
        provider,
        ...(createdViaUpdate ? { createdVia: createdViaUpdate } : {}),
        latestAssistantMessage: String(input.last_assistant_message || ""),
        updatedAt: timestamp,
        transcriptPath: String(input.transcript_path || ""),
        lastHookEvent: eventName,
        hostId,
        isBusy: false,
        activeRunSource: "",
      },
      defaults,
    );
  }

  if (!session) {
    return null;
  }

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
    (!String(session.threadId || "").trim() || String(session.threadId || "").trim() === sessionId));

  return candidates.length === 1 ? candidates[0] : null;
}

function isTelegramUiSession(session) {
  return String(session.createdVia || "").endsWith("-telegram-ui");
}

function isHookSession(session) {
  return String(session.createdVia || "").endsWith("-hook");
}
