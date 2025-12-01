// sw.js
const CACHE_NAME = 'pdf-editor-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html', // Change this to your actual HTML filename
  './js/pdf-lib.min.js',
  './js/pdf.min.js',
  './js/pdf.worker.min.js',
  './js/sortable.min.js',
  './js/tailwindcss.js'
];

// Install Service Worker and cache libraries
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// Serve cached files when offline
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
