// Shared settings. Loaded by the content script, the service worker, and the popup.
// The only host this extension talks to is the Citi portal host below.
(function (root) {
  var ORIGIN = "https://www.retailservicescommercial.citi.com";
  root.HD_CONFIG = {
    HOSTS: ["www.retailservicescommercial.citi.com"],
    ORIGIN: ORIGIN,
    // Same sign-on and Invoices URLs the Python fetcher uses (tools/citi_fetch.py).
    INVOICES_URL: ORIGIN + "/USCRSF/CMLSVC/index.html?siteId=PLNP_HOMEDEPOT#invprox/invoices",
    INVOICES_HASH: "#invprox/invoices",
    MANAGE_HASH: "#pro/manageacct",
    SIGNON_HASH: "#sec/signon",
    DEFAULT_START_DATE: "2026-10-01",
  MAX_BATCH: 100,              // portal limit for Invoice Details PDF
    DEFAULT_N: 10,
    POLL_MINUTES: 1,             // chrome.alarms minimum is 30 seconds, so 1 minute is safe
    POLL_MAX_MINUTES: 60,        // stop polling a request after this long
    RELOAD_EVERY_POLLS: 3,       // full page reload every Nth poll, clicks in between
    DOWNLOAD_SUBFOLDER: "redside-hd",
    GMAIL_BASE: "https://gmail.googleapis.com", // the only non-Citi host, used only to send mail you ask for
    FAKE_TOKEN: null,            // test build only: skips chrome.identity
    TEST_HOOKS: false            // true only in the generated test build
  };
})(typeof self !== "undefined" ? self : globalThis);
