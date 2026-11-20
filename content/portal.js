// DOM logic for the Citi commercial portal pages. No messaging and no storage in here.
// createPortal(win) works on a real window or on a jsdom window, which is how it is unit tested.
//
// All names below are the accessible names Winston verified on the live portal on Nov 17, 2026
// (see README, "What maps to what"). Anything marked GUESS has not been seen on the real page.
(function (root) {
  "use strict";

  function createPortal(win, deps) {
    var doc = win.document;
    var G = (deps && deps.guard) || root.HD_GUARD;
    var CFG = (deps && deps.config) || root.HD_CONFIG;

    // ---------------------------------------------------------------- basics
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function waitFor(fn, timeoutMs, everyMs) {
      var deadline = Date.now() + (timeoutMs == null ? 10000 : timeoutMs);
      var step = everyMs || 150;
      return new Promise(function (resolve) {
        (function tick() {
          var v;
          try { v = fn(); } catch (e) { v = null; }
          if (v) return resolve(v);
          if (Date.now() >= deadline) return resolve(null);
          setTimeout(tick, step);
        })();
      });
    }

    function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

    function textOf(el) {
      var t = el.innerText !== undefined && el.innerText !== null ? el.innerText : el.textContent;
      return norm(t);
    }

    function isVisible(el) {
      for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
        if (n.hidden) return false;
        if (n.getAttribute("aria-hidden") === "true" && n.tagName !== "BODY") return false;
        var cs = win.getComputedStyle(n);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
      }
      return true;
    }

    // Accessible name, close to what Playwright's get_by_role(name=...) sees.
    function accName(el) {
      var lb = el.getAttribute("aria-labelledby");
      if (lb) {
        var parts = lb.split(/\s+/).map(function (id) { var r = doc.getElementById(id); return r ? textOf(r) : ""; });
        var joined = norm(parts.join(" "));
        if (joined) return joined;
      }
      var al = el.getAttribute("aria-label");
      if (al && norm(al)) return norm(al);
      var tag = el.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") {
        if (el.id) {
          var l = doc.querySelector('label[for="' + String(el.id).replace(/"/g, '\\"') + '"]');
          if (l) return textOf(l);
        }
        var wrap = el.closest("label");
        if (wrap) return textOf(wrap);
        return norm(el.getAttribute("placeholder") || el.getAttribute("title") || "");
      }
      var t = textOf(el);
      return t || norm(el.getAttribute("title") || el.getAttribute("alt") || "");
    }

    function matches(re, s) { return typeof re === "string" ? s.toLowerCase() === re.toLowerCase() : re.test(s); }

    // First visible element among `selector` whose accessible name matches.
    function findByName(scope, selector, nameRe, opts) {
      var list = (scope || doc).querySelectorAll(selector);
      var hits = [];
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (!isVisible(el)) continue;
        if (opts && opts.not && el.closest(opts.not)) continue;
        if (!matches(nameRe, accName(el))) continue;
        if (opts && opts.textRe && !opts.textRe.test(textOf(el))) continue;
        hits.push(el);
      }
      return hits;
    }

    var CLICKABLE = "a,button,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=menu],[role=combobox],li";
    var DIALOG_SEL = "[role=dialog],[role=alertdialog],dialog,.modal,.modal-dialog,.ui-dialog";

    // ------------------------------------------------------------ session
    function session() {
      var hash = win.location.hash || "";
      var pw = doc.querySelector("input[type=password]");
      var pwVisible = !!(pw && isVisible(pw));   // presence only, the value is never read
      var body = textOf(doc.body || doc.documentElement);
      var timedOut = /your session (has )?(timed out|expired)|session (has )?(timed out|expired)/i.test(body);
      var navInvoices = findByName(doc, "a,[role=link],[role=menuitem],[role=tab],button", /^Invoices$/i).length > 0;
      var signedOut = hash.indexOf(CFG.SIGNON_HASH) !== -1 || pwVisible || timedOut;
      return { signedOut: signedOut, hash: hash, hasInvoicesNav: navInvoices };
    }

    // ------------------------------------------------------------ navigation
    function navLink(label) {
      var re = new RegExp("^" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");
      var hits = findByName(doc, "a,[role=link],[role=menuitem],[role=tab],button", re);
      return hits[0] || null;
    }

    function invoiceCheckboxes() {
      var list = doc.querySelectorAll("input[type=checkbox],[role=checkbox]");
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var m = /^Select invoice number\s+(\S+)\s*$/i.exec(accName(list[i]));
        if (m) out.push({ el: list[i], number: m[1] });
      }
      return out;
    }

    // Cell texts are checked one by one, because textContent glues neighbouring cells together.
    function hasSubjectHeader(t) {
      var cells = t.querySelectorAll("th,td,[role=columnheader],[role=cell]");
      for (var i = 0; i < cells.length; i++) if (/^\s*SUBJECT\b/i.test(textOf(cells[i]))) return true;
      return false;
    }

    // Row text with a space between cells, so a date is never glued to the number before it.
    function rowText(row) {
      var cells = row.querySelectorAll("td,th,[role=cell],[role=gridcell]");
      if (!cells.length) return textOf(row);
      return Array.prototype.map.call(cells, textOf).join(" ");
    }

    function manageTables() {
      var all = doc.querySelectorAll("table,[role=table],[role=grid]");
      var withSubject = [];
      for (var i = 0; i < all.length; i++) {
        if (isVisible(all[i]) && hasSubjectHeader(all[i])) withSubject.push(all[i]);
      }
      // Innermost only, so a layout table that wraps the real one is skipped.
      return withSubject.filter(function (t) {
        return !withSubject.some(function (o) { return o !== t && t.contains(o); });
      });
    }

    async function goNav(label) {
      var wantHash = label === "Invoices" ? CFG.INVOICES_HASH : label === "Manage Account" ? CFG.MANAGE_HASH : null;
      if (!wantHash) throw new Error("Unknown navigation target: " + label);
      var link = await waitFor(function () { return navLink(label); }, 8000);
      if (link) {
        G.guardedClick(link, "open " + label, "link");
      } else {
        // Same fallback as the Python fetcher: set the hash directly. This is not a click.
        win.location.hash = wantHash;
      }
      var hashKey = wantHash.slice(1);
      await waitFor(function () { return (win.location.hash || "").indexOf(hashKey) !== -1; }, 8000);
      if ((win.location.hash || "").indexOf(hashKey) === -1) win.location.hash = wantHash;
      if (label === "Invoices") {
        var ready = await waitFor(function () { return invoiceCheckboxes().length > 0 || session().signedOut; }, 25000);
        return { hash: win.location.hash, ready: !!ready, rows: invoiceCheckboxes().length, signedOut: session().signedOut };
      }
      var tbl = await waitFor(function () { return manageTables().length > 0 || session().signedOut; }, 20000);
      return { hash: win.location.hash, ready: !!tbl, signedOut: session().signedOut };
    }

    // -------------------------------------------------------------- invoices
    // The reference code skips rows inside a Credits table (_IN_CREDITS_JS in citi_fetch.py).
    function inCredits(el) {
      var n = el;
      for (var d = 0; n && n.nodeType === 1 && d < 14; d++, n = n.parentElement) {
        var meta = [n.id, typeof n.className === "string" ? n.className : "", n.getAttribute("aria-label"), n.getAttribute("data-testid"), n.getAttribute("data-section")].join(" ");
        if (/credit/i.test(meta)) return true;
        var h = n.querySelector(":scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > legend,:scope > caption,:scope > [role=heading]");
        if (h) {
          var t = textOf(h);
          if (/credit/i.test(t)) return true;
          if (/invoice/i.test(t)) return false;
        }
      }
      return false;
    }

    var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    // Strict: a date that does not exist (13/45/2026, 02/30/2026) is null, never rolled over to another day.
    function utcDate(y, mo, d) {
      if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
      var t = Date.UTC(y, mo - 1, d);
      var chk = new Date(t);
      return chk.getUTCFullYear() === y && chk.getUTCMonth() === mo - 1 && chk.getUTCDate() === d ? t : null;
    }
    function firstDate(text) {
      var m = /(^|[^\d\/])(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/.exec(text);
      if (m) return utcDate(+m[4], +m[2], +m[3]);
      m = /(^|\D)(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(text);
      if (m) return utcDate(+m[2], +m[3], +m[4]);
      m = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(text);
      if (m) return utcDate(+m[3], MONTHS[m[1].toLowerCase()] + 1, +m[2]);
      return null;
    }
    function ymd(ms) { return ms == null ? "" : new Date(ms).toISOString().slice(0, 10); }

    // Money in a cell: "$1,234.50" -> "1234.50", "($12.00)" or "-$12.00" -> "-12.00".
    function moneyIn(text) {
      var out = [];
      var re = /(\()?\s*(-)?\s*\$?\s*(-)?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?!\d)/g, m;
      while ((m = re.exec(text))) {
        var neg = m[1] || m[2] || m[3];
        out.push((neg ? "-" : "") + m[4].replace(/,/g, "") + "." + m[5]);
      }
      return out;
    }

    // Column lookup by header text, so the due date or a balance is never mistaken for the invoice date or amount.
    function columnCells(row, headerRe, notRe) {
      var table = row.closest("table,[role=table],[role=grid]");
      if (!table) return null;
      var heads = table.querySelectorAll("th,[role=columnheader]");
      var cells = row.querySelectorAll("td,[role=cell],[role=gridcell]");
      if (!heads.length || !cells.length) return null;
      var headRow = heads[0].closest("tr,[role=row]");
      var hs = headRow ? headRow.querySelectorAll("th,td,[role=columnheader]") : heads;
      if (hs.length !== cells.length) return null;
      for (var i = 0; i < hs.length; i++) {
        var t = textOf(hs[i]);
        if (headerRe.test(t) && !(notRe && notRe.test(t))) return cells[i];
      }
      return null;
    }

    var dateSources = { header: 0, fallback: 0 };
    function dateOf(row) {
      var cell = row ? columnCells(row, /invoice\s*date|^\s*date\s*$|inv\.?\s*date/i, /due/i) : null;
      if (cell) { dateSources.header++; return firstDate(textOf(cell)); }
      dateSources.fallback++;
      return firstDate(row ? rowText(row) : "");
    }
    function amountOf(row) {
      if (!row) return "";
      var cell = columnCells(row, /amount|total/i, /balance|due\s*date|tax/i);
      if (cell) { var one = moneyIn(textOf(cell)); return one.length === 1 ? one[0] : ""; }
      var all = moneyIn(rowText(row));
      return all.length === 1 ? all[0] : "";
    }

    // ---- Checked state. The real portal's boxes may be styled wrappers, so the state can live on
    // the input (.checked), on aria-checked, or on a class of the input or a wrapper, and it may
    // update a moment after the click. Every one of those is read, and any positive one counts.
    var CHECKED_CLASS = /(^|[\s_-])(checked|selected)(?=$|[\s_-])/i;
    var UNCHECKED_CLASS = /(^|[\s_-])(unchecked|unselected|not[-_ ]?checked|not[-_ ]?selected)(?=$|[\s_-])/i;
    var WRAPPER_STOP = /^(TD|TH|TR|TABLE|TBODY|THEAD|BODY|HTML|LI|SECTION|FORM)$/;

    function classOf(n) {
      var c = n.getAttribute ? n.getAttribute("class") : "";
      return c || "";
    }

    function wrappersOf(el) {
      var out = [];
      var n = el.parentElement;
      for (var d = 0; n && d < 4 && !WRAPPER_STOP.test(n.tagName); d++, n = n.parentElement) {
        // A wrapper that holds more than one checkbox is a row or list, not this box's own wrapper.
        if (n.querySelectorAll("input[type=checkbox],[role=checkbox]").length > 1) break;
        out.push(n);
      }
      return out;
    }

    function readState(el) {
      var sig = { inputChecked: null, aria: null, cls: null };
      if (el.tagName === "INPUT") sig.inputChecked = !!el.checked;
      var nodes = [el].concat(wrappersOf(el));
      var sibs = [el.previousElementSibling, el.nextElementSibling].filter(function (x) {
        return x && !x.querySelector("input[type=checkbox],[role=checkbox]");
      });
      nodes.forEach(function (n) {
        var a = n.getAttribute("aria-checked");
        if (a === "true") sig.aria = true;
        else if (a === "false" && sig.aria == null) sig.aria = false;
      });
      nodes.concat(sibs).forEach(function (n) {
        var c = classOf(n);
        if (!c) return;
        if (UNCHECKED_CLASS.test(c)) { if (sig.cls == null) sig.cls = false; return; }
        if (CHECKED_CLASS.test(c)) sig.cls = true;
        else if (sig.cls == null) sig.cls = false;
      });
      var how = [];
      if (sig.inputChecked) how.push("input.checked");
      if (sig.aria === true) how.push("aria-checked");
      if (sig.cls === true) how.push("wrapper class");
      return { checked: how.length > 0, how: how, signals: sig };
    }

    function isChecked(el) { return readState(el).checked; }

    // Short description of the box and its wrapper, for the log when the signals disagree.
    function snapshot(el) {
      var host = el.parentElement || el;
      var html = host.outerHTML || "";
      return html.replace(/\s+/g, " ").slice(0, 320);
    }

    function readRows() {
      var seen = {};
      var rows = [];
      invoiceCheckboxes().forEach(function (c) {
        if (seen[c.number]) return;
        if (inCredits(c.el)) return;
        if (!isVisible(c.el) && !isVisible(c.el.parentElement || c.el)) return;
        var row = c.el.closest("tr,[role=row],li") || c.el.parentElement;
        seen[c.number] = true;
        var st = readState(c.el);
        rows.push({
          number: c.number, el: c.el, checked: st.checked, how: st.how, index: rows.length,
          date: dateOf(row), amount: amountOf(row), recent: /recently\s+downloaded/i.test(row ? rowText(row) : "")
        });
      });
      return rows;
    }

    function orderOf(rows) {
      var dated = rows.filter(function (r) { return r.date != null; });
      if (dated.length < 2) return "unknown";
      var asc = 0, desc = 0;
      for (var i = 1; i < dated.length; i++) {
        if (dated[i].date > dated[i - 1].date) asc++;
        else if (dated[i].date < dated[i - 1].date) desc++;
      }
      if (asc > 0 && desc === 0) return "ascending";
      if (desc > 0 && asc === 0) return "descending";
      return asc > desc ? "ascending" : desc > asc ? "descending" : "unknown";
    }

    function newestFirst(rows, order) {
      if (order !== "ascending") return rows.slice();
      return rows.slice().sort(function (a, b) {
        if (a.date != null && b.date != null && a.date !== b.date) return b.date - a.date;
        return b.index - a.index;
      });
    }

    function expandButton() {
      // 'View All' first (one click shows every row), then repeated 'View More'.
      var sel = "button,[role=button],a,[role=link]";
      var all = findByName(doc, sel, /^View All$/i)[0];
      if (all) return { el: all, label: "View All" };
      var more = findByName(doc, sel, /^View More$/i)[0];
      if (more) return { el: more, label: "View More" };
      return null;
    }

    // Find the n newest eligible invoices. Never ticks anything.
    //   opts.startDate     "YYYY-MM-DD" or null. Rows dated before it, or with no readable date, are never eligible.
    //   opts.excludedSent  numbers in the sent ledger.   opts.excludedPending  numbers in a still-pending request.
    //   opts.excluded      legacy list, counted with the sent ones.
    // The list is expanded (View All, else View More) until the oldest row on the page is older than the start date,
    // or there is nothing more to show. A page sorted oldest first is always expanded to the end.
    async function scan(opts) {
      var n = opts.n;
      dateSources.header = 0; dateSources.fallback = 0;
      var sentSet = {}, pendSet = {};
      (opts.excludedSent || []).concat(opts.excluded || []).forEach(function (x) { sentSet[String(x)] = true; });
      (opts.excludedPending || []).forEach(function (x) { pendSet[String(x)] = true; });
      var startMs = null;
      if (opts.startDate) {
        var sm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(opts.startDate));
        startMs = sm ? utcDate(+sm[1], +sm[2], +sm[3]) : null;
        if (startMs == null) throw new Error("The 'Start from invoice date' (" + opts.startDate + ") is not a real date.");
      }
      var skipped = function (r) { return sentSet[r.number] || pendSet[r.number]; };
      var eligibleOf = function (rows, order) {
        return newestFirst(rows, order).filter(function (r) {
          if (skipped(r)) return false;
          if (startMs == null) return true;
          return r.date != null && r.date >= startMs;
        });
      };
      var expansions = 0;
      var rows, order, fresh;
      for (var guardLoop = 0; guardLoop < 80; guardLoop++) {
        rows = readRows();
        order = orderOf(rows);
        fresh = eligibleOf(rows, order);
        var done;
        if (startMs != null) {
          var dated = rows.filter(function (r) { return r.date != null; });
          var minDate = dated.length ? Math.min.apply(null, dated.map(function (r) { return r.date; })) : null;
          done = order === "descending" && minDate != null && minDate < startMs;
        } else {
          done = fresh.length >= n && order !== "ascending";
        }
        if (done) break;
        var btn = expandButton();
        if (!btn) break;
        var before = rows.length;
        G.guardedClick(btn.el, "expand invoice list (" + btn.label + ")", "button");
        expansions++;
        var grew = await waitFor(function () { return readRows().length > before; }, 8000);
        if (!grew) break;
      }
      var picked = fresh.slice(0, n);
      var dates = rows.filter(function (r) { return r.date != null; }).map(function (r) { return r.date; });
      var inRange = startMs == null ? rows : rows.filter(function (r) { return r.date != null && r.date >= startMs; });
      var amounts = {};
      picked.forEach(function (r) { if (r.amount) amounts[r.number] = r.amount; });
      return {
        rowsSeen: rows.length,
        orderedBy: order === "ascending" ? "date, newest first (page was oldest first)" : order === "descending" ? "page order (newest first by date)" : "page order (no dates found to check)",
        expansions: expansions,
        startDate: startMs == null ? null : ymd(startMs),
        inRange: inRange.length,
        beforeStart: startMs == null ? 0 : rows.filter(function (r) { return r.date != null && r.date < startMs; }).length,
        undated: startMs == null ? [] : rows.filter(function (r) { return r.date == null; }).map(function (r) { return r.number; }),
        sentExcluded: inRange.filter(function (r) { return sentSet[r.number]; }).length,
        pendingExcluded: inRange.filter(function (r) { return !sentSet[r.number] && pendSet[r.number]; }).length,
        alreadyHandled: inRange.filter(skipped).length,
        oldestDate: ymd(dates.length ? Math.min.apply(null, dates) : null),
        newestDate: ymd(dates.length ? Math.max.apply(null, dates) : null),
        dateSource: dateSources.header >= dateSources.fallback ? "the Invoice Date column" : "the first date in each row (no Invoice Date column found)",
        recentTagged: rows.filter(function (r) { return r.recent; }).map(function (r) { return r.number; }),
        newNumbers: picked.map(function (r) { return r.number; }),
        newAvailable: fresh.length,
        amounts: amounts,
        preChecked: rows.filter(function (r) { return r.checked; }).map(function (r) { return r.number; }),
        selection: selectionSignal()
      };
    }

    function checkedNumbers() {
      return readRows().filter(function (r) { return r.checked; }).map(function (r) { return r.number; });
    }

    function stickyDownloadButton() {
      var hits = findByName(doc, "button,[role=button],a,[role=link]", /^Download selected invoices$/i, { not: DIALOG_SEL });
      return hits[0] || null;
    }

    // The sticky bar: is it showing, is Download enabled, and what count does it show.
    // count is a number when it can be told (0 when the bar is absent or Download is disabled),
    // or null when the bar is showing but no count could be read from it.
    function parseBarCount(btn) {
      var n = btn;
      var weak = null;
      for (var d = 0; n && d < 6; d++, n = n.parentElement) {
        var t = textOf(n);
        if (t.length > 400 || n.querySelector("table,input[type=checkbox],[role=checkbox]")) break;
        var m = /(\d[\d,]*)\s*(invoices?|selected|items?|statements?)\b/i.exec(t) ||
          /\b(?:selected|invoices?|items?|count)\s*[:\-(]?\s*(\d[\d,]*)/i.exec(t);
        if (m) return { n: parseInt(m[1].replace(/,/g, ""), 10), weak: false };
        if (weak == null) {
          var plain = t.replace(/\$\s*[\d,]+(\.\d+)?/g, " ");
          var w = /(?:^|\D)(\d{1,4})(?!\d)/.exec(plain);
          if (w) weak = { n: parseInt(w[1], 10), weak: true };
        }
      }
      return weak;
    }

    function selectionSignal() {
      var btn = stickyDownloadButton();
      if (!btn) return { present: false, enabled: false, active: false, count: 0 };
      var enabled = !btn.disabled && btn.getAttribute("aria-disabled") !== "true";
      var parsed = parseBarCount(btn);
      var count = parsed ? parsed.n : enabled ? null : 0;
      if (!enabled && count == null) count = 0;
      return { present: true, enabled: enabled, active: enabled, count: count };
    }

    function stickyCount() {
      var s = selectionSignal();
      return s.present ? s.count : null;
    }

    // True when the bar shows evidence that the selection went up (dir 1) or down (dir -1).
    function barMoved(base, now, dir) {
      if (dir > 0) {
        if (!base.active && now.active) return "Download button appeared or became enabled";
        if (base.count != null && now.count != null && now.count > base.count) return "sticky bar count " + base.count + " to " + now.count;
      } else {
        if (base.active && !now.active) return "Download button went away or was disabled";
        if (base.count != null && now.count != null && now.count < base.count) return "sticky bar count " + base.count + " to " + now.count;
      }
      return null;
    }

    // null: not known yet. true: a click was confirmed by a per-box signal. false: the per-box signals
    // missed a change that the sticky bar saw, so from then on only the bar is trusted.
    var stateReliable = null;

    function dirtyError(message, detail) {
      var e = new Error(message);
      e.code = "DIRTY_SELECTION";
      e.detail = detail;
      return e;
    }
    function coded(code, message) { var e = new Error(message); e.code = code; return e; }

    function rowFor(num) {
      return readRows().filter(function (r) { return r.number === num; })[0] || null;
    }

    function labelTarget(el) {
      if (el.id) {
        var l = doc.querySelector('label[for="' + String(el.id).replace(/"/g, '\\"') + '"]');
        if (l && isVisible(l)) return l;
      }
      var wrap = el.closest("label");
      if (wrap) return wrap;
      var w = wrappersOf(el)[0];
      return w && isVisible(w) ? w : null;
    }

    function pointTarget(el) {
      try {
        var r = el.getBoundingClientRect();
        if (!r || (!r.width && !r.height)) return null;
        var t = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!t || t === el) return null;
        // Only something that is this box or its own wrapper. Never some other control that happens to be on top.
        if (!(t.contains(el) || el.contains(t))) return null;
        if (t.querySelectorAll("input[type=checkbox],[role=checkbox]").length > 1) return null;
        return t;
      } catch (e) { return null; }
    }

    // Bring one box to the wanted state (desired true = ticked). Clicks once the way that is known to work
    // on the real portal. It only tries another way after it has seen that NOTHING changed, in the box's own
    // state or in the sticky bar, and it re-reads after a wait before each extra try, because a second click
    // on a box that did toggle would untick it.
    async function toggleTo(num, desired) {
      var verb = desired ? "tick" : "untick";
      var dir = desired ? 1 : -1;
      var useState = stateReliable !== false;
      var row = rowFor(num);
      if (!row) throw new Error("Invoice " + num + " is no longer in the table. Nothing was requested.");
      var st0 = readState(row.el);
      if (useState && st0.checked === desired) return { number: num, strategy: "already " + (desired ? "ticked" : "unticked"), clicked: false, evidence: st0.how };
      if (!useState && stateReliable === false && !desired && selectionSignal().count === 0) return { number: num, strategy: "already unticked", clicked: false, evidence: ["bar shows 0"] };

      var strategies = ["direct click", "label or wrapper click", "click at the box's own position"];
      for (var i = 0; i < strategies.length; i++) {
        var base = selectionSignal();
        row = rowFor(num) || row;
        var el = row.el;
        if (i > 0) {
          // Gate: a slow update from the previous click must not be mistaken for "nothing happened".
          await sleep(1500);
          var stG = readState(el), sigG = selectionSignal();
          var evG = (useState && stG.checked === desired) ? stG.how : null;
          var barG = barMoved(prevBase, sigG, dir);
          if (evG || barG) return { number: num, strategy: strategies[i - 1] + " (late update)", clicked: true, evidence: (evG || []).concat(barG ? [barG] : []), snapshot: stG.checked === desired ? null : snapshot(el) };
          base = sigG;
        }
        var target = el;
        if (i === 1) target = labelTarget(el);
        if (i === 2) target = pointTarget(el);
        if (!target) continue;
        var prevBase = base;
        G.guardedClick(target, verb + " invoice " + num + " (" + strategies[i] + ")", "checkbox", { pointer: i > 0 });
        var found = null;
        await waitFor(function () {
          var r = rowFor(num);
          var stN = r ? readState(r.el) : st0;
          var sigN = selectionSignal();
          var ev = [];
          if (useState && stN.checked === desired) ev = ev.concat(stN.how.length ? stN.how : ["state cleared"]);
          var bar = barMoved(base, sigN, dir);
          if (bar) ev.push(bar);
          if (!desired && useState && !stN.checked && st0.checked) ev.push("state cleared");
          if (ev.length) { found = { ev: ev, st: stN }; return true; }
          return false;
        }, 2000, 100);
        if (found) {
          var barOnly = found.ev.length > 0 && found.ev.every(function (x) { return /sticky|Download button/.test(x); });
          if (barOnly && stateReliable == null) stateReliable = false;
          else if (!barOnly && stateReliable == null) stateReliable = true;
          return { number: num, strategy: strategies[i], clicked: true, evidence: found.ev, snapshot: barOnly ? snapshot(el) : null };
        }
        // Nothing seen after the wait. Only go on if the bar gives independent proof that nothing changed.
        var after = selectionSignal();
        var proof = base.count != null && after.count != null && after.count === base.count;
        if (!proof) {
          var sNow = readState(rowFor(num) ? rowFor(num).el : el);
          throw coded("UNVERIFIED", "Clicked invoice " + num + " once, but cannot tell whether it " + (desired ? "ticked" : "unticked") +
            " (no box state change and no readable count on the sticky bar). Not clicking again, because a second click could undo it. " +
            "Check the page by eye. Box signals: " + JSON.stringify(sNow.signals) + ". Markup: " + snapshot(el));
        }
      }
      throw coded("NOT_TOGGLED", "Invoice " + num + " would not " + verb + " after trying: " + strategies.join(", ") + ". The sticky bar count did not change. Markup: " + snapshot(rowFor(num) ? rowFor(num).el : row.el));
    }

    // Make the ticked set exactly `numbers`. Already-ticked wanted boxes are left alone, ticked boxes that are
    // not wanted are unticked, and the end result is checked against the sticky bar before anything else happens.
    async function tick(numbers) {
      var want = {};
      numbers.forEach(function (x) { want[x] = true; });
      await sleep(500);
      var base = selectionSignal();
      var rows = readRows();
      var known = rows.filter(function (r) { return r.checked; }).map(function (r) { return r.number; });
      var diag = [];

      if (base.count != null) {
        if (base.count === 0 && known.length > 0) {
          // The bar says nothing is ticked but some boxes look ticked: their state markers are not trustworthy.
          stateReliable = false;
          diag.push("Per-box state looks ticked on " + known.length + " box(es) but the sticky bar shows nothing selected. Trusting the bar.");
          known = [];
        } else if (base.count !== known.length) {
          throw dirtyError("The sticky bar shows " + base.count + " selected but I can identify " + known.length + " ticked box(es) on this page (" + known.join(", ") + ").", { barCount: base.count, known: known });
        }
      } else if (known.length > 0 || base.present) {
        throw dirtyError("Something may already be ticked, and the sticky bar has no readable count to check it against.", { known: known });
      }

      if (known.length) diag.push("Already ticked when I started: " + known.join(", ") + ".");
      var leftovers = known.filter(function (x) { return !want[x]; });
      var keep = known.filter(function (x) { return want[x]; });
      var steps = [];
      for (var u = 0; u < leftovers.length; u++) steps.push(await toggleTo(leftovers[u], false));
      if (leftovers.length) diag.push("Unticked leftovers that were not wanted: " + leftovers.join(", ") + ".");
      if (keep.length) diag.push("Kept already-ticked wanted box(es) without clicking: " + keep.join(", ") + ".");
      for (var i = 0; i < numbers.length; i++) {
        if (keep.indexOf(numbers[i]) !== -1) continue;
        steps.push(await toggleTo(numbers[i], true));
      }
      await sleep(300);

      // Final check: the ticked set must equal the target exactly.
      var sig = selectionSignal();
      var now = checkedNumbers();
      var extra = now.filter(function (x) { return !want[x]; });
      var missing = numbers.filter(function (x) { return now.indexOf(x) === -1; });
      var stateOk = stateReliable !== false;
      if (sig.present && sig.count != null) {
        if (sig.count !== numbers.length) throw coded("MISMATCH", "After ticking, the sticky bar shows " + sig.count + " selected but I planned " + numbers.length + ". Stopping before the Download dialog.");
        if (stateOk && extra.length) throw coded("MISMATCH", "These boxes are ticked but were not wanted: " + extra.join(", ") + ". Stopping before the Download dialog.");
        if (stateOk && missing.length && stateReliable === true) throw coded("MISMATCH", "These wanted boxes do not show as ticked: " + missing.join(", ") + ". Stopping before the Download dialog.");
      } else {
        if (!stateOk || extra.length || missing.length) throw coded("MISMATCH", "Could not confirm the ticked set (no readable sticky bar count). Extra: " + extra.join(",") + " Missing: " + missing.join(",") + ". Stopping before the Download dialog.");
      }
      steps.forEach(function (s) {
        if (s.clicked) diag.push("invoice " + s.number + ": " + s.strategy + ", confirmed by " + s.evidence.join(" + ") + ".");
        if (s.snapshot) diag.push("  markup of the box (for fixing the check): " + s.snapshot);
      });
      return { ticked: numbers.slice(), stickyCount: sig.count, stateReliable: stateReliable, diag: diag };
    }

    // Untick boxes. With no argument it unticks every box that shows as ticked. With a list, it unticks exactly
    // those (used to leave the page clean after test mode), reading the sticky bar when box state is not readable.
    async function untick(numbers) {
      var undone = [];
      var diag = [];
      var list = numbers && numbers.length ? numbers.slice() : checkedNumbers();
      for (var i = 0; i < list.length; i++) {
        if (selectionSignal().count === 0 && stateReliable === false) break;
        var r = await toggleTo(list[i], false);
        if (r.clicked) { undone.push(list[i]); diag.push("invoice " + list[i] + ": " + r.strategy + ", confirmed by " + r.evidence.join(" + ")); }
      }
      await sleep(200);
      return { unticked: undone, stillTicked: checkedNumbers(), stickyCount: stickyCount(), diag: diag };
    }

    // ---------------------------------------------------------------- dialog
    function findDialog() {
      var list = doc.querySelectorAll(DIALOG_SEL);
      for (var i = 0; i < list.length; i++) {
        if (isVisible(list[i]) && /Download Invoices/i.test(textOf(list[i]) + " " + (list[i].getAttribute("aria-label") || ""))) return list[i];
      }
      return null;
    }

    async function openDialog() {
      if (findDialog()) return { alreadyOpen: true };
      var btn = stickyDownloadButton();
      if (!btn) throw new Error("Could not find the 'Download selected invoices' button. Is anything ticked?");
      G.guardedClick(btn, "open Download Invoices dialog", "button");
      var dlg = await waitFor(findDialog, 10000);
      if (!dlg) throw new Error("The 'Download Invoices' dialog did not open.");
      return { opened: true };
    }

    async function chooseFromMenu(dlg, menuNameRe, optionText, what) {
      var triggers = findByName(dlg, "button,[role=button],[role=menu],[role=combobox],a,select", menuNameRe);
      if (!triggers.length) {
        // The menu button may keep its name but live beside the dialog body.
        triggers = findByName(doc, "button,[role=button],[role=menu],[role=combobox],a,select", menuNameRe);
      }
      var trigger = triggers[0];
      if (!trigger) throw new Error("Could not find the '" + what + "' menu in the Download Invoices dialog.");
      if (trigger.tagName === "SELECT") {
        var opt = Array.prototype.filter.call(trigger.options, function (o) { return matches(optionText, norm(o.text)); })[0];
        if (!opt) throw new Error("No '" + optionText.source + "' option in the " + what + " menu.");
        trigger.value = opt.value;
        trigger.dispatchEvent(new win.Event("input", { bubbles: true }));
        trigger.dispatchEvent(new win.Event("change", { bubbles: true }));
        return norm(opt.text);
      }
      G.guardedClick(trigger, "open " + what + " menu", "button");
      var item = await waitFor(function () {
        var inDlg = findByName(dlg, "a,[role=link],[role=menuitem],[role=option],button,li", optionText).filter(function (e) { return e !== trigger && !e.contains(trigger); });
        if (inDlg.length) return inDlg[0];
        var anywhere = findByName(doc, "a,[role=link],[role=menuitem],[role=option],li", optionText).filter(function (e) { return e !== trigger && !e.contains(trigger); });
        return anywhere[0] || null;
      }, 4000);
      if (!item) throw new Error("Opened the " + what + " menu but found no '" + optionText.source + "' choice.");
      G.guardedClick(item, "choose " + what + ": " + textOf(item), "link");
      await sleep(250);
      return textOf(item);
    }

    // Choose Type 'Invoice Details' and Format 'PDF'. Reads the default request name and keeps it.
    async function fillDialog() {
      var dlg = findDialog();
      if (!dlg) throw new Error("The Download Invoices dialog is not open.");
      var type = await chooseFromMenu(dlg, /^Select Download Type$/i, /^Invoice Details$/i, "Download Type");
      dlg = findDialog() || dlg;
      var format = await chooseFromMenu(dlg, /^Select Download Format$/i, /^PDF$/i, "Download Format");
      dlg = findDialog() || dlg;
      var boxes = Array.prototype.filter.call(
        dlg.querySelectorAll("input,textarea,[role=textbox]"),
        function (e) {
          var t = (e.getAttribute("type") || "text").toLowerCase();
          return isVisible(e) && (e.tagName !== "INPUT" || t === "text" || t === "");
        }
      );
      var pw = dlg.querySelector("input[type=password],input[type=email],input[type=tel]");
      void pw; // never touched
      var box = boxes[0];
      var name = box ? norm(box.value !== undefined && box.tagName !== "DIV" ? box.value : textOf(box)) : "";
      if (!name) throw new Error("The request name box is empty or was not found, so the request cannot be tracked.");
      var text = textOf(dlg);
      return {
        name: name, type: type, format: format,
        typeShownInDialog: /Invoice Details/i.test(text),
        formatShownInDialog: /\bPDF\b/i.test(text)
      };
    }

    function startButton() {
      var dlg = findDialog();
      if (!dlg) return null;
      var hits = findByName(dlg, "button,[role=button],input[type=button],input[type=submit]", /^Download selected invoices$/i, { textRe: /^\s*Start Download\s*$/i });
      if (hits.length) return hits[0];
      // Fallback: any control in the dialog whose visible text is exactly Start Download.
      var all = dlg.querySelectorAll("button,[role=button]");
      for (var i = 0; i < all.length; i++) if (isVisible(all[i]) && /^\s*Start Download\s*$/i.test(textOf(all[i]))) return all[i];
      return null;
    }

    var SUCCESS_RE = /success!?[\s\S]{0,40}(receive an email|download is complete)/i;
    var ERROR_RE = /unable to complete your download request/i;

    function bodyText() { return textOf(doc.body || doc.documentElement); }

    async function startDownload() {
      var btn = startButton();
      if (!btn) throw new Error("Could not find the 'Start Download' button inside the dialog.");
      var staleSuccess = SUCCESS_RE.test(bodyText());
      G.guardedClick(btn, "Start Download", "button");
      var res = await waitFor(function () {
        var t = bodyText();
        if (ERROR_RE.test(t)) return { ok: false, refused: true, message: (ERROR_RE.exec(t) || [""])[0] };
        if (SUCCESS_RE.test(t) && !staleSuccess) return { ok: true, message: (SUCCESS_RE.exec(t) || [""])[0] };
        if (staleSuccess && !findDialog()) return { ok: true, message: "dialog closed (earlier success text was already on the page)" };
        return null;
      }, 45000, 300);
      return res || { ok: false, refused: false, message: "No success or error text appeared within 45 seconds." };
    }

    async function closeDialog() {
      var dlg = findDialog();
      if (!dlg) return { closed: true };
      var btns = findByName(dlg, "button,[role=button],a", /^(Cancel|Close)$/i);
      if (!btns.length) btns = Array.prototype.filter.call(dlg.querySelectorAll("[aria-label=Close],.close"), isVisible);
      if (btns.length) {
        try { G.guardedClick(btns[0], "close dialog", "button"); } catch (e) { /* fall through to Escape */ }
      } else {
        doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      }
      var gone = await waitFor(function () { return !findDialog(); }, 4000);
      return { closed: !!gone };
    }

    // ------------------------------------------------------- Requested Invoices
    // Rows of the REQUESTED INVOICES table: each subject is a link. Same lookup as poll_batch.py:
    // table filtered by the SUBJECT header, then its links.
    async function readRequested() {
      var tables = await waitFor(function () { var t = manageTables(); return t.length ? t : null; }, 15000);
      if (!tables) return { tableFound: false, subjects: [], signedOut: session().signedOut };
      var subjects = [];
      tables.forEach(function (t) {
        Array.prototype.forEach.call(t.querySelectorAll("a,[role=link]"), function (a) {
          if (isVisible(a)) subjects.push(textOf(a));
        });
      });
      return { tableFound: true, subjects: subjects, signedOut: false };
    }

    function subjectLink(name) {
      var out = null;
      manageTables().forEach(function (t) {
        Array.prototype.forEach.call(t.querySelectorAll("a,[role=link]"), function (a) {
          if (!out && isVisible(a) && textOf(a) === name) out = a;
        });
      });
      return out;
    }

    async function clickSubject(name) {
      var link = subjectLink(name);
      if (!link) throw new Error("The link '" + name + "' is not in the Requested Invoices table.");
      G.guardedClick(link, "download requested file " + name, "link");
      return { clicked: true };
    }

    // Email support: read the PDF through the link's own address, with the page's session, then save those
    // exact bytes through a blob link so the file on disk and the attachment are the same bytes. Only for a real
    // address on the portal host. Anything else (no address, page-script link, another host, not a PDF) returns a
    // reason and the caller falls back to clicking the link normally, with no attachment.
    async function fetchSubject(name, wantBytes) {
      var link = subjectLink(name);
      if (!link) throw new Error("The link '" + name + "' is not in the Requested Invoices table.");
      var a0 = link.tagName === "A" ? link : link.querySelector("a[href]");
      var href = a0 ? a0.getAttribute("href") : "";
      if (!href || /^\s*(#|javascript:|mailto:|tel:)/i.test(href)) {
        return { mode: "no-href", reason: "the link has no real address (the page handles the click with script)" };
      }
      var url;
      try { url = new URL(href, win.location.href); } catch (e) { return { mode: "no-href", reason: "the link address could not be read" }; }
      if (!/^https?:$/.test(url.protocol) || CFG.HOSTS.indexOf(url.hostname) === -1) {
        return { mode: "foreign-host", reason: "the link points outside the portal (" + url.hostname + "), so it was not fetched" };
      }
      var res = await win.fetch(url.href, { credentials: "include" });
      if (!res.ok) return { mode: "http-error", reason: "the portal answered HTTP " + res.status + " for the link" };
      var buf = new Uint8Array(await res.arrayBuffer());
      var head = String.fromCharCode.apply(null, buf.subarray(0, 5));
      if (head !== "%PDF-") return { mode: "not-pdf", reason: "the link did not return a PDF" };
      var blobUrl = win.URL.createObjectURL(new win.Blob([buf], { type: "application/pdf" }));
      var anchor = doc.createElement("a");
      anchor.href = blobUrl;
      anchor.download = String(name).replace(/[^A-Za-z0-9._-]/g, "_") + ".pdf";
      anchor.style.display = "none";
      doc.body.appendChild(anchor);
      try { G.guardedClick(anchor, "save fetched PDF " + name, "link"); }
      finally { anchor.remove(); setTimeout(function () { win.URL.revokeObjectURL(blobUrl); }, 120000); }
      var out = { mode: "fetched", size: buf.length };
      if (wantBytes) out.b64 = root.HD_MIME.bytesToBase64(buf);
      return out;
    }

    return {
      fetchSubject: fetchSubject,
      sleep: sleep, waitFor: waitFor, isVisible: isVisible, accName: accName, textOf: textOf,
      session: session, goNav: goNav, readRows: readRows, scan: scan, tick: tick, untick: untick,
      checkedNumbers: checkedNumbers, stickyCount: stickyCount, selectionSignal: selectionSignal, readState: readState,
      findDialog: findDialog, openDialog: openDialog, fillDialog: fillDialog, startDownload: startDownload,
      closeDialog: closeDialog, readRequested: readRequested, clickSubject: clickSubject,
      _firstDate: firstDate, _orderOf: orderOf, _inCredits: inCredits
    };
  }

  root.HD_CREATE_PORTAL = createPortal;
  if (typeof module !== "undefined" && module.exports) module.exports = { createPortal: createPortal };
})(typeof self !== "undefined" ? self : globalThis);
