const CACHE_NAME = 'chess-json-trainer-v1.2.0';

const PRECACHE = [
    './', './index.html',
    './assets/app.js', './assets/chess-pgn-trainer.js',
    './assets/game-modes.js', './assets/storage.js',
    './assets/database.js', './assets/puzzle-manifest.js',
    './assets/json-parser.js', './assets/pgn-upload-handler.js',
    './assets/piece-list.js', './assets/pagestyle.css', './assets/w3.js',
    './assets/jquery.wheelcolorpicker.js', './assets/wheelcolorpicker.css',
    './assets/cm-chessboard/assets/chessboard.css',
    './assets/cm-chessboard/assets/pieces/staunty.svg',
    './assets/cm-chessboard/assets/extensions/markers/markers.css',
    './assets/cm-chessboard/assets/extensions/markers/markers.svg',
    './assets/cm-chessboard/assets/extensions/promotion-dialog/promotion-dialog.css',
    './assets/cm-chessboard/src/Chessboard.js',
    './assets/cm-chessboard/src/extensions/markers/Markers.js',
    './assets/cm-chessboard/src/extensions/promotion-dialog/PromotionDialog.js',
    './assets/cm-chessboard/src/lib/Svg.js',
    './assets/cm-chessboard/src/lib/Utils.js',
    './assets/cm-chessboard/src/model/ChessboardState.js',
    './assets/cm-chessboard/src/model/Extension.js',
    './assets/cm-chessboard/src/model/Position.js',
    './assets/cm-chessboard/src/view/ChessboardView.js',
    './assets/cm-chessboard/src/view/PositionAnimationsQueue.js',
    './assets/cm-chessboard/src/view/VisualMoveInput.js',
];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    const isData = url.pathname.endsWith('.pgn') || url.pathname.endsWith('.json');
    
    if (isData) {
        // Network-first for data files so content updates propagate
        e.respondWith(
            fetch(e.request)
                .then(r => { caches.open(CACHE_NAME).then(c => c.put(e.request, r.clone())); return r; })
                .catch(() => caches.match(e.request))
        );
    } else {
        // Cache-first for all other assets
        e.respondWith(
            caches.match(e.request).then(cached => cached ||
                fetch(e.request).then(r => {
                    caches.open(CACHE_NAME).then(c => c.put(e.request, r.clone()));
                    return r;
                })
            )
        );
    }
});
