import { getRuntimeConfig } from "./config.js";
import { runProviderHook } from "./hook-runtime.js";

await runProviderHook("claude", getRuntimeConfig());
