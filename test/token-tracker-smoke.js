"use strict";

// Quick smoke test: parse this session's real transcript and print totals.
// Run: node test/token-tracker-smoke.js <transcript_path>
const path = require("path");
const { createTokenTracker } = require("../src/token-tracker");

const transcriptPath = process.argv[2];
if (!transcriptPath) {
  console.error("usage: node test/token-tracker-smoke.js <transcript.jsonl>");
  process.exit(2);
}

const tracker = createTokenTracker({
  historyPath: null,
  log: (m) => console.log("[tracker]", m),
});

const sid = "smoke-session";
const res = tracker.scanTranscript(transcriptPath, sid);
console.log("scan result:", res);
console.log("session summary:");
console.log(JSON.stringify(tracker.getSessionSummary(sid), null, 2));
console.log("daily total:");
console.log(JSON.stringify(tracker.getDailyTotal(), null, 2));
console.log("status:");
console.log(JSON.stringify(tracker.getStatus(), null, 2));
