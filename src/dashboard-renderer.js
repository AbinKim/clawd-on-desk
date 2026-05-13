"use strict";

const AGENT_LABELS = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "copilot-cli": "Copilot",
  "cursor-agent": "Cursor Agent",
  "gemini-cli": "Gemini",
  "kiro-cli": "Kiro",
  "kimi-cli": "Kimi",
  opencode: "opencode",
  codebuddy: "CodeBuddy",
  pi: "Pi",
  openclaw: "OpenClaw",
};

let snapshot = { sessions: [], groups: [], orderedIds: [] };
let i18nPayload = { lang: "en", translations: {} };
let activeEdit = null;

const titleEl = document.getElementById("title");
const countEl = document.getElementById("count");
const contentEl = document.getElementById("content");
const tokensPanelEl = document.getElementById("tokens-panel");
const tokensCostEl = document.getElementById("tokens-cost");
const tokensCountEl = document.getElementById("tokens-count");
const tokensDetailEl = document.getElementById("tokens-detail");
const contextGaugeEl = document.getElementById("context-gauge");
const contextPctEl = document.getElementById("context-pct");
const contextRatioEl = document.getElementById("context-ratio");
const contextFillEl = document.getElementById("context-fill");

function formatTokenInt(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(0)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

function formatUsd(n) {
  const v = Number(n || 0);
  if (v >= 100) return `$${v.toFixed(2)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

async function renderTokens() {
  if (!tokensPanelEl || !window.dashboardAPI || typeof window.dashboardAPI.getTokens !== "function") return;
  let payload;
  try {
    payload = await window.dashboardAPI.getTokens();
  } catch (err) {
    return;
  }
  const today = payload && payload.today ? payload.today : null;
  if (!today || !today.message_count) {
    tokensPanelEl.classList.add("hidden");
    return;
  }
  tokensPanelEl.classList.remove("hidden");
  if (tokensCostEl) tokensCostEl.textContent = formatUsd(today.cost_usd);
  if (tokensCountEl) {
    const msgs = Number(today.message_count || 0);
    tokensCountEl.textContent = `${msgs} msg${msgs === 1 ? "" : "s"}`;
  }
  if (tokensDetailEl) {
    const parts = [
      `in <strong>${formatTokenInt(today.input_tokens)}</strong>`,
      `out <strong>${formatTokenInt(today.output_tokens)}</strong>`,
      `cache 1h <strong>${formatTokenInt(today.cache_write_1h)}</strong>`,
      `cache 5m <strong>${formatTokenInt(today.cache_write_5m)}</strong>`,
      `cache read <strong>${formatTokenInt(today.cache_read_input_tokens)}</strong>`,
    ];
    tokensDetailEl.innerHTML = parts.join(" · ");
  }
  renderContextGauge(payload);
}

function renderContextGauge(payload) {
  if (!contextGaugeEl) return;
  const latest = payload && payload.active && payload.active.latest;
  if (!latest || !latest.contextSize || !latest.contextLimit) {
    contextGaugeEl.classList.add("hidden");
    return;
  }
  const size = Number(latest.contextSize) || 0;
  const limit = Number(latest.contextLimit) || 1;
  const pct = Math.max(0, Math.min(100, (size / limit) * 100));
  contextGaugeEl.classList.remove("hidden");
  if (contextPctEl) contextPctEl.textContent = `${pct.toFixed(1)}%`;
  if (contextRatioEl) {
    contextRatioEl.textContent = `${formatTokenInt(size)} / ${formatTokenInt(limit)}`;
  }
  if (contextFillEl) {
    contextFillEl.style.width = `${pct}%`;
    contextFillEl.classList.remove("warn", "crit");
    if (pct >= 90) contextFillEl.classList.add("crit");
    else if (pct >= 70) contextFillEl.classList.add("warn");
  }
}

function t(key) {
  const dict = i18nPayload && i18nPayload.translations ? i18nPayload.translations : {};
  return dict[key] || key;
}

function formatElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 5) return t("sessionJustNow");
  if (sec < 60) return t("sessionHudElapsedSec").replace("{n}", sec);
  const min = Math.floor(sec / 60);
  if (min < 60) return t("sessionMinAgo").replace("{n}", min);
  const hr = Math.floor(min / 60);
  return t("sessionHrAgo").replace("{n}", hr);
}

function badgeLabel(badge) {
  const key = {
    running: "sessionBadgeRunning",
    done: "sessionBadgeDone",
    interrupted: "sessionBadgeInterrupted",
    idle: "sessionBadgeIdle",
  }[badge] || "sessionBadgeIdle";
  return t(key);
}

function agentLabel(agentId) {
  return AGENT_LABELS[agentId] || agentId || t("dashboardUnknownAgent");
}

function agentFallback(agentId) {
  const label = agentLabel(agentId).trim();
  return label ? label.slice(0, 2).toUpperCase() : "?";
}

function createText(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text || "";
  return el;
}

function sessionTitleText(session) {
  return session.displayTitle || session.sessionTitle || session.id || "";
}

function snapshotHasSession(currentSnapshot, sessionId) {
  const sessions = Array.isArray(currentSnapshot && currentSnapshot.sessions)
    ? currentSnapshot.sessions
    : [];
  return sessions.some((session) => session && session.id === sessionId);
}

function beginTitleEdit(session) {
  if (!session || !session.id) return;
  activeEdit = {
    sessionId: session.id,
    agentId: session.agentId || null,
    host: session.host || null,
    cwd: session.cwd || "",
    initialDraft: sessionTitleText(session),
    draft: sessionTitleText(session),
    committing: false,
  };
  render({ force: true });
}

function cancelTitleEdit() {
  if (!activeEdit) return;
  activeEdit = null;
  render({ force: true });
}

async function commitTitleEdit() {
  if (!activeEdit || activeEdit.committing) return;
  const edit = activeEdit;
  if (edit.draft === edit.initialDraft) {
    activeEdit = null;
    render({ force: true });
    return;
  }
  edit.committing = true;
  try {
    const result = await window.dashboardAPI.setSessionAlias({
      host: edit.host,
      agentId: edit.agentId,
      sessionId: edit.sessionId,
      cwd: edit.cwd,
      alias: edit.draft,
    });
    if (!result || result.status !== "ok") {
      edit.committing = false;
      console.warn("session alias update failed:", result && result.message);
      render({ force: true });
      return;
    }
    if (activeEdit === edit) activeEdit = null;
    render({ force: true });
  } catch (err) {
    if (activeEdit === edit) {
      edit.committing = false;
      render({ force: true });
    }
    console.warn("session alias update threw:", err);
  }
}

function createTitle(session) {
  const text = sessionTitleText(session);
  if (activeEdit && activeEdit.sessionId === session.id) {
    const input = document.createElement("input");
    input.className = "session-title-input";
    input.type = "text";
    input.value = activeEdit.draft;
    input.addEventListener("input", () => {
      if (activeEdit && activeEdit.sessionId === session.id) {
        activeEdit.draft = input.value;
      }
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitTitleEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelTitleEdit();
      }
    });
    input.addEventListener("blur", () => {
      commitTitleEdit();
    });
    requestAnimationFrame(() => {
      if (activeEdit && activeEdit.sessionId === session.id && document.contains(input)) {
        input.focus();
        input.select();
      }
    });
    return input;
  }

  const title = createText("div", "session-title", text);
  title.title = text;
  title.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    beginTitleEdit(session);
  });
  return title;
}

function appendMeta(main, session, now) {
  const meta = createText("div", "meta", "");
  const badge = document.createElement("span");
  badge.className = `badge badge-${session.badge || "idle"}`;
  const dot = document.createElement("span");
  dot.className = "dot";
  badge.appendChild(dot);
  badge.appendChild(document.createTextNode(badgeLabel(session.badge)));

  meta.appendChild(document.createTextNode(agentLabel(session.agentId)));
  meta.appendChild(document.createTextNode(" · "));
  meta.appendChild(badge);
  meta.appendChild(document.createTextNode(` · ${formatElapsed(now - session.updatedAt)}`));
  if (session.headless) {
    meta.appendChild(document.createTextNode(` · ${t("dashboardHeadless")}`));
  }
  main.appendChild(meta);
}

function appendPath(main, session) {
  const pathText = session.cwd || t("dashboardNoPath");
  const pathEl = createText("div", "path", pathText);
  if (session.cwd) pathEl.title = session.cwd;
  main.appendChild(pathEl);
}

function appendEvent(main, session, now) {
  if (!session.lastEvent) return;
  const eventLabel = session.lastEvent.labelKey
    ? t(session.lastEvent.labelKey)
    : (session.lastEvent.rawEvent || "");
  if (!eventLabel) return;
  const eventAt = Number(session.lastEvent.at) || session.updatedAt;
  main.appendChild(createText(
    "div",
    "event-row",
    `${t("dashboardLastEventPrefix")}: ${eventLabel} · ${formatElapsed(now - eventAt)}`
  ));
}

function createIcon(session) {
  if (session.iconUrl) {
    const img = document.createElement("img");
    img.className = "agent-icon";
    img.alt = "";
    img.src = session.iconUrl;
    img.addEventListener("error", () => {
      const fallback = createText("span", "agent-fallback", agentFallback(session.agentId));
      img.replaceWith(fallback);
    }, { once: true });
    return img;
  }
  return createText("span", "agent-fallback", agentFallback(session.agentId));
}

function createHideButton(session) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "hide-session-button";
  button.textContent = "\u00d7";
  button.title = t("dashboardHideSessionTitle");
  button.setAttribute("aria-label", t("dashboardHideSessionTitle"));
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!session || !session.id || !window.dashboardAPI.hideSession) return;
    button.disabled = true;
    try {
      const result = await window.dashboardAPI.hideSession(session.id);
      if (!result || (result.status !== "ok" && result.status !== "not-found")) {
        button.disabled = false;
        console.warn("hide session failed:", result && result.message);
      }
    } catch (err) {
      button.disabled = false;
      console.warn("hide session threw:", err);
    }
  });
  return button;
}

function createCard(session, now) {
  const card = document.createElement("article");
  card.className = "card";

  if (session.id) {
    const idTail = String(session.id).slice(-3);
    card.appendChild(createText("span", "session-id-badge", `#${idTail}`));
    card.appendChild(createHideButton(session));
  }

  card.appendChild(createIcon(session));

  const main = document.createElement("div");
  main.className = "main";
  main.appendChild(createTitle(session));
  appendMeta(main, session, now);
  appendPath(main, session);
  appendEvent(main, session, now);
  card.appendChild(main);

  const actions = document.createElement("div");
  actions.className = "actions";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = t("dashboardJumpTerminal");
  button.disabled = !session.sourcePid || session.platform === "webui";
  button.addEventListener("click", () => {
    window.dashboardAPI.focusSession(session.id);
  });
  actions.appendChild(button);
  // Phase 7: Resume button — opens a fresh terminal at session.cwd and
  // invokes the agent's --resume flag with the session id. Available
  // only for the 3 supported agents with a known cwd.
  const supportedResume = new Set(["claude-code", "codex", "cursor-agent"]);
  if (session.cwd && supportedResume.has(session.agentId) && typeof window.dashboardAPI.resumeSession === "function") {
    const resumeBtn = document.createElement("button");
    resumeBtn.type = "button";
    resumeBtn.textContent = "Resume";
    resumeBtn.className = "resume-button";
    resumeBtn.title = `Resume in new terminal — ${session.cwd}`;
    resumeBtn.addEventListener("click", async () => {
      resumeBtn.disabled = true;
      try {
        const result = await window.dashboardAPI.resumeSession(session.id);
        if (result && result.status === "error") {
          console.warn("resumeSession failed:", result.reason);
        }
      } finally {
        setTimeout(() => { resumeBtn.disabled = false; }, 800);
      }
    });
    actions.appendChild(resumeBtn);
  }
  card.appendChild(actions);

  return card;
}

function deriveGroups(currentSnapshot) {
  return Array.isArray(currentSnapshot.groups) ? currentSnapshot.groups : [];
}

function renderEmpty() {
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.appendChild(createText("div", "empty-title", t("dashboardEmpty")));
  empty.appendChild(createText("div", "empty-hint", t("dashboardEmptyHint")));
  contentEl.replaceChildren(empty);
}

function render(options = {}) {
  if (activeEdit && !options.force) return;
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const count = sessions.length;
  titleEl.textContent = t("dashboardWindowTitle");
  countEl.textContent = t("dashboardCount").replace("{n}", count);
  document.title = t("dashboardWindowTitle");

  if (count === 0) {
    renderEmpty();
    return;
  }

  const now = Date.now();
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const fragment = document.createDocumentFragment();

  for (const group of deriveGroups(snapshot)) {
    const ids = Array.isArray(group.ids) ? group.ids : [];
    const groupSessions = ids.map((id) => byId.get(id)).filter(Boolean);
    if (!groupSessions.length) continue;

    const section = document.createElement("section");
    section.className = "group";
    const host = group.host || "";
    section.appendChild(createText("h2", "group-title", host || t("sessionLocal")));

    const cards = document.createElement("div");
    cards.className = "cards";
    for (const session of groupSessions) {
      cards.appendChild(createCard(session, now));
    }
    section.appendChild(cards);
    fragment.appendChild(section);
  }

  contentEl.replaceChildren(fragment);
}

async function init() {
  window.dashboardAPI.onLangChange((payload) => {
    i18nPayload = payload || i18nPayload;
    render();
  });
  window.dashboardAPI.onSessionSnapshot((nextSnapshot) => {
    snapshot = nextSnapshot || snapshot;
    if (activeEdit && !snapshotHasSession(snapshot, activeEdit.sessionId)) {
      activeEdit = null;
      render({ force: true });
    } else {
      render();
    }
    // Token usage updates roughly every hook event — refresh in lockstep.
    renderTokens();
  });

  const [nextI18n, nextSnapshot] = await Promise.all([
    window.dashboardAPI.getI18n(),
    window.dashboardAPI.getSnapshot(),
  ]);
  i18nPayload = nextI18n || i18nPayload;
  snapshot = nextSnapshot || snapshot;
  render();
  renderTokens();

  setInterval(render, 1000);
}

init().catch((err) => {
  contentEl.textContent = err && err.message ? err.message : String(err);
});
