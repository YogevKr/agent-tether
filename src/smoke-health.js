export function parseRequiredHostRefs(value, defaultHostId = "") {
  const raw = value === undefined ? defaultHostId : value;

  return String(raw || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function partitionHostsByHeartbeat(hosts, {
  nowMs = Date.now(),
  maxAgeMs = 300000,
} = {}) {
  const freshHosts = [];
  const staleHosts = [];

  for (const host of hosts) {
    if (isFreshHeartbeat(host.lastSeenAt, { nowMs, maxAgeMs })) {
      freshHosts.push(host);
    } else {
      staleHosts.push(host);
    }
  }

  return { freshHosts, staleHosts };
}

export function findMissingRequiredHosts(freshHosts, requiredHostRefs) {
  return requiredHostRefs.filter(
    (requiredHostRef) =>
      !freshHosts.some((host) => hostMatchesRef(host, requiredHostRef)),
  );
}

export function isFreshHeartbeat(lastSeenAt, {
  nowMs = Date.now(),
  maxAgeMs = 300000,
} = {}) {
  const parsed = Date.parse(lastSeenAt || "");

  if (Number.isNaN(parsed)) {
    return false;
  }

  return nowMs - parsed <= maxAgeMs;
}

function hostMatchesRef(host, requiredHostRef) {
  const normalized = String(requiredHostRef);
  return String(host.id || "") === normalized || String(host.label || "") === normalized;
}
