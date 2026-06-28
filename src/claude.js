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
        const body = parseClaudeJson(stdout, { stderr, code });
        const finalMessage = String(body.result || "").trim();
        const resolvedThreadId = String(body.session_id || threadId || "").trim();

        if (code !== 0 || body.is_error || body.subtype === "error") {
          reject(
            new Error(
              formatClaudeFailure({
                stderr,
                code,
                fallback: finalMessage || "Claude Code exited without output.",
              }),
            ),
          );
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

function parseClaudeJson(stdout, { stderr = "", code = 0 } = {}) {
  const trimmed = String(stdout || "").trim();

  if (!trimmed) {
    throw new Error(
      formatClaudeFailure({
        stderr,
        stdout,
        code,
        fallback:
          code && code !== 0
            ? `Claude Code exited with code ${code} without JSON output.`
            : "Claude Code finished without JSON output.",
      }),
    );
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      formatClaudeFailure({
        stderr,
        stdout,
        code,
        fallback: "Claude Code returned invalid JSON output.",
      }),
      { cause: error },
    );
  }
}

function formatClaudeFailure({ stderr = "", stdout = "", code = 0, fallback }) {
  const stderrText = String(stderr || "").trim();
  const stdoutText = String(stdout || "").trim();
  const parts = [];

  if (stderrText) {
    parts.push(stderrText);
  }

  if (stdoutText) {
    parts.push(`stdout:\n${previewText(stdoutText)}`);
  }

  if (stderrText) {
    return parts.join("\n\n");
  }

  if (stdoutText && fallback) {
    return [fallback, ...parts].join("\n\n");
  }

  if (fallback) {
    return fallback;
  }

  return code && code !== 0
    ? `Claude Code exited with code ${code}.`
    : "Claude Code exited without output.";
}

function previewText(text, limit = 4000) {
  const value = String(text || "").trim();

  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}...`;
}
