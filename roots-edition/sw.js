// Roots Edition — minimal offline-support service worker.
// Cache-first for the app shell (index.html, styles.css, app_bundle.js, recipes.json),
// falling back to the network for anything else / on a cache miss.
const CACHE_NAME = 'roots-edition-v15'; // v15 (2026-11-23): stop caching ./index.html — Cloudflare redirects it to /, and a cached redirect blanks the page
const APP_SHELL = [
  './',
  './styles.css',
  './app_bundle.js',
  './pager.js',
  './recipes.json',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

// Notifies any open tabs that a background refresh found a genuinely
// different copy of an app-shell asset, so the page can offer the person
// a "refresh to update" prompt instead of silently running stale code
// until their next visit.
function notifyClientsOfUpdate() {
  self.clients.matchAll({ includeUncontrolled: true }).then((clientList) => {
    clientList.forEach((client) => client.postMessage({ type: 'ROOTS_UPDATE_AVAILABLE' }));
  });
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // recipes.json is the one piece of app-shell content that changes on its
  // own schedule (independent of a service-worker version bump), so it gets
  // network-first: always try the live copy, cache it for offline use, and
  // only fall back to the cached copy if the network is unavailable.
  const isRecipesJson = event.request.url.endsWith('/recipes.json') || event.request.url.endsWith('recipes.json');

  if (isRecipesJson) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Everything else in the app shell: cache-first for instant offline loads,
  // with a background refresh so the cache doesn't go stale. The refresh is
  // wrapped in waitUntil so the service worker isn't terminated mid-write.
  //
  // Cache-first means this request itself still serves the OLD cached copy
  // even when the network has a newer one — that's the point, for instant
  // loads on unreliable kitchen wifi. But for the app shell's HTML/JS/CSS
  // (not images/fonts/etc — those changing silently doesn't matter), if the
  // background fetch turns up content that's actually different from what
  // was cached, tell any open tabs so they can prompt for a refresh, rather
  // than the person running stale code for an entire extra session with no
  // way to know a fix or new recipe is one reload away.
  const isShellAsset = ['document', 'script', 'style'].includes(event.request.destination);

  event.respondWith(
    caches.match(event.request).then((cached) => {
      // Clone synchronously, BEFORE the cached response is handed to the page:
      // once the page reads it, cached.clone() throws "body already used" and
      // the update comparison silently never runs.
      const cachedForCompare = cached ? cached.clone() : null;
      const refresh = fetch(event.request).then(async (response) => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          if (isShellAsset && cachedForCompare) {
            try {
              const [oldText, newText] = await Promise.all([cachedForCompare.text(), copy.clone().text()]);
              if (oldText !== newText) notifyClientsOfUpdate();
            } catch (_) { /* comparison is best-effort; never block the response on it */ }
          }
          const cache = await caches.open(CACHE_NAME);
          await cache.put(event.request, copy);
        }
        return response;
      });
      // Registered synchronously (calling waitUntil after the handler finishes
      // throws InvalidStateError) so the worker stays alive for the write.
      event.waitUntil(refresh.catch(() => {}));
      return cached || refresh.catch(() => cached);
    })
  );
});
