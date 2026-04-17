import { getCodexConfig } from "./config.js";
import { runProviderHook } from "./hook-runtime.js";

await runProviderHook("codex", getCodexConfig());
