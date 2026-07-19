/*
 * Game Modes Module for Chess PGN Trainer
 * Implements various training modes
 *
 * Repetition mode logic is fully integrated here.
 * repetition-mode.js is no longer needed and should be deleted.
 *
 * Infinity Mode is now a full Spaced Repetition (SM-2) mode.
 */

// Game mode constants
const GAME_MODES = {
    STANDARD:   'standard',
    REPETITION: 'repetition',
    THREE:      'three',
    HASTE:      'haste',
    COUNTDOWN:  'countdown',
    SPEEDRUN:   'speedrun',
    INFINITY:   'infinity',
    WOODPECKER: 'woodpecker',
    BRUTAL: 'brutal'
};

// Game mode configurations
const MODE_CONFIGS = {
    [GAME_MODES.STANDARD]: {
        name: 'Standard Mode',
        description: 'Play puzzles sequentially from a PGN file',
        hasTimer: false, hasLives: false, hasHints: false, hasLevels: false
    },
    [GAME_MODES.REPETITION]: {
        name: 'Repetition Mode',
        description: 'Complete levels perfectly to unlock the next (20 puzzles per level)',
        hasTimer: false, hasLives: false, hasHints: false, hasLevels: true,
        puzzlesPerLevel: 20
    },
    [GAME_MODES.THREE]: {
        name: 'Three Mode',
        description: '3 minutes, 3 lives, 3 hints',
        hasTimer: true, hasLives: true, hasHints: true, hasLevels: false,
        timeLimit: 180, lives: 3, hints: 3
    },
    [GAME_MODES.HASTE]: {
        name: 'Haste Mode',
        description: 'Start with base time, gain/lose time on correct/incorrect moves',
        hasTimer: true, hasLives: false, hasHints: false, hasLevels: false,
        baseTime: 30, timeGain: 5, timeLoss: 10
    },
    [GAME_MODES.COUNTDOWN]: {
        name: 'Countdown Mode',
        description: 'Fixed total time to solve as many puzzles as possible',
        hasTimer: true, hasLives: false, hasHints: false, hasLevels: false,
        timeLimit: 600
    },
    [GAME_MODES.SPEEDRUN]: {
        name: 'Speedrun Mode',
        description: 'Complete all puzzles as fast as possible',
        hasTimer: true, hasLives: false, hasHints: false, hasLevels: false,
        isSpeedrun: true
    },
    [GAME_MODES.INFINITY]: {
        name: 'Spaced Repetition',
        description: 'Puzzles you struggle with appear more often. Progress is saved across sessions.',
        hasTimer: false, hasLives: false, hasHints: false, hasLevels: false
    },
    [GAME_MODES.WOODPECKER]: {
        name: 'Woodpecker',
        description: 'Complete the full set. Each cycle must be faster than the last.',
        hasTimer: true, hasLives: false, hasHints: false, hasLevels: false
    },
    [GAME_MODES.BRUTAL]: {
        name: 'Brutal Mode',
        description: 'Solve every puzzle in a row without a single mistake or 7-second timeout. Any failure resets your streak to zero.',
        hasTimer: false,
        hasLives: false,
        hasHints: false,
        hasLevels: false
    }
};

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

let currentGameMode = GAME_MODES.STANDARD;

let modeState = {
    timeRemaining:  0,
    livesRemaining: 0,
    hintsRemaining: 0,
    currentLevel:   1,
    levelProgress:  0,
    levelErrors:    0,
    totalSolved:    0,
    modeTimer:      null,
    isActive:       false
};

// Repetition-mode tracking
let repetitionSetStartIndex = 0;
let repetitionSetHadError   = false;

// Woodpecker mode tracking
let wpData = null;
let wpCurrentPgn = null;
const WP_STORAGE_PREFIX = 'wp_data_';

// ── Brutal Mode state ─────────────────────────────────────────────────────
let brutalStreakCount   = 0;    // consecutive correct puzzle solves since last reset
let brutalNumPuzzles   = 0;    // total puzzles in loaded PGN (set on onStartTest)
let brutalCleared      = false; // one-way latch: true once streak reaches brutalNumPuzzles
let brutalLapStartTime = 0;    // Date.now() when current lap started
let brutalLapTimes     = [];   // array of lap elapsed-ms values, oldest first
let brutalMoveTimer    = null;  // setTimeout handle for per-move 7-second clock
let brutalClockInterval = null; // setInterval handle for the running lap display

const BRUTAL_TIMEOUT_MS   = 7000;
const BRUTAL_HINT_DELAY_MS = 750;

// ---------------------------------------------------------------------------
// Helper: get the shared HUD container (works in both portrait & landscape)
// ---------------------------------------------------------------------------

/**
 * Returns the #mode-hud element which lives inside #mode-hud-anchor in index.html.
 * Falls back to the landscape sidebar container for backward compatibility.
 */
function getModeHudContainer() {
    // If the landscape board panel is visible (i.e., display != 'none'),
    // we are in landscape orientation. Use the dedicated anchor.
    const boardBg = document.getElementById('board_background');
    if (boardBg && window.getComputedStyle(boardBg).display !== 'none') {
        const anchor = document.getElementById('mode-hud-landscape');
        if (anchor) return anchor;
    }
    // Otherwise, we are in portrait. Fall back to the original container.
    return document.getElementById('mode-hud');
}

// ═══════════════════════════════════════════════════════════════════════════
//  BRUTAL MODE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Start (or restart) the 7-second per-move countdown.
 * Called on every puzzle load and every correct move.
 * When it fires: reset streak, then 750ms later show the hint button.
 */
function brutalStartMoveTimer() {
    brutalClearMoveTimer();
    brutalMoveTimer = setTimeout(() => {
        brutalOnTooSlow();
        setTimeout(() => brutalShowHintButton(), BRUTAL_HINT_DELAY_MS);
    }, BRUTAL_TIMEOUT_MS);
}

/**
 * Cancel the per-move countdown and hide the hint button.
 * Called on puzzle load, wrong move, and mode reset.
 */
function brutalClearMoveTimer() {
    if (brutalMoveTimer) {
        clearTimeout(brutalMoveTimer);
        brutalMoveTimer = null;
    }
    brutalHideHintButton();
}

/**
 * Called when the 7-second move timer fires.
 * Resets streak to zero. Hint button appears 750ms after this.
 */
function brutalOnTooSlow() {
    if (currentGameMode !== GAME_MODES.BRUTAL) return;
    brutalStreakCount = 0;
    brutalUpdateStreakDisplay();
    brutalUpdateProgressBar();
}

/**
 * Make the Brutal-Mode-specific hint button visible.
 * This is NOT the main #btn_hint_landscape / #btn_hint_portrait —
 * those stay hidden. Only #brutal-hint-btn is used.
 */
function brutalShowHintButton() {
    if (currentGameMode !== GAME_MODES.BRUTAL) return;
    const btn = document.getElementById('brutal-hint-btn');
    if (btn) btn.style.display = 'inline-block';
}

/** Hide the Brutal Mode hint button. */
function brutalHideHintButton() {
    const btn = document.getElementById('brutal-hint-btn');
    if (btn) btn.style.display = 'none';
}

/**
 * Called when the player clicks the Brutal Mode hint button.
 * Delegates to the existing showHint() in chess-pgn-trainer.js,
 * which sets error=true and counts the hint as an error.
 * Streak is already 0 at this point (reset on timeout).
 */
function brutalDoHint() {
    if (typeof showHint === 'function') showHint();
    // Mirror the hint text to the brutal hint button label since the
    // standard hint buttons are hidden in Brutal Mode
    const moveText = typeof moveHistory !== 'undefined' && typeof game !== 'undefined'
        ? moveHistory[game.history().length] : '?';
    const btn = document.getElementById('brutal-hint-btn');
    if (btn) btn.textContent = moveText;
    // Don't hide the button — leave the move visible until next puzzle loads
}

/**
 * Update the streak counter display in the HUD.
 */
function brutalUpdateStreakDisplay() {
    const el = document.getElementById('brutal-streak-display');
    if (el) el.textContent = brutalStreakCount + ' / ' + brutalNumPuzzles;
}

/**
 * Update the progress bar to reflect the current streak as a percentage.
 * On reset (streak=0): transition is disabled so the drop is instant.
 * On clear: bar turns green and freezes at 100%.
 */
function brutalUpdateProgressBar() {
    if (brutalNumPuzzles === 0) return;
    const pct = brutalCleared ? 100 : Math.floor(100 * brutalStreakCount / brutalNumPuzzles);
    const pctStr = pct + '%';
    const isReset = (brutalStreakCount === 0 && !brutalCleared);

    ['progressbar_landscape', 'progressbar_portrait'].forEach(id => {
        const bar = document.getElementById(id);
        if (!bar) return;
        bar.style.transition = isReset ? 'none' : 'width 0.3s ease';
        bar.style.width = pctStr;
        bar.style.backgroundColor = brutalCleared ? '#63F706' : '';
    });
}

/**
 * Build the Brutal Mode HUD and inject it into the mode HUD container.
 * Idempotent — does nothing if the HUD already exists.
 */
function brutalGetOrCreateHud() {
    const container = getModeHudContainer();
    let hud = document.getElementById('brutal-hud');

    if (hud && hud.parentNode !== container) {
        hud.remove();
        hud = null;
    }

    if (!hud) {
        hud = document.createElement('div');
        hud.id = 'brutal-hud';
        hud.style.cssText = 'width:100%; text-align:center; padding:4px 0 2px;';

        hud.innerHTML = `
            <div style="font-size:0.85rem; margin-bottom:3px;">
                Streak: <span id="brutal-streak-display"
                    style="font-weight:700; color:var(--lc-gold); font-variant-numeric:tabular-nums;">
                    0 / 0
                </span>
            </div>
            <div style="font-size:0.72rem; color:var(--lc-text-dim); margin-bottom:3px;">
                Lap: <span id="brutal-lap-clock" style="font-variant-numeric:tabular-nums;">0:00</span>
            </div>
            <button id="brutal-hint-btn"
                style="display:none; padding:4px 12px; font-size:0.78rem; cursor:pointer;
                       background:var(--lc-surface2); color:var(--lc-gold);
                       border:1px solid var(--lc-gold); border-radius:var(--lc-radius,4px);"
                onclick="brutalDoHint()">
                Show Hint
            </button>
            <div id="brutal-laps-list"
                style="font-size:0.72rem; color:var(--lc-text-dim); margin-top:4px; line-height:1.6;">
            </div>
        `;

        if (container) container.appendChild(hud);
    }
}

/** Remove the Brutal Mode HUD entirely (called on reset). */
function brutalRemoveHud() {
    const hud = document.getElementById('brutal-hud');
    if (hud) hud.remove();
}

/** Update the running lap clock display (called every 500ms). */
function brutalTickLapClock() {
    if (currentGameMode !== GAME_MODES.BRUTAL || !brutalLapStartTime) return;
    const elapsed = Date.now() - brutalLapStartTime;
    const s = Math.floor(elapsed / 1000);
    const m = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, '0');
    const el = document.getElementById('brutal-lap-clock');
    if (el) el.textContent = m + ':' + ss;
}

/** Start the 500ms interval that drives the lap clock display. */
function brutalStartLapClock() {
    if (brutalClockInterval) clearInterval(brutalClockInterval);
    brutalClockInterval = setInterval(brutalTickLapClock, 500);
}

/** Stop the lap clock interval. */
function brutalStopLapClock() {
    if (brutalClockInterval) {
        clearInterval(brutalClockInterval);
        brutalClockInterval = null;
    }
}

/**
 * Rebuild the list of completed lap times in the HUD.
 * Most recent lap is shown at the top.
 */
function brutalUpdateLapsList() {
    const el = document.getElementById('brutal-laps-list');
    if (!el || brutalLapTimes.length === 0) return;
    el.innerHTML = brutalLapTimes.slice().reverse().map(ms => {
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const ss = String(s % 60).padStart(2, '0');
        return `<div>${m}:${ss}</div>`;
    }).join('');
}

/**
 * Handle a completed lap (puzzle index wrapped back to 0).
 * Records the lap time, reshuffles the puzzle order (if randomize is on),
 * and guarantees the first puzzle of the new lap is not the same FEN as
 * the last puzzle of the completed lap.
 */
function brutalCompleteLap() {
    const lapMs = Date.now() - brutalLapStartTime;
    brutalLapTimes.push(lapMs);
    if (brutalLapTimes.length > 5) brutalLapTimes.shift();
    brutalLapStartTime = Date.now();
    brutalUpdateLapsList();

    if ($('#randomizeSet').is(':checked') && typeof puzzleset !== 'undefined' && puzzleset.length > 1) {
        const lastFen = puzzleset[PuzzleOrder[PuzzleOrder.length - 1]]?.FEN;
        let newOrder;
        let attempts = 0;
        do {
            newOrder = shuffle([...Array(puzzleset.length).keys()]);
            attempts++;
        } while (attempts < 10 && lastFen && puzzleset[newOrder[0]]?.FEN === lastFen);
        PuzzleOrder = newOrder;
    }
}

/**
 * Full reset of all Brutal Mode state.
 * Called from resetModeState() when entering or leaving Brutal Mode.
 */
function brutalReset() {
    brutalClearMoveTimer();
    brutalStopLapClock();
    brutalStreakCount   = 0;
    brutalNumPuzzles   = 0;
    brutalCleared      = false;
    brutalLapTimes     = [];
    brutalLapStartTime = 0;
    brutalRemoveHud();
    brutalUpdateProgressBar();
}

// ---------------------------------------------------------------------------
// ═══════════════════════════════════════════════════════════════════════════
//  SPACED REPETITION (SM-2) — Infinity Mode
// ═══════════════════════════════════════════════════════════════════════════

const SR_STORAGE_PREFIX  = 'sr_cards_';
let SR_INITIAL_EASE   = 2.5;
let SR_MIN_EASE       = 1.3;
let SR_REINSERT_AFTER  = 4;
const SR_PARAMS_KEY = 'sr_params';
const SR_HISTORY_KEY = 'sr_history';

let srCards                 = {};
let srCurrentPgnFile        = '';
let srCurrentPuzzleHadError = false;
let srQueue                 = [];
let srPendingRetry          = new Set();

// ── Persistence ─────────────────────────────────────────────────────────────

function srGetStorageKey() {
    return SR_STORAGE_PREFIX + srCurrentPgnFile;
}

function srLoadCards() {
    const raw = localStorage.getItem(srGetStorageKey());
    srCards = raw ? JSON.parse(raw) : {};
}

function srSaveCards() {
    localStorage.setItem(srGetStorageKey(), JSON.stringify(srCards));
    if (window.ChessDB && typeof ChessDB.srSaveAllCards === 'function' && srCurrentPgnFile) {
        ChessDB.srSaveAllCards(srCurrentPgnFile, srCards).catch(console.error);
    }
}

function srClearCards() {
    localStorage.removeItem(srGetStorageKey());
    srCards = {};
    if (window.ChessDB && typeof ChessDB.srClearCards === 'function' && srCurrentPgnFile) {
        ChessDB.srClearCards(srCurrentPgnFile).catch(console.error);
    }
}

// ── Card initialisation ──────────────────────────────────────────────────────

function srGetCard(puzzleIndex) {
    if (!srCards[puzzleIndex]) {
        srCards[puzzleIndex] = {
            index:       puzzleIndex,
            interval:    1,
            easeFactor:  SR_INITIAL_EASE,
            repetitions: 0,
            nextReview:  Date.now(),
            due:         true
        };
    }
    return srCards[puzzleIndex];
}

// ── SM-2 update ──────────────────────────────────────────────────────────────

function srApplySM2(card, quality) {
    card.easeFactor = Math.max(
        SR_MIN_EASE,
        card.easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
    );

    const msPerDay = 24 * 60 * 60 * 1000;

    if (quality < 3) {
        card.repetitions = 0;
        card.interval    = 1;
        card.nextReview  = Date.now() - 1;
        card.due         = true;
    } else {
        if (card.repetitions === 0)      card.interval = 1;
        else if (card.repetitions === 1) card.interval = 6;
        else card.interval = Math.round(card.interval * card.easeFactor);

        card.repetitions++;
        card.nextReview = Date.now() + card.interval * msPerDay;
        card.due        = false;
    }
}

// ── Initial queue builder ────────────────────────────────────────────────────

function srBuildInitialQueue(totalPuzzles) {
    const now    = Date.now();
    const due    = [];
    const fresh  = [];
    const future = [];

    for (let i = 0; i < totalPuzzles; i++) {
        const card = srCards[i];
        if (!card) {
            fresh.push(i);
        } else if (card.nextReview <= now) {
            due.push({ i, overdue: now - card.nextReview });
        } else {
            future.push({ i, nextReview: card.nextReview });
        }
    }

    due.sort((a, b) => b.overdue - a.overdue);
    future.sort((a, b) => a.nextReview - b.nextReview);

    return [
        ...due.map(x => x.i),
        ...fresh,
        ...future.map(x => x.i)
    ];
}

// ── Session initialisation ───────────────────────────────────────────────────

function srInitSession() {
    srCurrentPgnFile        = ($('#openPGN').val() || 'default').replace(/[^a-zA-Z0-9]/g, '_');
    srCurrentPuzzleHadError = false;
    srPendingRetry          = new Set();
    srLoadCards();

    srQueue     = srBuildInitialQueue(puzzleset.length);
    PuzzleOrder = srQueue;
    increment   = 0;
    srUpdateStatsDisplay();
}

// ── Per-puzzle hooks ─────────────────────────────────────────────────────────

function srOnPuzzleStart() {
    srCurrentPuzzleHadError = false;
}

function srOnError() {
    srCurrentPuzzleHadError = true;
}

function srOnPuzzleComplete() {
    const puzzleIndex  = srQueue[increment];
    const wasInRetry   = srPendingRetry.has(puzzleIndex);

    if (srCurrentPuzzleHadError) {
        srLogResult(0, 1);

        const card = srGetCard(puzzleIndex);
        card.nextReview = Date.now() - 1;
        card.due        = true;
        srSaveCards();

        srPendingRetry.add(puzzleIndex);

        const insertAt = Math.min(
            increment + SR_REINSERT_AFTER,
            srQueue.length
        );
        srQueue.splice(insertAt, 0, puzzleIndex);
        PuzzleOrder = srQueue;

        srCurrentPuzzleHadError = false;
        srUpdateStatsDisplay();
        return;
    }

    srLogResult(1, 0);

    const quality = wasInRetry ? 1 : 4;
    const card    = srGetCard(puzzleIndex);
    srApplySM2(card, quality);
    srSaveCards();

    srPendingRetry.delete(puzzleIndex);

    srCurrentPuzzleHadError = false;
    srUpdateStatsDisplay();
}

// ── Queue advance ─────────────────────────────────────────────────────────────

function srAdvance() {
    const nextIncrement = increment + 1;

    if (nextIncrement < srQueue.length) {
        return true;
    }

    const now       = Date.now();
    const hasPending = srPendingRetry.size > 0;
    const hasDueOrNew = [...Array(puzzleset.length).keys()].some(i => {
        if (srPendingRetry.has(i)) return false;
        const card = srCards[i];
        return !card || card.nextReview <= now;
    });

    if (!hasPending && !hasDueOrNew) {
        return false;
    }

    const retryList = [...srPendingRetry];
    const baseQueue = srBuildInitialQueue(puzzleset.length);
    const retrySet  = new Set(retryList);
    const remainder = baseQueue.filter(i => !retrySet.has(i));

    srQueue     = [...retryList, ...remainder];
    PuzzleOrder = srQueue;
    increment   = -1;
    return true;
}

// ── Stats display ─────────────────────────────────────────────────────────────

function srUpdateStatsDisplay() {
    const container = getModeHudContainer();
    let statsDiv = document.getElementById('sr-stats');

    if (statsDiv && statsDiv.parentNode !== container) {
        statsDiv.remove();
        statsDiv = null;
    }
    if (!statsDiv) {
        statsDiv = document.createElement('div');
        statsDiv.id = 'sr-stats';
        statsDiv.className = 'w3-container w3-center w3-margin-bottom w3-small';
        if (container) container.appendChild(statsDiv);
    }

    if (currentGameMode !== GAME_MODES.INFINITY) {
        statsDiv.style.display = 'none';
        return;
    }

    const now = Date.now();
    let due = srPendingRetry.size;
    let learned = 0;
    let newCount = 0;

    for (let i = 0; i < puzzleset.length; i++) {
        if (srPendingRetry.has(i)) continue;
        const card = srCards[i];
        if (!card)                        { newCount++; }
        else if (card.nextReview <= now)  { due++; }
        else if (card.repetitions > 0)    { learned++; }
        else                              { newCount++; }
    }

    statsDiv.innerHTML =
        `<span style="color:#c14a4a;">⏰ Due: ${due}</span> &nbsp;|&nbsp; ` +
        `<span style="color:#759900;">✓ Learned: ${learned}</span> &nbsp;|&nbsp; ` +
        `<span style="color:#3692e7;">★ New: ${newCount}</span>`;
    statsDiv.style.display = 'block';
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function initializeGameModes() {
    const select = document.getElementById('game-mode-select-manual');
    if (select) {
        select.addEventListener('change', handleModeChange);
    }
    srLoadParams();
    const srInitialEaseEl   = document.getElementById('sr-initial-ease');
    const srMinEaseEl       = document.getElementById('sr-min-ease');
    const srReinsertAfterEl = document.getElementById('sr-reinsert-after');
    if (srInitialEaseEl)   srInitialEaseEl.value   = SR_INITIAL_EASE;
    if (srMinEaseEl)       srMinEaseEl.value        = SR_MIN_EASE;
    if (srReinsertAfterEl) srReinsertAfterEl.value  = SR_REINSERT_AFTER;
    resetModeState();
}

// Relocate HUD on resize
window.addEventListener('resize', () => {
    // Throttled update
    if (window._hudResizeTimeout) clearTimeout(window._hudResizeTimeout);
    window._hudResizeTimeout = setTimeout(() => {
        if (typeof updateModeUI === 'function') updateModeUI();
        if (currentGameMode === GAME_MODES.BRUTAL) brutalGetOrCreateHud();
    }, 100);
});

// ---------------------------------------------------------------------------
// Mode switching
// ---------------------------------------------------------------------------

function handleModeChange(event) {
    setGameMode(event.target.value);
}

function setGameMode(mode) {
    if (modeState.isActive) {
        if (!confirm('Changing game mode will reset the current session. Continue?')) {
            const select = document.getElementById('game-mode-select-manual');
            if (select) select.value = currentGameMode;
            return;
        }
        stopModeTimer();
        resetGame();
    }

    currentGameMode = mode;
    const select = document.getElementById('game-mode-select-manual');
    if (select) select.value = mode;
    resetModeState();
    updateModeUI();
}

// ---------------------------------------------------------------------------
// State reset
// ---------------------------------------------------------------------------

function resetModeState() {
    const config = MODE_CONFIGS[currentGameMode];

    modeState = {
        timeRemaining:  config.timeLimit || config.baseTime || 0,
        livesRemaining: config.lives || 0,
        hintsRemaining: config.hints || 0,
        currentLevel:   1,
        levelProgress:  0,
        levelErrors:    0,
        totalSolved:    0,
        modeTimer:      null,
        isActive:       false
    };

    repetitionSetStartIndex = 0;
    repetitionSetHadError   = false;

    // Always clean up Brutal Mode resources regardless of which mode we're entering
    brutalReset();

    if (currentGameMode === GAME_MODES.WOODPECKER) {
        if (typeof puzzleset !== 'undefined' && puzzleset.length > 0) {
            const pgnName = ($('#openPGN').val() || 'default').replace(/[^a-zA-Z0-9]/g, '_');
            const resumeIndex = typeof wpCheckResume === 'function' ? wpCheckResume(pgnName, puzzleset.length) : 0;
            if (typeof wpStartCycle === 'function') {
                wpStartCycle(pgnName, puzzleset.length);
            }
            if (resumeIndex > 0) {
                increment = resumeIndex - 1;
            }
        }
    }

    updateModeUI();
}

// ---------------------------------------------------------------------------
// UI display helpers
// ---------------------------------------------------------------------------

function updateModeUI() {
    updateTimerDisplay();
    updateLivesDisplay();
    updateHintsDisplay();
    updateLevelDisplay();
    toggleModeElements(MODE_CONFIGS[currentGameMode]);
    srUpdateStatsDisplay();
    updateWpUI();
    const srRow = document.getElementById('sr-params-row');
    if (srRow) srRow.style.display = currentGameMode === GAME_MODES.INFINITY ? 'table-row' : 'none';

    // Show or hide the Brutal Mode HUD
    const brutalHud = document.getElementById('brutal-hud');
    if (brutalHud) {
        brutalHud.style.display = currentGameMode === GAME_MODES.BRUTAL ? 'block' : 'none';
    }
}

function updateTimerDisplay() {
    const config = MODE_CONFIGS[currentGameMode];
    const container = getModeHudContainer();

    let timerDiv = document.getElementById('mode-timer');

    if (config.hasTimer) {
        // Recreate if missing or in the wrong container
        if (timerDiv && timerDiv.parentNode !== container) {
            timerDiv.remove();
            timerDiv = null;
        }
        if (!timerDiv) {
            timerDiv = document.createElement('div');
            timerDiv.id = 'mode-timer';
            timerDiv.className = 'w3-container w3-center w3-margin-bottom';
            const label = document.createElement('div');
            label.className = 'mode-hud-label';
            const display = document.createElement('span');
            display.id = 'timer-display';
            display.className = 'w3-text-red w3-large';
            timerDiv.appendChild(label);
            timerDiv.appendChild(display);
            if (container) container.appendChild(timerDiv);
        }
        const label = timerDiv.querySelector('.mode-hud-label');
        if (label) {
            if (currentGameMode === GAME_MODES.SPEEDRUN)       label.textContent = 'Elapsed';
            else if (currentGameMode === GAME_MODES.HASTE)     label.textContent = 'Time';
            else if (currentGameMode === GAME_MODES.COUNTDOWN) label.textContent = 'Time Left';
            else                                                label.textContent = 'Time';
        }
        const display = document.getElementById('timer-display');
        if (display) display.textContent = formatTime(modeState.timeRemaining);
        timerDiv.style.display = 'block';
    } else if (timerDiv) {
        timerDiv.style.display = 'none';
    }
}

function updateLivesDisplay() {
    const config = MODE_CONFIGS[currentGameMode];
    const container = getModeHudContainer();

    let livesDiv = document.getElementById('mode-lives');

    if (config.hasLives) {
        if (livesDiv && livesDiv.parentNode !== container) {
            livesDiv.remove();
            livesDiv = null;
        }
        if (!livesDiv) {
            livesDiv = document.createElement('div');
            livesDiv.id = 'mode-lives';
            livesDiv.className = 'w3-container w3-center w3-margin-bottom';
            const label = document.createElement('div');
            label.className = 'mode-hud-label';
            label.textContent = 'Lives';
            const display = document.createElement('span');
            display.id = 'lives-display';
            display.className = 'w3-text-red w3-large';
            livesDiv.appendChild(label);
            livesDiv.appendChild(display);
            if (container) container.appendChild(livesDiv);
        }
        const display = document.getElementById('lives-display');
        if (display) display.textContent = '❤️'.repeat(modeState.livesRemaining);
        livesDiv.style.display = 'block';
    } else if (livesDiv) {
        livesDiv.style.display = 'none';
    }
}

function updateHintsDisplay() {
    const config = MODE_CONFIGS[currentGameMode];
    const container = getModeHudContainer();

    let hintsDiv = document.getElementById('mode-hints');

    if (config.hasHints) {
        if (hintsDiv && hintsDiv.parentNode !== container) {
            hintsDiv.remove();
            hintsDiv = null;
        }
        if (!hintsDiv) {
            hintsDiv = document.createElement('div');
            hintsDiv.id = 'mode-hints';
            hintsDiv.className = 'w3-container w3-center w3-margin-bottom';
            const label = document.createElement('div');
            label.className = 'mode-hud-label';
            label.textContent = 'Hints';
            const display = document.createElement('span');
            display.id = 'hints-display';
            display.className = 'w3-text-blue w3-large';
            hintsDiv.appendChild(label);
            hintsDiv.appendChild(display);
            if (container) container.appendChild(hintsDiv);
        }
        const display = document.getElementById('hints-display');
        if (display) display.textContent = '💡'.repeat(modeState.hintsRemaining);
        hintsDiv.style.display = 'block';
    } else if (hintsDiv) {
        hintsDiv.style.display = 'none';
    }
}

function updateLevelDisplay() {
    const config = MODE_CONFIGS[currentGameMode];
    const container = getModeHudContainer();

    let levelDiv = document.getElementById('mode-level');

    if (config.hasLevels) {
        if (levelDiv && levelDiv.parentNode !== container) {
            levelDiv.remove();
            levelDiv = null;
        }
        if (!levelDiv) {
            levelDiv = document.createElement('div');
            levelDiv.id = 'mode-level';
            levelDiv.className = 'w3-container w3-center w3-margin-bottom';
            const label = document.createElement('div');
            label.className = 'mode-hud-label';
            label.textContent = 'Level';
            const display = document.createElement('span');
            display.id = 'level-display';
            display.className = 'w3-text-green w3-large';
            levelDiv.appendChild(label);
            levelDiv.appendChild(display);
            if (container) container.appendChild(levelDiv);
        }
        const display = document.getElementById('level-display');
        if (display) {
            display.textContent =
                `${modeState.currentLevel} (${modeState.levelProgress}/${config.puzzlesPerLevel})`;
        }
        levelDiv.style.display = 'block';
    } else if (levelDiv) {
        levelDiv.style.display = 'none';
    }
}

function toggleModeElements(config) {
    ['#btn_hint_landscape', '#btn_hint_portrait'].forEach(selector => {
        const button = document.querySelector(selector);
        if (!button) return;
        if (config.hasHints) {
            button.style.display = 'block';
        } else if (currentGameMode !== GAME_MODES.STANDARD) {
            button.style.display = 'none';
        }
    });
    const srBtn = document.getElementById('btn_sr_dashboard');
    if (srBtn) srBtn.style.display = currentGameMode === GAME_MODES.INFINITY ? 'block' : 'none';
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

function startModeTimer() {
    const config = MODE_CONFIGS[currentGameMode];
    if (!config.hasTimer) return;
    stopModeTimer();
    modeState.isActive = true;
    if (config.isSpeedrun) {
        modeState.timeRemaining = 0;
        modeState.modeTimer = setInterval(() => {
            modeState.timeRemaining++;
            updateTimerDisplay();
        }, 1000);
    } else {
        modeState.modeTimer = setInterval(() => {
            modeState.timeRemaining--;
            updateTimerDisplay();
            if (modeState.timeRemaining <= 0) handleTimeUp();
        }, 1000);
    }
}

function stopModeTimer() {
    brutalClearMoveTimer();
    brutalStopLapClock();
    if (modeState.modeTimer) {
        clearInterval(modeState.modeTimer);
        modeState.modeTimer = null;
    }
    modeState.isActive = false;
}

function handleTimeUp() {
    stopModeTimer();
    if      (currentGameMode === GAME_MODES.THREE)     endGameSession('Time\'s up! Session ended.');
    else if (currentGameMode === GAME_MODES.HASTE)     endGameSession('Time ran out! Session ended.');
    else if (currentGameMode === GAME_MODES.COUNTDOWN) endGameSession(`Time's up! You solved ${modeState.totalSolved} puzzles.`);
}

// ---------------------------------------------------------------------------
// Move & puzzle event hooks
// ---------------------------------------------------------------------------

function handleCorrectMove() {
    if (currentGameMode === GAME_MODES.BRUTAL) {
        // Restart the per-move timer on every correct move
        brutalStartMoveTimer();
        return;
    }
    if (currentGameMode === GAME_MODES.REPETITION) return;
    if (currentGameMode === GAME_MODES.INFINITY)   return;

    modeState.totalSolved++;
    if (currentGameMode === GAME_MODES.HASTE) {
        modeState.timeRemaining += MODE_CONFIGS[currentGameMode].timeGain;
        updateTimerDisplay();
    }
}

function handleIncorrectMove() {
    if (currentGameMode === GAME_MODES.REPETITION) {
        repetitionSetHadError = true;
        return;
    }
    if (currentGameMode === GAME_MODES.WOODPECKER) {
        if (wpData && wpData.currentCycle && typeof getCurrentPuzzleIndex === 'function') {
            const idx = getCurrentPuzzleIndex();
            wpRecordMistake(idx);
        }
        return;
    }
    if (currentGameMode === GAME_MODES.INFINITY) {
        srOnError();
        return;
    }
    if (currentGameMode === GAME_MODES.BRUTAL) {
        brutalStreakCount = 0;
        brutalClearMoveTimer();
        brutalUpdateStreakDisplay();
        brutalUpdateProgressBar();
        return;
    }
    if (currentGameMode === GAME_MODES.THREE) {
        modeState.livesRemaining--;
        updateLivesDisplay();
        if (modeState.livesRemaining <= 0) endGameSession('No lives remaining! Session ended.');
    } else if (currentGameMode === GAME_MODES.HASTE) {
        modeState.timeRemaining -= MODE_CONFIGS[currentGameMode].timeLoss;
        if (modeState.timeRemaining < 0) modeState.timeRemaining = 0;
        updateTimerDisplay();
        if (modeState.timeRemaining <= 0) handleTimeUp();
    }
}

function handlePuzzleComplete() {
    if (currentGameMode === GAME_MODES.REPETITION) {
        if (!repetitionSetHadError) {
            modeState.levelProgress++;
        }
        updateLevelDisplay();
        return;
    }

    if (currentGameMode === GAME_MODES.INFINITY) {
        srOnPuzzleComplete();
        return;
    }
    if (currentGameMode === GAME_MODES.BRUTAL) {
        brutalClearMoveTimer();

        // `error` is a global in chess-pgn-trainer.js — true if any wrong move
        // was made on this puzzle. Only increment streak on a clean solve.
        if (typeof error !== 'undefined' && !error) {
            brutalStreakCount++;
        }

        brutalUpdateStreakDisplay();
        brutalUpdateProgressBar();

        // First-time clear: latch the flag and freeze the bar green
        if (!brutalCleared && brutalNumPuzzles > 0 && brutalStreakCount >= brutalNumPuzzles) {
            brutalCleared = true;
            brutalUpdateProgressBar();
            // Show cleared indicator in the streak display itself, not the puzzle name
            const streakEl = document.getElementById('brutal-streak-display');
            if (streakEl) streakEl.innerHTML = '💀 <strong>CLEARED</strong>';

            // Trigger the celebration toast
            const toast = document.getElementById('brutal-cleared-toast');
            if (toast) {
                toast.classList.add('show');
                setTimeout(() => {
                    toast.classList.remove('show');
                }, 3000);
            }
        }
        return;
    }
}

function handleHintUsed() {
    if (currentGameMode === GAME_MODES.BRUTAL) {
        // Hint in Brutal Mode is triggered by brutalDoHint(), not this hook.
        // brutalDoHint() calls showHint() directly. Nothing to do here.
        return;
    }
    if (currentGameMode === GAME_MODES.INFINITY) {
        srOnError();
    }
    if (MODE_CONFIGS[currentGameMode].hasHints) {
        modeState.hintsRemaining--;
        updateHintsDisplay();
        if (modeState.hintsRemaining <= 0) {
            ['#btn_hint_landscape', '#btn_hint_portrait'].forEach(s => {
                const b = document.querySelector(s);
                if (b) b.disabled = true;
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Puzzle start notification
// ---------------------------------------------------------------------------

function handlePuzzleStart() {
    if (currentGameMode === GAME_MODES.BRUTAL) {
        brutalClearMoveTimer();
        brutalStartMoveTimer();
        brutalGetOrCreateHud();
        brutalUpdateStreakDisplay();
        return;
    }
    if (currentGameMode === GAME_MODES.INFINITY) {
        srOnPuzzleStart();
    }

    if (currentGameMode === GAME_MODES.WOODPECKER && typeof wpUpdateLastPuzzleIndex === 'function') {
        const idx = typeof getCurrentPuzzleIndex === 'function'
            ? getCurrentPuzzleIndex()
            : (typeof PuzzleOrder !== 'undefined' && PuzzleOrder.length > 0 ? PuzzleOrder[increment] : increment);
        if (typeof idx === 'number') {
            wpUpdateLastPuzzleIndex(idx);
            updateWpUI();
        }
    }
}

// ---------------------------------------------------------------------------
// Puzzle advancement
// ---------------------------------------------------------------------------

function shouldContinueToNextPuzzle() {
    if (currentGameMode === GAME_MODES.BRUTAL) {
        const nextIncrement = increment + 1;
        if (nextIncrement >= puzzleset.length) {
            // The puzzle index is about to wrap — record the lap,
            // then reset increment to -1 so chess-pgn-trainer.js sets it to 0.
            brutalCompleteLap();
            increment = -1;
        }
        return true; // loop never ends
    }

    if (currentGameMode === GAME_MODES.WOODPECKER) {
        return increment + 1 < puzzleset.length;
    }

    if (currentGameMode === GAME_MODES.INFINITY) {
        const hasMore = srAdvance();
        if (!hasMore) {
            setTimeout(() => {
                alert('Session complete! All due puzzles have been solved. Come back tomorrow for your next review.');
            }, 50);
        }
        return hasMore;
    }

    if (currentGameMode === GAME_MODES.REPETITION) {
        const config = MODE_CONFIGS[GAME_MODES.REPETITION];
        const puzzlesCompletedInSet = (increment - repetitionSetStartIndex) + 1;

        if (puzzlesCompletedInSet < config.puzzlesPerLevel) {
            repetitionSetHadError = false;
            return true;
        }

        const setWasClean = !repetitionSetHadError &&
                            modeState.levelProgress >= config.puzzlesPerLevel;
        repetitionSetHadError = false;

        if (setWasClean) {
            modeState.currentLevel++;
            modeState.levelProgress  = 0;
            repetitionSetStartIndex  = increment + 1;
            updateLevelDisplay();
            alert(`Level ${modeState.currentLevel - 1} complete! Starting Level ${modeState.currentLevel}.`);
            return true;
        } else {
            modeState.levelProgress = 0;
            increment = repetitionSetStartIndex - 1;
            updateLevelDisplay();
            alert(`Set not clean. Restarting Level ${modeState.currentLevel}.`);
            return true;
        }
    }

    if (typeof isMistakeReviewActive !== 'undefined' && isMistakeReviewActive) {
        const total = (typeof PuzzleOrder !== 'undefined' && Array.isArray(PuzzleOrder))
            ? PuzzleOrder.length
            : puzzleset.length;
        return increment + 1 < total;
    }

    return increment + 1 < puzzleset.length;
}

// ---------------------------------------------------------------------------
// Hook called by startTest()
// ---------------------------------------------------------------------------

function onStartTest() {
    if (currentGameMode === GAME_MODES.INFINITY) {
        srInitSession();
    }
    if (currentGameMode === GAME_MODES.BRUTAL) {
        brutalStreakCount   = 0;
        brutalNumPuzzles   = puzzleset.length;
        brutalCleared      = false;
        brutalLapTimes     = [];
        brutalLapStartTime = Date.now();
        modeState.isActive = true;
        brutalGetOrCreateHud();
        brutalUpdateStreakDisplay();
        brutalUpdateProgressBar();
        brutalStartLapClock();
    }
}

// ---------------------------------------------------------------------------
// Session end
// ---------------------------------------------------------------------------

function endGameSession(message) {
    stopModeTimer();
    setTimeout(() => {
        alert(message);
        if (typeof showresults === 'function') showresults();
    }, 100);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatTime(seconds) {
    const mins = Math.floor(Math.abs(seconds) / 60);
    const secs = Math.abs(seconds) % 60;
    const sign = seconds < 0 ? '-' : '';
    return `${sign}${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function getCurrentGameMode() { return currentGameMode; }
function getModeState()       { return modeState; }
function isHintAvailable()    { return !MODE_CONFIGS[currentGameMode].hasHints || modeState.hintsRemaining > 0; }

function getCurrentPuzzleIndex() {
    if (typeof PuzzleOrder !== 'undefined' && Array.isArray(PuzzleOrder) &&
        typeof increment !== 'undefined') {
        const idx = PuzzleOrder[increment];
        if (typeof idx === 'number') return idx;
    }
    return typeof increment === 'number' ? increment : 0;
}

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        GAME_MODES, MODE_CONFIGS,
        initializeGameModes, setGameMode,
        getCurrentGameMode, getModeState,
        startModeTimer, stopModeTimer,
        handleCorrectMove, handleIncorrectMove,
        handlePuzzleComplete, handlePuzzleStart, handleHintUsed,
        isHintAvailable, shouldContinueToNextPuzzle,
        onStartTest, resetModeState, updateModeUI,
        srClearCards,
        brutalReset,
        brutalDoHint,
        brutalUpdateProgressBar,
        brutalUpdateStreakDisplay
    };
}

// ── SR Parameter Management ──────────────────────────────────────────────────

function srLoadParams() {
    const raw = localStorage.getItem(SR_PARAMS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.initialEase)   SR_INITIAL_EASE   = p.initialEase;
    if (p.minEase)       SR_MIN_EASE       = p.minEase;
    if (p.reinsertAfter) SR_REINSERT_AFTER = p.reinsertAfter;
}

function srSaveParams() {
    localStorage.setItem(SR_PARAMS_KEY, JSON.stringify({
        initialEase: SR_INITIAL_EASE, minEase: SR_MIN_EASE, reinsertAfter: SR_REINSERT_AFTER
    }));
}

function srUpdateParam(param, value) {
    const v = parseFloat(value);
    if (isNaN(v)) return;
    if (param === 'initialEase')   SR_INITIAL_EASE   = Math.max(1.3, Math.min(3.5, v));
    if (param === 'minEase')       SR_MIN_EASE       = Math.max(1.0, Math.min(2.0, v));
    if (param === 'reinsertAfter') SR_REINSERT_AFTER = Math.max(1,   Math.min(10, Math.round(v)));
    srSaveParams();
}

// ── SR Dashboard & Export/Import ──────────────────────────────────────────────

function showSRDashboard() {
    const tbody = document.getElementById('sr-dashboard-tbody');
    const summary = document.getElementById('sr-dashboard-summary');
    if (!tbody) return;
    tbody.innerHTML = '';
    const now = Date.now(), msPerDay = 86400000;
    let totalNew = 0, totalDue = 0, totalLearned = 0;

    for (let i = 0; i < puzzleset.length; i++) {
        const card = srCards[i];
        const name = (puzzleset[i] && puzzleset[i].Event) || `Puzzle ${i + 1}`;
        let reps = '—', interval = '—', ease = '—', nextReview = 'New', status = '★ New';

        if (card) {
            reps = card.repetitions;
            interval = `${card.interval}d`;
            ease = card.easeFactor.toFixed(2);
            const daysUntil = Math.round((card.nextReview - now) / msPerDay);
            if (daysUntil <= 0) { nextReview = 'Due now'; status = '⏰ Due'; totalDue++; }
            else if (daysUntil === 1) { nextReview = 'Tomorrow'; status = '✓'; totalLearned++; }
            else { nextReview = `In ${daysUntil}d`; status = '✓'; totalLearned++; }
        } else { totalNew++; }

        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${i+1}</td><td>${name}</td><td>${reps}</td>
                        <td>${interval}</td><td>${ease}</td><td>${nextReview}</td><td>${status}</td>`;
        tbody.appendChild(tr);
    }

    summary.innerHTML =
        `<span class="w3-tag w3-red w3-round">⏰ Due: ${totalDue}</span> &nbsp;` +
        `<span class="w3-tag w3-green w3-round">✓ Learned: ${totalLearned}</span> &nbsp;` +
        `<span class="w3-tag w3-blue w3-round">★ New: ${totalNew}</span>`;

    const graphDiv = document.getElementById('sr-retention-graph');
    if (graphDiv) graphDiv.innerHTML = srBuildSparkline();

    document.getElementById('modal_sr_dashboard').style.display = 'block';
}

function srExportJSON() {
    const data = { exportDate: new Date().toISOString(), pgnFile: srCurrentPgnFile, cards: srCards };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `sr-backup-${srCurrentPgnFile}-${new Date().toJSON().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
}

function srExportCSV() {
    const now = Date.now(), msPerDay = 86400000;
    const rows = [['Index','Puzzle','Repetitions','Interval (days)','Ease Factor','Next Review','Days Until Review']];
    for (let i = 0; i < puzzleset.length; i++) {
        const card = srCards[i];
        const name = (puzzleset[i] && puzzleset[i].Event) || `Puzzle ${i+1}`;
        if (card) {
            rows.push([i+1, name, card.repetitions, card.interval, card.easeFactor.toFixed(2),
                       new Date(card.nextReview).toLocaleDateString(),
                       Math.round((card.nextReview - now) / msPerDay)]);
        } else {
            rows.push([i+1, name, 0, '—', '—', 'New', '—']);
        }
    }
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `sr-data-${srCurrentPgnFile}-${new Date().toJSON().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
}

function srImportJSON() { document.getElementById('sr-import-input').click(); }

function srHandleImport(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (data.cards) {
                srCards = data.cards;
                srSaveCards();
                alert('SR data imported. Restart session to apply.');
                showSRDashboard();
            } else { alert('Invalid SR backup file.'); }
        } catch (err) { alert('Parse error: ' + err.message); }
    };
    reader.readAsText(file);
    input.value = '';
}

function srBuildSparkline() {
    const raw = localStorage.getItem(SR_HISTORY_KEY);
    const history = raw ? JSON.parse(raw) : {};
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toJSON().slice(0, 10);
        days.push({ label: key.slice(5), ...(history[key] || { correct: 0, incorrect: 0 }) });
    }
    const W = 280, H = 80, pad = 20;
    const maxVal = Math.max(1, ...days.map(d => d.correct + d.incorrect));
    const barW = (W - pad * 2) / days.length;
    let svg = `<svg width="${W}" height="${H + 20}" xmlns="http://www.w3.org/2000/svg" style="font-family:sans-serif;font-size:10px">`;
    days.forEach((d, i) => {
        const x = pad + i * barW;
        const cH = (d.correct / maxVal) * H;
        const eH = (d.incorrect / maxVal) * H;
        const tH = cH + eH;
        if (eH > 0) svg += `<rect x="${x+1}" y="${H-tH}" width="${barW-2}" height="${eH}" fill="#c14a4a" opacity="0.8"/>`;
        if (cH > 0) svg += `<rect x="${x+1}" y="${H-tH+eH}" width="${barW-2}" height="${cH}" fill="#759900" opacity="0.8"/>`;
        svg += `<text x="${x+barW/2}" y="${H+14}" text-anchor="middle" fill="#7c7c7c">${d.label}</text>`;
    });
    svg += `<line x1="${pad}" y1="${H}" x2="${W-pad}" y2="${H}" stroke="#4a4846" stroke-width="1"/>`;
    svg += `</svg>`;
    return svg;
}

function srLogResult(correct, incorrect) {
    const today = new Date().toJSON().slice(0, 10);
    const raw = localStorage.getItem(SR_HISTORY_KEY);
    const history = raw ? JSON.parse(raw) : {};
    if (!history[today]) history[today] = { correct: 0, incorrect: 0 };
    history[today].correct   += correct;
    history[today].incorrect += incorrect;
    localStorage.setItem(SR_HISTORY_KEY, JSON.stringify(history));

    if (window.ChessDB && typeof ChessDB.srLogDay === 'function') {
        const pgnKey = srCurrentPgnFile || 'legacy';
        ChessDB.srLogDay(pgnKey, today, correct, incorrect).catch(console.error);
    }
}

// ---------------------------------------------------------------------------
// WOODPECKER METHOD MODE
// ---------------------------------------------------------------------------

function wpStorageKey(pgnName) { return WP_STORAGE_PREFIX + pgnName; }

function wpLoad(pgnName) {
    wpCurrentPgn = pgnName;
    const raw = localStorage.getItem(wpStorageKey(pgnName));
    wpData = raw ? JSON.parse(raw) : { cycleHistory: [], currentCycle: null };
    return wpData;
}

function wpSave() {
    if (!wpCurrentPgn) return;
    localStorage.setItem(wpStorageKey(wpCurrentPgn), JSON.stringify(wpData));
    if (window.ChessDB) {
        const pgnKey = wpCurrentPgn;
        try {
            if (wpData && wpData.currentCycle && typeof ChessDB.wpSaveCurrent === 'function') {
                ChessDB.wpSaveCurrent(pgnKey, wpData.currentCycle).catch(console.error);
            }
            if (wpData && Array.isArray(wpData.cycleHistory) && typeof ChessDB.wpSaveCompletedCycle === 'function') {
                wpData.cycleHistory.forEach(cycle => {
                    ChessDB.wpSaveCompletedCycle(pgnKey, cycle).catch(console.error);
                });
            }
        } catch (e) { console.error('[Woodpecker] Failed to mirror data to IndexedDB', e); }
    }
}

function wpGetLastCycleMs() {
    if (!wpData || wpData.cycleHistory.length === 0) return null;
    return wpData.cycleHistory[wpData.cycleHistory.length - 1].totalMs;
}

function wpGetCycleNumber() {
    if (!wpData) return 1;
    return wpData.cycleHistory.length + 1;
}

function wpStartCycle(pgnName, puzzleCount) {
    wpLoad(pgnName);
    if (!wpData.currentCycle) {
        wpData.currentCycle = {
            cycleNumber: wpGetCycleNumber(),
            startedAt: Date.now(),
            puzzleCount: puzzleCount,
            mistakesThisCycle: [],
            lastPuzzleIndex: 0
        };
        wpSave();
    }
    updateWpUI();
}

function wpRecordMistake(puzzleIndex) {
    if (!wpData || !wpData.currentCycle) return;
    if (!wpData.currentCycle.mistakesThisCycle.includes(puzzleIndex)) {
        wpData.currentCycle.mistakesThisCycle.push(puzzleIndex);
        wpSave();
    }
}

function wpUpdateLastPuzzleIndex(index) {
    if (!wpData || !wpData.currentCycle) return;
    wpData.currentCycle.lastPuzzleIndex = index;
    wpSave();
}

function wpCompleteCycle() {
    if (!wpData || !wpData.currentCycle) return null;
    const elapsed = Date.now() - wpData.currentCycle.startedAt;
    const completedCycle = {
        cycleNumber: wpData.currentCycle.cycleNumber,
        totalMs: elapsed,
        puzzleCount: wpData.currentCycle.puzzleCount,
        mistakeCount: wpData.currentCycle.mistakesThisCycle.length,
        completedAt: new Date().toISOString().split('T')[0],
        mistakeIndexes: wpData.currentCycle.mistakesThisCycle
    };
    wpData.cycleHistory.push(completedCycle);
    wpData.currentCycle = null;
    wpSave();

    if (window.ChessDB && typeof ChessDB.wpSaveCompletedCycle === 'function') {
        const pgnKey = wpCurrentPgn;
        ChessDB.wpSaveCompletedCycle(pgnKey, completedCycle)
            .then(() => { if (typeof ChessDB.wpClearCurrent === 'function') return ChessDB.wpClearCurrent(pgnKey); })
            .catch(console.error);
    }
    return completedCycle;
}

function wpCheckResume(pgnName, puzzleCount) {
    wpLoad(pgnName);
    if (wpData.currentCycle) {
        const elapsed = msToHMS(Date.now() - wpData.currentCycle.startedAt);
        const confirmed = confirm(
            `You have an in-progress Cycle ${wpData.currentCycle.cycleNumber} ` +
            `(elapsed: ${elapsed}, at puzzle ${wpData.currentCycle.lastPuzzleIndex + 1}/${puzzleCount}). Resume it?`
        );
        if (confirmed) return wpData.currentCycle.lastPuzzleIndex;
        else { wpData.currentCycle = null; wpSave(); }
    }
    return 0;
}

function msToHMS(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return [h, m, sec].map(v => String(v).padStart(2, '0')).join(':');
}

function updateWpUI() {
    const isWp = currentGameMode === GAME_MODES.WOODPECKER;
    const container = getModeHudContainer();
    let display = document.getElementById('wp-status-display');

    if (isWp) {
        if (display && display.parentNode !== container) {
            display.remove();
            display = null;
        }
        if (!display) {
            display = document.createElement('div');
            display.id = 'wp-status-display';
            display.className = 'w3-container w3-center w3-small w3-padding w3-margin-bottom';
            display.innerHTML = `
                <div>🪵 Cycle <strong id="wp-cycle-number">1</strong></div>
                <div id="wp-prev-time-row" style="display:none;">
                    Target: <strong id="wp-target-time">--:--:--</strong>
                </div>
                <div>Mistakes: <strong id="wp-mistake-count">0</strong></div>
            `;
            if (container) container.appendChild(display);
        }
        
        if (wpData) {
            const cycleEl = document.getElementById('wp-cycle-number');
            if (cycleEl) cycleEl.textContent = wpGetCycleNumber();

            const lastMs = wpGetLastCycleMs();
            const prevRow = document.getElementById('wp-prev-time-row');
            const targetEl = document.getElementById('wp-target-time');
            if (lastMs && prevRow && targetEl) {
                prevRow.style.display = 'block';
                targetEl.textContent = msToHMS(lastMs);
            }

            const mistakeEl = document.getElementById('wp-mistake-count');
            if (mistakeEl && wpData.currentCycle) {
                mistakeEl.textContent = wpData.currentCycle.mistakesThisCycle.length;
            }
        }
        display.style.display = 'block';
    } else if (display) {
        display.style.display = 'none';
    }
}

function wpBuildCycleChart(history) {
    if (!history || history.length === 0) return '';
    const W = 300, H = 80, pad = 4;
    const maxMs = Math.max(...history.map(c => c.totalMs));
    const barW = Math.floor((W - pad * (history.length + 1)) / history.length);

    const bars = history.map((c, i) => {
        const barH = Math.round((c.totalMs / maxMs) * (H - 20));
        const x = pad + i * (barW + pad);
        const y = H - barH - 16;
        const color = i === 0 ? '#888' : c.totalMs < history[i - 1].totalMs ? '#759900' : '#c14a4a';
        return `
            <rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${color}" rx="2"/>
            <text x="${x + barW / 2}" y="${H - 2}" text-anchor="middle"
                  font-size="9" fill="#7c7c7c">${c.cycleNumber}</text>
        `;
    }).join('');

    return `<svg width="${W}" height="${H}" style="display:block;margin:auto;">
        ${bars}
        <text x="${W/2}" y="${H}" text-anchor="middle" font-size="9" fill="#7c7c7c">Cycle</text>
    </svg>`;
}

function wpPopulateFlaggedList(mistakeIndexes) {
    const section = document.getElementById('wp-flagged-section');
    const list = document.getElementById('wp-flagged-list');
    if (!section || !list || !mistakeIndexes || mistakeIndexes.length === 0) {
        if (section) section.style.display = 'none';
        return;
    }
    section.style.display = 'block';
    list.innerHTML = mistakeIndexes.map(idx => {
        let name = `Puzzle ${idx + 1}`;
        if (typeof puzzleset !== 'undefined' && puzzleset[idx]) {
            const puzzle = puzzleset[idx];
            if (puzzle && puzzle.Event) {
                name = puzzle.Event.replace(/<br\s*\/?>/gi, ' ').replace(/<\/?[^>]+(>|$)/g, '');
            }
        }
        return `<li>${name}</li>`;
    }).join('');
}
