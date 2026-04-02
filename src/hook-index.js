import path from "node:path";

export async function applyHookEvent(store, input, { now = () => new Date().toISOString() } = {}) {
  const eventName = String(input.hook_event_name || "");
  const sessionId = String(input.session_id || "").trim();

  if (!eventName || !sessionId) {
    return null;
  }

  const timestamp = now();
  const defaults = {
    id: sessionId,
    label: deriveSessionLabel(input),
    threadId: sessionId,
    cwd: String(input.cwd || ""),
    model: String(input.model || ""),
    createdVia: "codex-hook",
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "headless",
    transcriptPath: String(input.transcript_path || ""),
    hostId: String(input.host_id || ""),
  };

  if (eventName === "SessionStart") {
    return store.upsertSession(
      sessionId,
      {
        label: deriveSessionLabel(input),
        threadId: sessionId,
        cwd: String(input.cwd || ""),
        model: String(input.model || ""),
        createdVia: "codex-hook",
        updatedAt: timestamp,
        transcriptPath: String(input.transcript_path || ""),
        lastHookEvent: eventName,
        lastStartSource: String(input.source || ""),
        hostId: String(input.host_id || ""),
      },
      defaults,
    );
  }

  if (eventName === "UserPromptSubmit") {
    return store.upsertSession(
      sessionId,
      {
        label: deriveSessionLabel(input),
        threadId: sessionId,
        cwd: String(input.cwd || ""),
        model: String(input.model || ""),
        createdVia: "codex-hook",
        latestUserPrompt: String(input.prompt || ""),
        updatedAt: timestamp,
        transcriptPath: String(input.transcript_path || ""),
        lastHookEvent: eventName,
        hostId: String(input.host_id || ""),
      },
      defaults,
    );
  }

  if (eventName === "Stop") {
    return store.upsertSession(
      sessionId,
      {
        label: deriveSessionLabel(input),
        threadId: sessionId,
        cwd: String(input.cwd || ""),
        model: String(input.model || ""),
        createdVia: "codex-hook",
        latestAssistantMessage: String(input.last_assistant_message || ""),
        updatedAt: timestamp,
        transcriptPath: String(input.transcript_path || ""),
        lastHookEvent: eventName,
        hostId: String(input.host_id || ""),
      },
      defaults,
    );
  }

  return null;
}

export function deriveSessionLabel(input) {
  const cwd = String(input.cwd || "").trim();

  if (!cwd) {
    return "Local Codex session";
  }

  return path.basename(cwd) || cwd;
}

export function stopHookResponse() {
  return {
    continue: true,
  };
}
