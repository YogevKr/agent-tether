import http from "node:http";
import { randomUUID } from "node:crypto";
import { applyHookEvent } from "./hook-index.js";
import { createProgressState, formatProgressMessage } from "./relay-app.js";
import { formatProviderName } from "./session-view.js";

const HOST_HEARTBEAT_WRITE_INTERVAL_MS = 30_000;

export function createHubServer({
  botConfig,
  codexConfig = null,
  store,
  telegram,
  now = () => new Date().toISOString(),
  logger = console,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const hostHeartbeatWrites = new Map();

  async function finalizeJob(jobId, payload) {
    const job = await store.getJob(jobId);

    if (!job) {
      const error = new Error("job not found");
      error.statusCode = 404;
      throw error;
    }

    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return {
        ok: true,
        alreadyFinalized: true,
        sessionId: job.sessionId || "",
      };
    }

    const finishedAt = now();
    const isCancelled = Boolean(payload.cancelled) || Boolean(job.cancelRequestedAt);
    const isFailure = !isCancelled && Boolean(payload.error);

    if (job.kind === "browse-dir") {
      await store.updateJob(jobId, {
        status: isFailure ? "failed" : isCancelled ? "cancelled" : "completed",
        updatedAt: finishedAt,
        completedAt: finishedAt,
        entries: payload.entries || [],
        error: payload.error || (isCancelled ? "Stopped from Telegram." : ""),
      });
      return { ok: true };
    }

    const session = await store.getSession(job.sessionId);

    if (!session) {
      const error = new Error("session not found");
      error.statusCode = 404;
      throw error;
    }

    await store.updateJob(jobId, {
      status: isFailure ? "failed" : isCancelled ? "cancelled" : "completed",
      updatedAt: finishedAt,
      completedAt: finishedAt,
      finalMessage: payload.message || "",
      error: payload.error || (isCancelled ? "Stopped from Telegram." : ""),
    });

    await store.updateSession(session.id, {
      threadId: payload.threadId || session.threadId,
      latestUserPrompt:
        !isCancelled && job.prompt
          ? job.prompt || session.latestUserPrompt
          : session.latestUserPrompt,
      latestAssistantMessage:
        !isCancelled && payload.message
          ? payload.message || session.latestAssistantMessage
          : session.latestAssistantMessage,
      isBusy: false,
      activeRunSource: "",
      updatedAt: finishedAt,
    });
    await syncTopicName(session.id);

    if (job.chatId && !isCancelled) {
      try {
        if (isFailure) {
          await telegram.sendLongMessage(
            job.chatId,
            `${formatProviderName(session.provider)} failed.\n\n${payload.error}`,
            {
              message_thread_id: job.messageThreadId,
            },
          );
        } else {
          await telegram.sendMarkdownMessage(job.chatId, payload.message, {
            message_thread_id: job.messageThreadId,
          });
        }
      } catch (deliveryError) {
        logger.error(deliveryError);
      }
    }

    return { ok: true, sessionId: session.id };
  }

  async function syncTopicName(sessionId) {
    const session = await store.getSession(sessionId);

    if (!session?.forumChatId || !session.topicId) {
      return;
    }

    const baseName = String(session.topicName || session.label || "Agent session")
      .replace(/^⏳\s*/, "")
      .trim() || "Agent session";
    const targetName = baseName.slice(0, 128);
    const currentName = String(session.topicName || "").trim();

    if (currentName === targetName) {
      return;
    }

    try {
      await telegram.editForumTopic(session.forumChatId, session.topicId, {
        name: targetName,
      });
    } catch (error) {
      const message = String(error.message || "").toLowerCase();

      if (!message.includes("not modified") && !message.includes("topic_id_invalid")) {
        logger.error(error);
      }
    }
  }

  async function syncAllTopicNames() {
    const sessions = await store.listSessions();

    for (const session of sessions) {
      if (!session.forumChatId || !session.topicId) {
        continue;
      }

      await syncTopicName(session.id);
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/api/health") {
        return sendJson(response, 200, {
          ok: true,
          hostId: botConfig.hostId,
          forumChatId: String(botConfig.forumChatId),
        });
      }

      if (request.method === "GET" && request.url === "/api/status") {
        assertAuthorized(request, botConfig.hubToken);
        return sendJson(response, 200, {
          ok: true,
          hosts: await store.listHosts(),
        });
      }

      if (request.method === "POST" && request.url === "/api/hooks") {
        assertAuthorized(request, botConfig.hubToken);
        const payload = await readJson(request);
        const session = await applyHookEvent(store, payload, { now });
        return sendJson(response, 200, { ok: true, sessionId: session?.id || null });
      }

      if (request.method === "POST" && request.url === "/api/sessions/upsert") {
        assertAuthorized(request, botConfig.hubToken);
        const payload = await readJson(request);
        const session = await store.upsertSession(payload.id, payload, payload);
        return sendJson(response, 200, { ok: true, sessionId: session?.id || null });
      }

      if (request.method === "POST" && request.url === "/api/jobs/pull") {
        assertAuthorized(request, botConfig.hubToken);
        const payload = await readJson(request);
        const hostId = String(payload.hostId || "");
        await upsertHostHeartbeat(hostId, {
          label: payload.label || hostId,
          defaultCwd: payload.defaultCwd || "",
          roots: payload.roots || [],
          lastSeenAt: now(),
        });
        const job = await store.pullQueuedJob(hostId, { now: now() });

        if (!job) {
          return sendJson(response, 200, { job: null });
        }

        if (job.kind === "run-turn") {
          await syncTopicName(job.sessionId);
        }

        const session = await store.getSession(job.sessionId);
        return sendJson(response, 200, { job, session });
      }

      if (request.method === "POST" && request.url?.match(/^\/api\/hosts\/[^/]+\/recover$/)) {
        assertAuthorized(request, botConfig.hubToken);
        const hostId = decodeURIComponent(request.url.split("/")[3] || "");
        const recovery = await store.recoverInterruptedRuns({
          hostId,
          now: now(),
          errorMessage: "Interrupted by worker restart.",
        });

        for (const sessionId of recovery.recoveredSessionIds) {
          await syncTopicName(sessionId);
        }

        return sendJson(response, 200, {
          ok: true,
          recoveredJobCount: recovery.recoveredJobIds.length,
          recoveredSessionIds: recovery.recoveredSessionIds,
        });
      }

      if (request.method === "GET" && request.url?.match(/^\/api\/jobs\/[^/]+$/)) {
        assertAuthorized(request, botConfig.hubToken);
        const jobId = request.url.split("/")[3];
        const job = await store.getJob(jobId);

        if (!job) {
          return sendJson(response, 404, { error: "job not found" });
        }

        return sendJson(response, 200, { job });
      }

      if (request.method === "POST" && request.url?.match(/^\/api\/jobs\/[^/]+\/progress$/)) {
        assertAuthorized(request, botConfig.hubToken);
        const jobId = request.url.split("/")[3];
        const payload = await readJson(request);
        const job = await store.getJob(jobId);

        if (!job) {
          return sendJson(response, 404, { error: "job not found" });
        }

        const progressState = {
          ...job.progressState,
          ...(payload.update || {}),
        };

        await store.updateJob(jobId, {
          progressState,
          updatedAt: now(),
        });

        if (job.chatId && job.progressMessageId) {
          try {
            await telegram.sendLongMessage(
              job.chatId,
              formatProgressMessage(progressState),
              {
                message_thread_id: job.messageThreadId,
              },
            );
          } catch (error) {
            logger.error(error);
          }
        }

        return sendJson(response, 200, { ok: true });
      }

      if (request.method === "POST" && request.url?.match(/^\/api\/jobs\/[^/]+\/complete$/)) {
        assertAuthorized(request, botConfig.hubToken);
        const jobId = request.url.split("/")[3];
        const payload = await readJson(request);
        return sendJson(response, 200, await finalizeJob(jobId, payload));
      }

      if (request.method === "POST" && request.url?.match(/^\/api\/sessions\/[^/]+\/stop$/)) {
        assertAuthorized(request, botConfig.hubToken);
        const sessionId = request.url.split("/")[3];
        const outcome = await store.requestStopForSession(sessionId, {
          now: now(),
        });
        await syncTopicName(sessionId);

        return sendJson(response, 200, {
          ok: true,
          runningJobId: outcome.runningJob?.id || "",
          cancelledQueuedCount: outcome.cancelledQueuedCount || 0,
          activeRunSource: outcome.session?.activeRunSource || "",
        });
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      logger.error(error);
      sendJson(response, error.statusCode || 500, { error: error.message });
    }
  });

  async function upsertHostHeartbeat(hostId, updates) {
    const previousWriteAt = hostHeartbeatWrites.get(hostId) || 0;
    const currentWriteAt = Date.now();

    if (currentWriteAt - previousWriteAt < HOST_HEARTBEAT_WRITE_INTERVAL_MS) {
      return;
    }

    hostHeartbeatWrites.set(hostId, currentWriteAt);
    await store.upsertHost(hostId, updates);
  }

  return {
    async start() {
      if (codexConfig) {
        await store.upsertHost(botConfig.hostId, {
          label: botConfig.hostId,
          defaultCwd: codexConfig.defaultCwd,
          roots: codexConfig.startRoots,
          lastSeenAt: now(),
        });
      }

      await syncAllTopicNames();

      await new Promise((resolve) => {
        server.listen(botConfig.hubPort, botConfig.hubBindHost, resolve);
      });
      logger.log(`hub api listening on http://${botConfig.hubBindHost}:${botConfig.hubPort}`);
    },
    async stop() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    async queueRemoteJob(
      session,
      { prompt, chatId, messageThreadId, progressMessageId, pendingAhead = 0, attachments = [] },
    ) {
      return store.createJob({
        id: randomUUID(),
        kind: "run-turn",
        sessionId: session.id,
        hostId: session.hostId,
        prompt,
        attachments,
        status: "queued",
        chatId,
        messageThreadId,
        progressMessageId,
        progressState: {
          ...createProgressState(session),
          phase: pendingAhead > 0 ? "queued" : "waiting for agent",
        },
        createdAt: now(),
        updatedAt: now(),
      });
    },
    async completeJob(jobId, payload) {
      return finalizeJob(jobId, payload);
    },
    async stopRemoteSession(sessionId) {
      const outcome = await store.requestStopForSession(sessionId, {
        now: now(),
      });

      await syncTopicName(sessionId);
      return outcome;
    },
    async recoverHostRuns(hostId, { errorMessage = "Interrupted before completion." } = {}) {
      const recovery = await store.recoverInterruptedRuns({
        hostId,
        now: now(),
        errorMessage,
      });

      for (const sessionId of recovery.recoveredSessionIds) {
        await syncTopicName(sessionId);
      }

      return recovery;
    },
    async requestDirectoryBrowse(hostId, { directoryPath, rootPath, timeoutMs = 8000 }) {
      const browseJob = await store.createJob({
        id: randomUUID(),
        kind: "browse-dir",
        sessionId: "",
        hostId,
        browsePath: directoryPath,
        rootPath,
        status: "queued",
        createdAt: now(),
        updatedAt: now(),
      });
      const startedAt = Date.now();

      while (Date.now() - startedAt < timeoutMs) {
        const latest = await store.getJob(browseJob.id);

        if (latest?.status === "completed") {
          return latest.entries || [];
        }

        if (latest?.status === "failed") {
          throw new Error(latest.error || "Directory listing failed.");
        }

        await sleep(200);
      }

      throw new Error("Directory listing timed out.");
    },
  };
}

function assertAuthorized(request, expectedToken) {
  if (!expectedToken) {
    return;
  }

  if (request.headers["x-relay-token"] !== expectedToken) {
    const error = new Error("unauthorized");
    error.statusCode = 401;
    throw error;
  }
}

async function readJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}
