// Click guard. Every click this extension makes goes through guardedClick() below.
// It is the only place in the extension that calls element.click().
// It refuses anything that looks like a payment, edit, dispute, autopay, credit
// application, or sign off control, and it logs every click it does allow.
//
// This is a port of ClickGuard and guard_check() in hd-pipeline/tools/citi_fetch.py,
// with the control names Winston listed added explicitly.
(function (root) {
  "use strict";

  // Words in what a person sees or a screen reader hears. Checked on text, aria-label, title, value.
  var DENY_VISIBLE = [
    /\bpay\s*now\b/i,
    /\bmake\s+a\s+payment\b/i,
    /\bpay\s*statement\b/i,
    /\bapply\s+credits?\b/i,
    /\bedit\b/i,
    /\bdispute/i,
    /\bauto[\s_-]?pay/i,
    /\bsign[\s_-]?off\b/i,
    /\bsign[\s_-]?out\b/i,
    /\blog[\s_-]?(out|off)\b/i,
    /\bpay(s|ment|ments|ing)?\b/i
  ];
  // Looser match for id, name, class, and href, same idea as the Python FORBIDDEN_RE.
  var DENY_ATTR = /pay|edit|dispute|auto[-_ ]?pay|sign[-_ ]?off|apply[-_ ]?credit/i;

  // Plain download and navigation controls. Exempt from the loose attribute check
  // only when their own visible text is exactly one of these.
  var ALLOWED_TEXT = /^\s*(start\s+download|download(\s+selected\s+invoices)?|invoice details|pdf|view more|view all|invoices|manage account|cancel|close|select download (type|format))\s*$/i;

  function visibleFields(d) {
    return [d.text, d.aria, d.title, d.value];
  }

  // desc keys: text, aria, title, value, id, name, cls, href. kind:
  //   checkbox  a tick box cannot pay or edit, so only its own label is checked
  //   link      text, aria, title are checked (hrefs can be opaque)
  //   button    text, aria, title, value, id, name, class, href are all checked
  function checkDescriptor(desc, kind) {
    var visible = visibleFields(desc).join(" ");
    var hitVisible = null;
    var fields = kind === "checkbox" ? [desc.text, desc.aria] : visibleFields(desc);
    for (var i = 0; i < fields.length && !hitVisible; i++) {
      var f = fields[i];
      if (!f) continue;
      for (var j = 0; j < DENY_VISIBLE.length; j++) {
        if (DENY_VISIBLE[j].test(f)) { hitVisible = f; break; }
      }
    }
    if (hitVisible) return "visible label matches the denylist: " + JSON.stringify(String(hitVisible).slice(0, 80));
    if (kind === "button") {
      var attrs = [desc.id, desc.name, desc.cls, desc.href];
      for (var k = 0; k < attrs.length; k++) {
        var a = attrs[k];
        if (a && DENY_ATTR.test(a)) {
          var own = (desc.text || desc.aria || desc.value || "").trim();
          if (own && ALLOWED_TEXT.test(own)) {
            // A plain download control whose id or class merely contains a risky word.
            // The visible fields were already checked clean above.
            continue;
          }
          return "attribute matches the denylist: " + JSON.stringify(String(a).slice(0, 80));
        }
      }
    }
    void visible;
    return null;
  }

  function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, 200); }

  function describe(el) {
    var cls = el.className && typeof el.className === "object" && "baseVal" in el.className ? el.className.baseVal : el.className;
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    var text = el.innerText !== undefined && el.innerText !== null ? el.innerText : el.textContent;
    return {
      tag: tag,
      role: el.getAttribute ? el.getAttribute("role") || "" : "",
      text: norm(text),
      aria: norm(el.getAttribute && el.getAttribute("aria-label")),
      title: norm(el.getAttribute && el.getAttribute("title")),
      value: tag === "input" || tag === "button" ? norm(el.value) : "",
      id: el.id || "",
      name: (el.getAttribute && el.getAttribute("name")) || "",
      cls: String(cls || ""),
      href: (el.getAttribute && el.getAttribute("href")) || ""
    };
  }

  var INTERACTIVE = "button,a,[role=button],[role=link],[role=menuitem],[role=menu],[role=option],input,label,summary";

  // The element itself and the nearest interactive ancestor are both checked, so a
  // span inside a Pay Now button is still refused.
  function checkElement(el, kind) {
    var reason = checkDescriptor(describe(el), kind);
    if (reason) return reason;
    var anc = el.closest ? el.closest(INTERACTIVE) : null;
    if (anc && anc !== el) {
      var k = kind === "checkbox" ? "link" : kind;
      var r2 = checkDescriptor(describe(anc), k);
      if (r2) return "enclosing control: " + r2;
    }
    return null;
  }

  function GuardRefused(message) {
    var e = new Error(message);
    e.name = "GuardRefused";
    return e;
  }

  var clicks = [];
  var refusals = [];

  function fire(el, type, Ctor) {
    var win = el.ownerDocument.defaultView;
    var C = win[Ctor] || win.MouseEvent;
    el.dispatchEvent(new C(type, { bubbles: true, cancelable: true, composed: true, view: win, button: 0 }));
  }

  function guardedClick(el, why, kind, opts) {
    kind = kind || "button";
    var reason = checkElement(el, kind);
    var d = describe(el);
    if (reason) {
      refusals.push({ why: why, reason: reason, text: d.text.slice(0, 60) });
      throw GuardRefused("Click guard refused '" + why + "': " + reason);
    }
    clicks.push({ why: why, kind: kind, text: (d.aria || d.text).slice(0, 60) });
    if (kind !== "checkbox" || (opts && opts.pointer)) {
      // Menus and custom widgets sometimes listen for the pointer events, not just click.
      fire(el, "pointerdown", "PointerEvent");
      fire(el, "mousedown", "MouseEvent");
      fire(el, "pointerup", "PointerEvent");
      fire(el, "mouseup", "MouseEvent");
    }
    el.click();
  }

  function drain() {
    var out = { clicks: clicks.slice(), refusals: refusals.slice() };
    clicks.length = 0;
    refusals.length = 0;
    return out;
  }

  // Backstop: while the content script is loaded, any click-like event that was NOT
  // made by a person (isTrusted false) on a denylisted control is cancelled before the
  // page can see it, even if some future code path forgot to use guardedClick().
  var BACKSTOP_TYPES = ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "submit"];
  function installBackstop(doc) {
    BACKSTOP_TYPES.forEach(function (t) {
      doc.addEventListener(t, function (ev) {
        if (ev.isTrusted) return;
        var el = ev.target;
        if (!el || el.nodeType !== 1) return;
        var tag = el.tagName.toLowerCase();
        var kind = el.type === "checkbox" ? "checkbox" : "button";
        var reason = checkElement(el, kind);
        if (reason && tag !== "html" && tag !== "body") {
          ev.stopImmediatePropagation();
          ev.preventDefault();
          refusals.push({ why: "backstop " + t, reason: reason, text: describe(el).text.slice(0, 60) });
        }
      }, true);
    });
  }

  root.HD_GUARD = {
    DENY_VISIBLE: DENY_VISIBLE,
    DENY_ATTR: DENY_ATTR,
    describe: describe,
    checkDescriptor: checkDescriptor,
    checkElement: checkElement,
    guardedClick: guardedClick,
    drain: drain,
    installBackstop: installBackstop
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.HD_GUARD;
})(typeof self !== "undefined" ? self : globalThis);
