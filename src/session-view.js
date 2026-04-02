export const MAX_PANEL_SESSIONS = 20;
export const SESSIONS_PAGE_SIZE = 5;

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
      "This topic is not bound to an agent session.",
      "Use Sessions in General or DM to bind one.",
    ].join("\n");
  }

  return [
    `Session: ${session.label}`,
    "",
    "Use the buttons below for status, queue, stop, latest reply, detach, or archive.",
    "Plain text, images, documents, or voice continue the bound agent session.",
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
  page = 0,
  pageSize = SESSIONS_PAGE_SIZE,
}) {
  const cappedSessions = sessions.slice(0, limit);
  const totalSessions = cappedSessions.length;
  const totalPages = Math.max(Math.ceil(totalSessions / pageSize), 1);
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const visibleSessions = cappedSessions.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );
  const lines = [
    mode === "archived" ? "Archived sessions" : "Agent sessions",
    "",
    `Forum: ${forumTitle}`,
    "Sorted: newest update first",
    "Tap the row number to bind, open, or restore that session.",
    "",
  ];

  if (visibleSessions.length === 0) {
    lines.push(mode === "archived" ? "No archived sessions." : "No open sessions.");
    lines.push("");
    if (mode === "archived") {
      lines.push("Archive sessions to hide them from the main list.");
    } else {
      lines.push("Use New Session to start one from Telegram.");
      lines.push("Or run a supported agent locally and it will appear here after the next hook event.");
    }
    return lines.join("\n");
  }

  visibleSessions.forEach((session, index) => {
    lines.push(`${currentPage * pageSize + index + 1}. ${session.label}`);
    lines.push(`   id: ${shortSessionId(session.id)}`);
    lines.push(`   state: ${session.status}`);
    lines.push(`   provider: ${formatProviderName(session.provider)}`);
    lines.push(`   host: ${session.hostId || "local"}`);
    lines.push(`   origin: ${session.createdVia}`);
    lines.push(`   cwd: ${session.cwd}`);
    if (session.status === "bound" && session.topicId) {
      lines.push(`   topic: ${session.topicId}`);
    }
    lines.push(`   updated: ${session.updatedAt}`);
    lines.push("");
  });

  lines.push(`Page ${currentPage + 1}/${totalPages} · showing ${visibleSessions.length} of ${totalSessions}`);

  if (sessions.length > limit) {
    lines.push(`Capped to the newest ${limit} sessions.`);
  }

  return lines.join("\n").trim();
}

export function buildSessionsKeyboard(
  sessions,
  {
    mode = "open",
    page = 0,
    pageSize = SESSIONS_PAGE_SIZE,
    limit = MAX_PANEL_SESSIONS,
    bindSession = (session) => `session:create:${session.id}`,
    showSessionDetails = (session) => `session:details:${session.id}`,
    showLatestSessionReply = (session) => `session:latest:${session.id}`,
    archiveSession = (session) => `session:archive:${session.id}`,
    restoreSession = (session) => `session:restore:${session.id}`,
    goToPage = (targetMode, targetPage) => `sessions:page:${targetMode}:${targetPage}`,
  } = {},
) {
  const cappedSessions = sessions.slice(0, limit);
  const totalPages = Math.max(Math.ceil(cappedSessions.length / pageSize), 1);
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const pageSessions = cappedSessions.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  );
  const inline_keyboard = pageSessions.flatMap((session, index) => {
    const rowNumber = String(currentPage * pageSize + index + 1);
    const primaryButton = mode === "archived"
      ? {
          text: rowNumber,
          callback_data: restoreSession(session),
        }
      : session.status === "bound" && session.topicLink
      ? {
          text: rowNumber,
          url: session.topicLink,
        }
      : {
          text: rowNumber,
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

  if (totalPages > 1) {
    const navigationRow = [];

    if (currentPage > 0) {
      navigationRow.push({
        text: "Prev",
        callback_data: goToPage(mode, currentPage - 1),
      });
    }

    navigationRow.push({
      text: `${currentPage + 1}/${totalPages}`,
      callback_data: goToPage(mode, currentPage),
    });

    if (currentPage < totalPages - 1) {
      navigationRow.push({
        text: "Next",
        callback_data: goToPage(mode, currentPage + 1),
      });
    }

    inline_keyboard.push(navigationRow);
  }

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
    backToSessions = () => "sessions:refresh",
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
      callback_data: backToSessions(session),
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
    showTopicQueue = (item) => `topic:queue:${item.id}`,
    stopTopicSession = (item) => `topic:stop:${item.id}`,
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
          text: "Queue",
          callback_data: showTopicQueue(session),
        },
      ],
      [
        {
          text: "Stop",
          callback_data: stopTopicSession(session),
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
  const providerName = formatProviderName(session.provider);
  const lines = [
    `Session: ${session.label}`,
    `session_id: ${shortSessionId(session.id)}`,
    `provider: ${providerName}`,
    `host: ${session.hostId || "local"}`,
    `cwd: ${session.cwd}`,
    "",
    "Plain text, images, documents, or voice in this topic continue the bound agent session.",
    session.threadId
      ? `Back on computer: ${buildResumeCommand(session)}`
      : "Send the first prompt here to start the session.",
    "Buttons below handle status, queue, stop, latest reply, detach, and archive.",
    "",
    `Topic link: ${topicLink}`,
  ];

  if (session.latestAssistantMessage) {
    lines.push("");
    lines.push(`Latest ${providerName} reply:`);
    lines.push("");
    lines.push(session.latestAssistantMessage);
  }

  return lines.join("\n");
}

export function formatSessionDetails(session) {
  const providerName = formatProviderName(session.provider);
  return [
    `Session: ${session.label}`,
    `id: ${shortSessionId(session.id)}`,
    `provider: ${providerName}`,
    `agent_session_id: ${session.threadId || "(starts on first prompt)"}`,
    `host: ${session.hostId || "local"}`,
    `resume_local: ${
      session.threadId
        ? buildResumeCommand(session)
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
    `Latest ${formatProviderName(session.provider)} reply`,
    `session: ${session.label}`,
    `state: ${session.status}`,
    "",
    session.latestAssistantMessage || "No assistant reply saved yet.",
  ].join("\n");
}

export function formatQueuePanel({ session, jobs }) {
  const runningJobs = jobs.filter((job) => job.status === "running");
  const queuedJobs = jobs.filter((job) => job.status === "queued");
  const lines = [
    `Queue: ${session.label}`,
    `provider: ${formatProviderName(session.provider)}`,
    `host: ${session.hostId || "local"}`,
    `active_source: ${session.activeRunSource || "idle"}`,
    `running: ${runningJobs.length}`,
    `queued: ${queuedJobs.length}`,
  ];

  if (runningJobs.length === 0 && queuedJobs.length === 0) {
    if (session.isBusy && session.activeRunSource === "local-cli") {
      lines.push("", "A local CLI turn is still running on the computer.");
    } else {
      lines.push("", "No Telegram-run work is in flight.");
    }
    return lines.join("\n");
  }

  lines.push("");

  jobs.forEach((job, index) => {
    lines.push(
      `${index + 1}. ${job.status} · ${summarizePrompt(job.prompt)}${job.attachments?.length ? ` · attachments=${job.attachments.length}` : ""}`,
    );
  });

  if (session.isBusy && session.activeRunSource === "local-cli") {
    lines.push("", "Local CLI run is still active; queued Telegram prompts will wait.");
  }

  return lines.join("\n");
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
  return compact.slice(0, 128) || "Agent session";
}

function buildResumeCommand(session) {
  if (String(session.provider || "").toLowerCase() === "claude") {
    return `cd ${session.cwd} && claude --resume ${session.threadId}`;
  }

  return `cd ${session.cwd} && codex resume ${session.threadId}`;
}

function summarizePrompt(prompt) {
  const compact = String(prompt || "").replace(/\s+/g, " ").trim();

  if (compact.length <= 72) {
    return compact || "(no prompt saved)";
  }

  return `${compact.slice(0, 69)}...`;
}

export function formatProviderName(provider) {
  return String(provider || "").toLowerCase() === "claude" ? "Claude Code" : "Codex";
}
