import fs from "node:fs/promises";
import path from "node:path";

const EMPTY_STATE = {
  sessions: {},
  topicBindings: {},
  jobs: {},
  hosts: {},
};

export class StateStore {
  constructor(filePath, { fallbackReadPaths = [] } = {}) {
    this.filePath = filePath;
    this.fallbackReadPaths = [...new Set(
      fallbackReadPaths
        .map((candidate) => String(candidate || ""))
        .filter((candidate) => candidate && candidate !== filePath),
    )];
    this.pendingOperation = Promise.resolve();
  }

  async read() {
    return this.runExclusive(() => this.readFromDisk());
  }

  async write(state) {
    return this.runExclusive(() => this.writeToDisk(state));
  }

  async listSessions({ includeClosed = false } = {}) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
      return Object.values(state.sessions)
        .filter((session) => includeClosed || session.status !== "closed")
        .sort(compareSessions);
    });
  }

  async getSession(sessionId) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
      return state.sessions[sessionId] || null;
    });
  }

  async saveSession(session) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
      const normalized = normalizeSession(session);
      state.sessions[normalized.id] = normalized;
      syncBindingsForSession(state, normalized);
      await this.writeToDisk(state);
      return normalized;
    });
  }

  async upsertSession(sessionId, updates, defaults = {}) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
      const existing = state.sessions[sessionId];
      const next = normalizeSession({
        ...defaults,
        ...existing,
        ...updates,
        id: sessionId,
      });

      state.sessions[sessionId] = next;
      syncBindingsForSession(state, next);
      await this.writeToDisk(state);
      return next;
    });
  }

  async updateSession(sessionId, updates) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
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
      await this.writeToDisk(state);
      return next;
    });
  }

  async deleteSession(sessionId) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
      const existing = state.sessions[sessionId];

      if (!existing) {
        return null;
      }

      delete state.sessions[sessionId];

      for (const [bindingKey, boundSessionId] of Object.entries(state.topicBindings)) {
        if (boundSessionId === sessionId) {
          delete state.topicBindings[bindingKey];
        }
      }

      for (const [jobId, job] of Object.entries(state.jobs)) {
        if (job.sessionId === sessionId) {
          delete state.jobs[jobId];
        }
      }

      await this.writeToDisk(state);
      return existing;
    });
  }

  async bindSession(sessionId, binding) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
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
      await this.writeToDisk(state);
      return next;
    });
  }

  async detachSession(sessionId, { status = "headless" } = {}) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
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
      await this.writeToDisk(state);
      return next;
    });
  }

  async getSessionByTopic(forumChatId, topicId) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
      const sessionId = state.topicBindings[buildTopicKey(forumChatId, topicId)];
      if (!sessionId) {
        return null;
      }

      return state.sessions[sessionId] || null;
    });
  }

  async listHosts() {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
      return Object.values(state.hosts).sort(compareHosts);
    });
  }

  async getHost(hostId) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
      return state.hosts[String(hostId)] || null;
    });
  }

  async upsertHost(hostId, updates) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
      const existing = state.hosts[String(hostId)] || {};
      const next = normalizeHost({
        ...existing,
        ...updates,
        id: hostId,
      });

      state.hosts[next.id] = next;
      await this.writeToDisk(state);
      return next;
    });
  }

  async listJobsForSession(sessionId, { statuses = [] } = {}) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
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
    });
  }

  async pullQueuedJobForSession(sessionId, { now = new Date().toISOString() } = {}) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
      const session = state.sessions[String(sessionId)];

      if (!session || session.isBusy) {
        return null;
      }

      const next = Object.values(state.jobs)
        .filter(
          (job) =>
            job.sessionId === String(sessionId) &&
            job.kind === "run-turn" &&
            job.status === "queued",
        )
        .sort(compareJobs)[0];

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
      state.sessions[String(sessionId)] = normalizeSession({
        ...session,
        isBusy: true,
        activeRunSource: "telegram",
        updatedAt: now,
      });
      await this.writeToDisk(state);
      return claimed;
    });
  }

  async createJob(job) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
      const normalized = normalizeJob(job);
      state.jobs[normalized.id] = normalized;
      await this.writeToDisk(state);
      return normalized;
    });
  }

  async getJob(jobId) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
      return state.jobs[jobId] || null;
    });
  }

  async updateJob(jobId, updates) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
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
      await this.writeToDisk(state);
      return next;
    });
  }

  async requestStopForSession(sessionId, { now = new Date().toISOString() } = {}) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
      const session = state.sessions[String(sessionId)] || null;

      let cancelledQueuedCount = 0;
      let runningJob = null;

      for (const [jobId, job] of Object.entries(state.jobs)) {
        if (job.sessionId !== String(sessionId)) {
          continue;
        }

        if (job.status === "queued") {
          state.jobs[jobId] = normalizeJob({
            ...job,
            status: "cancelled",
            updatedAt: now,
            completedAt: now,
            error: "Stopped from Telegram.",
          });
          cancelledQueuedCount += 1;
          continue;
        }

        if (job.status === "running" && !job.cancelRequestedAt) {
          const next = normalizeJob({
            ...job,
            cancelRequestedAt: now,
            updatedAt: now,
          });
          state.jobs[jobId] = next;
          runningJob = next;
        }
      }

      await this.writeToDisk(state);
      return {
        session,
        runningJob,
        cancelledQueuedCount,
      };
    });
  }

  async recoverInterruptedRuns({
    hostId = "",
    now = new Date().toISOString(),
    errorMessage = "Interrupted before completion.",
  } = {}) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
      const targetHostId = String(hostId || "");
      const recoveredJobIds = [];
      const recoveredSessionIds = new Set();

      for (const [jobId, job] of Object.entries(state.jobs)) {
        if (job.status !== "running") {
          continue;
        }

        if (targetHostId && job.hostId !== targetHostId) {
          continue;
        }

        state.jobs[jobId] = normalizeJob({
          ...job,
          status: "failed",
          updatedAt: now,
          completedAt: now,
          error: job.error || errorMessage,
        });
        recoveredJobIds.push(jobId);

        if (job.kind === "run-turn" && job.sessionId) {
          recoveredSessionIds.add(job.sessionId);
        }
      }

      for (const sessionId of recoveredSessionIds) {
        const session = state.sessions[sessionId];

        if (!session || !session.isBusy) {
          continue;
        }

        if (session.activeRunSource && session.activeRunSource !== "telegram") {
          continue;
        }

        state.sessions[sessionId] = normalizeSession({
          ...session,
          isBusy: false,
          activeRunSource: "",
          updatedAt: now,
        });
      }

      if (recoveredJobIds.length > 0) {
        await this.writeToDisk(state);
      }

      return {
        recoveredJobIds,
        recoveredSessionIds: [...recoveredSessionIds],
      };
    });
  }

  async pullQueuedJob(hostId, { now = new Date().toISOString() } = {}) {
    return this.runExclusive(async () => {
      const state = await this.readFromDisk();
      const next = Object.values(state.jobs)
        .filter((job) => job.hostId === String(hostId) && job.status === "queued")
        .sort(compareJobs)
        .find((job) => {
          if (job.kind !== "run-turn") {
            return true;
          }

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
      if (claimed.kind === "run-turn" && state.sessions[claimed.sessionId]) {
        state.sessions[claimed.sessionId] = normalizeSession({
          ...state.sessions[claimed.sessionId],
          isBusy: true,
          activeRunSource: "telegram",
          updatedAt: now,
        });
      }
      await this.writeToDisk(state);
      return claimed;
    });
  }

  async runExclusive(operation) {
    const next = this.pendingOperation.then(operation, operation);
    this.pendingOperation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async readFromDisk() {
    for (const candidate of [this.filePath, ...this.fallbackReadPaths]) {
      try {
        const content = await fs.readFile(candidate, "utf8");
        return normalizeState(JSON.parse(content));
      } catch (error) {
        if (error.code === "ENOENT") {
          continue;
        }

        throw error;
      }
    }

    return cloneEmptyState();
  }

  async writeToDisk(state) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2));
    await fs.rename(tempPath, this.filePath);
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
    hosts: {},
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

  for (const [hostId, host] of Object.entries(state.hosts || {})) {
    normalized.hosts[hostId] = normalizeHost({
      id: hostId,
      ...host,
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
    provider: String(session.provider || "codex"),
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
    showIntermediateSteps: Boolean(session.showIntermediateSteps),
    isBusy: Boolean(session.isBusy),
    activeRunSource: String(session.activeRunSource || ""),
  };
}

function normalizeJob(job) {
  return {
    id: String(job.id),
    kind: normalizeJobKind(job.kind),
    sessionId: String(job.sessionId || ""),
    hostId: String(job.hostId || ""),
    prompt: String(job.prompt || ""),
    browsePath: String(job.browsePath || ""),
    rootPath: String(job.rootPath || ""),
    entries: Array.isArray(job.entries)
      ? job.entries.map((entry) => ({
          name: String(entry.name || ""),
          path: String(entry.path || ""),
        }))
      : [],
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
    cancelRequestedAt: String(job.cancelRequestedAt || ""),
    attachments: Array.isArray(job.attachments)
      ? job.attachments.map((attachment) => ({
          kind: normalizeAttachmentKind(attachment.kind),
          fileId: String(attachment.fileId || ""),
          fileUniqueId: String(attachment.fileUniqueId || ""),
          fileName: String(attachment.fileName || ""),
          mimeType: String(attachment.mimeType || ""),
          fileSize:
            attachment.fileSize === null || attachment.fileSize === undefined || attachment.fileSize === ""
              ? null
              : Number(attachment.fileSize),
          durationSeconds:
            attachment.durationSeconds === null ||
            attachment.durationSeconds === undefined ||
            attachment.durationSeconds === ""
              ? null
              : Number(attachment.durationSeconds),
        }))
      : [],
  };
}

function normalizeHost(host) {
  return {
    id: String(host.id || ""),
    label: String(host.label || host.id || ""),
    defaultCwd: String(host.defaultCwd || ""),
    roots: Array.isArray(host.roots)
      ? host.roots.map((root) => String(root)).filter(Boolean)
      : [],
    lastSeenAt: String(host.lastSeenAt || new Date().toISOString()),
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
  if (
    status === "running" ||
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    return status;
  }

  return "queued";
}

function normalizeJobKind(kind) {
  if (kind === "browse-dir") {
    return kind;
  }

  return "run-turn";
}

function normalizeAttachmentKind(kind) {
  if (kind === "image" || kind === "voice") {
    return kind;
  }

  return "document";
}

function compareJobs(left, right) {
  const leftTime = Date.parse(left.createdAt || 0);
  const rightTime = Date.parse(right.createdAt || 0);
  return leftTime - rightTime;
}

function compareHosts(left, right) {
  const leftTime = Date.parse(left.lastSeenAt || 0);
  const rightTime = Date.parse(right.lastSeenAt || 0);
  return rightTime - leftTime || left.label.localeCompare(right.label);
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
