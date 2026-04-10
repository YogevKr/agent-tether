import { getHostIdConfig, getStateStoreConfig } from "./config.js";
import { StateStore } from "./state-store.js";

const DEFAULT_OLDER_THAN_HOURS = 24;

async function main() {
  const stateStoreConfig = getStateStoreConfig();
  const hostIdConfig = getHostIdConfig(stateStoreConfig);
  const options = parseArgs(process.argv.slice(2), {
    defaultHostId: hostIdConfig.value,
  });
  const store = new StateStore(stateStoreConfig.filePath, {
    fallbackReadPaths: stateStoreConfig.fallbackReadPaths,
  });
  const result = await store.cleanupStaleLocalCliRuns({
    hostId: options.allHosts ? "" : options.hostId,
    olderThanMs: options.olderThanHours * 60 * 60 * 1000,
    dryRun: !options.execute,
  });

  console.log(JSON.stringify({
    ...result,
    hostScope: options.allHosts ? "all" : options.hostId,
    olderThanHours: options.olderThanHours,
    stateFile: stateStoreConfig.filePath,
  }, null, 2));

  if (!options.execute) {
    console.log("dry run only; re-run with --execute to mutate state");
  }
}

function parseArgs(argv, { defaultHostId }) {
  const options = {
    allHosts: false,
    execute: false,
    hostId: process.env.RELAY_CLEANUP_HOST_ID || defaultHostId,
    olderThanHours: parsePositiveNumber(
      process.env.RELAY_STALE_LOCAL_CLI_HOURS,
      DEFAULT_OLDER_THAN_HOURS,
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

    if (arg === "--all-hosts") {
      options.allHosts = true;
      continue;
    }

    if (arg === "--host") {
      options.hostId = requireNextValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--older-than-hours") {
      options.olderThanHours = parsePositiveNumber(requireNextValue(argv, index, arg));
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.allHosts && !options.hostId) {
    throw new Error("Missing host id. Set RELAY_HOST_ID, pass --host, or use --all-hosts.");
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

function parsePositiveNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseFloat(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive number, got: ${value}`);
  }

  return parsed;
}

function printUsage() {
  console.log([
    "Usage: npm run cleanup-stale -- [--host <host-id> | --all-hosts] [--older-than-hours <hours>] [--execute]",
    "",
    "Default is a dry run scoped to RELAY_HOST_ID or the persisted local host id.",
    "Use --execute to release stale local-cli busy flags and cancel stale queued prompts.",
  ].join("\n"));
}

await main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
