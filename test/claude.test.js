import test from "node:test";
import assert from "node:assert/strict";
import { buildClaudeArgs } from "../src/claude.js";

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
