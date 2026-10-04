// Chalito service worker (skeleton). Installability now; Web Push with VAPID lands later (D-050).
// No offline caching of app data: approvals and sessions must always be fresh.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
// A fetch handler keeps the app installable in browsers that still look for one; it never caches.
self.addEventListener("fetch", () => {});
self.addEventListener("push", (event) => {
  // Wired in the push slice: payloads are pointers ({kind, id}); the app fetches content under RLS.
  event.waitUntil(Promise.resolve());
});
