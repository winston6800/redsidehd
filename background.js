// Service worker. Orchestrates the flow and owns all stored state. It never clicks anything
// itself: every page action is a message to the content script, which goes through the click guard.
// It makes no network requests. The only outside traffic is the page's own, plus the file download
// that the portal link starts and chrome.downloads saves.
importScripts("config.js", "lib/util.js", "lib/mime.js", "lib/email-policy.js", "lib/gmail.js", "lib/bytes.js", "lib/ledger.js");

(function () {
  "use strict";
  var CFG = self.HD_CONFIG;
  var U = self.HD_UTIL;
  var ALARM = "hd-poll";
  var ACTIVE = ["starting", "requested", "downloading", "download-failed"];
  var LOG_MAX = 400;
  var EP = self.HD_EMAIL;
  var MIME = self.HD_MIME;
  var BYTES = self.HD_BYTES;
  var GMAIL = self.HD_GMAIL;
  var LG = self.HD_LEDGER;
  var LEDGER = LG.create(LG.chromeBackend());

  // ------------------------------------------------------------------ storage
  var chain = Promise.resolve();
  function locked(fn) {
    var p = chain.then(fn, fn);
    chain = p.then(function () {}, function () {});
    return p;
  }
  function getState() {
    return chrome.storage.local.get({ requested: {}, downloaded: {}, pending: [], run: { busy: false, phase: "idle", message: "" } });
  }
  function updateState(fn) {
    return locked(async function () {
      var st = await getState();
      fn(st);
      await chrome.storage.local.set({ requested: st.requested, downloaded: st.downloaded, pending: st.pending, run: st.run });
      return st;
    });
  }
  function stamp() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  function log(level, msg) {
    return locked(async function () {
      var cur = (await chrome.storage.local.get({ log: [] })).log;
      cur.push({ t: stamp(), level: level, msg: String(msg) });
      if (cur.length > LOG_MAX) cur = cur.slice(-LOG_MAX);
      await chrome.storage.local.set({ log: cur });
    });
  }
  function setRun(patch) {
    return updateState(function (st) {
      st.run = Object.assign({}, st.run, patch, { updatedAt: Date.now() });
    });
  }
  function badge(text, color) {
    try {
      chrome.action.setBadgeText({ text: text || "" });
      if (color) chrome.action.setBadgeBackgroundColor({ color: color });
    } catch (e) { /* not fatal */ }
  }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // ------------------------------------------------------------------ settings
  function getSettings() {
    return chrome.storage.local.get({ settings: {} }).then(function (r) {
      var s = r.settings || {};
      return { n: s.n, email: s.email || "", autoSend: !!s.autoSend, startDate: U.validYmd(s.startDate) ? s.startDate : CFG.DEFAULT_START_DATE };
    });
  }
  // Partial update. The address is only stored when valid (or empty), and automatic sending is forced off
  // for an empty, invalid, or AppFolio address.
  function saveSettings(patch) {
    return locked(async function () {
      var cur = (await chrome.storage.local.get({ settings: {} })).settings || {};
      var next = Object.assign({}, cur);
      if (patch.n != null) next.n = patch.n;
      if (patch.email != null) {
        var v = EP.validateEmail(patch.email);
        if (v.ok) next.email = v.value;
        else if (v.empty) next.email = "";
        else return { ok: false, error: v.error };
      }
      if (patch.startDate != null) {
        if (!U.validYmd(patch.startDate)) return { ok: false, error: "The start date must be a real date (YYYY-MM-DD)." };
        next.startDate = patch.startDate;
      }
      if (patch.autoSend != null) next.autoSend = !!patch.autoSend;
      if (!EP.canAutoSend({ autoSend: true, email: next.email })) next.autoSend = false;
      await chrome.storage.local.set({ settings: next });
      return { ok: true, settings: next };
    });
  }

  // ------------------------------------------------------------------ tabs
  async function findTab() {
    var tabs = await chrome.tabs.query({});
    var portal = tabs.filter(function (t) { return t.url && U.isPortalUrl(CFG, t.url); });
    if (!portal.length) return null;
    var active = portal.filter(function (t) { return t.active; })[0];
    return active || portal[0];
  }

  async function ping(tabId) {
    try {
      var r = await chrome.tabs.sendMessage(tabId, { hd: "cmd", cmd: "ping" });
      return !!(r && r.ok);
    } catch (e) { return false; }
  }

  // The content script is declared in the manifest, but a tab that was open before the extension
  // was loaded does not have it yet. Inject it then, so no page reload is needed.
  async function ensureContent(tabId) {
    for (var i = 0; i < 6; i++) { if (await ping(tabId)) return; await sleep(400); }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ["config.js", "lib/mime.js", "content/guard.js", "content/portal.js", "content/main.js"]
      });
    } catch (e) {
      throw new Error("Could not reach the Citi page (" + e.message + "). Reload the Citi tab and try again.");
    }
    for (var j = 0; j < 12; j++) { if (await ping(tabId)) return; await sleep(500); }
    throw new Error("The Citi page did not answer. Reload the Citi tab and try again.");
  }

  async function ensureTab(opts) {
    var tab = await findTab();
    if (!tab) {
      if (!opts.create) throw new Error("No Citi tab is open. Open the portal, log in, and try again.");
      await log("info", "No Citi tab open. Opening one at the Invoices page.");
      tab = await chrome.tabs.create({ url: CFG.INVOICES_URL, active: !!opts.activate });
      for (var i = 0; i < 60; i++) {
        var t = await chrome.tabs.get(tab.id);
        if (t.status === "complete") break;
        await sleep(500);
      }
    } else if (opts.activate) {
      try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) { /* ignore */ }
    }
    await ensureContent(tab.id);
    return tab.id;
  }

  async function reloadTab(tabId) {
    await chrome.tabs.reload(tabId);
    for (var i = 0; i < 60; i++) {
      await sleep(500);
      var t = await chrome.tabs.get(tabId);
      if (t.status === "complete") break;
    }
    await ensureContent(tabId);
  }

  function withTimeout(promise, ms, what) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error("Timed out waiting for the page (" + what + ")")); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  async function send(tabId, cmd, extra, timeoutMs) {
    var msg = Object.assign({ hd: "cmd", cmd: cmd }, extra || {});
    var r;
    try {
      r = await withTimeout(chrome.tabs.sendMessage(tabId, msg), timeoutMs || 90000, cmd);
    } catch (e) {
      throw new Error("Lost contact with the Citi page during '" + cmd + "': " + e.message);
    }
    if (!r) throw new Error("No answer from the Citi page for '" + cmd + "'.");
    (r.clicks || []).forEach(function (c) { log("click", c.why + (c.text ? " [" + c.text + "]" : "")); });
    (r.refusals || []).forEach(function (c) { log("guard", "REFUSED " + c.why + ": " + c.reason); });
    if (!r.ok) {
      var err = new Error(r.error || "Page command failed: " + cmd);
      err.guard = !!r.guard;
      err.code = r.code || null;
      throw err;
    }
    return r.data;
  }

  // ------------------------------------------------------------------ downloads
  var expect = null;                       // { name, until, downloadId }
  var expectLoaded = chrome.storage.local.get({ expectDownload: null }).then(function (r) { expect = r.expectDownload; });
  function saveExpect() { return chrome.storage.local.set({ expectDownload: expect }); }

  // The popup's own CSV export (a blob URL of this extension). Chrome may ignore the filename given to
  // chrome.downloads.download once a listener answers, so the name is suggested here.
  var exportExpect = null;                 // { name, until }
  chrome.downloads.onDeterminingFilename.addListener(function (item, suggest) {
    expectLoaded.then(function () {
      var url = item.finalUrl || item.url;
      if (exportExpect && Date.now() < exportExpect.until && String(item.url).indexOf("blob:chrome-extension://" + chrome.runtime.id + "/") === 0) {
        var nm = exportExpect.name;
        exportExpect = null;
        suggest({ filename: CFG.DOWNLOAD_SUBFOLDER + "/" + nm, conflictAction: "uniquify" });
        return;
      }
      var ours = expect && Date.now() < expect.until &&
        (U.isPortalDownloadUrl(CFG, item.url) || U.isPortalDownloadUrl(CFG, url)) &&
        (expect.downloadId == null || expect.downloadId === item.id);
      if (!ours) { suggest(); return; }
      expect.downloadId = item.id;
      saveExpect();
      suggest({ filename: CFG.DOWNLOAD_SUBFOLDER + "/" + U.sanitizeFilename(expect.name) + ".pdf", conflictAction: "uniquify" });
    });
    return true; // suggest() is called asynchronously
  });

  async function waitForDownload(name, timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await expectLoaded;
      if (expect && expect.name === name && expect.downloadId != null) {
        var items = await chrome.downloads.search({ id: expect.downloadId });
        var it = items[0];
        if (it && it.state === "complete") return { ok: true, item: it };
        if (it && it.state === "interrupted") return { ok: false, message: "Download interrupted: " + (it.error || "unknown") };
      }
      await sleep(1000);
    }
    return { ok: false, message: "No download started after clicking the link (timed out)." };
  }

  async function finalizeDownload(name, item) {
    var okFile = item && item.state === "complete" && item.exists !== false && item.fileSize !== 0;
    if (!okFile) {
      await updateState(function (st) {
        var p = st.pending.filter(function (x) { return x.name === name; })[0];
        if (p) { p.status = "download-failed"; p.note = "The saved file looks empty or missing."; }
      });
      await log("error", "Download finished but the file looks empty or missing. Invoices were NOT marked downloaded.");
      return false;
    }
    var rel = U.shortPath(item.filename);
    var count = 0;
    await updateState(function (st) {
      var p = st.pending.filter(function (x) { return x.name === name; })[0];
      if (!p) return;
      p.invoices.forEach(function (n) { st.downloaded[n] = { name: name, at: Date.now(), file: rel }; count++; });
      p.status = "downloaded";
      p.file = rel;
      p.note = "";
      p.downloadedAt = Date.now();
    });
    expect = null;
    await saveExpect();
    await log("ok", "Downloaded " + rel + " (" + (item.fileSize > 0 ? Math.round(item.fileSize / 1024) + " KB" : "size unknown") + "). Marked " + count + " invoice(s) as downloaded.");
    await maybeAutoSend(name);
    return true;
  }

  // If the worker was restarted mid-download, pick up where it was.
  async function reconcileDownloads() {
    await expectLoaded;
    var st = await getState();
    for (var i = 0; i < st.pending.length; i++) {
      var p = st.pending[i];
      if (p.status !== "downloading") continue;
      if (expect && expect.name === p.name && expect.downloadId != null) {
        var items = await chrome.downloads.search({ id: expect.downloadId });
        var it = items[0];
        if (it && it.state === "complete") { await finalizeDownload(p.name, it); continue; }
        if (it && it.state === "in_progress") continue;
      }
      await updateState(function (s) {
        var q = s.pending.filter(function (x) { return x.name === p.name; })[0];
        if (q && q.status === "downloading") q.status = "download-failed";
      });
    }
  }

  async function downloadPending(tabId, p) {
    await expectLoaded;
    expect = { name: p.name, until: Date.now() + 150000, downloadId: null };
    await saveExpect();
    await updateState(function (st) {
      var q = st.pending.filter(function (x) { return x.name === p.name; })[0];
      if (q) { q.status = "downloading"; q.dlAttempts = (q.dlAttempts || 0) + 1; }
    });
    var settings = await getSettings();
    var wantBytes = EP.validateEmail(settings.email).ok;
    var fetched = null;
    if (wantBytes) {
      // An address is saved, so read the PDF through the link itself. The same bytes are saved to disk and kept
      // (inside this browser only) for the email.
      await log("info", "Request '" + p.name + "' is listed. Fetching its PDF through the link so the same bytes can be emailed.");
      try { fetched = await send(tabId, "fetchSubject", { name: p.name, wantBytes: true }, 180000); }
      catch (e) { fetched = { mode: "error", reason: e.message }; }
    }
    if (fetched && fetched.mode === "fetched") {
      var bytes = MIME.base64ToBytes(fetched.b64);
      await BYTES.put(p.name, bytes);
      await updateState(function (st) {
        var q = st.pending.filter(function (x) { return x.name === p.name; })[0];
        if (q) { q.hasBytes = true; q.bytesSize = bytes.length; q.bytesNote = ""; }
      });
      await log("info", "Saving the fetched PDF (" + Math.round(bytes.length / 1024) + " KB) to Downloads/" + CFG.DOWNLOAD_SUBFOLDER + ".");
    } else {
      var why = fetched ? fetched.reason : "no email address was saved when this download started";
      await updateState(function (st) {
        var q = st.pending.filter(function (x) { return x.name === p.name; })[0];
        if (q) { q.hasBytes = false; q.bytesNote = why; }
      });
      if (fetched) await log("warn", "Cannot attach this PDF to an email: " + why + ". Downloading it the normal way instead.");
      else await log("info", "Request '" + p.name + "' is listed. Clicking its link to download.");
      await send(tabId, "clickSubject", { name: p.name });
    }
    var res = await waitForDownload(p.name, 90000);
    if (res.ok) return finalizeDownload(p.name, res.item);
    await updateState(function (st) {
      var q = st.pending.filter(function (x) { return x.name === p.name; })[0];
      if (q) {
        q.status = (q.dlAttempts || 0) >= 3 ? "failed" : "download-failed";
        q.note = res.message;
      }
    });
    await log("error", "Download did not complete: " + res.message);
    return false;
  }

  // ------------------------------------------------------------------ polling
  var polling = false;
  var runningNow = false;

  function scheduleAlarm() {
    chrome.alarms.create(ALARM, { delayInMinutes: CFG.POLL_MINUTES });
  }

  async function pollOnce(manual) {
    if (polling) return;
    if (runningNow) { scheduleAlarm(); return; }
    polling = true;
    try {
      await reconcileDownloads();
      var st = await getState();
      var now = Date.now();
      var active = st.pending.filter(function (p) { return ACTIVE.indexOf(p.status) !== -1; });
      if (!active.length) { await chrome.alarms.clear(ALARM); badge(""); return; }

      // Give up on requests that never showed up.
      var expired = active.filter(function (p) { return now > p.deadline; });
      if (expired.length) {
        await updateState(function (s) {
          s.pending.forEach(function (p) {
            if (ACTIVE.indexOf(p.status) !== -1 && now > p.deadline) {
              p.status = "failed";
              p.note = "Did not appear in Requested Invoices within " + CFG.POLL_MAX_MINUTES + " minutes.";
            }
          });
          // A request we were never sure was accepted frees its invoices again.
          s.pending = s.pending.filter(function (p) { return !(p.status === "failed" && p.unconfirmed); });
        });
        for (var e = 0; e < expired.length; e++) await log("error", "Gave up waiting for '" + expired[e].name + "' after " + CFG.POLL_MAX_MINUTES + " minutes. Check Requested Invoices in the portal.");
        st = await getState();
        active = st.pending.filter(function (p) { return ACTIVE.indexOf(p.status) !== -1; });
        if (!active.length) { await chrome.alarms.clear(ALARM); badge("!", "#b00020"); return; }
      }

      var tabId = await ensureTab({ create: true, activate: false });
      var s0 = await send(tabId, "session");
      if (s0.signedOut) return pause("The Citi session timed out. Log in again, then press 'Check now' in the extension.");

      var pollNo = Math.max.apply(null, active.map(function (p) { return (p.polls || 0) + 1; }));
      if (pollNo > 1 && pollNo % CFG.RELOAD_EVERY_POLLS === 0) {
        await log("info", "Reloading the Citi page before this check.");
        await reloadTab(tabId);
        var s1 = await send(tabId, "session");
        if (s1.signedOut) return pause("The Citi session timed out. Log in again, then press 'Check now' in the extension.");
      }
      var nav1 = await send(tabId, "goNav", { label: "Invoices" });
      if (nav1.signedOut) return pause("The Citi session timed out. Log in again, then press 'Check now' in the extension.");
      var nav2 = await send(tabId, "goNav", { label: "Manage Account" });
      if (nav2.signedOut) return pause("The Citi session timed out. Log in again, then press 'Check now' in the extension.");
      var req = await send(tabId, "readRequested");
      if (req.signedOut) return pause("The Citi session timed out. Log in again, then press 'Check now' in the extension.");
      if (!req.tableFound) {
        await log("warn", "Could not find the REQUESTED INVOICES table on Manage Account. Will try again.");
      } else {
        await log("info", "Poll " + pollNo + ": Requested Invoices shows " + req.subjects.length + " row(s). Newest: " + (req.subjects.slice(0, 2).join(" | ") || "none"));
      }
      for (var i = 0; i < active.length; i++) {
        var p = active[i];
        var found = req.tableFound && req.subjects.indexOf(p.name) !== -1;
        await updateState(function (s) {
          var q = s.pending.filter(function (x) { return x.name === p.name; })[0];
          if (q) { q.polls = (q.polls || 0) + 1; q.lastPollAt = Date.now(); if (found && q.status === "starting") { q.status = "requested"; q.unconfirmed = false; } }
        });
        if (found) {
          if (p.status === "starting") {
            // The request did go through even though the success text was never seen.
            await updateState(function (s) { p.invoices.forEach(function (n) { s.requested[n] = { name: p.name, at: Date.now() }; }); });
          }
          badge("");
          var ok = await downloadPending(tabId, p);
          void ok;
        }
      }
      st = await getState();
      if (st.pending.some(function (p) { return ACTIVE.indexOf(p.status) !== -1; })) {
        scheduleAlarm();
        badge("...", "#8a6d00");
      } else {
        await chrome.alarms.clear(ALARM);
        var failed = st.pending.some(function (p) { return p.status === "failed"; });
        badge(failed ? "!" : "", "#b00020");
      }
    } catch (err) {
      await log("error", "Polling problem: " + err.message + (manual ? "" : " Will try again."));
      var st2 = await getState();
      if (st2.pending.some(function (p) { return ACTIVE.indexOf(p.status) !== -1; })) scheduleAlarm();
    } finally {
      polling = false;
    }
  }

  async function pause(message) {
    await updateState(function (s) {
      s.pending.forEach(function (p) {
        if (ACTIVE.indexOf(p.status) !== -1) { p.status = "paused"; p.note = message; }
      });
    });
    await chrome.alarms.clear(ALARM);
    await log("error", message);
    badge("!", "#b00020");
  }

  chrome.alarms.onAlarm.addListener(function (a) { if (a.name === ALARM) pollOnce(false); });

  // ------------------------------------------------------------------ the run
  function fail(message) { var e = new Error(message); e.userFacing = true; return e; }

  async function doRun(mode, nRaw) {
    var n = U.clampN(nRaw, CFG.MAX_BATCH, CFG.DEFAULT_N);
    var label = mode === "dry" ? "dry run" : mode === "test" ? "test mode" : "run";
    var tabId = null, ticked = null, dialogOpen = false, started = false;
    runningNow = true;
    try {
      await setRun({ busy: true, phase: "starting", mode: mode, message: "Starting " + label + "...", startedAt: Date.now() });
      await log("info", "=== " + label.toUpperCase() + " started, up to " + n + " newest eligible invoices ===");
      badge("");

      tabId = await ensureTab({ create: false, activate: mode !== "dry" });
      var s0 = await send(tabId, "session");
      if (s0.signedOut) throw fail("You are not logged in to Citi in that tab. Log in, then try again.");

      await setRun({ phase: "invoices", message: "Opening Invoices..." });
      var nav = await send(tabId, "goNav", { label: "Invoices" });
      if (nav.signedOut) throw fail("The Citi session timed out. Log in again, then try again.");
      if (!nav.rows) throw fail("The Invoices page showed no invoice rows ('Select invoice number ...' checkboxes).");

      var st = await getState();
      var settings = await getSettings();
      var startDate = settings.startDate;
      var ledgerNumbers = await LEDGER.numbers();
      var rule = LG.selectionRule({ ledgerNumbers: ledgerNumbers, pending: st.pending, requested: st.requested, downloaded: st.downloaded });
      await log("info", "Start from invoice date: " + startDate + ". Invoices dated before it, or with no readable date, are never selected.");
      await log("info", "Selection rule: skip invoices in the sent ledger (" + rule.sent.length + ") and in a request that is still pending (" + rule.pending.length + "). An invoice that was requested or downloaded but never emailed is eligible again. Citi's 'Recently Downloaded' tag is ignored.");

      await setRun({ phase: "scan", message: "Reading the invoice list..." });
      var scan, tk;
      for (var attempt = 1; attempt <= 2; attempt++) {
        scan = await send(tabId, "scan", { n: n, excludedSent: rule.sent, excludedPending: rule.pending, startDate: startDate }, 180000);
        await log("info", "Saw " + scan.rowsSeen + " invoice row(s) in total (" + scan.expansions + " list expansion(s)); dates run " + (scan.oldestDate || "?") + " to " + (scan.newestDate || "?") + ", read from " + scan.dateSource + "; ordered by " + scan.orderedBy + ".");
        await log("info", "On or after " + scan.startDate + ": " + scan.inRange + " row(s) in the date range; " + scan.beforeStart + " older (never selected); " + scan.sentExcluded + " excluded by the sent ledger; " + scan.pendingExcluded + " excluded by a pending request; " + scan.newAvailable + " eligible.");
        if (scan.undated.length) await log("warn", scan.undated.length + " row(s) have no date that could be read as MM/DD/YYYY and were excluded: " + scan.undated.slice(0, 20).join(", ") + (scan.undated.length > 20 ? ", ..." : ""));
        if (scan.recentTagged.length) await log("info", scan.recentTagged.length + " row(s) carry Citi's 'Recently Downloaded' tag. Info only: it is not used for selection.");
        var again = scan.newNumbers.filter(function (x) { return rule.retry.indexOf(x) !== -1; });
        if (again.length) await log("warn", again.length + " picked invoice(s) were requested or downloaded earlier but never emailed, so they are eligible again: " + again.join(", "));
        if (!scan.newNumbers.length) {
          await log("ok", "Nothing eligible to request.");
          await setRun({ busy: false, phase: "done", message: "Nothing eligible to request (" + scan.inRange + " in the date range, " + scan.sentExcluded + " already emailed)." });
          return;
        }
        await log("info", (mode === "dry" ? "Would select " : "Will select ") + scan.newNumbers.length + " invoice(s): " + scan.newNumbers.join(", "));
        if (scan.newAvailable < n) await log("info", "Only " + scan.newAvailable + " new invoice(s) were available, fewer than the " + n + " asked for.");
        if (scan.preChecked.length) await log("info", "Already ticked on the page: " + scan.preChecked.join(", ") + (mode === "dry" ? ". A real run would keep the wanted ones as they are and untick the rest." : ". Wanted ones are kept as they are, the rest will be unticked."));
        if (mode === "dry") {
          await log("ok", "DRY RUN finished. Nothing was ticked or requested.");
          await setRun({ busy: false, phase: "done", message: "Dry run: would select " + scan.newNumbers.length + " invoice(s). Nothing was ticked." });
          return;
        }

        await setRun({ phase: "tick", message: "Ticking " + scan.newNumbers.length + " invoice(s)..." });
        try {
          tk = await send(tabId, "tick", { numbers: scan.newNumbers }, 180000);
          break;
        } catch (err) {
          if (err.code !== "DIRTY_SELECTION" || attempt === 2) {
            if (err.code === "DIRTY_SELECTION") throw fail(err.message + " Untick everything on the Invoices page (or reload it) and run again.");
            throw err;
          }
          await log("warn", err.message + " Reloading the page to clear the selection, then trying once more.");
          await reloadTab(tabId);
          var navAgain = await send(tabId, "goNav", { label: "Invoices" });
          if (navAgain.signedOut) throw fail("The Citi session timed out. Log in again, then try again.");
        }
      }
      ticked = tk.ticked;
      (tk.diag || []).forEach(function (d) { log(/markup of the box|looks ticked|Trusting/.test(d) ? "warn" : "info", d); });
      await log("info", "Ticked set is exactly " + tk.ticked.length + " invoice(s)." + (tk.stickyCount != null ? " The portal's bar says " + tk.stickyCount + "." : " Could not read the portal's count."));
      if (tk.stickyCount != null && tk.stickyCount !== tk.ticked.length) {
        throw fail("The portal says " + tk.stickyCount + " selected but " + tk.ticked.length + " were ticked. Stopping before the Download dialog.");
      }

      await setRun({ phase: "dialog", message: "Opening the Download Invoices dialog..." });
      await send(tabId, "openDialog");
      dialogOpen = true;
      var fill = await send(tabId, "fillDialog");
      await log("info", "Dialog: Type '" + fill.type + "', Format '" + fill.format + "', request name '" + fill.name + "'.");
      if (!fill.typeShownInDialog || !fill.formatShownInDialog) await log("warn", "The dialog text does not show the chosen Type or Format. Check it by eye.");
      var inName = U.parseRequestName(fill.name);
      if (inName != null && inName !== ticked.length) {
        throw fail("The request name says " + inName + " invoices but " + ticked.length + " are ticked. Stopping before Start Download.");
      }

      if (mode === "test") {
        await log("ok", "TEST MODE: everything is filled in. Stopping BEFORE Start Download. Closing the dialog and unticking.");
        await send(tabId, "closeDialog"); dialogOpen = false;
        await send(tabId, "untick", { numbers: ticked }); ticked = null;
        await setRun({ busy: false, phase: "done", message: "Test mode finished. Dialog filled for " + scan.newNumbers.length + " invoice(s), request name '" + fill.name + "'. Start Download was NOT pressed." });
        return;
      }

      // Record the intent first so these invoices are never picked twice, even if this worker dies now.
      await updateState(function (s) {
        s.pending = s.pending.filter(function (p) { return p.name !== fill.name; });
        s.pending.push({
          name: fill.name, invoices: scan.newNumbers.slice(), status: "starting", unconfirmed: true, amounts: scan.amounts || {},
          createdAt: Date.now(), deadline: Date.now() + CFG.POLL_MAX_MINUTES * 60000, polls: 0, note: ""
        });
      });
      await setRun({ phase: "start", message: "Pressing Start Download..." });
      started = true;
      var res = await send(tabId, "startDownload", {}, 70000);
      if (!res.ok) {
        if (res.refused) {
          started = false;
          await updateState(function (s) { s.pending = s.pending.filter(function (p) { return p.name !== fill.name; }); });
          throw fail("The portal refused the request: '" + res.message + "'. Nothing was marked as requested. Wait a few minutes and run again.");
        }
        // No success and no error text: it may still have gone through, so keep it pending and look for it.
        throw fail(res.message + " The request is kept as pending and will be looked for in Requested Invoices.");
      }
      await updateState(function (s) {
        scan.newNumbers.forEach(function (x) { s.requested[x] = { name: fill.name, at: Date.now() }; });
        var p = s.pending.filter(function (q) { return q.name === fill.name; })[0];
        if (p) { p.status = "requested"; p.unconfirmed = false; }
      });
      ticked = null; dialogOpen = false;
      await log("ok", "Request accepted: '" + fill.name + "' (" + scan.newNumbers.length + " invoices). Marked as requested. Now waiting for it to appear in Requested Invoices.");
      try { await send(tabId, "closeDialog"); } catch (e) { /* the page may have closed it */ }
      await setRun({ busy: false, phase: "waiting", message: "Requested '" + fill.name + "'. Checking Requested Invoices every " + CFG.POLL_MINUTES + " minute(s)." });
      scheduleAlarm();
      badge("...", "#8a6d00");
    } catch (err) {
      await log("error", (err.userFacing ? "" : "Unexpected problem: ") + err.message);
      if (started) await log("warn", "Start Download may or may not have gone through. It is kept as pending and will be looked for in Requested Invoices.");
      // Best-effort tidy up so the page is not left half set up. Both steps go through the click guard.
      if (tabId != null && !started) {
        try { if (dialogOpen) await send(tabId, "closeDialog"); } catch (e) { /* ignore */ }
        try { if (ticked) await send(tabId, "untick", { numbers: ticked }); } catch (e) { /* ignore */ }
      }
      await setRun({ busy: false, phase: "error", message: err.message });
      if (started) scheduleAlarm();
      badge("!", "#b00020");
    } finally {
      runningNow = false;
    }
  }

  // ------------------------------------------------------------------ email
  // Mail goes out only through the Gmail API with the scope gmail.send, using a token Chrome hands over for
  // one request. Nothing about the token is stored or logged by this extension.
  var sending = new Set();

  async function getToken(interactive) {
    if (CFG.FAKE_TOKEN) return CFG.FAKE_TOKEN; // test build only
    var r;
    try { r = await chrome.identity.getAuthToken({ interactive: !!interactive }); }
    catch (e) {
      var err = new Error(interactive
        ? "Google sign-in did not complete: " + e.message
        : "Gmail access has not been approved yet. Press 'Send this batch' once to approve it.");
      err.code = interactive ? "AUTH" : "NEEDS_APPROVAL";
      throw err;
    }
    var t = typeof r === "string" ? r : r && r.token;
    if (!t) { var e2 = new Error("Google did not return an access token."); e2.code = "AUTH"; throw e2; }
    return t;
  }

  function setEmailState(name, patch) {
    return updateState(function (st) {
      var p = st.pending.filter(function (x) { return x.name === name; })[0];
      if (p) Object.keys(patch).forEach(function (k) { p[k] = patch[k]; });
    });
  }

  // args: name, trigger ("button" or "auto"), to (address shown on the button), confirmed (AppFolio confirm dialog)
  async function sendBatch(args) {
    var name = args.name;
    if (sending.has(name)) return { ok: false, error: "Already sending this batch." };
    sending.add(name);
    try {
      return await sendBatchOnce(args);
    } finally {
      sending.delete(name);
    }
  }

  async function sendBatchOnce(args) {
    var name = args.name;
    var settings = await getSettings();
    var gate = EP.checkSend({ settings: settings, trigger: args.trigger, to: args.to, confirmed: args.confirmed });
    if (!gate.ok) {
      await log("warn", "Email not sent: " + gate.reason);
      return { ok: false, error: gate.reason, needsConfirm: !!gate.needsConfirm };
    }
    var clientId = (chrome.runtime.getManifest().oauth2 || {}).client_id;
    if (EP.needsSetup(clientId)) {
      var m0 = "Email needs one-time Google setup first (see the README: Gmail setup). The client ID in manifest.json is still the placeholder.";
      await log("warn", "Email not sent: " + m0);
      return { ok: false, error: m0 };
    }
    var st0 = await getState();
    var p = st0.pending.filter(function (x) { return x.name === name; })[0];
    if (!p || p.status !== "downloaded") return { ok: false, error: "That batch has not finished downloading." };
    if (!p.hasBytes) {
      var m1 = "This batch cannot be attached: " + (p.bytesNote || "its PDF bytes were not kept") + ". The PDF is in Downloads/" + CFG.DOWNLOAD_SUBFOLDER + ".";
      await log("warn", "Email not sent: " + m1);
      return { ok: false, error: m1 };
    }
    try {
      var rec = await BYTES.get(name);
      if (!rec || !rec.bytes) throw new Error("The PDF bytes for this batch are no longer held (they are kept for 3 days). The PDF is in Downloads/" + CFG.DOWNLOAD_SUBFOLDER + ".");
      if (rec.bytes.length > EP.MAX_PDF_BYTES) throw new Error("The PDF is " + Math.round(rec.bytes.length / 1048576) + " MB, over the " + Math.round(EP.MAX_PDF_BYTES / 1048576) + " MB limit for emailing. Send it by hand from Downloads.");
      await setEmailState(name, { emailStatus: "sending", emailNote: "" });
      await log("info", "Emailing '" + name + "' (" + Math.round(rec.bytes.length / 1024) + " KB) to " + gate.to + (args.trigger === "auto" ? " automatically." : " because you pressed the button."));
      var mime = MIME.buildMime({
        to: gate.to,
        subject: EP.subjectFor(name),
        body: EP.bodyFor(name, p.invoices.length),
        filename: U.sanitizeFilename(name) + ".pdf",
        bytes: rec.bytes
      });
      var raw = MIME.toBase64Url(mime);
      var token = await getToken(args.trigger === "button");
      var out;
      try { out = await GMAIL.sendRaw({ base: CFG.GMAIL_BASE, token: token, raw: raw }); }
      catch (e) {
        if (e.code === "AUTH" && !CFG.FAKE_TOKEN) {
          try { await chrome.identity.removeCachedAuthToken({ token: token }); } catch (x) { /* ignore */ }
          var token2 = await getToken(args.trigger === "button");
          out = await GMAIL.sendRaw({ base: CFG.GMAIL_BASE, token: token2, raw: raw });
        } else throw e;
      }
      // The ledger is written only here, after Gmail returned success.
      var sentAt = new Date().toISOString();
      var amounts = p.amounts || {};
      var ledgerNote = "";
      try {
        var led = await LEDGER.add(p.invoices.map(function (num) { return { invoice: num, amount: amounts[num] || "", batch: name, to: gate.to, at: sentAt }; }));
        await log("ok", "Sent ledger: recorded " + led.added + " invoice(s)" + (led.skipped ? " (" + led.skipped + " were already in it)" : "") + ".");
      } catch (le) {
        ledgerNote = " The email WAS sent but the sent ledger could not be written (" + le.message + ").";
        await log("error", "Email sent but the sent ledger write failed: " + le.message);
      }
      await BYTES.del(name);
      await setEmailState(name, { emailStatus: "sent", emailedTo: gate.to, emailedAt: Date.now(), emailNote: ledgerNote.trim(), hasBytes: false, bytesNote: "the bytes were released after sending" });
      await log("ok", "Emailed '" + name + "' to " + gate.to + " (Gmail message id " + (out.id || "unknown") + ").");
      return { ok: true, id: out.id };
    } catch (err) {
      var msg = err.code === "AUTH" || err.status === 401
        ? "Gmail did not accept the sign-in (" + err.message + "). Press the button again to sign in."
        : err.message;
      await setEmailState(name, { emailStatus: "failed", emailNote: msg });
      await log("error", "Email failed: " + msg);
      return { ok: false, error: msg };
    }
  }

  async function maybeAutoSend(name) {
    try {
      var settings = await getSettings();
      if (!settings.autoSend) return;
      if (!EP.canAutoSend(settings)) {
        await log("info", "Automatic sending is on but not allowed for this address" + (EP.isAppfolio(settings.email) ? " (AppFolio addresses are never sent automatically)" : "") + ". Use the button in the popup.");
        return;
      }
      var st = await getState();
      var p = st.pending.filter(function (x) { return x.name === name; })[0];
      if (!p || !p.hasBytes || p.emailStatus === "sent") return;
      await sendBatch({ name: name, trigger: "auto", to: settings.email });
    } catch (e) {
      await log("error", "Automatic email problem: " + e.message);
    }
  }

  // ------------------------------------------------------------------ popup messages
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (sender.id !== chrome.runtime.id || !msg || msg.hd !== "ui") return false;
    (async function () {
      if (msg.cmd === "run") {
        if (runningNow) return { ok: false, error: "A run is already in progress." };
        doRun(msg.mode, msg.n);
        return { ok: true };
      }
      if (msg.cmd === "checkNow") {
        if (runningNow || polling) return { ok: false, error: "Busy right now. Try again in a moment." };
        await updateState(function (s) {
          s.pending.forEach(function (p) {
            if (p.status === "paused" || p.status === "download-failed" || p.status === "failed") {
              p.status = "requested"; p.deadline = Date.now() + CFG.POLL_MAX_MINUTES * 60000; p.dlAttempts = 0; p.note = "";
            }
          });
        });
        badge("");
        await log("info", "Manual check of Requested Invoices.");
        pollOnce(true);
        return { ok: true };
      }
      if (msg.cmd === "stop") {
        await chrome.alarms.clear(ALARM);
        await pause("Polling stopped by you. Press 'Check now' to resume.");
        return { ok: true };
      }
      if (msg.cmd === "forget") {
        await updateState(function (s) {
          var p = s.pending.filter(function (x) { return x.name === msg.name; })[0];
          if (p) p.invoices.forEach(function (n) { if (!s.downloaded[n]) delete s.requested[n]; });
          s.pending = s.pending.filter(function (x) { return x.name !== msg.name; });
        });
        try { await BYTES.del(msg.name); } catch (e) { /* ignore */ }
        await log("info", "Forgot request '" + msg.name + "'. Its invoices can be requested again.");
        return { ok: true };
      }
      if (msg.cmd === "reset") {
        await chrome.alarms.clear(ALARM);
        expect = null;
        try { await BYTES.clear(); } catch (e) { /* ignore */ }
        await chrome.storage.local.set({ requested: {}, downloaded: {}, pending: [], expectDownload: null, log: [], run: { busy: false, phase: "idle", message: "History reset." } });
        await log("info", "History reset: requested, downloaded, and pending lists cleared. The sent ledger was NOT touched.");
        badge("");
        return { ok: true };
      }
      if (msg.cmd === "saveSettings") return saveSettings(msg.patch || {});
      if (msg.cmd === "sendBatch") return sendBatch({ name: msg.name, trigger: "button", to: msg.to, confirmed: msg.confirmed === true });
      if (msg.cmd === "expectExport") {
        var nm0 = U.sanitizeFilename(msg.name);
        if (!/\.csv$/i.test(nm0)) return { ok: false, error: "Only CSV exports are expected." };
        exportExpect = { name: nm0, until: Date.now() + 30000 };
        return { ok: true };
      }
      if (msg.cmd === "clearLedger") {
        if (msg.confirmed !== true) return { ok: false, error: "Clearing the sent ledger needs confirmation." };
        var removed = await LEDGER.clear();
        await log("warn", "Sent ledger cleared on request: " + removed + " record(s) removed. Those invoices are eligible again.");
        return { ok: true, removed: removed };
      }
      if (msg.cmd === "clearLog") {
        await chrome.storage.local.set({ log: [] });
        return { ok: true };
      }
      return { ok: false, error: "Unknown command" };
    })().then(sendResponse, function (e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  });

  // ------------------------------------------------------------------ startup
  async function onWake() {
    try { await BYTES.purgeOld(); } catch (e) { /* ignore */ }
    var st = await getState();
    if (st.run && st.run.busy && !runningNow) {
      await updateState(function (s) { s.run.busy = false; s.run.phase = "error"; s.run.message = "The extension was restarted during a run. Check the log and Requested Invoices."; });
      await log("warn", "The extension worker restarted in the middle of a run. Any request that was started is kept as pending.");
    }
    if (st.pending.some(function (p) { return ACTIVE.indexOf(p.status) !== -1; })) {
      var a = await chrome.alarms.get(ALARM);
      if (!a) scheduleAlarm();
    }
  }
  chrome.runtime.onStartup.addListener(onWake);
  chrome.runtime.onInstalled.addListener(onWake);
  onWake();

  if (CFG.TEST_HOOKS) {
    self.__hdTest = { send: send, findTab: findTab, pollOnce: pollOnce };
  }
})();
