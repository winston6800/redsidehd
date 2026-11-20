// Popup: buttons send messages to the service worker, and the view is redrawn from chrome.storage.local.
(function () {
  "use strict";
  var CFG = self.HD_CONFIG;
  var $ = function (id) { return document.getElementById(id); };

  function ask(cmd, extra) {
    return chrome.runtime.sendMessage(Object.assign({ hd: "ui", cmd: cmd }, extra || {})).then(function (r) {
      if (r && r.ok === false) setStatusText(r.error, "error");
      return r;
    });
  }
  function setStatusText(text, cls) {
    var s = $("status");
    s.textContent = text;
    s.className = "status" + (cls ? " " + cls : "");
  }

  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }

  function render(st) {
    var run = st.run || {};
    var cls = run.phase === "error" ? "error" : run.phase === "done" || run.phase === "waiting" ? "ok" : "";
    setStatusText(run.message || "Idle.", cls);
    ["run", "test", "dry"].forEach(function (id) { $(id).disabled = !!run.busy; });

    var pend = st.pending || [];
    var ul = $("pending");
    ul.innerHTML = "";
    if (!pend.length) ul.innerHTML = "<li>None yet.</li>";
    pend.slice().reverse().forEach(function (p) {
      var li = document.createElement("li");
      li.innerHTML = "<b>" + esc(p.name) + "</b><br>" + p.invoices.length + " invoice(s), status: " + esc(p.status) +
        (p.polls ? ", checks: " + p.polls : "") + (p.file ? ", saved: " + esc(p.file) : "") +
        (p.note ? '<br><span class="note">' + esc(p.note) + "</span>" : "");
      var b = document.createElement("button");
      b.textContent = "Forget";
      b.title = "Remove this request so its invoices can be requested again";
      b.onclick = function () { if (confirm("Forget request " + p.name + "? Its invoices can then be requested again.")) ask("forget", { name: p.name }); };
      li.appendChild(b);
      var er = emailRow(p, st.settings);
      if (er) li.appendChild(er);
      ul.appendChild(li);
    });

    var logEl = $("log");
    var atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 8;
    logEl.innerHTML = (st.log || []).map(function (l) {
      return '<span class="' + esc(l.level) + '">' + esc(l.t + "  " + l.msg) + "</span>";
    }).join("\n");
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;

    renderEmail(st);
    $("counts").textContent = "Info only: " + Object.keys(st.requested || {}).length + " invoice number(s) requested, " +
      Object.keys(st.downloaded || {}).length + " downloaded. Only the sent history decides what is skipped.";
    renderLedger(st.sentLedger || []);
    var sd = $("startdate");
    var want = (st.settings && st.settings.startDate) || CFG.DEFAULT_START_DATE;
    if (document.activeElement !== sd && sd.dataset.dirty !== "1") sd.value = want;
  }

  var SHOW_LEDGER = 100;
  function renderLedger(records) {
    var rows = L.newestFirst(records);
    $("ledgercount").textContent = rows.length
      ? rows.length + " invoice(s) emailed" + (rows.length > SHOW_LEDGER ? " (newest " + SHOW_LEDGER + " shown, Export CSV has all)" : "") + ". These are skipped when selecting."
      : "Nothing emailed yet. An invoice is recorded here only after its email is sent.";
    var tb = $("ledgertable").querySelector("tbody");
    tb.innerHTML = "";
    rows.slice(0, SHOW_LEDGER).forEach(function (r) {
      var tr = document.createElement("tr");
      var when = new Date(r.at);
      [r.invoice, r.amount ? "$" + r.amount : "", r.batch, r.to, isNaN(when) ? r.at : when.toLocaleString()].forEach(function (v, i) {
        var td = document.createElement("td");
        td.textContent = v;
        if (i === 4) td.title = r.at;
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    $("ledgertable").hidden = !rows.length;
  }

  function load() {
    return chrome.storage.local.get({ run: {}, pending: [], log: [], requested: {}, downloaded: {}, settings: {}, sentLedger: [] }).then(render);
  }

  var EP = self.HD_EMAIL;
  var L = self.HD_LEDGER;
  var clientId = (chrome.runtime.getManifest().oauth2 || {}).client_id;
  var setupNeeded = EP.needsSetup(clientId);

  function renderEmail(st) {
    var s = st.settings || {};
    var addr = s.email || "";
    var emailEl = $("email");
    if (document.activeElement !== emailEl && emailEl.dataset.dirty !== "1") emailEl.value = addr;
    var af = EP.isAppfolio(addr);
    var ok = EP.validateEmail(addr).ok;
    var auto = $("autosend");
    auto.checked = !!s.autoSend && ok && !af;
    auto.disabled = !ok || af;
    var msg = "";
    if (setupNeeded) msg = "Email needs one-time Google setup before it can send (see the README, Gmail setup).";
    else if (af) msg = "AppFolio address: never sent automatically. Use the button on a finished batch and confirm.";
    else if (!ok) msg = "Without an address, the PDF is only saved to Downloads.";
    else msg = "Saved. Nothing is sent until you press 'Send this batch'" + (auto.checked ? ", or after each download because the box above is ticked." : ".");
    $("emailmsg").textContent = msg;
  }

  var emailTimer = null;
  $("email").addEventListener("input", function () {
    var el = $("email");
    el.dataset.dirty = "1";
    clearTimeout(emailTimer);
    emailTimer = setTimeout(function () {
      var v = EP.validateEmail(el.value);
      if (v.ok || v.empty) {
        el.classList.remove("bad");
        ask("saveSettings", { patch: { email: el.value } }).then(function () { el.dataset.dirty = "0"; });
      } else {
        el.classList.add("bad");
        $("emailmsg").textContent = v.error + " Not saved.";
      }
    }, 350);
  });
  $("startdate").addEventListener("input", function () { $("startdate").dataset.dirty = "1"; });
  $("startdate").addEventListener("change", function () {
    var el = $("startdate");
    var v = el.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      // Cleared or incomplete: go back to the saved value, never save an empty date.
      el.dataset.dirty = "0";
      chrome.storage.local.get({ settings: {} }).then(function (r) { el.value = (r.settings && r.settings.startDate) || CFG.DEFAULT_START_DATE; });
      $("startmsg").textContent = "Pick a full date. The saved start date was kept.";
      return;
    }
    ask("saveSettings", { patch: { startDate: v } }).then(function (r) {
      el.dataset.dirty = "0";
      $("startmsg").textContent = r && r.ok ? "Saved. Invoices dated before " + v + " are never selected." : "Not saved.";
      load();
    });
  });
  $("autosend").addEventListener("change", function () { ask("saveSettings", { patch: { autoSend: $("autosend").checked } }); });

  function emailRow(p, settings) {
    var div = document.createElement("div");
    div.className = "emailrow";
    if (p.status !== "downloaded") return null;
    var addr = (settings && settings.email) || "";
    if (p.emailStatus === "sent") {
      div.innerHTML = '<span class="ok">Emailed to ' + esc(p.emailedTo || "") + ".</span>" + (p.emailNote ? ' <span class="note">' + esc(p.emailNote) + "</span>" : "");
      return div;
    }
    if (!p.hasBytes) {
      div.innerHTML = '<span class="bad">Cannot attach to an email: ' + esc(p.bytesNote || "the PDF bytes were not kept") + ". The PDF is in Downloads.</span>";
      return div;
    }
    var b = document.createElement("button");
    b.className = "sendbatch";
    if (setupNeeded) { b.textContent = "Email needs setup (see README)"; b.disabled = true; }
    else if (!EP.validateEmail(addr).ok) { b.textContent = "Enter a 'Send batch to' address first"; b.disabled = true; }
    else {
      b.textContent = "Send this batch to " + addr;
      b.onclick = function () {
        var confirmed = false;
        if (EP.isAppfolio(addr)) {
          confirmed = confirm("This sends the batch PDF to an AppFolio address (" + addr + ") from your Gmail account.\n\nSend " + p.name + " now?");
          if (!confirmed) return;
        }
        b.disabled = true;
        ask("sendBatch", { name: p.name, to: addr, confirmed: confirmed });
      };
    }
    div.appendChild(b);
    if (p.emailStatus === "failed" && p.emailNote) {
      var n = document.createElement("div");
      n.className = "bad";
      n.textContent = "Last try failed: " + p.emailNote;
      div.appendChild(n);
    }
    return div;
  }

  function nValue() {
    var v = parseInt($("n").value, 10);
    if (!isFinite(v) || v < 1) v = 1;
    if (v > CFG.MAX_BATCH) v = CFG.MAX_BATCH;
    $("n").value = v;
    ask("saveSettings", { patch: { n: v } });
    return v;
  }

  $("run").onclick = function () { ask("run", { mode: "run", n: nValue() }); };
  $("test").onclick = function () { ask("run", { mode: "test", n: nValue() }); };
  $("dry").onclick = function () { ask("run", { mode: "dry", n: nValue() }); };
  $("check").onclick = function () { ask("checkNow"); };
  $("stop").onclick = function () { ask("stop"); };
  $("clear").onclick = function () { ask("clearLog"); };
  $("copy").onclick = function () { navigator.clipboard.writeText($("log").innerText); };
  $("reset").onclick = function () {
    if (confirm("Reset request history? The extension will forget which invoices were requested and downloaded, and the pending list. The sent history is NOT cleared.")) ask("reset");
  };
  $("clearledger").onclick = function () {
    if (confirm("Clear the sent ledger? The extension will forget which invoices were emailed, and could select them again. Export the CSV first if you want a copy.")) ask("clearLedger", { confirmed: true });
  };
  $("exportcsv").onclick = async function () {
    var records = await L.create(L.chromeBackend()).list();
    if (!records.length) { setStatusText("The sent history is empty, nothing to export.", "error"); return; }
    var csv = "\uFEFF" + L.toCsv(records);
    var url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    var day = new Date().toISOString().slice(0, 10);
    try {
      await ask("expectExport", { name: "sent-history-" + day + ".csv" });
      await chrome.downloads.download({ url: url, filename: CFG.DOWNLOAD_SUBFOLDER + "/sent-history-" + day + ".csv", conflictAction: "uniquify" });
      setStatusText("Exported " + records.length + " record(s) to Downloads/" + CFG.DOWNLOAD_SUBFOLDER + "/sent-history-" + day + ".csv", "ok");
    } catch (e) {
      setStatusText("Export failed: " + e.message, "error");
    }
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  };

  chrome.storage.onChanged.addListener(load);
  chrome.storage.local.get({ settings: {} }).then(function (r) { $("n").value = (r.settings && r.settings.n) || CFG.DEFAULT_N; });
  load();
})();
