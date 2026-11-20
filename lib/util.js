// Small pure helpers, shared by the service worker and the unit tests.
(function (root) {
  function sanitizeFilename(name) {
    var s = String(name || "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120);
    return s || "download";
  }

  // "Nov_17_2026-11-51-44-No_of_Invoices-3" -> 3, or null when the name has another shape.
  function parseRequestName(name) {
    var m = /No_of_Invoices-(\d+)\s*$/i.exec(String(name || "").trim());
    return m ? parseInt(m[1], 10) : null;
  }

  function clampN(n, max, fallback) {
    var v = parseInt(n, 10);
    if (!isFinite(v) || v < 1) v = fallback || 1;
    return Math.min(v, max);
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return ""; }
  }

  function isPortalUrl(cfg, url) {
    return cfg.HOSTS.indexOf(hostOf(url)) !== -1;
  }

  // A download belongs to the portal when its URL, or the origin inside a blob: URL, is a portal host.
  function isPortalDownloadUrl(cfg, url) {
    var u = String(url || "");
    if (u.indexOf("blob:") === 0) u = u.slice(5);
    return isPortalUrl(cfg, u);
  }

  function shortPath(p) {
    return String(p || "").split(/[\\/]/).slice(-2).join("/");
  }

  // "YYYY-MM-DD" that is a real calendar date, else false.
  function validYmd(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ""));
    if (!m) return false;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (y < 1990 || y > 2100) return false;
    var t = new Date(Date.UTC(y, mo - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
  }

  root.HD_UTIL = {
    validYmd: validYmd,
    sanitizeFilename: sanitizeFilename,
    parseRequestName: parseRequestName,
    clampN: clampN,
    hostOf: hostOf,
    isPortalUrl: isPortalUrl,
    isPortalDownloadUrl: isPortalDownloadUrl,
    shortPath: shortPath
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.HD_UTIL;
})(typeof self !== "undefined" ? self : globalThis);
