// Dubplate's service worker: just enough to install it as an app and to say so
// when the server can't be reached. Nothing is cached - your music, the API and
// the app itself always come fresh from the server.

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dubplate - offline</title><style>
body{margin:0;min-height:100svh;display:grid;place-items:center;background:#1a1613;color:#f3ece4;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px}
.s{height:4px;background:linear-gradient(90deg,#d62f2f 33%,#f4c20d 33% 66%,#1f9d55 66%);position:fixed;inset:0 0 auto}
h1{font-size:22px;margin:16px 0 4px}p{color:#b3a79b;margin:0 0 20px}button{font:inherit;border:0;border-radius:999px;padding:10px 20px;background:#d62f2f;color:#fff}
</style></head><body><div class="s"></div><main><h1>Can't reach Dubplate</h1><p>The server isn't answering - is it running, and is this device on the same network?</p>
<button onclick="location.reload()">Try again</button></main></body></html>`

self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))

self.addEventListener("fetch", (event) => {
  // Only page loads: everything else goes straight to the network as usual.
  if (event.request.mode !== "navigate") return
  event.respondWith(fetch(event.request).catch(() => new Response(OFFLINE, { headers: { "content-type": "text/html; charset=utf-8" } })))
})
