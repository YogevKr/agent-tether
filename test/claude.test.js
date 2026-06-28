import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildClaudeArgs, runClaudeTurn } from "../src/claude.js";

test("When building a fresh Claude Code turn, then print json args are included", () => {
  const args = buildClaudeArgs({
    claude: {
      defaultArgs: ["--dangerously-skip-permissions"],
      model: "claude-sonnet-4-5",
      permissionMode: "acceptEdits",
    },
    prompt: "Inspect the repo",
    threadId: "",
    model: "",
  });

  assert.deepEqual(args, [
    "--dangerously-skip-permissions",
    "-p",
    "--output-format",
    "json",
    "--model",
    "claude-sonnet-4-5",
    "--permission-mode",
    "acceptEdits",
    "Inspect the repo",
  ]);
});

test("When building a resumed Claude Code turn, then resume and explicit model override are included", () => {
  const args = buildClaudeArgs({
    claude: {
      defaultArgs: [],
      model: "claude-sonnet-4-5",
      permissionMode: "",
    },
    prompt: "Continue from Telegram",
    threadId: "session-123",
    model: "claude-opus-4-1",
  });

  assert.deepEqual(args, [
    "-p",
    "--output-format",
    "json",
    "--resume",
    "session-123",
    "--model",
    "claude-opus-4-1",
    "Continue from Telegram",
  ]);
});

test("When building a Claude Code turn with extra attachment directories, then each directory is added", () => {
  const args = buildClaudeArgs({
    claude: {
      defaultArgs: ["--dangerously-skip-permissions"],
      model: "",
      permissionMode: "",
    },
    prompt: "Check the uploaded files",
    threadId: "",
    model: "",
    attachments: {
      extraDirs: ["/tmp/upload-one", "/tmp/upload-two"],
    },
  });

  assert.deepEqual(args, [
    "--dangerously-skip-permissions",
    "-p",
    "--output-format",
    "json",
    "--add-dir",
    "/tmp/upload-one",
    "--add-dir",
    "/tmp/upload-two",
    "Check the uploaded files",
  ]);
});

test("When Claude exits without JSON but writes stderr, then stderr is surfaced", async () => {
  const bin = await writeFakeClaude();

  try {
    await assert.rejects(
      runClaudeTurn({
        claude: {
          bin: process.execPath,
          defaultArgs: [bin, "stderr-fail"],
          model: "",
          permissionMode: "",
        },
        prompt: "Inspect the repo",
        cwd: path.dirname(bin),
      }),
      (error) => {
        assert.match(error.message, /fake claude stderr failure/);
        assert.doesNotMatch(error.message, /finished without JSON output/);
        return true;
      },
    );
  } finally {
    await removeFakeClaude(bin);
  }
});

test("When Claude prints invalid JSON, then stdout preview is surfaced", async () => {
  const bin = await writeFakeClaude();

  try {
    await assert.rejects(
      runClaudeTurn({
        claude: {
          bin: process.execPath,
          defaultArgs: [bin, "invalid-json"],
          model: "",
          permissionMode: "",
        },
        prompt: "Inspect the repo",
        cwd: path.dirname(bin),
      }),
      (error) => {
        assert.match(error.message, /Claude Code returned invalid JSON output/);
        assert.match(error.message, /stdout:\nnot json/);
        return true;
      },
    );
  } finally {
    await removeFakeClaude(bin);
  }
});

test("When Claude returns a JSON error result, then only the result message is surfaced", async () => {
  const bin = await writeFakeClaude();

  try {
    await assert.rejects(
      runClaudeTurn({
        claude: {
          bin: process.execPath,
          defaultArgs: [bin, "json-error"],
          model: "",
          permissionMode: "",
        },
        prompt: "Inspect the repo",
        cwd: path.dirname(bin),
      }),
      (error) => {
        assert.equal(error.message, "Not logged in");
        return true;
      },
    );
  } finally {
    await removeFakeClaude(bin);
  }
});

async function writeFakeClaude() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tether-claude-test-"));
  const file = path.join(dir, "fake-claude.js");
  await fs.writeFile(
    file,
    [
      "const mode = process.argv[2];",
      "if (mode === 'stderr-fail') {",
      "  process.stderr.write('fake claude stderr failure\\n');",
      "  process.exit(2);",
      "}",
      "if (mode === 'invalid-json') {",
      "  process.stdout.write('not json\\n');",
      "  process.exit(0);",
      "}",
      "if (mode === 'json-error') {",
      "  process.stdout.write(JSON.stringify({",
      "    is_error: true,",
      "    result: 'Not logged in',",
      "    session_id: 'session-1',",
      "  }));",
      "  process.exit(1);",
      "}",
    ].join("\n"),
  );

  return file;
}

async function removeFakeClaude(file) {
  await fs.rm(path.dirname(file), { recursive: true, force: true });
}
