import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROJECT_ROOT } from "./config.js";

const CODEX_HOME = path.join(os.homedir(), ".codex");
const CONFIG_PATH = path.join(CODEX_HOME, "config.toml");
const HOOKS_PATH = path.join(CODEX_HOME, "hooks.json");
const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_HOME, "settings.json");
const CODEX_HOOK_COMMAND = `/usr/bin/env node ${path.join(PROJECT_ROOT, "src/codex-hook.js")}`;
const CLAUDE_HOOK_COMMAND = `/usr/bin/env node ${path.join(PROJECT_ROOT, "src/claude-hook.js")}`;

async function main() {
  await fs.mkdir(CODEX_HOME, { recursive: true });
  await fs.mkdir(CLAUDE_HOME, { recursive: true });
  await installConfigToml();
  await installHooksJson();
  await installClaudeSettingsJson();

  console.log(`installed config: ${CONFIG_PATH}`);
  console.log(`installed hooks: ${HOOKS_PATH}`);
  console.log(`installed claude settings: ${CLAUDE_SETTINGS_PATH}`);
  console.log(`codex hook command: ${CODEX_HOOK_COMMAND}`);
  console.log(`claude hook command: ${CLAUDE_HOOK_COMMAND}`);
}

async function installConfigToml() {
  const current = await fs.readFile(CONFIG_PATH, "utf8").catch(() => "");

  if (current.includes("codex_hooks = true")) {
    return;
  }

  const next = current.includes("[features]")
    ? current.replace("[features]", "[features]\ncodex_hooks = true")
    : `${current.trimEnd()}\n\n[features]\ncodex_hooks = true\n`;

  await fs.writeFile(CONFIG_PATH, next.replace(/^\n+/, ""));
}

async function installHooksJson() {
  const current = await fs.readFile(HOOKS_PATH, "utf8").catch(() => "");
  const parsed = current ? JSON.parse(current) : {};
  const hooks = parsed.hooks || {};

  hooks.SessionStart = mergeHookEntries(hooks.SessionStart, "startup|resume");
  hooks.UserPromptSubmit = mergeHookEntries(hooks.UserPromptSubmit);
  hooks.Stop = mergeHookEntries(hooks.Stop);

  await fs.writeFile(
    HOOKS_PATH,
    `${JSON.stringify({ ...parsed, hooks }, null, 2)}\n`,
  );
}

function mergeHookEntries(entries = [], matcher = undefined) {
  const list = Array.isArray(entries) ? [...entries] : [];
  const existing = list.find((entry) => entry.matcher === matcher || (!matcher && !entry.matcher));

  if (existing) {
    existing.hooks = mergeCommands(existing.hooks || []);
    return list;
  }

  list.push({
    ...(matcher ? { matcher } : {}),
    hooks: mergeCommands([]),
  });

  return list;
}

function mergeCommands(commands) {
  if (commands.some((hook) => hook.type === "command" && hook.command === CODEX_HOOK_COMMAND)) {
    return commands;
  }

  return [
    ...commands,
    {
      type: "command",
      command: CODEX_HOOK_COMMAND,
    },
  ];
}

async function installClaudeSettingsJson() {
  const current = await fs.readFile(CLAUDE_SETTINGS_PATH, "utf8").catch(() => "");
  const parsed = current ? JSON.parse(current) : {};
  const hooks = parsed.hooks || {};

  hooks.SessionStart = mergeClaudeHookEntries(hooks.SessionStart, "startup|resume");
  hooks.UserPromptSubmit = mergeClaudeHookEntries(hooks.UserPromptSubmit);
  hooks.Stop = mergeClaudeHookEntries(hooks.Stop);

  await fs.writeFile(
    CLAUDE_SETTINGS_PATH,
    `${JSON.stringify({ ...parsed, hooks }, null, 2)}\n`,
  );
}

function mergeClaudeHookEntries(entries = [], matcher = undefined) {
  const list = Array.isArray(entries) ? [...entries] : [];
  const existing = list.find((entry) => entry.matcher === matcher || (!matcher && !entry.matcher));

  if (existing) {
    existing.hooks = mergeClaudeCommands(existing.hooks || []);
    return list;
  }

  list.push({
    ...(matcher ? { matcher } : {}),
    hooks: mergeClaudeCommands([]),
  });

  return list;
}

function mergeClaudeCommands(commands) {
  if (commands.some((hook) => hook.type === "command" && hook.command === CLAUDE_HOOK_COMMAND)) {
    return commands;
  }

  return [
    ...commands,
    {
      type: "command",
      command: CLAUDE_HOOK_COMMAND,
    },
  ];
}

await main();
