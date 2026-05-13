"use strict";

// Detects tool-call loops. The "stuck" signal is conservative on
// purpose — we'd rather miss a borderline case than ping the user every
// time Claude legitimately retries a command twice. Threshold defaults
// are tuned against a 5-minute sliding window.
//
// Keying is (sessionId, fingerprint). The fingerprint comes from
// hooks/clawd-hook.js (SHA-1 of the normalized tool_input), so two
// invocations of the same tool with different arguments don't collide.
//
// Failure-marked events count for half the threshold of regular ones —
// repeated failures of the same call are a stronger stuck signal than
// repeated successful calls (which are often a legitimate fan-out).

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_THRESHOLD = 3;
const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const SESSION_CAP = 200; // max fingerprints retained per session

function createLoopDetector(options = {}) {
  const windowMs = Number(options.windowMs) || DEFAULT_WINDOW_MS;
  const threshold = Number(options.threshold) || DEFAULT_THRESHOLD;
  const failureThreshold = Number(options.failureThreshold) || DEFAULT_FAILURE_THRESHOLD;
  const cooldownMs = Number(options.cooldownMs) || DEFAULT_COOLDOWN_MS;
  const onLoopDetected = typeof options.onLoopDetected === "function"
    ? options.onLoopDetected
    : null;

  // sessionId -> Map<fingerprint, { successes: number[], failures: number[], toolName }>
  const seen = new Map();
  // sessionId:fingerprint -> last alert timestamp
  const lastAlertAt = new Map();

  function prune(entry, now) {
    entry.successes = entry.successes.filter((t) => now - t <= windowMs);
    entry.failures = entry.failures.filter((t) => now - t <= windowMs);
  }

  function record({ sessionId, toolName, fingerprint, failure, cwd }) {
    if (!sessionId || !fingerprint) return null;
    const now = Date.now();
    let sessMap = seen.get(sessionId);
    if (!sessMap) {
      sessMap = new Map();
      seen.set(sessionId, sessMap);
    }
    if (sessMap.size > SESSION_CAP) {
      // Drop oldest entries to keep memory bounded
      const it = sessMap.keys();
      sessMap.delete(it.next().value);
    }
    let entry = sessMap.get(fingerprint);
    if (!entry) {
      entry = { successes: [], failures: [], toolName: toolName || null };
      sessMap.set(fingerprint, entry);
    }
    (failure ? entry.failures : entry.successes).push(now);
    prune(entry, now);

    const repeats = entry.successes.length + entry.failures.length;
    const tripped =
      entry.failures.length >= failureThreshold ||
      repeats >= threshold;
    if (!tripped) return null;

    const alertKey = `${sessionId}:${fingerprint}`;
    const lastAlert = lastAlertAt.get(alertKey) || 0;
    if (now - lastAlert < cooldownMs) return null;
    lastAlertAt.set(alertKey, now);

    const payload = {
      sessionId,
      toolName: entry.toolName,
      fingerprint,
      successes: entry.successes.length,
      failures: entry.failures.length,
      windowMs,
      cwd: cwd || null,
    };
    if (onLoopDetected) {
      try { onLoopDetected(payload); } catch {}
    }
    return payload;
  }

  function getActiveLoops() {
    const now = Date.now();
    const out = [];
    for (const [sessionId, sessMap] of seen) {
      for (const [fingerprint, entry] of sessMap) {
        prune(entry, now);
        const repeats = entry.successes.length + entry.failures.length;
        if (repeats >= threshold || entry.failures.length >= failureThreshold) {
          out.push({
            sessionId,
            fingerprint,
            toolName: entry.toolName,
            successes: entry.successes.length,
            failures: entry.failures.length,
          });
        }
      }
    }
    return out;
  }

  function clearSession(sessionId) {
    seen.delete(sessionId);
    for (const key of [...lastAlertAt.keys()]) {
      if (key.startsWith(`${sessionId}:`)) lastAlertAt.delete(key);
    }
  }

  return { record, getActiveLoops, clearSession };
}

module.exports = {
  createLoopDetector,
  DEFAULT_WINDOW_MS,
  DEFAULT_THRESHOLD,
  DEFAULT_FAILURE_THRESHOLD,
};
