// MIME message builder for the Gmail API. Pure functions, no network.
(function (root) {
  "use strict";

  function bytesToBinaryString(bytes) {
    var out = "";
    var step = 8192;
    for (var i = 0; i < bytes.length; i += step) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + step, bytes.length)));
    }
    return out;
  }

  // Standard base64. Chunks are a multiple of 3 bytes so no padding appears in the middle.
  function bytesToBase64(bytes) {
    var CH = 30720;
    var parts = [];
    for (var i = 0; i < bytes.length; i += CH) {
      parts.push(btoa(bytesToBinaryString(bytes.subarray(i, Math.min(i + CH, bytes.length)))));
    }
    return parts.join("");
  }

  function base64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Base64url without padding, as the Gmail API wants for `raw`. Input is an ASCII string or bytes.
  function toBase64Url(input) {
    var bytes = typeof input === "string" ? asciiBytes(input) : input;
    return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function asciiBytes(s) {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c > 255) throw new Error("Non-ASCII character in message source.");
      out[i] = c;
    }
    return out;
  }

  function header(name, value) {
    var v = String(value);
    if (/[\r\n]/.test(v)) throw new Error("Line break in header " + name + " is not allowed.");
    return name + ": " + v;
  }

  // RFC 2047 encoding for a header that has non-ASCII text.
  function encodeHeaderText(s) {
    if (/^[\x20-\x7e]*$/.test(s)) return s;
    var utf8 = new TextEncoder().encode(s);
    return "=?UTF-8?B?" + bytesToBase64(utf8) + "?=";
  }

  function wrap76(s) {
    return s.replace(/.{1,76}/g, "$&\r\n");
  }

  function randomBoundary() {
    var a = new Uint8Array(12);
    globalThis.crypto.getRandomValues(a);
    return "=_hd_" + Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  // Returns the whole message as an ASCII string with CRLF line ends.
  //   opts: to, subject, body, filename, bytes (Uint8Array), contentType, boundary (tests only)
  function buildMime(opts) {
    var boundary = opts.boundary || randomBoundary();
    var filename = String(opts.filename || "attachment.pdf").replace(/[^A-Za-z0-9._-]/g, "_");
    var type = opts.contentType || "application/pdf";
    var bodyIsAscii = /^[\x00-\x7f]*$/.test(opts.body || "");
    var lines = [
      header("To", opts.to),
      header("Subject", encodeHeaderText(opts.subject || "")),
      "MIME-Version: 1.0",
      header("Content-Type", 'multipart/mixed; boundary="' + boundary + '"'),
      "",
      "--" + boundary,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: " + (bodyIsAscii ? "7bit" : "base64"),
      "",
      bodyIsAscii ? String(opts.body || "").replace(/\r?\n/g, "\r\n") : wrap76(bytesToBase64(new TextEncoder().encode(opts.body))).replace(/\r\n$/, ""),
      "--" + boundary,
      header("Content-Type", type + '; name="' + filename + '"'),
      header("Content-Disposition", 'attachment; filename="' + filename + '"'),
      "Content-Transfer-Encoding: base64",
      ""
    ];
    return lines.join("\r\n") + "\r\n" + wrap76(bytesToBase64(opts.bytes)) + "--" + boundary + "--\r\n";
  }

  root.HD_MIME = {
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    toBase64Url: toBase64Url,
    buildMime: buildMime
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.HD_MIME;
})(typeof self !== "undefined" ? self : globalThis);
