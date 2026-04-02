export const MAX_PANEL_SESSIONS = 20;

export function dmHelpText({ userId, forumTitle }) {
  return [
    "Agent Tether",
    "",
    `user_id: ${userId}`,
    `forum: ${forumTitle}`,
    "",
    "DM commands:",
    "/chatid",
    "/sessions",
    "/status",
    "",
    "Local Codex sessions appear here once global hooks are installed.",
    "Use /sessions to bind a topic, open a topic, inspect details, or resend the latest reply.",
  ].join("\n");
}

export function topicHelpText(session) {
  if (!session) {
    return [
      "This topic is not bound to a Codex session.",
      "Use DM /sessions to create or bind one.",
    ].join("\n");
  }

  return [
    `Session: ${session.label}`,
    "",
    "Topic commands:",
    "/status",
    "/latest",
    "/reset",
    "",
    "Plain text continues the bound Codex session.",
  ].join("\n");
}

export function formatDmStatus({ forumTitle, sessions }) {
  const openSessions = sessions.filter((session) => session.status !== "closed");
  const boundCount = openSessions.filter((session) => session.status === "bound").length;
  const headlessCount = openSessions.filter((session) => session.status === "headless").length;

  return [
    "Relay status",
    `forum: ${forumTitle}`,
    `open_sessions: ${openSessions.length}`,
    `bound_sessions: ${boundCount}`,
    `headless_sessions: ${headlessCount}`,
  ].join("\n");
}

export function formatSessionsPanel({ forumTitle, sessions, limit = MAX_PANEL_SESSIONS }) {
  const visibleSessions = sessions.slice(0, limit);
  const lines = [
    "Codex sessions",
    "",
    `Forum: ${forumTitle}`,
    "",
  ];

  if (visibleSessions.length === 0) {
    lines.push("No open sessions.");
    lines.push("");
    lines.push("Run Codex locally. Indexed sessions appear here after the next hook event.");
    lines.push("Fallback launcher:");
    lines.push('npm run start-session -- --label "task" --prompt "..."');
    return lines.join("\n");
  }

  visibleSessions.forEach((session, index) => {
    lines.push(`${index + 1}. ${session.label}`);
    lines.push(`   id: ${shortSessionId(session.id)}`);
    lines.push(`   state: ${session.status}`);
    lines.push(`   host: ${session.hostId || "local"}`);
    lines.push(`   origin: ${session.createdVia}`);
    lines.push(`   cwd: ${session.cwd}`);
    if (session.status === "bound" && session.topicId) {
      lines.push(`   topic: ${session.topicId}`);
    }
    lines.push(`   updated: ${session.updatedAt}`);
    lines.push("");
  });

  if (sessions.length > limit) {
    lines.push(`Showing the newest ${limit} sessions.`);
  }

  return lines.join("\n").trim();
}

export function buildSessionsKeyboard(sessions) {
  const inline_keyboard = sessions.slice(0, MAX_PANEL_SESSIONS).flatMap((session) => {
    const label = truncateLabel(session.label, 18);
    const primaryButton =
      session.status === "bound" && session.topicLink
      ? {
          text: `Open ${label}`,
          url: session.topicLink,
        }
      : {
          text: `Bind ${label}`,
          callback_data: `session:create:${session.id}`,
        };

    return [[
      primaryButton,
      {
        text: "Details",
        callback_data: `session:details:${session.id}`,
      },
      {
        text: "Latest",
        callback_data: `session:latest:${session.id}`,
      },
    ]];
  });

  inline_keyboard.push([
    {
      text: "Refresh",
      callback_data: "sessions:refresh",
    },
  ]);

  return { inline_keyboard };
}

export function buildSessionDetailKeyboard(session) {
  const inline_keyboard = [];

  inline_keyboard.push([
    session.status === "bound" && session.topicLink
      ? {
          text: "Open Topic",
          url: session.topicLink,
        }
      : {
          text: "Bind Topic",
          callback_data: `session:create:${session.id}`,
        },
    {
      text: "Latest Reply",
      callback_data: `session:latest:${session.id}`,
    },
  ]);

  inline_keyboard.push([
    {
      text: "Back to Sessions",
      callback_data: "sessions:refresh",
    },
  ]);

  return { inline_keyboard };
}

export function formatTopicBootstrap(session, topicLink) {
  const lines = [
    `Session: ${session.label}`,
    `session_id: ${shortSessionId(session.id)}`,
    `host: ${session.hostId || "local"}`,
    `cwd: ${session.cwd}`,
    "",
    "Plain text in this topic continues the bound Codex session.",
    `Back on computer: codex resume ${session.threadId}`,
    "/status shows session details.",
    "/latest resends the latest assistant reply.",
    "/reset detaches the topic and returns the session to headless mode.",
    "",
    `Topic link: ${topicLink}`,
  ];

  if (session.latestAssistantMessage) {
    lines.push("");
    lines.push("Latest Codex reply:");
    lines.push("");
    lines.push(session.latestAssistantMessage);
  }

  return lines.join("\n");
}

export function formatSessionDetails(session) {
  return [
    `Session: ${session.label}`,
    `id: ${shortSessionId(session.id)}`,
    `codex_session_id: ${session.threadId}`,
    `host: ${session.hostId || "local"}`,
    `resume_local: cd ${session.cwd} && codex resume ${session.threadId}`,
    `state: ${session.status}`,
    `origin: ${session.createdVia}`,
    `cwd: ${session.cwd}`,
    `model: ${session.model || "(default)"}`,
    `created: ${session.createdAt}`,
    `updated: ${session.updatedAt}`,
    session.topicId ? `topic: ${session.topicId}` : "topic: not bound",
    session.topicLink ? `topic_link: ready` : "topic_link: none",
  ].join("\n");
}

export function formatLatestReply(session) {
  return [
    `Latest Codex reply`,
    `session: ${session.label}`,
    `state: ${session.status}`,
    "",
    session.latestAssistantMessage || "No assistant reply saved yet.",
  ].join("\n");
}

export function shortSessionId(sessionId) {
  return sessionId.slice(0, 8);
}

export function truncateLabel(label, maxLength) {
  if (label.length <= maxLength) {
    return label;
  }

  return `${label.slice(0, maxLength - 3)}...`;
}

export function toTopicName(label) {
  const compact = label.replace(/\s+/g, " ").trim();
  return compact.slice(0, 128) || "Codex session";
}
