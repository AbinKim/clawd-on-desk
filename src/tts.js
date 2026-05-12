"use strict";

// Lightweight TTS that drives the pet window's browser SpeechSynthesis API
// from the main process. No external dependencies — Chromium ships speech
// synth on all three platforms, using OS voices.
//
// Triggers from clawd-hook events are intentionally limited to two short
// utterances ("진행중", "완료") so we don't turn the desk into a chatty pet.

function escapeJsString(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, " ")
    .replace(/\r/g, "");
}

function createTts(options = {}) {
  const getPetWebContents = typeof options.getPetWebContents === "function"
    ? options.getPetWebContents
    : () => null;
  const log = typeof options.log === "function" ? options.log : () => {};

  // Per-utterance throttling so a rapid burst (e.g. tool loop) doesn't queue
  // up overlapping speech. The renderer-side queue can also pile up if we
  // don't gate at the source.
  const lastSpoken = new Map(); // text -> timestamp
  const MIN_REPEAT_MS = 800;

  function speak(text, opts = {}) {
    if (!text || typeof text !== "string") return;
    const now = Date.now();
    const last = lastSpoken.get(text) || 0;
    if (now - last < MIN_REPEAT_MS) return;
    lastSpoken.set(text, now);

    const wc = getPetWebContents();
    if (!wc || wc.isDestroyed()) return;

    const lang = typeof opts.lang === "string" && opts.lang ? opts.lang : "ko-KR";
    const rate = Number.isFinite(opts.rate) ? opts.rate : 1.05;
    const volume = Number.isFinite(opts.volume) ? opts.volume : 0.9;
    const pitch = Number.isFinite(opts.pitch) ? opts.pitch : 1;

    const js = `(function(){
      try {
        if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return false;
        var u = new SpeechSynthesisUtterance('${escapeJsString(text)}');
        u.lang = '${escapeJsString(lang)}';
        u.rate = ${rate};
        u.volume = ${volume};
        u.pitch = ${pitch};
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
        return true;
      } catch (e) { return false; }
    })();`;

    wc.executeJavaScript(js, true).catch((err) => {
      log(`tts: speak failed: ${err && err.message ? err.message : err}`);
    });
  }

  return { speak };
}

module.exports = { createTts };
