// Makes the app open without internet.
//
// When this file's VERSION changes, the browser downloads a fresh copy of every app file
// into a new store and deletes the old store. The app is then always served from one
// complete set of files, never a mix of old and new, and an update shows the next time
// the app is opened. Requests to the sheet script are never touched here: they go to
// another address and are not GETs.

// Set by `npm run stamp`. Do not edit by hand; tests/sw.test.js checks it.
const VERSION = '07049cfda493';
const PREFIX = 'cafe-billing-';
const CACHE = PREFIX + VERSION;

// Every file in app/ except this one and icon.svg. tests/sw.test.js fails if one is missing.
const SHELL = [
  './',
  'api.js',
  'bill.js',
  'firebase-config.js',
  'firebase.js',
  'icon-192.png',
  'icon-512.png',
  'index.html',
  'main.js',
  'manifest.webmanifest',
  'menu.js',
  'push-config.js',
  'push.js',
  'ring.js',
  'setup-link.js',
  'stock.js',
  'store.js',
  'styles.css',
  'sync.js',
  'tickets.js',
  'ui.js',
];

self.addEventListener('install', (event) => {
  // 'reload' skips the browser's own cache, so the new store really holds the new files.
  // If any file fails to download, the install fails and the old version stays in use.
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name.startsWith(PREFIX) && name !== CACHE).map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE)
      .then((cache) => cache.match(request, { ignoreSearch: true }))
      .then((stored) => stored || fetch(request)),
  );
});
