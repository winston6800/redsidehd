// Gmail API call. The access token is passed in for one request and never stored or logged here.
// This is one of only two places in the extension that calls fetch() (the other reads the portal's
// own PDF link on the Citi page). The only host it talks to is the Gmail API base from config.js.
(function (root) {
  "use strict";

  async function sendRaw(args) {
    var f = args.fetchFn || fetch.bind(root);
    var res = await f(args.base + "/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { "Authorization": "Bearer " + args.token, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: args.raw })
    });
    var text = "";
    try { text = await res.text(); } catch (e) { text = ""; }
    var json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    if (!res.ok) {
      var msg = (json && json.error && json.error.message) || text || "no details";
      msg = String(msg).split(args.token).join("[token]").slice(0, 200);
      var err = new Error("Gmail answered " + res.status + ": " + msg);
      err.status = res.status;
      err.code = res.status === 401 ? "AUTH" : res.status === 403 ? "FORBIDDEN" : "HTTP";
      throw err;
    }
    return { id: json && json.id, threadId: json && json.threadId };
  }

  root.HD_GMAIL = { sendRaw: sendRaw };
  if (typeof module !== "undefined" && module.exports) module.exports = root.HD_GMAIL;
})(typeof self !== "undefined" ? self : globalThis);
