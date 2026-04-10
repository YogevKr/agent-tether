import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_HOOK_COMMAND,
  CODEX_HOOK_COMMAND,
  ensureClaudeHooksConfig,
  ensureCodexHooksConfig,
  hasClaudeHooksInstalled,
  hasCodexHooksInstalled,
} from "../src/hook-config.js";

test("When Codex hooks are ensured twice, then the config stays installed without duplicates", () => {
  const once = ensureCodexHooksConfig({
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: "echo existing",
            },
          ],
        },
      ],
    },
  });
  const twice = ensureCodexHooksConfig(once);

  assert.equal(hasCodexHooksInstalled(twice), true);
  assert.equal(twice.hooks.SessionStart.length, 1);
  assert.equal(twice.hooks.UserPromptSubmit.length, 1);
  assert.equal(
    twice.hooks.UserPromptSubmit[0].hooks.filter((hook) => hook.command === CODEX_HOOK_COMMAND).length,
    1,
  );
});

test("When Claude hooks are ensured, then settings report the install as healthy", () => {
  const settings = ensureClaudeHooksConfig({
    effortLevel: "high",
    enabledPlugins: {
      "gopls-lsp@claude-plugins-official": true,
    },
  });

  assert.equal(hasClaudeHooksInstalled(settings), true);
  assert.equal(settings.hooks.SessionStart[0].matcher, "startup|resume");
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, CLAUDE_HOOK_COMMAND);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, CLAUDE_HOOK_COMMAND);
});
