import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export async function runCodexTurn({
  codex,
  prompt,
  cwd,
  threadId = "",
  model = "",
  onEvent,
  onProgress,
}) {
  const outputFile = path.join(
    os.tmpdir(),
    `codex-relay-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
  );
  const args = buildCodexArgs({
    codex,
    prompt,
    cwd,
    threadId,
    model,
    outputFile,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(codex.bin, args, {
      cwd: threadId ? undefined : cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderr = "";
    let resolvedThreadId = threadId;
    let lastAgentMessage = "";

    const handleEvent = (event) => {
      if (normalizeCodexEventType(event.type) === "thread.started") {
        resolvedThreadId = event.thread_id || event.threadId || resolvedThreadId;
      }

      if (
        normalizeCodexEventType(event.type) === "item.completed" &&
        event.item?.type === "agent_message"
      ) {
        lastAgentMessage = event.item.text || lastAgentMessage;
      }

      if (onEvent) {
        onEvent(event);
      }

      if (onProgress) {
        for (const update of toProgressUpdates(event)) {
          onProgress(update);
        }
      }
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      stdoutBuffer = drainJsonLines(stdoutBuffer, handleEvent);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);

    child.on("close", async (code) => {
      try {
        const trailing = stdoutBuffer.trim();

        if (trailing.startsWith("{")) {
          drainJsonLines(`${trailing}\n`, handleEvent);
        }

        const savedOutput = await fs.readFile(outputFile, "utf8").catch(
          () => "",
        );
        await fs.unlink(outputFile).catch(() => {});
        const finalMessage = savedOutput.trim() || lastAgentMessage.trim();

        if (code !== 0) {
          const reason =
            stderr.trim() || finalMessage || "Codex exited without output.";
          reject(new Error(reason));
          return;
        }

        if (!resolvedThreadId) {
          reject(new Error("Codex finished without returning a thread id."));
          return;
        }

        if (!finalMessage) {
          reject(new Error("Codex finished without a final message."));
          return;
        }

        resolve({
          threadId: resolvedThreadId,
          message: finalMessage,
          stderr: stderr.trim(),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function buildCodexArgs({
  codex,
  prompt,
  cwd,
  threadId,
  model,
  outputFile,
}) {
  const defaultArgs = codex.defaultArgs || [];
  const hasYolo = defaultArgs.includes("--yolo");
  const args = [...defaultArgs, ...(threadId ? ["exec", "resume"] : ["exec"])];

  args.push("--json", "-o", outputFile);

  if (codex.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }

  if (model || codex.model) {
    args.push("-m", model || codex.model);
  }

  if (!hasYolo && codex.approvalPolicy) {
    args.push("-c", `approval_policy="${codex.approvalPolicy}"`);
  }

  if (!hasYolo && codex.sandboxMode) {
    args.push("-c", `sandbox_mode="${codex.sandboxMode}"`);
  }

  if (!threadId && cwd) {
    args.push("-C", cwd);
  }

  if (threadId) {
    args.push(threadId);
  }

  args.push(prompt);

  return args;
}

export function drainJsonLines(buffer, onEvent) {
  let remaining = buffer;

  while (remaining.includes("\n")) {
    const newlineIndex = remaining.indexOf("\n");
    const line = remaining.slice(0, newlineIndex).trim();
    remaining = remaining.slice(newlineIndex + 1);

    if (!line.startsWith("{")) {
      continue;
    }

    try {
      onEvent(JSON.parse(line));
    } catch {
      continue;
    }
  }

  return remaining;
}

export function normalizeCodexEventType(type) {
  if (!type) {
    return "";
  }

  return String(type)
    .replace(/[/_]/g, ".")
    .replace(/([a-z])([A-Z])/g, "$1.$2")
    .replace(/\.+/g, ".")
    .toLowerCase();
}

export function toProgressUpdates(event) {
  const normalizedType = normalizeCodexEventType(event.type);
  const updates = [];

  if (normalizedType === "thread.started") {
    updates.push({
      type: "thread_started",
      threadId: event.thread_id || event.threadId || "",
    });
  }

  if (
    normalizedType === "item.started" &&
    event.item?.type === "command_execution"
  ) {
    updates.push({
      type: "command_started",
      command: event.item.command || "",
    });
  }

  if (
    normalizedType === "item.completed" &&
    event.item?.type === "command_execution"
  ) {
    updates.push({
      type: "command_completed",
      command: event.item.command || "",
      output: event.item.aggregated_output || "",
      exitCode: event.item.exit_code ?? null,
    });
  }

  if (
    normalizedType === "item.completed" &&
    event.item?.type === "agent_message"
  ) {
    updates.push({
      type: "agent_message",
      text: event.item.text || "",
    });
  }

  if (normalizedType === "item.agent.message.delta") {
    updates.push({
      type: "agent_message_delta",
      delta: event.delta || "",
    });
  }

  if (normalizedType === "item.command.execution.output.delta") {
    updates.push({
      type: "command_output_delta",
      delta: event.delta || "",
    });
  }

  if (normalizedType === "item.reasoning.summary.text.delta") {
    updates.push({
      type: "reasoning_summary_delta",
      delta: event.delta || "",
    });
  }

  return updates;
}
