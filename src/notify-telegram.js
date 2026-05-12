"use strict";

const https = require("https");

const HOST = "api.telegram.org";
const TIMEOUT_MS = 10_000;

function sendTelegramMessage({ botToken, chatId, text, parseMode = "HTML" }) {
  return new Promise((resolve, reject) => {
    if (!botToken || !chatId || !text) {
      reject(new Error("missing telegram config (botToken / chatId / text)"));
      return;
    }
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    });
    const req = https.request(
      {
        hostname: HOST,
        path: `/bot${encodeURIComponent(botToken)}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(raw || "{}")); }
            catch { resolve({ ok: true }); }
          } else {
            reject(new Error(`telegram ${res.statusCode}: ${raw.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("telegram request timed out"));
    });
    req.end(body);
  });
}

function escapeHtml(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

module.exports = { sendTelegramMessage, escapeHtml };
