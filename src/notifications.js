"use strict";

const fs = require("fs");
const path = require("path");
const { sendTelegramMessage, escapeHtml } = require("./notify-telegram");

// User-editable channel config lives in:
//   %APPDATA%/clawd-on-desk/notifications.json
// Skeleton is written on first run so the user can fill in their bot
// credentials without consulting the source. All channels start disabled.
const DEFAULT_CONFIG = {
  telegram: {
    enabled: false,
    botToken: "",
    chatId: "",
    events: {
      taskDone: true,
      permissionRequest: true,
      error: true,
    },
    // Minimum seconds between events of the same type per session. Prevents
    // a spammy turn loop from blasting 50 messages.
    minIntervalSec: 120,
  },
  // Phase 5: local TTS via the pet window's SpeechSynthesis API. Short
  // phrases only ("완료" / "진행중") so it doesn't become a chatty pet.
  tts: {
    enabled: false,
    lang: "ko-KR",
    rate: 1.05,
    volume: 0.9,
    events: {
      taskStart: true,
      taskDone: true,
      permissionRequest: false,
      error: false,
    },
    phrases: {
      taskStart: "진행중",
      taskDone: "완료",
      permissionRequest: "허가",
      error: "오류",
    },
  },
};

function deepMerge(defaults, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return JSON.parse(JSON.stringify(defaults));
  }
  const out = Array.isArray(defaults)
    ? defaults.slice()
    : { ...(defaults || {}) };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(out[k] || {}, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function createNotifier(options = {}) {
  const configPath = options.configPath || null;
  const log = typeof options.log === "function" ? options.log : () => {};
  const tts = options.tts && typeof options.tts.speak === "function"
    ? options.tts
    : null;

  let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const lastSent = new Map(); // `${type}:${sessionId}` -> ms

  function loadConfig() {
    if (!configPath) return;
    try {
      if (!fs.existsSync(configPath)) return;
      const raw = fs.readFileSync(configPath, "utf8");
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw);
      config = deepMerge(DEFAULT_CONFIG, parsed);
    } catch (err) {
      log(`notifications: failed to load config: ${err.message}`);
    }
  }

  function writeConfigSkeletonIfMissing() {
    if (!configPath) return;
    try {
      if (fs.existsSync(configPath)) return;
      fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
      log(`notifications: wrote config skeleton at ${configPath}`);
    } catch (err) {
      log(`notifications: failed to write skeleton: ${err.message}`);
    }
  }

  function rateLimited(key, minSec) {
    const last = lastSent.get(key) || 0;
    const now = Date.now();
    if (now - last < (minSec || 0) * 1000) return true;
    lastSent.set(key, now);
    return false;
  }

  function formatTelegramMessage(event) {
    const sidShort = typeof event.sessionId === "string" && event.sessionId
      ? event.sessionId.slice(0, 8)
      : "?";
    const project = event.cwd ? path.basename(String(event.cwd)) : "";
    const projectTag = project ? ` · <code>${escapeHtml(project)}</code>` : "";
    const sidTag = ` · <code>${escapeHtml(sidShort)}</code>`;
    switch (event.type) {
      case "taskDone": {
        const cost = typeof event.cost === "number" && event.cost > 0
          ? ` · $${event.cost.toFixed(2)}`
          : "";
        return `✅ <b>Clawd</b> task done${projectTag}${sidTag}${cost}`;
      }
      case "permissionRequest": {
        const tool = event.toolName ? `<code>${escapeHtml(event.toolName)}</code>` : "?";
        return `🔐 <b>Clawd</b> permission needed · ${tool}${projectTag}${sidTag}`;
      }
      case "error": {
        const detail = event.message ? ` · ${escapeHtml(String(event.message).slice(0, 200))}` : "";
        return `⚠️ <b>Clawd</b> error${projectTag}${sidTag}${detail}`;
      }
      default:
        return `<b>Clawd</b> ${escapeHtml(event.type || "event")}`;
    }
  }

  function notify(event) {
    if (!event || typeof event !== "object" || !event.type) return;
    // ── Telegram channel ──
    const tg = config.telegram || {};
    if (tg.enabled && tg.botToken && tg.chatId) {
      const tgEventEnabled = tg.events && tg.events[event.type];
      if (tgEventEnabled !== false) {
        const key = `tg:${event.type}:${event.sessionId || "global"}`;
        if (!rateLimited(key, tg.minIntervalSec || 0)) {
          const text = formatTelegramMessage(event);
          sendTelegramMessage({ botToken: tg.botToken, chatId: tg.chatId, text })
            .catch((err) => log(`notifications: telegram send failed: ${err.message}`));
        }
      }
    }
    // ── TTS channel ──
    const ttsCfg = config.tts || {};
    if (tts && ttsCfg.enabled) {
      const ttsEventEnabled = ttsCfg.events && ttsCfg.events[event.type];
      if (ttsEventEnabled) {
        const phrase = ttsCfg.phrases && ttsCfg.phrases[event.type];
        if (phrase) {
          try {
            tts.speak(phrase, {
              lang: ttsCfg.lang || "ko-KR",
              rate: ttsCfg.rate,
              volume: ttsCfg.volume,
            });
          } catch (err) {
            log(`notifications: tts speak failed: ${err && err.message}`);
          }
        }
      }
    }
  }

  writeConfigSkeletonIfMissing();
  loadConfig();

  return {
    notify,
    reload: loadConfig,
    getConfig: () => JSON.parse(JSON.stringify(config)),
    // Test hook
    _internal: { formatTelegramMessage, rateLimited, lastSent },
  };
}

module.exports = { createNotifier, DEFAULT_CONFIG };
