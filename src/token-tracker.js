"use strict";

const fs = require("fs");
const path = require("path");
const { computeCostUsd, getContextLimit } = require("./token-pricing");

const PERSIST_DEBOUNCE_MS = 1500;
const MESSAGE_ID_RING = 256;
const TAIL_CHUNK_BYTES = 1024 * 1024; // 1 MB read window per scan

function todayUtcDate() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function emptyTotals() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cost_usd: 0,
    message_count: 0,
  };
}

function addUsageInto(target, usage, cost) {
  target.input_tokens += Number(usage?.input_tokens || 0);
  target.output_tokens += Number(usage?.output_tokens || 0);
  target.cache_creation_input_tokens += Number(usage?.cache_creation_input_tokens || 0);
  target.cache_read_input_tokens += Number(usage?.cache_read_input_tokens || 0);
  target.cache_write_5m += Number(usage?.cache_creation?.ephemeral_5m_input_tokens || 0);
  target.cache_write_1h += Number(usage?.cache_creation?.ephemeral_1h_input_tokens || 0);
  if (typeof cost === "number" && Number.isFinite(cost)) target.cost_usd += cost;
  target.message_count += 1;
}

function createTokenTracker(options = {}) {
  const historyPath = options.historyPath || null;
  const log = typeof options.log === "function" ? options.log : () => {};
  const pricingOverrides = options.pricingOverrides || null;

  // In-memory state
  const transcripts = new Map(); // transcriptPath -> { offset, ids: Set }
  const sessions = new Map();    // sessionId -> { byModel: Map<model, totals>, total: totals, lastUpdate }
  const daily = new Map();       // YYYY-MM-DD -> totals

  let persistTimer = null;
  let lastError = null;

  function loadFromDisk() {
    if (!historyPath) return;
    try {
      if (!fs.existsSync(historyPath)) return;
      const raw = fs.readFileSync(historyPath, "utf8");
      if (!raw.trim()) return;
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        if (data.transcripts && typeof data.transcripts === "object") {
          for (const [p, info] of Object.entries(data.transcripts)) {
            const ids = new Set(Array.isArray(info?.ids) ? info.ids.slice(-MESSAGE_ID_RING) : []);
            transcripts.set(p, { offset: Number(info?.offset || 0), ids });
          }
        }
        if (data.sessions && typeof data.sessions === "object") {
          for (const [sid, info] of Object.entries(data.sessions)) {
            const byModel = new Map();
            if (info?.byModel && typeof info.byModel === "object") {
              for (const [m, t] of Object.entries(info.byModel)) {
                byModel.set(m, { ...emptyTotals(), ...t });
              }
            }
            sessions.set(sid, {
              byModel,
              total: { ...emptyTotals(), ...(info?.total || {}) },
              lastUpdate: Number(info?.lastUpdate || 0),
            });
          }
        }
        if (data.daily && typeof data.daily === "object") {
          for (const [day, t] of Object.entries(data.daily)) {
            daily.set(day, { ...emptyTotals(), ...t });
          }
        }
      }
    } catch (err) {
      lastError = err.message;
      log(`token-tracker: failed to load history: ${err.message}`);
    }
  }

  function serializeForDisk() {
    const out = { version: 1, transcripts: {}, sessions: {}, daily: {} };
    for (const [p, info] of transcripts) {
      out.transcripts[p] = {
        offset: info.offset,
        ids: [...info.ids].slice(-MESSAGE_ID_RING),
      };
    }
    for (const [sid, info] of sessions) {
      const byModel = {};
      for (const [m, t] of info.byModel) byModel[m] = t;
      out.sessions[sid] = { byModel, total: info.total, lastUpdate: info.lastUpdate };
    }
    for (const [day, t] of daily) out.daily[day] = t;
    return out;
  }

  function scheduleWrite() {
    if (!historyPath) return;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        const tmp = `${historyPath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(serializeForDisk(), null, 2));
        fs.renameSync(tmp, historyPath);
      } catch (err) {
        lastError = err.message;
        log(`token-tracker: failed to write history: ${err.message}`);
      }
    }, PERSIST_DEBOUNCE_MS);
  }

  function getOrCreateSession(sessionId) {
    let s = sessions.get(sessionId);
    if (!s) {
      s = { byModel: new Map(), total: emptyTotals(), lastUpdate: 0 };
      sessions.set(sessionId, s);
    }
    return s;
  }

  function recordUsage(sessionId, modelId, usage) {
    const cost = computeCostUsd(usage, modelId, pricingOverrides);
    const sess = getOrCreateSession(sessionId);
    let bucket = sess.byModel.get(modelId);
    if (!bucket) {
      bucket = emptyTotals();
      sess.byModel.set(modelId, bucket);
    }
    addUsageInto(bucket, usage, cost);
    addUsageInto(sess.total, usage, cost);
    // Latest context size = prompt sent to model on the most recent turn.
    // = input_tokens + cache_read + cache_creation. This is the "in-window"
    // size that the user cares about for /compact decisions.
    const ctxSize =
      Number(usage?.input_tokens || 0) +
      Number(usage?.cache_read_input_tokens || 0) +
      Number(usage?.cache_creation_input_tokens || 0);
    sess.latest = {
      modelId,
      contextSize: ctxSize,
      contextLimit: getContextLimit(modelId, options.contextLimitOverrides, ctxSize),
      ts: Date.now(),
    };
    sess.lastUpdate = Date.now();

    const day = todayUtcDate();
    let dayBucket = daily.get(day);
    if (!dayBucket) {
      dayBucket = emptyTotals();
      daily.set(day, dayBucket);
    }
    addUsageInto(dayBucket, usage, cost);
    return cost;
  }

  function parseAssistantLine(line) {
    if (!line || !line.trim()) return null;
    let obj;
    try { obj = JSON.parse(line); } catch { return null; }
    if (!obj || obj.type !== "assistant") return null;
    const msg = obj.message;
    if (!msg || typeof msg !== "object") return null;
    const usage = msg.usage;
    if (!usage || typeof usage !== "object") return null;
    return {
      messageId: typeof msg.id === "string" ? msg.id : null,
      modelId: typeof msg.model === "string" ? msg.model : "unknown",
      usage,
    };
  }

  function scanTranscript(transcriptPath, sessionId) {
    if (!transcriptPath || typeof transcriptPath !== "string") return null;
    let stat;
    try { stat = fs.statSync(transcriptPath); } catch { return null; }
    if (!stat.isFile()) return null;

    let entry = transcripts.get(transcriptPath);
    if (!entry) {
      entry = { offset: 0, ids: new Set() };
      transcripts.set(transcriptPath, entry);
    }

    // Cap read window; if the file is huge and we just started, read from
    // (size - TAIL_CHUNK_BYTES). Otherwise read from last offset.
    let start = entry.offset;
    if (start > stat.size) start = 0; // truncated/rotated
    if (entry.offset === 0 && stat.size > TAIL_CHUNK_BYTES) {
      start = stat.size - TAIL_CHUNK_BYTES;
    }
    const readLen = stat.size - start;
    if (readLen <= 0) return { added: 0, sessionId };

    let fd;
    let buf;
    try {
      fd = fs.openSync(transcriptPath, "r");
      buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, start);
    } catch (err) {
      lastError = err.message;
      log(`token-tracker: read failed for ${transcriptPath}: ${err.message}`);
      if (fd) try { fs.closeSync(fd); } catch {}
      return null;
    }
    try { fs.closeSync(fd); } catch {}

    const data = buf.toString("utf8");
    const lines = data.split("\n");

    // If we started mid-file (initial tail), the first line is likely a
    // partial JSON fragment. Drop it.
    let dropFirst = (entry.offset === 0 && start > 0) || (entry.offset > 0 && start === entry.offset && !data.startsWith("{"));
    let lastNewlineRel = data.lastIndexOf("\n");
    let consumed = lastNewlineRel >= 0 ? lastNewlineRel + 1 : 0;

    let added = 0;
    let totalCost = 0;
    for (let i = dropFirst ? 1 : 0; i < lines.length; i++) {
      const line = lines[i];
      // Last element after split is "" if trailing newline, or a partial line
      // that we will revisit next scan — skip if no newline observed.
      if (i === lines.length - 1 && lastNewlineRel >= 0 && consumed === data.length && line === "") continue;
      if (i === lines.length - 1 && consumed < data.length) continue; // partial trailer
      const parsed = parseAssistantLine(line);
      if (!parsed) continue;
      if (parsed.messageId && entry.ids.has(parsed.messageId)) continue;
      if (parsed.messageId) {
        entry.ids.add(parsed.messageId);
        // Bound the dedup set
        if (entry.ids.size > MESSAGE_ID_RING) {
          const overflow = entry.ids.size - MESSAGE_ID_RING;
          const it = entry.ids.values();
          for (let k = 0; k < overflow; k++) entry.ids.delete(it.next().value);
        }
      }
      const cost = recordUsage(sessionId, parsed.modelId, parsed.usage);
      if (typeof cost === "number") totalCost += cost;
      added += 1;
    }

    entry.offset = start + consumed;
    if (added > 0) scheduleWrite();
    return { added, sessionId, cost: totalCost };
  }

  function getSessionSummary(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return null;
    const byModel = {};
    for (const [m, t] of s.byModel) byModel[m] = t;
    return {
      sessionId,
      byModel,
      total: s.total,
      lastUpdate: s.lastUpdate,
      latest: s.latest || null,
    };
  }

  function getActiveSession() {
    let best = null;
    let bestTs = 0;
    for (const [sid, s] of sessions) {
      if ((s.lastUpdate || 0) > bestTs) {
        bestTs = s.lastUpdate;
        best = sid;
      }
    }
    return best ? getSessionSummary(best) : null;
  }

  function getDailyTotal(day) {
    return daily.get(day || todayUtcDate()) || emptyTotals();
  }

  function getAllSessions() {
    return [...sessions.keys()].map((sid) => getSessionSummary(sid));
  }

  function getStatus() {
    return {
      tracked_sessions: sessions.size,
      tracked_transcripts: transcripts.size,
      daily_today: getDailyTotal(),
      last_error: lastError,
    };
  }

  loadFromDisk();

  return {
    scanTranscript,
    getSessionSummary,
    getActiveSession,
    getDailyTotal,
    getAllSessions,
    getStatus,
    // Test hooks
    _internal: { transcripts, sessions, daily, recordUsage, parseAssistantLine },
  };
}

module.exports = {
  createTokenTracker,
  todayUtcDate,
  emptyTotals,
};
