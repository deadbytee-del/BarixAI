/* Cross-origin isolation shim for static hosting (GitHub Pages cannot set COOP/COEP headers).
   Re-serves same-origin responses with COOP/COEP so SharedArrayBuffer — and multi-threaded WASM inference — is available. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
  e.respondWith(fetch(r).then((res) => {
    if (res.status === 0) return res;
    const h = new Headers(res.headers); h.set("Cross-Origin-Embedder-Policy", "credentialless"); h.set("Cross-Origin-Opener-Policy", "same-origin"); h.set("Cross-Origin-Resource-Policy", "cross-origin");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }).catch((err) => { console.error(err); return new Response("offline", { status: 503 }); }));
});
