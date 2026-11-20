// Holds the PDF bytes of a batch in IndexedDB (inside this browser profile) until the batch is emailed,
// forgotten, or three days old. Extensions cannot read files in Downloads, so this is the only way
// the exact bytes that were saved can be attached later. Nothing here leaves the browser.
(function (root) {
  "use strict";
  var MAX_AGE_MS = 3 * 24 * 3600 * 1000;

  function open() {
    return new Promise(function (resolve, reject) {
      var r = indexedDB.open("hd-bytes", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("pdf", { keyPath: "name" }); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function run(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction("pdf", mode);
        var out = fn(tx.objectStore("pdf"));
        tx.oncomplete = function () { db.close(); resolve(out && out.result !== undefined ? out.result : undefined); };
        tx.onerror = function () { db.close(); reject(tx.error); };
        tx.onabort = function () { db.close(); reject(tx.error); };
      });
    });
  }
  function put(name, bytes) { return run("readwrite", function (s) { return s.put({ name: name, bytes: bytes, size: bytes.length, at: Date.now() }); }); }
  function get(name) { return run("readonly", function (s) { return s.get(name); }); }
  function del(name) { return run("readwrite", function (s) { return s.delete(name); }); }
  function clear() { return run("readwrite", function (s) { return s.clear(); }); }
  function count() { return run("readonly", function (s) { return s.count(); }); }
  function purgeOld() {
    return run("readwrite", function (s) {
      var cur = s.openCursor();
      cur.onsuccess = function () {
        var c = cur.result;
        if (!c) return;
        if (Date.now() - c.value.at > MAX_AGE_MS) c.delete();
        c.continue();
      };
      return cur;
    });
  }

  root.HD_BYTES = { put: put, get: get, del: del, clear: clear, count: count, purgeOld: purgeOld };
})(typeof self !== "undefined" ? self : globalThis);
