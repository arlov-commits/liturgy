// sw.js — lets the editor be installed as an app and open when offline.
// The app's files come from the network when there is one (asking the server whether they changed, so a new
// version always arrives whole — taking some files from an older copy could mix two versions and stop the page from
// starting), and from this cache when offline. The liturgy text (GitHub's API) is never cached here.
const CACHE = "liturgy-app-2";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);   // (older, possibly mixed, copies)
  await self.clients.claim();
})()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const scope = new URL(self.registration.scope);
  if (e.request.method !== "GET" || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const r = await fetch(e.request, { cache: "no-cache" });
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    } catch (err) {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      if (cached) return cached;
      throw err;
    }
  })());
});
