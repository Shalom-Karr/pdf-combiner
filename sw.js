// sw.js
const CACHE_NAME = 'pdf-editor-v2';
const APP_SHELL = [
  './',
  './index.html',
  './pro.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];
const JS_LIBS = [
  './js/pdf-lib.min.js',
  './js/pdf.min.js',
  './js/pdf.worker.min.js',
  './js/sortable.min.js',
  './js/tailwindcss.js'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(APP_SHELL.concat(JS_LIBS));
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(n) { return n.indexOf('pdf-editor-') === 0 && n !== CACHE_NAME; })
             .map(function(n) { return caches.delete(n); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;
  var url = new URL(event.request.url);
  if (url.pathname.indexOf('/js/') !== -1) {
    // Cache-first for large immutable vendored libraries
    event.respondWith(
      caches.match(event.request).then(function(cached) {
        if (cached) return cached;
        return fetch(event.request).then(function(response) {
          if (response && response.ok && response.type !== 'opaque') {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
          }
          return response;
        });
      })
    );
    return;
  }
  // Network-first for app shell and HTML — users get fresh content when online,
  // cached fallback keeps the app functional offline
  event.respondWith(
    fetch(event.request).then(function(response) {
      if (response && response.ok && response.type !== 'opaque') {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, clone); });
      }
      return response;
    }).catch(function() {
      return caches.match(event.request);
    })
  );
});
