import fs from "node:fs/promises";
import {
  CLAUDE_HOME,
  CLAUDE_HOOK_COMMAND,
  CLAUDE_SETTINGS_PATH,
  CODEX_HOME,
  CODEX_HOOK_COMMAND,
  CONFIG_PATH,
  HOOKS_PATH,
  ensureClaudeHooksConfig,
  ensureCodexHooksConfig,
} from "./hook-config.js";

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

  await fs.writeFile(
    HOOKS_PATH,
    `${JSON.stringify(ensureCodexHooksConfig(parsed), null, 2)}\n`,
  );
}

async function installClaudeSettingsJson() {
  const current = await fs.readFile(CLAUDE_SETTINGS_PATH, "utf8").catch(() => "");
  const parsed = current ? JSON.parse(current) : {};

  await fs.writeFile(
    CLAUDE_SETTINGS_PATH,
    `${JSON.stringify(ensureClaudeHooksConfig(parsed), null, 2)}\n`,
  );
}

await main();
