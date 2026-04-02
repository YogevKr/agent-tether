import fs from "node:fs/promises";
import path from "node:path";

const EMPTY_STATE = {
  sessions: {},
  topicBindings: {},
  jobs: {},
};

export class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async read() {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      return normalizeState(JSON.parse(content));
    } catch (error) {
      if (error.code === "ENOENT") {
        return cloneEmptyState();
      }

      throw error;
    }
  }

  async write(state) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2));
    await fs.rename(tempPath, this.filePath);
  }

  async listSessions({ includeClosed = false } = {}) {
    const state = await this.read();
    return Object.values(state.sessions)
      .filter((session) => includeClosed || session.status !== "closed")
      .sort(compareSessions);
  }

  async getSession(sessionId) {
    const state = await this.read();
    return state.sessions[sessionId] || null;
  }

  async saveSession(session) {
    const state = await this.read();
    const normalized = normalizeSession(session);
    state.sessions[normalized.id] = normalized;
    syncBindingsForSession(state, normalized);
    await this.write(state);
    return normalized;
  }

  async upsertSession(sessionId, updates, defaults = {}) {
    const state = await this.read();
    const existing = state.sessions[sessionId];
    const next = normalizeSession({
      ...defaults,
      ...existing,
      ...updates,
      id: sessionId,
    });

    state.sessions[sessionId] = next;
    syncBindingsForSession(state, next);
    await this.write(state);
    return next;
  }

  async updateSession(sessionId, updates) {
    const state = await this.read();
    const existing = state.sessions[sessionId];

    if (!existing) {
      return null;
    }

    const next = normalizeSession({
      ...existing,
      ...updates,
    });

    state.sessions[sessionId] = next;
    syncBindingsForSession(state, next);
    await this.write(state);
    return next;
  }

  async bindSession(sessionId, binding) {
    const state = await this.read();
    const existing = state.sessions[sessionId];

    if (!existing) {
      return null;
    }

    const next = normalizeSession({
      ...existing,
      forumChatId: String(binding.forumChatId),
      topicId: Number(binding.topicId),
      topicName: binding.topicName || existing.topicName || "",
      topicLink: binding.topicLink || existing.topicLink || "",
      bootstrapMessageId: binding.bootstrapMessageId || existing.bootstrapMessageId || null,
      status: "bound",
      updatedAt: binding.updatedAt || new Date().toISOString(),
    });

    state.sessions[sessionId] = next;
    syncBindingsForSession(state, next);
    await this.write(state);
    return next;
  }

  async detachSession(sessionId, { status = "headless" } = {}) {
    const state = await this.read();
    const existing = state.sessions[sessionId];

    if (!existing) {
      return null;
    }

    const next = normalizeSession({
      ...existing,
      forumChatId: "",
      topicId: null,
      topicName: "",
      topicLink: "",
      bootstrapMessageId: null,
      status,
      updatedAt: new Date().toISOString(),
    });

    state.sessions[sessionId] = next;
    syncBindingsForSession(state, next);
    await this.write(state);
    return next;
  }

  async getSessionByTopic(forumChatId, topicId) {
    const state = await this.read();
    const sessionId = state.topicBindings[buildTopicKey(forumChatId, topicId)];
    if (!sessionId) {
      return null;
    }

    return state.sessions[sessionId] || null;
  }

  async listJobsForSession(sessionId, { statuses = [] } = {}) {
    const state = await this.read();
    const allowedStatuses = new Set(statuses.map((status) => String(status)));

    return Object.values(state.jobs)
      .filter((job) => {
        if (job.sessionId !== String(sessionId)) {
          return false;
        }

        if (allowedStatuses.size === 0) {
          return true;
        }

        return allowedStatuses.has(job.status);
      })
      .sort(compareJobs);
  }

  async createJob(job) {
    const state = await this.read();
    const normalized = normalizeJob(job);
    state.jobs[normalized.id] = normalized;
    await this.write(state);
    return normalized;
  }

  async getJob(jobId) {
    const state = await this.read();
    return state.jobs[jobId] || null;
  }

  async updateJob(jobId, updates) {
    const state = await this.read();
    const existing = state.jobs[jobId];

    if (!existing) {
      return null;
    }

    const next = normalizeJob({
      ...existing,
      ...updates,
      id: jobId,
    });

    state.jobs[jobId] = next;
    await this.write(state);
    return next;
  }

  async pullQueuedJob(hostId, { now = new Date().toISOString() } = {}) {
    const state = await this.read();
    const next = Object.values(state.jobs)
      .filter((job) => job.hostId === String(hostId) && job.status === "queued")
      .sort(compareJobs)
      .find((job) => {
        const session = state.sessions[job.sessionId];
        return session && !session.isBusy;
      });

    if (!next) {
      return null;
    }

    const claimed = normalizeJob({
      ...next,
      status: "running",
      startedAt: next.startedAt || now,
      updatedAt: now,
    });

    state.jobs[claimed.id] = claimed;
    state.sessions[claimed.sessionId] = normalizeSession({
      ...state.sessions[claimed.sessionId],
      isBusy: true,
      activeRunSource: "telegram",
      updatedAt: now,
    });
    await this.write(state);
    return claimed;
  }
}

export function buildTopicKey(forumChatId, topicId) {
  return `${String(forumChatId)}:${String(topicId)}`;
}

function compareSessions(left, right) {
  const leftTime = Date.parse(left.updatedAt || left.createdAt || 0);
  const rightTime = Date.parse(right.updatedAt || right.createdAt || 0);
  return rightTime - leftTime;
}

function cloneEmptyState() {
  return {
    sessions: {},
    topicBindings: {},
    jobs: {},
  };
}

function normalizeState(state) {
  const normalized = cloneEmptyState();

  for (const [sessionId, session] of Object.entries(state.sessions || {})) {
    normalized.sessions[sessionId] = normalizeSession({
      id: sessionId,
      ...session,
    });
  }

  for (const [jobId, job] of Object.entries(state.jobs || {})) {
    normalized.jobs[jobId] = normalizeJob({
      id: jobId,
      ...job,
    });
  }

  for (const session of Object.values(normalized.sessions)) {
    syncBindingsForSession(normalized, session);
  }

  return normalized;
}

function normalizeSession(session) {
  return {
    id: String(session.id),
    label: String(session.label || "Untitled session"),
    threadId: String(session.threadId || ""),
    cwd: String(session.cwd || ""),
    model: String(session.model || ""),
    latestAssistantMessage: String(session.latestAssistantMessage || ""),
    latestUserPrompt: String(session.latestUserPrompt || ""),
    createdVia: String(session.createdVia || "local-cli"),
    createdAt: String(session.createdAt || new Date().toISOString()),
    updatedAt: String(session.updatedAt || session.createdAt || new Date().toISOString()),
    status: normalizeStatus(session.status),
    transcriptPath: String(session.transcriptPath || ""),
    lastHookEvent: String(session.lastHookEvent || ""),
    lastStartSource: String(session.lastStartSource || ""),
    hostId: String(session.hostId || ""),
    forumChatId: session.forumChatId ? String(session.forumChatId) : "",
    topicId:
      session.topicId === null || session.topicId === undefined || session.topicId === ""
        ? null
        : Number(session.topicId),
    topicName: String(session.topicName || ""),
    topicLink: String(session.topicLink || ""),
    bootstrapMessageId:
      session.bootstrapMessageId === null ||
      session.bootstrapMessageId === undefined ||
      session.bootstrapMessageId === ""
        ? null
        : Number(session.bootstrapMessageId),
    isBusy: Boolean(session.isBusy),
    activeRunSource: String(session.activeRunSource || ""),
  };
}

function normalizeJob(job) {
  return {
    id: String(job.id),
    sessionId: String(job.sessionId || ""),
    hostId: String(job.hostId || ""),
    prompt: String(job.prompt || ""),
    status: normalizeJobStatus(job.status),
    chatId: String(job.chatId || ""),
    messageThreadId:
      job.messageThreadId === null || job.messageThreadId === undefined || job.messageThreadId === ""
        ? null
        : Number(job.messageThreadId),
    progressMessageId:
      job.progressMessageId === null ||
      job.progressMessageId === undefined ||
      job.progressMessageId === ""
        ? null
        : Number(job.progressMessageId),
    progressState: normalizeProgressState(job.progressState || {}),
    createdAt: String(job.createdAt || new Date().toISOString()),
    updatedAt: String(job.updatedAt || job.createdAt || new Date().toISOString()),
    startedAt: String(job.startedAt || ""),
    completedAt: String(job.completedAt || ""),
    finalMessage: String(job.finalMessage || ""),
    error: String(job.error || ""),
  };
}

function normalizeProgressState(state) {
  return {
    label: String(state.label || ""),
    phase: String(state.phase || ""),
    command: String(state.command || ""),
    reasoning: String(state.reasoning || ""),
    commandOutput: String(state.commandOutput || ""),
    draftReply: String(state.draftReply || ""),
  };
}

function normalizeStatus(status) {
  if (status === "bound" || status === "closed") {
    return status;
  }

  return "headless";
}

function normalizeJobStatus(status) {
  if (status === "running" || status === "completed" || status === "failed") {
    return status;
  }

  return "queued";
}

function compareJobs(left, right) {
  const leftTime = Date.parse(left.createdAt || 0);
  const rightTime = Date.parse(right.createdAt || 0);
  return leftTime - rightTime;
}

function syncBindingsForSession(state, session) {
  for (const [key, value] of Object.entries(state.topicBindings)) {
    if (value === session.id) {
      delete state.topicBindings[key];
    }
  }

  if (session.status === "bound" && session.forumChatId && session.topicId) {
    state.topicBindings[buildTopicKey(session.forumChatId, session.topicId)] = session.id;
  }
}
