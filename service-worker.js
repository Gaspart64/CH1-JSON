const CACHE_NAME = 'chess-json-trainer-v1.1';
const PRECACHE = [
    './',
    './index.html',
    './manifest.json',
    './assets/pagestyle.css',
    './assets/w3.js',
    './assets/storage.js',
    './assets/pgn-upload-handler.js',
    './assets/game-modes.js',
    './assets/chess-pgn-trainer.js',
    './assets/piece-list.js',
    './assets/puzzle-manifest.js',
    './assets/json-parser.js',
    './img/github-mark.svg',
    './img/github-mark-white.svg'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(PRECACHE))
            .then(self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    // Only cache GET requests
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    const isDynamic = url.pathname.includes('/Puzzles/') ||
                      url.pathname.endsWith('.pgn') ||
                      url.pathname.endsWith('.json');

    if (isDynamic) {
        // Network-first strategy for puzzles
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    const resClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, resClone);
                    });
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
    } else {
        // Cache-first strategy for assets
        event.respondWith(
            caches.match(event.request).then(response => {
                return response || fetch(event.request).then(fetchRes => {
                    return caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, fetchRes.clone());
                        return fetchRes;
                    });
                });
            })
        );
    }
});
