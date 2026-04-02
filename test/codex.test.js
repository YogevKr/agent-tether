import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexArgs,
  normalizeCodexEventType,
  toProgressUpdates,
} from "../src/codex.js";

test("When building a fresh codex turn, then cwd and prompt are included", () => {
  const args = buildCodexArgs({
    codex: {
      defaultArgs: ["--yolo"],
      model: "gpt-5.4",
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      skipGitRepoCheck: true,
    },
    prompt: "Inspect the repo",
    cwd: "/repo",
    threadId: "",
    model: "",
    outputFile: "/tmp/out.txt",
  });

  assert.deepEqual(args, [
    "--yolo",
    "exec",
    "--json",
    "-o",
    "/tmp/out.txt",
    "--skip-git-repo-check",
    "-m",
    "gpt-5.4",
    "-C",
    "/repo",
    "Inspect the repo",
  ]);
});

test("When normalizing app-server events, then streaming updates are recognized", () => {
  const type = normalizeCodexEventType("item/agentMessage/delta");
  const updates = toProgressUpdates({
    type: "item/agentMessage/delta",
    delta: "partial reply",
  });

  assert.equal(type, "item.agent.message.delta");
  assert.deepEqual(updates, [
    {
      type: "agent_message_delta",
      delta: "partial reply",
    },
  ]);
});
