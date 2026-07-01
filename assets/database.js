/**
 * database.js — IndexedDB persistence layer for Chess PGN Trainer
 *
 * Replaces the ad-hoc localStorage usage for Spaced Repetition and
 * Woodpecker mode with a structured, queryable database.
 *
 * Object stores
 * ─────────────
 *  sr_cards     One row per (pgnFile, puzzleIndex). Holds the SM-2 card.
 *  sr_daily     One row per (pgnFile, date). Daily correct/incorrect counts
 *               used for the retention graph.
 *  wp_current   One row per pgnFile. The in-progress Woodpecker cycle.
 *  wp_history   One row per (pgnFile, cycleNumber). Completed cycle records.
 *  session_log  Auto-increment. One row per completed training session.
 *
 * All public functions are async and return Promises so callers can
 * await them. Fire-and-forget saves (e.g. after every move) are safe
 * to call without awaiting — errors are logged to the console only.
 *
 * Usage
 * ─────
 *   await ChessDB.open();                    // call once on app start
 *   const cards = await ChessDB.srGetCards('1_pgn');
 *   await ChessDB.srSaveCard('1_pgn', card);
 *   await ChessDB.srLogDay('1_pgn', '2025-03-05', 4, 1);
 */

const ChessDB = (() => {

	// ── Constants ────────────────────────────────────────────────────────────

	const DB_NAME    = 'ChessPGNTrainerDB';
	const DB_VERSION = 1;

	const STORE = {
		SR_CARDS  : 'sr_cards',
		SR_DAILY  : 'sr_daily',
		WP_CURRENT: 'wp_current',
		WP_HISTORY: 'wp_history',
		SESSION   : 'session_log'
	};

	// ── Internal state ───────────────────────────────────────────────────────

	let _db = null;           // IDBDatabase instance after open()
	let _openPromise = null;  // cached so open() is idempotent

	// ── Database initialisation ──────────────────────────────────────────────

	/**
	 * Open (or create) the database.
	 * Safe to call multiple times — returns the same promise after the first call.
	 * @returns {Promise<IDBDatabase>}
	 */
	function open() {
		if (_openPromise) return _openPromise;

		_openPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(DB_NAME, DB_VERSION);

			req.onupgradeneeded = (event) => {
				const db = event.target.result;

				// ── sr_cards ─────────────────────────────────────────────────
				// keyPath is a string composite key "pgnFile::puzzleIndex"
				// so we don't need a compound IDB key (simpler cross-browser).
				if (!db.objectStoreNames.contains(STORE.SR_CARDS)) {
					const cardStore = db.createObjectStore(STORE.SR_CARDS, { keyPath: 'id' });
					cardStore.createIndex('byPgn',       'pgnFile',     { unique: false });
					cardStore.createIndex('byNextReview','nextReview',  { unique: false });
				}

				// ── sr_daily ─────────────────────────────────────────────────
				if (!db.objectStoreNames.contains(STORE.SR_DAILY)) {
					const dailyStore = db.createObjectStore(STORE.SR_DAILY, { keyPath: 'id' });
					dailyStore.createIndex('byPgn',  'pgnFile', { unique: false });
					dailyStore.createIndex('byDate', 'date',    { unique: false });
				}

				// ── wp_current ───────────────────────────────────────────────
				if (!db.objectStoreNames.contains(STORE.WP_CURRENT)) {
					db.createObjectStore(STORE.WP_CURRENT, { keyPath: 'pgnFile' });
				}

				// ── wp_history ───────────────────────────────────────────────
				if (!db.objectStoreNames.contains(STORE.WP_HISTORY)) {
					const wpStore = db.createObjectStore(STORE.WP_HISTORY, { keyPath: 'id' });
					wpStore.createIndex('byPgn', 'pgnFile', { unique: false });
				}

				// ── session_log ──────────────────────────────────────────────
				if (!db.objectStoreNames.contains(STORE.SESSION)) {
					const sesStore = db.createObjectStore(STORE.SESSION,
						{ keyPath: 'id', autoIncrement: true });
					sesStore.createIndex('byPgn',  'pgnFile',   { unique: false });
					sesStore.createIndex('byMode', 'mode',      { unique: false });
					sesStore.createIndex('byDate', 'date',      { unique: false });
				}
			};

			req.onsuccess = (event) => {
				_db = event.target.result;
				console.log(`[ChessDB] opened ${DB_NAME} v${DB_VERSION}`);
				resolve(_db);
			};

			req.onerror = (event) => {
				console.error('[ChessDB] open failed:', event.target.error);
				reject(event.target.error);
			};
		});

		return _openPromise;
	}

	// ── Internal helpers ─────────────────────────────────────────────────────

	/** Wrap a single IDB request in a Promise */
	function _req(request) {
		return new Promise((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror   = () => reject(request.error);
		});
	}

	/** Get a readwrite transaction on one store */
	function _rw(storeName) {
		return _db.transaction([storeName], 'readwrite').objectStore(storeName);
	}

	/** Get a readonly transaction on one store */
	function _ro(storeName) {
		return _db.transaction([storeName], 'readonly').objectStore(storeName);
	}

	/** Build the composite string key used for sr_cards and sr_daily */
	function _cardId(pgnFile, puzzleIndex) {
		return `${pgnFile}::${puzzleIndex}`;
	}
	function _dailyId(pgnFile, date) {
		return `${pgnFile}::${date}`;
	}
	function _wpHistoryId(pgnFile, cycleNumber) {
		return `${pgnFile}::${cycleNumber}`;
	}

	// =========================================================================
	// SPACED REPETITION — Cards
	// =========================================================================

	/**
	 * Return all SR cards for a PGN file as a plain object keyed by puzzleIndex.
	 * Returns {} if none exist yet.
	 * @param {string} pgnFile
	 * @returns {Promise<Object>}   { [puzzleIndex]: card }
	 */
	async function srGetCards(pgnFile) {
		await open();
		const store = _ro(STORE.SR_CARDS);
		const idx   = store.index('byPgn');
		const rows  = await _req(idx.getAll(pgnFile));
		const result = {};
		rows.forEach(row => { result[row.puzzleIndex] = row; });
		return result;
	}

	/**
	 * Persist a single SR card (upsert).
	 * @param {string} pgnFile
	 * @param {Object} card   Must include puzzleIndex and all SM-2 fields.
	 * @returns {Promise<void>}
	 */
	async function srSaveCard(pgnFile, card) {
		await open();
		const record = {
			id          : _cardId(pgnFile, card.puzzleIndex ?? card.index),
			pgnFile,
			puzzleIndex : card.puzzleIndex ?? card.index,
			interval    : card.interval,
			easeFactor  : card.easeFactor,
			repetitions : card.repetitions,
			nextReview  : card.nextReview,
			due         : card.due
		};
		return _req(_rw(STORE.SR_CARDS).put(record));
	}

	/**
	 * Bulk-save an array (or values-object) of cards.
	 * @param {string} pgnFile
	 * @param {Object|Array} cards
	 * @returns {Promise<void>}
	 */
	async function srSaveAllCards(pgnFile, cards) {
		await open();
		const tx    = _db.transaction([STORE.SR_CARDS], 'readwrite');
		const store = tx.objectStore(STORE.SR_CARDS);
		const list  = Array.isArray(cards) ? cards : Object.values(cards);
		list.forEach(card => {
			const record = {
				id          : _cardId(pgnFile, card.puzzleIndex ?? card.index),
				pgnFile,
				puzzleIndex : card.puzzleIndex ?? card.index,
				interval    : card.interval,
				easeFactor  : card.easeFactor,
				repetitions : card.repetitions,
				nextReview  : card.nextReview,
				due         : card.due
			};
			store.put(record);
		});
		return new Promise((resolve, reject) => {
			tx.oncomplete = resolve;
			tx.onerror    = () => reject(tx.error);
		});
	}

	/**
	 * Delete all SR cards for a PGN file.
	 * @param {string} pgnFile
	 * @returns {Promise<void>}
	 */
	async function srClearCards(pgnFile) {
		await open();
		const store  = _rw(STORE.SR_CARDS);
		const idx    = store.index('byPgn');
		const keys   = await _req(idx.getAllKeys(pgnFile));
		const tx     = _db.transaction([STORE.SR_CARDS], 'readwrite');
		const store2 = tx.objectStore(STORE.SR_CARDS);
		keys.forEach(k => store2.delete(k));
		return new Promise((resolve, reject) => {
			tx.oncomplete = resolve;
			tx.onerror    = () => reject(tx.error);
		});
	}

	// =========================================================================
	// SPACED REPETITION — Daily History (Retention Graph)
	// =========================================================================

	/**
	 * Increment (or create) the daily counter for a PGN file.
	 * @param {string} pgnFile
	 * @param {string} date        ISO date string  'YYYY-MM-DD'
	 * @param {number} correct     Number of correct solves to add
	 * @param {number} incorrect   Number of incorrect solves to add
	 * @returns {Promise<void>}
	 */
	async function srLogDay(pgnFile, date, correct, incorrect) {
		await open();
		const id     = _dailyId(pgnFile, date);
		const store  = _rw(STORE.SR_DAILY);
		const existing = await _req(store.get(id));
		const record = existing
			? { ...existing, correct: existing.correct + correct, incorrect: existing.incorrect + incorrect }
			: { id, pgnFile, date, correct, incorrect };
		return _req(_rw(STORE.SR_DAILY).put(record));
	}

	/**
	 * Return daily history for a PGN file for the last N days.
	 * Each entry: { date, correct, incorrect }.
	 * Missing days are filled with zeros so the array always has `days` entries.
	 * @param {string} pgnFile
	 * @param {number} [days=30]
	 * @returns {Promise<Array>}
	 */
	async function srGetHistory(pgnFile, days = 30) {
		await open();
		const store = _ro(STORE.SR_DAILY);
		const idx   = store.index('byPgn');
		const rows  = await _req(idx.getAll(pgnFile));

		const byDate = {};
		rows.forEach(r => { byDate[r.date] = r; });

		const result = [];
		for (let i = days - 1; i >= 0; i--) {
			const d    = new Date();
			d.setDate(d.getDate() - i);
			const key  = d.toISOString().slice(0, 10);
			result.push(byDate[key]
				? { date: key, correct: byDate[key].correct, incorrect: byDate[key].incorrect }
				: { date: key, correct: 0, incorrect: 0 });
		}
		return result;
	}

	/**
	 * Return daily history across ALL PGN files for the last N days.
	 * Useful for an aggregate retention view.
	 * @param {number} [days=30]
	 * @returns {Promise<Array>}
	 */
	async function srGetHistoryAll(days = 30) {
		await open();
		const store = _ro(STORE.SR_DAILY);
		const rows  = await _req(store.getAll());

		// Build date range
		const dates = {};
		for (let i = days - 1; i >= 0; i--) {
			const d   = new Date();
			d.setDate(d.getDate() - i);
			const key = d.toISOString().slice(0, 10);
			dates[key] = { date: key, correct: 0, incorrect: 0 };
		}
		rows.forEach(r => {
			if (dates[r.date]) {
				dates[r.date].correct   += r.correct;
				dates[r.date].incorrect += r.incorrect;
			}
		});
		return Object.values(dates).sort((a, b) => a.date.localeCompare(b.date));
	}

	/**
	 * Return the list of distinct PGN files that have SR history.
	 * @returns {Promise<string[]>}
	 */
	async function srGetPgnFiles() {
		await open();
		const rows = await _req(_ro(STORE.SR_CARDS).getAll());
		return [...new Set(rows.map(r => r.pgnFile))];
	}

	// =========================================================================
	// WOODPECKER — Current Cycle
	// =========================================================================

	/**
	 * Persist (upsert) the in-progress Woodpecker cycle for a PGN file.
	 * @param {string} pgnFile
	 * @param {Object} cycleData
	 * @returns {Promise<void>}
	 */
	async function wpSaveCurrent(pgnFile, cycleData) {
		await open();
		return _req(_rw(STORE.WP_CURRENT).put({ pgnFile, ...cycleData }));
	}

	/**
	 * Load the in-progress cycle for a PGN file, or null if none.
	 * @param {string} pgnFile
	 * @returns {Promise<Object|null>}
	 */
	async function wpGetCurrent(pgnFile) {
		await open();
		const row = await _req(_ro(STORE.WP_CURRENT).get(pgnFile));
		return row || null;
	}

	/**
	 * Delete the in-progress cycle (called when a cycle completes).
	 * @param {string} pgnFile
	 * @returns {Promise<void>}
	 */
	async function wpClearCurrent(pgnFile) {
		await open();
		return _req(_rw(STORE.WP_CURRENT).delete(pgnFile));
	}

	// =========================================================================
	// WOODPECKER — Cycle History
	// =========================================================================

	/**
	 * Append a completed cycle record.
	 * @param {string} pgnFile
	 * @param {Object} cycle   { cycleNumber, startedAt, completedAt, totalMs, puzzleCount, mistakeCount, mistakeIndexes }
	 * @returns {Promise<void>}
	 */
	async function wpSaveCompletedCycle(pgnFile, cycle) {
		await open();
		const record = {
			id          : _wpHistoryId(pgnFile, cycle.cycleNumber),
			pgnFile,
			cycleNumber : cycle.cycleNumber,
			startedAt   : cycle.startedAt,
			completedAt : cycle.completedAt,
			totalMs     : cycle.totalMs,
			puzzleCount : cycle.puzzleCount,
			mistakeCount: cycle.mistakeCount,
			mistakeIndexes: cycle.mistakeIndexes || []
		};
		return _req(_rw(STORE.WP_HISTORY).put(record));
	}

	/**
	 * Return all completed cycles for a PGN file, sorted oldest→newest.
	 * @param {string} pgnFile
	 * @returns {Promise<Array>}
	 */
	async function wpGetCycleHistory(pgnFile) {
		await open();
		const idx  = _ro(STORE.WP_HISTORY).index('byPgn');
		const rows = await _req(idx.getAll(pgnFile));
		return rows.sort((a, b) => a.cycleNumber - b.cycleNumber);
	}

	/**
	 * Delete all Woodpecker data (current + history) for a PGN file.
	 * @param {string} pgnFile
	 * @returns {Promise<void>}
	 */
	async function wpClearAll(pgnFile) {
		await open();
		await wpClearCurrent(pgnFile);
		const store = _rw(STORE.WP_HISTORY);
		const keys  = await _req(store.index('byPgn').getAllKeys(pgnFile));
		const tx    = _db.transaction([STORE.WP_HISTORY], 'readwrite');
		keys.forEach(k => tx.objectStore(STORE.WP_HISTORY).delete(k));
		return new Promise((resolve, reject) => {
			tx.oncomplete = resolve;
			tx.onerror    = () => reject(tx.error);
		});
	}

	// =========================================================================
	// SESSION LOG
	// =========================================================================

	/**
	 * Append a session record after any mode completes.
	 * @param {Object} session
	 *   { pgnFile, mode, date, timestamp, puzzlesSolved, errors, errorRate,
	 *     totalTimeMs, avgTimeMs, bestStreak }
	 * @returns {Promise<number>}  The auto-increment id
	 */
	async function saveSession(session) {
		await open();
		return _req(_rw(STORE.SESSION).add({
			pgnFile     : session.pgnFile      || 'unknown',
			mode        : session.mode         || 'standard',
			date        : session.date         || new Date().toISOString().slice(0, 10),
			timestamp   : session.timestamp    || Date.now(),
			puzzlesSolved: session.puzzlesSolved || 0,
			errors      : session.errors       || 0,
			errorRate   : session.errorRate    || 0,
			totalTimeMs : session.totalTimeMs  || 0,
			avgTimeMs   : session.avgTimeMs    || 0,
			bestStreak  : session.bestStreak   || 0
		}));
	}

	/**
	 * Return recent sessions, optionally filtered by PGN file.
	 * @param {string|null} [pgnFile]  Pass null for all files.
	 * @param {number}      [limit=50]
	 * @returns {Promise<Array>}
	 */
	async function getSessions(pgnFile = null, limit = 50) {
		await open();
		let rows;
		if (pgnFile) {
			const idx = _ro(STORE.SESSION).index('byPgn');
			rows = await _req(idx.getAll(pgnFile));
		} else {
			rows = await _req(_ro(STORE.SESSION).getAll());
		}
		rows.sort((a, b) => b.timestamp - a.timestamp);
		return rows.slice(0, limit);
	}

	// =========================================================================
	// EXPORT / IMPORT
	// =========================================================================

	/**
	 * Export everything to a single JSON blob.
	 * Useful for backups and cross-device migration.
	 * @returns {Promise<Object>}
	 */
	async function exportAll() {
		await open();
		const [srCards, srDaily, wpCurrent, wpHistory, sessions] = await Promise.all([
			_req(_ro(STORE.SR_CARDS).getAll()),
			_req(_ro(STORE.SR_DAILY).getAll()),
			_req(_ro(STORE.WP_CURRENT).getAll()),
			_req(_ro(STORE.WP_HISTORY).getAll()),
			_req(_ro(STORE.SESSION).getAll())
		]);
		return {
			exportDate: new Date().toISOString(),
			version   : DB_VERSION,
			srCards, srDaily, wpCurrent, wpHistory, sessions
		};
	}

	/**
	 * Import data from a blob produced by exportAll().
	 * Existing data is overwritten (put semantics).
	 * @param {Object} data
	 * @returns {Promise<void>}
	 */
	async function importAll(data) {
		await open();

		const stores = {
			[STORE.SR_CARDS]  : data.srCards   || [],
			[STORE.SR_DAILY]  : data.srDaily   || [],
			[STORE.WP_CURRENT]: data.wpCurrent || [],
			[STORE.WP_HISTORY]: data.wpHistory || [],
			[STORE.SESSION]   : data.sessions  || []
		};

		for (const [storeName, rows] of Object.entries(stores)) {
			const tx    = _db.transaction([storeName], 'readwrite');
			const store = tx.objectStore(storeName);
			rows.forEach(row => store.put(row));
			await new Promise((resolve, reject) => {
				tx.oncomplete = resolve;
				tx.onerror    = () => reject(tx.error);
			});
		}
	}

	// =========================================================================
	// MIGRATION — import legacy localStorage data on first run
	// =========================================================================

	/**
	 * One-time migration: read SR cards and Woodpecker data from localStorage
	 * and write them into IndexedDB. Marks migration done with a localStorage flag
	 * so it never runs twice.
	 */
	async function migrateFromLocalStorage() {
		if (localStorage.getItem('idb_migrated')) return;

		console.log('[ChessDB] Migrating data from localStorage …');

		// SR cards: keys prefixed "sr_cards_"
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key || !key.startsWith('sr_cards_')) continue;
			const pgnFile = key.replace('sr_cards_', '');
			try {
				const cards = JSON.parse(localStorage.getItem(key));
				if (cards && typeof cards === 'object') {
					await srSaveAllCards(pgnFile, Object.values(cards));
				}
			} catch (e) {
				console.warn('[ChessDB] Could not migrate', key, e);
			}
		}

		// SR history: single key "sr_history"
		try {
			const raw = localStorage.getItem('sr_history');
			if (raw) {
				const hist = JSON.parse(raw);
				for (const [date, entry] of Object.entries(hist)) {
					// History was stored globally (no pgnFile), label as 'legacy'
					await srLogDay('legacy', date, entry.correct || 0, entry.incorrect || 0);
				}
			}
		} catch (e) {
			console.warn('[ChessDB] Could not migrate sr_history', e);
		}

		// Woodpecker: keys prefixed "wp_data_"
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key || !key.startsWith('wp_data_')) continue;
			const pgnFile = key.replace('wp_data_', '');
			try {
				const wpData = JSON.parse(localStorage.getItem(key));
				if (!wpData) continue;
				if (wpData.currentCycle) {
					await wpSaveCurrent(pgnFile, wpData.currentCycle);
				}
				if (wpData.cycleHistory && wpData.cycleHistory.length) {
					for (const cycle of wpData.cycleHistory) {
						await wpSaveCompletedCycle(pgnFile, cycle);
					}
				}
			} catch (e) {
				console.warn('[ChessDB] Could not migrate', key, e);
			}
		}

		localStorage.setItem('idb_migrated', '1');
		console.log('[ChessDB] Migration complete.');
	}

	// =========================================================================
	// RETENTION GRAPH RENDERER
	// =========================================================================

	/**
	 * Build a full SVG retention graph for a given history array.
	 *
	 * @param {Array}  history    Array of { date, correct, incorrect }
	 * @param {Object} [opts]
	 *   opts.width      SVG width  (default 560)
	 *   opts.height     SVG height (default 140)
	 *   opts.labelEvery Show x-axis label every N days (default 7)
	 * @returns {string}  SVG markup string
	 */
	function buildRetentionGraph(history, opts = {}) {
		const W     = opts.width      || 560;
		const H     = opts.height     || 140;
		const LABEL = opts.labelEvery || 7;
		const PAD   = { top: 10, right: 10, bottom: 28, left: 36 };

		const chartW = W - PAD.left - PAD.right;
		const chartH = H - PAD.top  - PAD.bottom;
		const n      = history.length;
		const barW   = chartW / n;
		const maxVal = Math.max(1, ...history.map(d => d.correct + d.incorrect));

		let bars  = '';
		let labels = '';
		let yLines = '';

		// Y-axis grid lines (4 lines)
		const ySteps = [0.25, 0.5, 0.75, 1.0];
		ySteps.forEach(frac => {
			const y = PAD.top + chartH - Math.round(frac * chartH);
			const v = Math.round(frac * maxVal);
			yLines += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}"
                             stroke="#e0e0e0" stroke-width="1"/>`;
			yLines += `<text x="${PAD.left - 4}" y="${y + 4}" text-anchor="end"
                             font-size="9" fill="#aaa">${v}</text>`;
		});

		history.forEach((d, i) => {
			const x   = PAD.left + i * barW;
			const tot = d.correct + d.incorrect;

			// Incorrect (red) drawn first (bottom of the bar)
			if (d.incorrect > 0) {
				const bh = Math.max(1, Math.round((d.incorrect / maxVal) * chartH));
				bars += `<rect x="${x + 1}" y="${PAD.top + chartH - bh}"
                               width="${barW - 2}" height="${bh}"
                               fill="#e53935" opacity="0.85" rx="1"/>`;
			}
			// Correct (green) stacked on top
			if (d.correct > 0) {
				const chBase = Math.round((d.incorrect / maxVal) * chartH);
				const ch     = Math.max(1, Math.round((d.correct / maxVal) * chartH));
				bars += `<rect x="${x + 1}" y="${PAD.top + chartH - chBase - ch}"
                               width="${barW - 2}" height="${ch}"
                               fill="#43a047" opacity="0.85" rx="1"/>`;
			}

			// X-axis label every LABEL days
			if (i % LABEL === 0 || i === n - 1) {
				const lx  = x + barW / 2;
				const ly  = H - PAD.bottom + 14;
				const lbl = d.date.slice(5); // 'MM-DD'
				labels += `<text x="${lx}" y="${ly}" text-anchor="middle"
                                 font-size="9" fill="#888">${lbl}</text>`;
			}
		});

		// Axis lines
		const axisX = `<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + chartH}"
                              stroke="#bbb" stroke-width="1"/>`;
		const axisY = `<line x1="${PAD.left}" y1="${PAD.top + chartH}" x2="${PAD.left + chartW}" y2="${PAD.top + chartH}"
                              stroke="#bbb" stroke-width="1"/>`;

		// Legend
		const legend =
			`<rect x="${PAD.left}" y="${H - 10}" width="8" height="8" fill="#43a047"/>` +
			`<text x="${PAD.left + 11}" y="${H - 2}" font-size="9" fill="#555">Correct</text>` +
			`<rect x="${PAD.left + 60}" y="${H - 10}" width="8" height="8" fill="#e53935"/>` +
			`<text x="${PAD.left + 73}" y="${H - 2}" font-size="9" fill="#555">Incorrect</text>`;

		return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"
                     style="font-family:sans-serif; display:block; max-width:100%;">
                    ${yLines}
                    ${axisX}${axisY}
                    ${bars}
                    ${labels}
                    ${legend}
                </svg>`;
	}

	/**
	 * Build an SVG bar chart of Woodpecker cycle times.
	 *
	 * @param {Array} history  Array of completed cycle records
	 * @param {Object} [opts]
	 *   opts.width   (default 400)
	 *   opts.height  (default 120)
	 * @returns {string}  SVG markup string
	 */
	function buildWoodpeckerChart(history, opts = {}) {
		if (!history || history.length === 0) return '';

		const W   = opts.width  || 400;
		const H   = opts.height || 120;
		const PAD = { top: 10, right: 10, bottom: 30, left: 42 };

		const chartW = W - PAD.left - PAD.right;
		const chartH = H - PAD.top  - PAD.bottom;
		const n      = history.length;
		const barW   = Math.max(8, Math.floor((chartW - n * 2) / n));
		const maxMs  = Math.max(...history.map(c => c.totalMs));

		let bars = '';
		let labels = '';
		let yLines = '';

		// Y-axis grid (3 lines)
		[0.5, 1.0].forEach(frac => {
			const y   = PAD.top + chartH - Math.round(frac * chartH);
			const ms  = Math.round(frac * maxMs);
			const lbl = msToHMSShort(ms);
			yLines += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}"
                             stroke="#e0e0e0" stroke-width="1"/>`;
			yLines += `<text x="${PAD.left - 4}" y="${y + 4}" text-anchor="end"
                             font-size="9" fill="#aaa">${lbl}</text>`;
		});

		history.forEach((c, i) => {
			const bh    = Math.max(2, Math.round((c.totalMs / maxMs) * chartH));
			const x     = PAD.left + i * (barW + 2);
			const y     = PAD.top + chartH - bh;
			const isFirst = i === 0;
			const faster  = !isFirst && c.totalMs < history[i - 1].totalMs;
			const color   = isFirst ? '#90a4ae' : (faster ? '#4caf50' : '#e53935');

			bars   += `<rect x="${x}" y="${y}" width="${barW}" height="${bh}"
                             fill="${color}" rx="2"/>`;
			labels += `<text x="${x + barW / 2}" y="${H - PAD.bottom + 13}"
                             text-anchor="middle" font-size="9" fill="#888">${c.cycleNumber}</text>`;

			// Mistake count badge
			if (c.mistakeCount > 0) {
				bars += `<text x="${x + barW / 2}" y="${y - 3}"
                               text-anchor="middle" font-size="8" fill="#e53935">${c.mistakeCount}✕</text>`;
			}
		});

		const axisX = `<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + chartH}"
                              stroke="#bbb" stroke-width="1"/>`;
		const axisY = `<line x1="${PAD.left}" y1="${PAD.top + chartH}" x2="${PAD.left + chartW}" y2="${PAD.top + chartH}"
                              stroke="#bbb" stroke-width="1"/>`;

		const xLabel = `<text x="${PAD.left + chartW / 2}" y="${H}" text-anchor="middle"
                               font-size="9" fill="#888">Cycle →</text>`;

		// Legend
		const legend =
			`<rect x="${PAD.left}" y="${H - 10}" width="8" height="8" fill="#4caf50"/>` +
			`<text x="${PAD.left + 11}" y="${H - 2}" font-size="9" fill="#555">Faster</text>` +
			`<rect x="${PAD.left + 55}" y="${H - 10}" width="8" height="8" fill="#e53935"/>` +
			`<text x="${PAD.left + 68}" y="${H - 2}" font-size="9" fill="#555">Slower</text>`;

		return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"
                     style="font-family:sans-serif; display:block; max-width:100%;">
                    ${yLines}${axisX}${axisY}
                    ${bars}
                    ${labels}${xLabel}
                    ${legend}
                </svg>`;
	}

	/** Format ms as H:MM or MM:SS depending on magnitude */
	function msToHMSShort(ms) {
		const s = Math.floor(ms / 1000);
		if (s >= 3600) {
			const h = Math.floor(s / 3600);
			const m = Math.floor((s % 3600) / 60);
			return `${h}:${String(m).padStart(2,'0')}`;
		}
		const m   = Math.floor(s / 60);
		const sec = s % 60;
		return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
	}

	// =========================================================================
	// Public API
	// =========================================================================

	return {
		open,

		// SR cards
		srGetCards,
		srSaveCard,
		srSaveAllCards,
		srClearCards,

		// SR daily history
		srLogDay,
		srGetHistory,
		srGetHistoryAll,
		srGetPgnFiles,

		// Woodpecker current
		wpSaveCurrent,
		wpGetCurrent,
		wpClearCurrent,

		// Woodpecker history
		wpSaveCompletedCycle,
		wpGetCycleHistory,
		wpClearAll,

		// Session log
		saveSession,
		getSessions,

		// Export / import
		exportAll,
		importAll,

		// Migration
		migrateFromLocalStorage,

		// Graph renderers (pure functions — no DB access)
		buildRetentionGraph,
		buildWoodpeckerChart,

		// Expose store names for external use
		STORE
	};

})();

// Make available globally for non-module scripts
window.ChessDB = ChessDB;

