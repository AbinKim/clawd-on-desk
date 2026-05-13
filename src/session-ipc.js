"use strict";

function requiredDependency(value, name) {
  if (!value) throw new Error(`registerSessionIpc requires ${name}`);
  return value;
}

function registerSessionIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain");
  const getSessionSnapshot = requiredDependency(options.getSessionSnapshot, "getSessionSnapshot");
  const getI18n = requiredDependency(options.getI18n, "getI18n");
  const focusSession = requiredDependency(options.focusSession, "focusSession");
  const hideSession = requiredDependency(options.hideSession, "hideSession");
  const setSessionAlias = requiredDependency(options.setSessionAlias, "setSessionAlias");
  const showDashboard = requiredDependency(options.showDashboard, "showDashboard");
  const setSessionHudPinned = requiredDependency(options.setSessionHudPinned, "setSessionHudPinned");
  // Optional Phase 7: resume a past session in a fresh terminal.
  const resumeSession = typeof options.resumeSession === "function"
    ? options.resumeSession
    : null;
  // Optional: token tracker accessor. When absent, dashboard:get-tokens
  // returns an empty payload so the renderer can hide its tokens panel.
  const getTokenSummary = typeof options.getTokenSummary === "function"
    ? options.getTokenSummary
    : () => null;
  const disposers = [];

  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    disposers.push(() => ipcMain.removeHandler(channel));
  }

  function on(channel, listener) {
    ipcMain.on(channel, listener);
    disposers.push(() => ipcMain.removeListener(channel, listener));
  }

  handle("dashboard:get-snapshot", () => getSessionSnapshot());
  handle("dashboard:get-i18n", () => getI18n());
  handle("dashboard:get-tokens", () => {
    const summary = getTokenSummary();
    return summary || null;
  });
  on("dashboard:focus-session", (_event, sessionId) =>
    focusSession(sessionId, { requestSource: "dashboard" })
  );
  handle("dashboard:hide-session", (_event, sessionId) => hideSession(sessionId));
  handle("dashboard:set-session-alias", (_event, payload) => setSessionAlias(payload));
  handle("dashboard:resume-session", (_event, sessionId) => {
    if (!resumeSession) return { status: "error", reason: "not-supported" };
    try {
      return resumeSession(sessionId) || { status: "ok" };
    } catch (err) {
      return { status: "error", reason: err && err.message };
    }
  });

  handle("session-hud:get-i18n", () => getI18n());
  on("session-hud:focus-session", (_event, sessionId) =>
    focusSession(sessionId, { requestSource: "hud" })
  );
  on("session-hud:open-dashboard", () => showDashboard());
  on("session-hud:set-pinned", (_event, value) => setSessionHudPinned(!!value));

  on("settings:open-dashboard", () => showDashboard());
  on("show-dashboard", () => showDashboard());

  return {
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        dispose();
      }
    },
  };
}

module.exports = {
  registerSessionIpc,
};
