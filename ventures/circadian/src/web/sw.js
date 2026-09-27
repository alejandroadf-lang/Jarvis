// Keeps the app shell on the phone so a saved plan opens on a plane with no
// signal. The plan itself is kept by the page in localStorage; a POST cannot
// be cached here, and the plan is the one thing a traveller needs offline.
const SHELL = "circadian-shell-v3";
// Relative to the worker's scope, so the app works at "/" or under "/circadian/".
const BASE = new URL(self.registration.scope).pathname;
const FILES = ["", "index.html", "app.js", "manifest.webmanifest", "icon.svg"].map((f) => BASE + f);

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const path = url.pathname.startsWith(BASE) ? url.pathname.slice(BASE.length) : null;
  if (e.request.method !== "GET" || path === null || /^(app|v\d|whoop)\//.test(path)) return;
  // Network first, so a new version reaches people; the cache is the fallback.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match(BASE + "index.html")))
  );
});

// Reminders. The server sends {title, body, kind}; the page is opened on tap.
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: "Circadian", body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || "Circadian", {
    body: data.body || "",
    icon: BASE + "icon.svg",
    badge: BASE + "icon.svg",
    tag: data.kind || "circadian",
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => new URL(w.url).pathname.startsWith(BASE));
      return open ? open.focus() : self.clients.openWindow(self.registration.scope);
    })
  );
});
