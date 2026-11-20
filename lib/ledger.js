// The sent ledger: one record per invoice that was emailed successfully.
//
// Storage sits behind a small interface so another backend (for example a Google Sheet sync) can be added
// later without touching the callers:
//   backend.read()        -> Promise<array of records>
//   backend.write(array)  -> Promise
// and the ledger object offers add / list / has / numbers / count / clear / export.
// A Sheets backend could implement read/write against the Sheets API, or wrap `add` to also append a row.
//
// A record is { invoice, amount, batch, to, at } with `at` an ISO 8601 timestamp.
(function (root) {
  var KEY = "sentLedger";
  var CSV_COLUMNS = ["invoice", "amount", "batch", "recipient", "sent_at"];

  function str(v) { return v == null ? "" : String(v); }

  function normalize(r) {
    var invoice = str(r && r.invoice).trim();
    if (!/^[A-Za-z0-9-]+$/.test(invoice)) throw new Error("Invalid invoice number for the ledger: '" + invoice + "'");
    var at = str(r.at);
    if (!at || isNaN(Date.parse(at))) throw new Error("Ledger record for " + invoice + " needs an ISO timestamp.");
    return { invoice: invoice, amount: str(r.amount).trim(), batch: str(r.batch), to: str(r.to), at: at };
  }

  // Newest first. Ties keep the order the records were added in.
  function newestFirst(records) {
    return records.map(function (r, i) { return { r: r, i: i }; }).sort(function (a, b) {
      var d = Date.parse(b.r.at) - Date.parse(a.r.at);
      return d !== 0 ? d : a.i - b.i;
    }).map(function (x) { return x.r; });
  }

  // RFC 4180 quoting. A leading = + @ or tab is prefixed with an apostrophe so a spreadsheet never runs it as a formula.
  function csvField(v) {
    var t = str(v);
    if (/^[=+@\t\r]/.test(t) || (/^-/.test(t) && !/^-?\d+(\.\d+)?$/.test(t))) t = "'" + t;
    return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  function toCsv(records) {
    var lines = [CSV_COLUMNS.join(",")];
    records.forEach(function (r) {
      lines.push([r.invoice, r.amount, r.batch, r.to, r.at].map(csvField).join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }

  function create(backend) {
    var chain = Promise.resolve();
    function serial(fn) {
      var p = chain.then(fn);
      chain = p.then(function () {}, function () {});
      return p;
    }
    function read() { return Promise.resolve(backend.read()).then(function (a) { return Array.isArray(a) ? a : []; }); }
    return {
      // Adds records, skipping invoice numbers already present. Resolves { added, skipped }.
      add: function (records) {
        return serial(async function () {
          var cur = await read();
          var have = {};
          cur.forEach(function (r) { have[r.invoice] = true; });
          var added = 0, skipped = 0;
          var next = cur.slice();
          records.forEach(function (raw) {
            var r = normalize(raw);
            if (have[r.invoice]) { skipped++; return; }
            have[r.invoice] = true;
            next.push(r);
            added++;
          });
          if (added) await backend.write(next);
          return { added: added, skipped: skipped };
        });
      },
      list: function () { return read().then(newestFirst); },
      has: function (invoice) { return read().then(function (a) { return a.some(function (r) { return r.invoice === String(invoice); }); }); },
      numbers: function () { return read().then(function (a) { return a.map(function (r) { return r.invoice; }); }); },
      count: function () { return read().then(function (a) { return a.length; }); },
      clear: function () { return serial(async function () { var n = (await read()).length; await backend.write([]); return n; }); },
      export: function () { return read().then(function (a) { return toCsv(newestFirst(a)); }); }
    };
  }

  function memoryBackend(initial) {
    var data = (initial || []).slice();
    return { read: function () { return Promise.resolve(data.slice()); }, write: function (a) { data = a.slice(); return Promise.resolve(); } };
  }

  function chromeBackend() {
    return {
      read: function () { return chrome.storage.local.get({ sentLedger: [] }).then(function (r) { return r.sentLedger; }); },
      write: function (a) { return chrome.storage.local.set({ sentLedger: a }); }
    };
  }

  // Which invoices selection must skip, and which ones only deserve a warning.
  //   skip, ledger:   in the sent ledger.
  //   skip, pending:  in a request that is not downloaded yet (or whose email is being sent or was sent).
  //   not skipped:    requested or downloaded earlier but never emailed. Eligible again, reported as a warning.
  // A failed request whose Start Download was never confirmed does not hold its invoices.
  function selectionRule(input) {
    var ledger = {}, pending = {}, pendingList = [];
    (input.ledgerNumbers || []).forEach(function (n) { ledger[String(n)] = true; });
    (input.pending || []).forEach(function (p) {
      var holds;
      if (p.status === "downloaded") holds = p.emailStatus === "sending" || p.emailStatus === "sent";
      else holds = !(p.status === "failed" && p.unconfirmed);
      if (holds) (p.invoices || []).forEach(function (n) { if (!ledger[String(n)] && !pending[String(n)]) { pending[String(n)] = true; pendingList.push(String(n)); } });
    });
    var retry = [];
    Object.keys(input.requested || {}).concat(Object.keys(input.downloaded || {})).forEach(function (n) {
      if (!ledger[n] && !pending[n] && retry.indexOf(n) === -1) retry.push(n);
    });
    return { sent: Object.keys(ledger), pending: pendingList, retry: retry };
  }

  root.HD_LEDGER = {
    KEY: KEY, CSV_COLUMNS: CSV_COLUMNS, create: create, memoryBackend: memoryBackend, chromeBackend: chromeBackend,
    normalize: normalize, newestFirst: newestFirst, toCsv: toCsv, csvField: csvField, selectionRule: selectionRule
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.HD_LEDGER;
})(typeof self !== "undefined" ? self : globalThis);
