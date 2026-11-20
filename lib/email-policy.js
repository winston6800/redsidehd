// Email rules in one place, so they can be unit tested and so the service worker and popup agree.
(function (root) {
  "use strict";

  var PLACEHOLDER_CLIENT_ID = "REPLACE_WITH_YOUR_CLIENT_ID.apps.googleusercontent.com";
  var MAX_PDF_BYTES = 15 * 1024 * 1024; // see README: Gmail's message limit is 25 MB and the PDF is base64 encoded

  // One plain address. No names, no angle brackets, no lists, no spaces, no line breaks.
  function validateEmail(input) {
    var s = String(input == null ? "" : input).trim();
    if (!s) return { ok: false, empty: true, error: "Enter an email address." };
    if (s.length > 254) return { ok: false, error: "That address is too long." };
    if (/[\s,;<>()\[\]\\"]/.test(s)) return { ok: false, error: "Use one plain address, like name@example.com." };
    var m = /^([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+)@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)$/.exec(s);
    if (!m || m[1].length > 64 || m[1][0] === "." || m[1].slice(-1) === "." || /\.\./.test(m[1])) {
      return { ok: false, error: "That does not look like an email address." };
    }
    return { ok: true, value: m[1] + "@" + m[2].toLowerCase() };
  }

  // appfolio.com and any subdomain of it, such as invoices.appfolio.com.
  function isAppfolio(addr) {
    var v = validateEmail(addr);
    if (!v.ok) return false;
    var domain = v.value.split("@")[1];
    return domain === "appfolio.com" || /\.appfolio\.com$/.test(domain);
  }

  // A real Chrome extension client ID looks like 123456789012-abc123.apps.googleusercontent.com
  function needsSetup(clientId) {
    return !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(String(clientId || "").trim());
  }

  function subjectFor(requestName) {
    return ("Home Depot invoices " + String(requestName || "")).replace(/[\r\n]+/g, " ").slice(0, 150);
  }

  function bodyFor(requestName, count) {
    return "Attached is the Home Depot Invoice Details PDF for request " + requestName +
      (count ? " (" + count + " invoices)" : "") + ".\r\nSent from the Redside HD Bill Puller extension.";
  }

  // Automatic sending needs the opt-in box, a valid address, and a non-AppFolio address.
  function canAutoSend(settings) {
    if (!settings || !settings.autoSend) return false;
    var v = validateEmail(settings.email);
    return v.ok && !isAppfolio(v.value);
  }

  // The single gate every send goes through.
  //   trigger: "button" (the user pressed Send this batch) or "auto"
  //   confirmed: true when the user accepted the confirm() dialog
  function checkSend(args) {
    var settings = args.settings || {};
    var v = validateEmail(settings.email);
    if (!v.ok) return { ok: false, reason: "No valid 'Send batch to' address is saved." };
    if (args.to && String(args.to).toLowerCase() !== v.value) return { ok: false, reason: "The saved address changed since the button was drawn. Look at the popup and press the button again." };
    if (args.trigger !== "button" && args.trigger !== "auto") return { ok: false, reason: "Unknown send trigger." };
    var af = isAppfolio(v.value);
    if (args.trigger === "auto") {
      if (af) return { ok: false, reason: "AppFolio addresses are never sent automatically. Press the button in the popup." };
      if (!settings.autoSend) return { ok: false, reason: "Automatic sending is off." };
    }
    if (af && args.confirmed !== true) return { ok: false, reason: "AppFolio addresses need the button and a confirmation.", needsConfirm: true };
    return { ok: true, to: v.value, appfolio: af };
  }

  root.HD_EMAIL = {
    PLACEHOLDER_CLIENT_ID: PLACEHOLDER_CLIENT_ID,
    MAX_PDF_BYTES: MAX_PDF_BYTES,
    validateEmail: validateEmail,
    isAppfolio: isAppfolio,
    needsSetup: needsSetup,
    subjectFor: subjectFor,
    bodyFor: bodyFor,
    canAutoSend: canAutoSend,
    checkSend: checkSend
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.HD_EMAIL;
})(typeof self !== "undefined" ? self : globalThis);
