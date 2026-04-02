export const MAX_PANEL_SESSIONS = 20;

export function dmHelpText({ userId, forumTitle }) {
  return [
    "Agent Tether",
    "",
    `user_id: ${userId}`,
    `forum: ${forumTitle}`,
    "",
    "Use the buttons below.",
    "",
    "New Session creates a fresh topic from Telegram.",
    "Sessions shows indexed local agent sessions.",
    "Archived shows hidden historical sessions.",
    "Status shows forum and session counts.",
    "Chat ID shows your Telegram user id.",
  ].join("\n");
}

export function topicHelpText(session) {
  if (!session) {
    return [
      "This topic is not bound to a Codex session.",
      "Use Sessions in General or DM to bind one.",
    ].join("\n");
  }

  return [
    `Session: ${session.label}`,
    "",
    "Use the buttons below for status, latest reply, detach, or archive.",
    "Plain text continues the bound agent session.",
  ].join("\n");
}

export function formatDmStatus({ forumTitle, sessions }) {
  const openSessions = sessions.filter((session) => session.status !== "closed");
  const archivedSessions = sessions.filter((session) => session.status === "closed");
  const boundCount = openSessions.filter((session) => session.status === "bound").length;
  const headlessCount = openSessions.filter((session) => session.status === "headless").length;

  return [
    "Relay status",
    `forum: ${forumTitle}`,
    `open_sessions: ${openSessions.length}`,
    `archived_sessions: ${archivedSessions.length}`,
    `bound_sessions: ${boundCount}`,
    `headless_sessions: ${headlessCount}`,
  ].join("\n");
}

export function formatSessionsPanel({
  forumTitle,
  sessions,
  limit = MAX_PANEL_SESSIONS,
  mode = "open",
}) {
  const visibleSessions = sessions.slice(0, limit);
  const lines = [
    mode === "archived" ? "Archived sessions" : "Agent sessions",
    "",
    `Forum: ${forumTitle}`,
    "Sorted: newest update first",
    "",
  ];

  if (visibleSessions.length === 0) {
    lines.push(mode === "archived" ? "No archived sessions." : "No open sessions.");
    lines.push("");
    if (mode === "archived") {
      lines.push("Archive sessions to hide them from the main list.");
    } else {
      lines.push("Use New Session to start one from Telegram.");
      lines.push("Or run Codex locally and it will appear here after the next hook event.");
    }
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

export function buildSessionsKeyboard(
  sessions,
  {
    mode = "open",
    bindSession = (session) => `session:create:${session.id}`,
    showSessionDetails = (session) => `session:details:${session.id}`,
    showLatestSessionReply = (session) => `session:latest:${session.id}`,
    archiveSession = (session) => `session:archive:${session.id}`,
    restoreSession = (session) => `session:restore:${session.id}`,
  } = {},
) {
  const inline_keyboard = sessions.slice(0, MAX_PANEL_SESSIONS).flatMap((session) => {
    const label = truncateLabel(session.label, 18);
    const primaryButton = mode === "archived"
      ? {
          text: `Restore ${label}`,
          callback_data: restoreSession(session),
        }
      : session.status === "bound" && session.topicLink
      ? {
          text: `Open ${label}`,
          url: session.topicLink,
        }
      : {
          text: `Bind ${label}`,
          callback_data: bindSession(session),
        };

    return [[
      primaryButton,
      {
        text: "Details",
        callback_data: showSessionDetails(session),
      },
      mode === "archived"
        ? {
            text: "Latest",
            callback_data: showLatestSessionReply(session),
          }
        : {
            text: "Archive",
            callback_data: archiveSession(session),
          },
    ]];
  });

  inline_keyboard.push([
    {
      text: "New Session",
      callback_data: "dm:new",
    },
    {
      text: mode === "archived" ? "Open Sessions" : "Archived",
      callback_data: mode === "archived" ? "sessions:refresh" : "sessions:archived",
    },
  ]);

  inline_keyboard.push([
    {
      text: "Refresh",
      callback_data: mode === "archived" ? "sessions:archived" : "sessions:refresh",
    },
    {
      text: "Status",
      callback_data: "dm:status",
    },
  ]);

  inline_keyboard.push([
    {
      text: "Help",
      callback_data: "dm:help",
    },
  ]);

  return { inline_keyboard };
}

export function buildSessionDetailKeyboard(
  session,
  {
    bindSession = (item) => `session:create:${item.id}`,
    showLatestSessionReply = (item) => `session:latest:${item.id}`,
    archiveSession = (item) => `session:archive:${item.id}`,
    restoreSession = (item) => `session:restore:${item.id}`,
  } = {},
) {
  const inline_keyboard = [];

  inline_keyboard.push([
    session.status === "closed"
      ? {
          text: "Restore",
          callback_data: restoreSession(session),
        }
      : session.status === "bound" && session.topicLink
      ? {
          text: "Open Topic",
          url: session.topicLink,
        }
      : {
          text: "Bind Topic",
          callback_data: bindSession(session),
        },
    {
      text: "Latest Reply",
      callback_data: showLatestSessionReply(session),
    },
  ]);

  inline_keyboard.push([
    session.status === "closed"
      ? {
          text: "Archived",
          callback_data: "sessions:archived",
        }
      : {
          text: "Archive",
          callback_data: archiveSession(session),
        },
    {
      text: session.status === "closed" ? "Open Sessions" : "Back to Sessions",
      callback_data: session.status === "closed" ? "sessions:refresh" : "sessions:refresh",
    },
  ]);

  inline_keyboard.push([
    {
      text: "New Session",
      callback_data: "dm:new",
    },
  ]);

  return { inline_keyboard };
}

export function buildDmHomeKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "New Session",
          callback_data: "dm:new",
        },
      ],
      [
        {
          text: "Sessions",
          callback_data: "dm:sessions",
        },
        {
          text: "Archived",
          callback_data: "dm:archived",
        },
      ],
      [
        {
          text: "Status",
          callback_data: "dm:status",
        },
        {
          text: "Chat ID",
          callback_data: "dm:chatid",
        },
      ],
      [
        {
          text: "Help",
          callback_data: "dm:help",
        },
      ],
    ],
  };
}

export function buildTopicKeyboard(
  session,
  {
    showTopicStatus = (item) => `topic:status:${item.id}`,
    showLatestTopicReply = (item) => `topic:latest:${item.id}`,
    detachTopicSession = (item) => `topic:reset:${item.id}`,
    archiveTopicSession = (item) => `topic:archive:${item.id}`,
  } = {},
) {
  if (!session) {
    return {
      inline_keyboard: [
        [
          {
            text: "Open Sessions",
            callback_data: "topic:unbound",
          },
        ],
      ],
    };
  }

  return {
    inline_keyboard: [
      [
        {
          text: "Status",
          callback_data: showTopicStatus(session),
        },
        {
          text: "Latest",
          callback_data: showLatestTopicReply(session),
        },
      ],
      [
        {
          text: "Detach",
          callback_data: detachTopicSession(session),
        },
        {
          text: "Archive",
          callback_data: archiveTopicSession(session),
        },
      ],
    ],
  };
}

export function formatTopicBootstrap(session, topicLink) {
  const lines = [
    `Session: ${session.label}`,
    `session_id: ${shortSessionId(session.id)}`,
    `host: ${session.hostId || "local"}`,
    `cwd: ${session.cwd}`,
    "",
    "Plain text in this topic continues the bound Codex session.",
    session.threadId
      ? `Back on computer: codex resume ${session.threadId}`
      : "Send the first prompt here to start the session.",
    "Buttons below handle status, latest reply, detach, and archive.",
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
    `codex_session_id: ${session.threadId || "(starts on first prompt)"}`,
    `host: ${session.hostId || "local"}`,
    `resume_local: ${
      session.threadId
        ? `cd ${session.cwd} && codex resume ${session.threadId}`
        : "send the first prompt in Telegram to start it"
    }`,
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
