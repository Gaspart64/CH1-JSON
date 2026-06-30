const CACHE_NAME = 'chess-json-trainer-v1';
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
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
    const isDynamic = event.request.url.includes('/Puzzles/') ||
                      event.request.url.endsWith('.pgn') ||
                      event.request.url.endsWith('.json');

    if (isDynamic) {
        event.respondWith(
            fetch(event.request).catch(() => caches.match(event.request))
        );
    } else {
        event.respondWith(
            caches.match(event.request).then(response => {
                return response || fetch(event.request);
            })
        );
    }
});
