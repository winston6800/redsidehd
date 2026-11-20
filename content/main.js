// Content script entry. Receives commands from the service worker, runs them with
// the DOM logic in portal.js, and answers. It never reads form values other than
// the Download dialog's request name, never touches the sign-on form, and makes no
// network requests.
(function () {
  "use strict";
  if (window.__hdRedsideLoaded) return;
  window.__hdRedsideLoaded = true;

  var CFG = self.HD_CONFIG;
  var G = self.HD_GUARD;
  G.installBackstop(document);
  var P = self.HD_CREATE_PORTAL(window);

  var handlers = {
    ping: async function () { return { pong: true, hash: location.hash }; },
    session: async function () { return P.session(); },
    goNav: async function (m) { return P.goNav(m.label); },
    scan: async function (m) { return P.scan({ n: m.n, excluded: m.excluded, excludedSent: m.excludedSent, excludedPending: m.excludedPending, startDate: m.startDate }); },
    tick: async function (m) { return P.tick(m.numbers); },
    untick: async function (m) { return P.untick(m.numbers); },
    selection: async function () { return P.selectionSignal(); },
    openDialog: async function () { return P.openDialog(); },
    fillDialog: async function () { return P.fillDialog(); },
    startDownload: async function () { return P.startDownload(); },
    closeDialog: async function () { return P.closeDialog(); },
    readRequested: async function () { return P.readRequested(); },
    clickSubject: async function (m) { return P.clickSubject(m.name); },
    fetchSubject: async function (m) { return P.fetchSubject(m.name, !!m.wantBytes); }
  };

  if (CFG.TEST_HOOKS) {
    // Test build only: try to click whatever control has this accessible name, through the guard.
    handlers.guardProbe = async function (m) {
      var els = document.querySelectorAll("button,a,[role=button],[role=link],[role=menuitem],input");
      for (var i = 0; i < els.length; i++) {
        if (P.accName(els[i]).toLowerCase() === String(m.label).toLowerCase()) {
          try { G.guardedClick(els[i], "probe " + m.label, m.kind || "button"); return { clicked: true }; }
          catch (e) { return { clicked: false, refused: e.name === "GuardRefused", message: e.message }; }
        }
      }
      return { clicked: false, notFound: true };
    };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (sender.id !== chrome.runtime.id) return false;
    if (!msg || msg.hd !== "cmd") return false;
    var h = handlers[msg.cmd];
    if (!h) { sendResponse({ ok: false, error: "Unknown command " + msg.cmd }); return false; }
    h(msg).then(function (data) {
      var d = G.drain();
      sendResponse({ ok: true, data: data, clicks: d.clicks, refusals: d.refusals });
    }, function (err) {
      var d = G.drain();
      sendResponse({ ok: false, error: (err && err.name === "GuardRefused" ? "[guard] " : "") + (err && err.message ? err.message : String(err)), guard: !!(err && err.name === "GuardRefused"), code: (err && err.code) || null, clicks: d.clicks, refusals: d.refusals });
    });
    return true;
  });
})();
