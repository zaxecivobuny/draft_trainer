/* Service worker: app shell precache, network-first data, cache-first card images. */
const VERSION = "p1p1-v3";
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;
const IMG = "p1p1-img"; // not versioned: card art never changes
const IMG_MAX = 2500;

const SHELL_FILES = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "vendor/Sortable.min.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, DATA, IMG]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trim(cacheName, max) {
  const c = await caches.open(cacheName);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Card images from Scryfall's CDN: cache-first (opaque responses are fine for <img>).
  if (url.hostname === "cards.scryfall.io") {
    e.respondWith((async () => {
      const c = await caches.open(IMG);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === "opaque") {
          c.put(req, res.clone());
          trim(IMG, IMG_MAX);
        }
        return res;
      } catch {
        return Response.error();
      }
    })());
    return;
  }

  if (url.origin !== location.origin) return;

  // Data snapshots: network first so new weekly data shows up, cache as offline fallback.
  if (url.pathname.includes("/data/")) {
    e.respondWith((async () => {
      const c = await caches.open(DATA);
      try {
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch {
        return (await c.match(req, { ignoreSearch: true })) || Response.error();
      }
    })());
    return;
  }

  // App shell: stale-while-revalidate.
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || (req.mode === "navigate" ? c.match("index.html") : Response.error());
  })());
});
