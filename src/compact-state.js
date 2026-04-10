import { getStateStoreConfig } from "./config.js";
import { StateStore } from "./state-store.js";

const DEFAULT_TERMINAL_JOB_RETENTION_DAYS = 14;
const DEFAULT_MAX_TERMINAL_JOBS = 5000;

async function main() {
  const stateStoreConfig = getStateStoreConfig();
  const options = parseArgs(process.argv.slice(2), {
    terminalJobRetentionDays: DEFAULT_TERMINAL_JOB_RETENTION_DAYS,
    maxTerminalJobs: DEFAULT_MAX_TERMINAL_JOBS,
  });
  const store = new StateStore(stateStoreConfig.filePath, {
    fallbackReadPaths: stateStoreConfig.fallbackReadPaths,
  });
  const result = await store.compactState({
    terminalJobRetentionMs: options.terminalJobRetentionDays * 24 * 60 * 60 * 1000,
    maxTerminalJobs: options.maxTerminalJobs,
    dryRun: !options.execute,
  });

  console.log(JSON.stringify({
    ...result,
    terminalJobRetentionDays: options.terminalJobRetentionDays,
    maxTerminalJobs: options.maxTerminalJobs,
    stateFile: stateStoreConfig.filePath,
  }, null, 2));

  if (!options.execute) {
    console.log("dry run only; re-run with --execute to mutate state");
  }
}

function parseArgs(argv, defaults) {
  const options = {
    execute: false,
    terminalJobRetentionDays: parseNonNegativeNumber(
      process.env.RELAY_TERMINAL_JOB_PRUNE_AFTER_DAYS,
      defaults.terminalJobRetentionDays,
    ),
    maxTerminalJobs: parseNonNegativeInteger(
      process.env.RELAY_MAX_TERMINAL_JOBS,
      defaults.maxTerminalJobs,
    ),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--execute") {
      options.execute = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.execute = false;
      continue;
    }

    if (arg === "--terminal-job-retention-days") {
      options.terminalJobRetentionDays = parseNonNegativeNumber(requireNextValue(argv, index, arg));
      index += 1;
      continue;
    }

    if (arg === "--max-terminal-jobs") {
      options.maxTerminalJobs = parseNonNegativeInteger(requireNextValue(argv, index, arg));
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function requireNextValue(argv, index, flag) {
  const value = argv[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function parseNonNegativeNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseFloat(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative number, got: ${value}`);
  }

  return parsed;
}

function parseNonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got: ${value}`);
  }

  return parsed;
}

function printUsage() {
  console.log([
    "Usage: npm run compact-state -- [--terminal-job-retention-days <days>] [--max-terminal-jobs <count>] [--execute]",
    "",
    "Default is a dry run using RELAY_TERMINAL_JOB_PRUNE_AFTER_DAYS and RELAY_MAX_TERMINAL_JOBS.",
    "Use --execute to prune old completed, failed, or cancelled jobs from STATE_FILE.",
  ].join("\n"));
}

await main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
