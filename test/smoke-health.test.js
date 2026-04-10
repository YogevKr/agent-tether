import test from "node:test";
import assert from "node:assert/strict";
import {
  findMissingRequiredHosts,
  parseRequiredHostRefs,
  partitionHostsByHeartbeat,
} from "../src/smoke-health.js";

test("When smoke host refs are unset, then the configured host id is required", () => {
  assert.deepEqual(parseRequiredHostRefs(undefined, "mbp"), ["mbp"]);
});

test("When smoke host refs are provided, then comma separated ids and labels are supported", () => {
  assert.deepEqual(parseRequiredHostRefs("mbp, Mac mini ,"), ["mbp", "Mac mini"]);
});

test("When partitioning hosts by heartbeat, then stale and invalid entries are separated", () => {
  const { freshHosts, staleHosts } = partitionHostsByHeartbeat([
    {
      id: "fresh",
      label: "Fresh",
      lastSeenAt: "2026-04-02T10:00:00.000Z",
    },
    {
      id: "stale",
      label: "Stale",
      lastSeenAt: "2026-04-02T09:54:00.000Z",
    },
    {
      id: "invalid",
      label: "Invalid",
      lastSeenAt: "not-a-date",
    },
  ], {
    nowMs: Date.parse("2026-04-02T10:04:00.000Z"),
    maxAgeMs: 5 * 60 * 1000,
  });

  assert.deepEqual(freshHosts.map((host) => host.id), ["fresh"]);
  assert.deepEqual(staleHosts.map((host) => host.id), ["stale", "invalid"]);
});

test("When required hosts are checked, then ids and labels both satisfy the requirement", () => {
  const missing = findMissingRequiredHosts([
    {
      id: "mbp",
      label: "Yogevs-MacBook-Pro",
    },
    {
      id: "mini-id",
      label: "Yogevs-Mac-mini",
    },
  ], ["mbp", "Yogevs-Mac-mini", "missing-host"]);

  assert.deepEqual(missing, ["missing-host"]);
});
