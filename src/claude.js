import { spawn } from "node:child_process";

export async function runClaudeTurn({
  claude,
  prompt,
  cwd,
  threadId = "",
  model = "",
  attachments = null,
  signal,
}) {
  const args = buildClaudeArgs({
    claude,
    prompt,
    threadId,
    model,
    attachments,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(claude.bin, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (signal) {
      if (signal.aborted) {
        child.kill("SIGTERM");
      } else {
        signal.addEventListener(
          "abort",
          () => {
            child.kill("SIGTERM");
          },
          { once: true },
        );
      }
    }

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);

    child.on("close", (code) => {
      try {
        const body = parseClaudeJson(stdout);
        const finalMessage = String(body.result || "").trim();
        const resolvedThreadId = String(body.session_id || threadId || "").trim();

        if (code !== 0 || body.is_error || body.subtype === "error") {
          reject(new Error(stderr.trim() || finalMessage || "Claude Code exited without output."));
          return;
        }

        if (!resolvedThreadId) {
          reject(new Error("Claude Code finished without returning a session id."));
          return;
        }

        if (!finalMessage) {
          reject(new Error("Claude Code finished without a final message."));
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

export function buildClaudeArgs({
  claude,
  prompt,
  threadId,
  model,
  attachments,
}) {
  const args = [...(claude.defaultArgs || []), "-p", "--output-format", "json"];

  if (threadId) {
    args.push("--resume", threadId);
  }

  if (model || claude.model) {
    args.push("--model", model || claude.model);
  }

  if (claude.permissionMode) {
    args.push("--permission-mode", claude.permissionMode);
  }

  for (const extraDir of attachments?.extraDirs || []) {
    args.push("--add-dir", extraDir);
  }

  args.push(prompt);

  return args;
}

function parseClaudeJson(stdout) {
  const trimmed = String(stdout || "").trim();

  if (!trimmed) {
    throw new Error("Claude Code finished without JSON output.");
  }

  return JSON.parse(trimmed);
}
