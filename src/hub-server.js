import http from "node:http";
import { randomUUID } from "node:crypto";
import { applyHookEvent } from "./hook-index.js";
import {
  applyProgressUpdate,
  createProgressState,
  formatProgressMessage,
} from "./relay-app.js";

export function createHubServer({
  botConfig,
  store,
  telegram,
  now = () => new Date().toISOString(),
  logger = console,
}) {
  const server = http.createServer(async (request, response) => {
    try {
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
        const job = await store.pullQueuedJob(hostId, { now: now() });

        if (!job) {
          return sendJson(response, 200, { job: null });
        }

        const session = await store.getSession(job.sessionId);
        return sendJson(response, 200, { job, session });
      }

      if (request.method === "POST" && request.url?.match(/^\/api\/jobs\/[^/]+\/progress$/)) {
        assertAuthorized(request, botConfig.hubToken);
        const jobId = request.url.split("/")[3];
        const payload = await readJson(request);
        const job = await store.getJob(jobId);

        if (!job) {
          return sendJson(response, 404, { error: "job not found" });
        }

        const nextProgressState = applyProgressUpdate(
          { ...job.progressState },
          payload.update || {},
        );
        const updatedJob = await store.updateJob(jobId, {
          progressState: nextProgressState,
          updatedAt: now(),
        });

        if (updatedJob?.chatId && updatedJob.progressMessageId) {
          try {
            await telegram.editMessage(
              updatedJob.chatId,
              updatedJob.progressMessageId,
              formatProgressMessage(updatedJob.progressState),
              {
                message_thread_id: updatedJob.messageThreadId,
              },
            );
          } catch (error) {
            if (!String(error.message).includes("message is not modified")) {
              throw error;
            }
          }
        }

        return sendJson(response, 200, { ok: true });
      }

      if (request.method === "POST" && request.url?.match(/^\/api\/jobs\/[^/]+\/complete$/)) {
        assertAuthorized(request, botConfig.hubToken);
        const jobId = request.url.split("/")[3];
        const payload = await readJson(request);
        const job = await store.getJob(jobId);

        if (!job) {
          return sendJson(response, 404, { error: "job not found" });
        }

        const session = await store.getSession(job.sessionId);

        if (!session) {
          return sendJson(response, 404, { error: "session not found" });
        }

        const isFailure = Boolean(payload.error);
        await store.updateJob(jobId, {
          status: isFailure ? "failed" : "completed",
          updatedAt: now(),
          completedAt: now(),
          finalMessage: payload.message || "",
          error: payload.error || "",
        });

        await store.updateSession(session.id, {
          threadId: payload.threadId || session.threadId,
          latestAssistantMessage: payload.message || session.latestAssistantMessage,
          updatedAt: now(),
        });

        if (job.chatId && job.progressMessageId) {
          await telegram.replaceProgressMessage(
            job.chatId,
            { message_id: job.progressMessageId },
            isFailure ? `Codex failed.\n\n${payload.error}` : payload.message,
            {
              message_thread_id: job.messageThreadId,
            },
          );
        }

        return sendJson(response, 200, { ok: true });
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      logger.error(error);
      sendJson(response, error.statusCode || 500, { error: error.message });
    }
  });

  return {
    async start() {
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
    async queueRemoteJob(session, { prompt, chatId, messageThreadId, progressMessageId }) {
      return store.createJob({
        id: randomUUID(),
        sessionId: session.id,
        hostId: session.hostId,
        prompt,
        status: "queued",
        chatId,
        messageThreadId,
        progressMessageId,
        progressState: createProgressState(session),
        createdAt: now(),
        updatedAt: now(),
      });
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
