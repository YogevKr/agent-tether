import os from "node:os";
import path from "node:path";
import { PROJECT_ROOT } from "./config.js";

export const CODEX_HOME = path.join(os.homedir(), ".codex");
export const CONFIG_PATH = path.join(CODEX_HOME, "config.toml");
export const HOOKS_PATH = path.join(CODEX_HOME, "hooks.json");
export const CLAUDE_HOME = path.join(os.homedir(), ".claude");
export const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_HOME, "settings.json");
export const CODEX_HOOK_COMMAND = `/usr/bin/env node ${path.join(PROJECT_ROOT, "src/codex-hook.js")}`;
export const CLAUDE_HOOK_COMMAND = `/usr/bin/env node ${path.join(PROJECT_ROOT, "src/claude-hook.js")}`;

export function ensureCodexHooksConfig(parsed = {}) {
  const hooks = { ...(parsed.hooks || {}) };

  hooks.SessionStart = mergeHookEntries(hooks.SessionStart, "startup|resume", CODEX_HOOK_COMMAND);
  hooks.UserPromptSubmit = mergeHookEntries(hooks.UserPromptSubmit, undefined, CODEX_HOOK_COMMAND);
  hooks.Stop = mergeHookEntries(hooks.Stop, undefined, CODEX_HOOK_COMMAND);

  return {
    ...parsed,
    hooks,
  };
}

export function ensureClaudeHooksConfig(parsed = {}) {
  const hooks = { ...(parsed.hooks || {}) };

  hooks.SessionStart = mergeHookEntries(hooks.SessionStart, "startup|resume", CLAUDE_HOOK_COMMAND);
  hooks.UserPromptSubmit = mergeHookEntries(hooks.UserPromptSubmit, undefined, CLAUDE_HOOK_COMMAND);
  hooks.Stop = mergeHookEntries(hooks.Stop, undefined, CLAUDE_HOOK_COMMAND);

  return {
    ...parsed,
    hooks,
  };
}

export function hasCodexHooksInstalled(parsed = {}) {
  return hasHookEntry(parsed.hooks?.SessionStart, "startup|resume", CODEX_HOOK_COMMAND) &&
    hasHookEntry(parsed.hooks?.UserPromptSubmit, undefined, CODEX_HOOK_COMMAND) &&
    hasHookEntry(parsed.hooks?.Stop, undefined, CODEX_HOOK_COMMAND);
}

export function hasClaudeHooksInstalled(parsed = {}) {
  return hasHookEntry(parsed.hooks?.SessionStart, "startup|resume", CLAUDE_HOOK_COMMAND) &&
    hasHookEntry(parsed.hooks?.UserPromptSubmit, undefined, CLAUDE_HOOK_COMMAND) &&
    hasHookEntry(parsed.hooks?.Stop, undefined, CLAUDE_HOOK_COMMAND);
}

function mergeHookEntries(entries = [], matcher = undefined, command) {
  const list = Array.isArray(entries) ? [...entries] : [];
  const existing = list.find((entry) => entry.matcher === matcher || (!matcher && !entry.matcher));

  if (existing) {
    existing.hooks = mergeCommands(existing.hooks || [], command);
    return list;
  }

  list.push({
    ...(matcher ? { matcher } : {}),
    hooks: mergeCommands([], command),
  });

  return list;
}

function mergeCommands(commands, command) {
  if (commands.some((hook) => hook.type === "command" && hook.command === command)) {
    return commands;
  }

  return [
    ...commands,
    {
      type: "command",
      command,
    },
  ];
}

function hasHookEntry(entries = [], matcher = undefined, command) {
  if (!Array.isArray(entries)) {
    return false;
  }

  return entries.some((entry) =>
    (entry.matcher === matcher || (!matcher && !entry.matcher)) &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some((hook) => hook.type === "command" && hook.command === command));
}
