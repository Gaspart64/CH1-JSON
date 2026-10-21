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
    // ── Modes modelled on linrock/blitz-tactics ───────────────────────────────
    // Rules below follow that project's source (app/javascript/game_modes/*).
    [GAME_MODES.REPETITION]: {
        name: 'Repetition Mode',
        description: 'Solve every puzzle in the set in a row to clear it. A mistake resets your ' +
                     'progress (you stay on the puzzle); the set loops and reshuffles every lap. ' +
                     'No move timer. A hint button appears after 7 s and costs your progress.',
        hasTimer: false, hasLives: false, hasHints: false, hasLevels: false,
        // A "level" is the loaded set (blitz: one level = one fixed set of puzzles),
        // so there is no minimum size.
        idleHintMs: 7000,            // hint button after 7 s on a puzzle (blitz: comboDroppedAfterMs)
        breakStreakOnIdle: false     // ...but idling does NOT reset progress (that is Brutal)
    },
    [GAME_MODES.THREE]: {
        name: 'Three Mode',
        description: '3 minutes, 3 lives, 3 hints. A mistake costs a life and skips the puzzle; ' +
                     'every 3 puzzles in a row adds 3 seconds. Clock starts on your first move.',
        hasTimer: true, hasLives: true, hasHints: true, hasLevels: false,
        timeLimit: 180, lives: 3, hints: 3,
        startOnFirstMove: true,
        skipOnMistake: true,                  // blitz: a mistake costs a life AND moves on to the next puzzle
        halfHint: true,                       // blitz: a hint reveals only the from- OR to-square
        comboEvery: 3, comboBonus: 3,         // +3 s per 3 puzzles solved in a row
        showScore: true,
        randomOrder: true,                    // blitz: 100 fresh random puzzles every run
    },
    [GAME_MODES.HASTE]: {
        name: 'Haste Mode',
        description: 'Start with 3 minutes. Every 10 correct moves in a row gains time (7 s, +3 s more ' +
                     'for each further 10); every mistake loses 30 seconds.',
        hasTimer: true, hasLives: false, hasHints: false, hasLevels: false,
        baseTime: 180,
        comboEvery: 10, comboBonus: 7, comboBonusStep: 3,   // counted in correct MOVES, not puzzles
        penalty: 30,
        showScore: true,
        randomOrder: true,                    // blitz: new random puzzles every run
    },
    [GAME_MODES.COUNTDOWN]: {
        name: 'Countdown Mode',
        description: 'Solve as many puzzles as you can in 5 minutes. Every mistake loses 30 seconds. ' +
                     'Clock starts on your first move.',
        hasTimer: true, hasLives: false, hasHints: false, hasLevels: false,
        timeLimit: 300,
        startOnFirstMove: true,
        penalty: 30,
        showScore: true
    },
    [GAME_MODES.SPEEDRUN]: {
        name: 'Speedrun Mode',
        description: 'Complete all puzzles as fast as possible. Clock starts on your first move.',
        hasTimer: true, hasLives: false, hasHints: false, hasLevels: false,
        isSpeedrun: true,
        startOnFirstMove: true,
        idleHintMs: 7000,                     // blitz: the default 7 s hint button (no penalty in Speedrun)
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
        description: 'Repetition with a clock: solve every puzzle in a row without a single mistake or 7-second timeout. Any failure resets your streak to zero.',
        hasTimer: false,
        hasLives: false,
        hasHints: false,
        hasLevels: false,
        idleHintMs: 7000,
        breakStreakOnIdle: true      // blitz 'move:too_slow': 7 s without a move resets progress
    }
};

/** Modes that share the "chain the whole set without a mistake" engine (Repetition, Brutal). */
function isStreakMode() {
    return currentGameMode === GAME_MODES.REPETITION || currentGameMode === GAME_MODES.BRUTAL;
}

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
    isActive:       false,
    timerStartMs:   0,      // Date.now() when the clock started (0 = not started yet)
    timeAdjustMs:   0,      // accumulated combo bonuses (+) and mistake penalties (−)
    sessionOver:    false   // Three/Haste/Countdown: the round has ended
};

// Per-session mode tracking (Three / Haste / Countdown / Speedrun / Repetition / Brutal)
let modeFirstMoveSeen = false;  // has the player attempted a move yet this session?
let modeCombo         = 0;      // consecutive-success counter (puzzles for Three, moves for Haste)
let modePuzzlesSolved = 0;      // puzzles completed this session (the score in Three/Haste/Countdown)
let modeMovesTried    = 0;      // every attempted move (for accuracy)
let modeMovesCorrect  = 0;      // attempted moves that were right

const MODE_TICK_MS        = 100;   // clock resolution (blitz uses 33–100 ms)
const IDLE_HINT_DELAY_MS  = 750;   // blitz PuzzleHint: hint button shows this long after the 7 s mark

// Woodpecker mode tracking
let wpData = null;
let wpCurrentPgn = null;
let wpResumePosition = 0;      // puzzle position to continue from when a cycle is resumed
let wpAutoResume = false;      // set by "Continue last session": resume without asking
let wpSegmentStart = 0;        // start of the current stretch of active solving time
const WP_STORAGE_PREFIX = 'wp_data_';

// ── Streak engine state (Repetition + Brutal; names kept from the original Brutal code) ──
let brutalStreakCount   = 0;    // puzzles solved since the last failure (blitz: LevelStatus.puzzleCounter)
let brutalNumPuzzles   = 0;    // total puzzles in the loaded set (set on onStartTest)
let brutalCleared      = false; // one-way latch: true once streak reaches brutalNumPuzzles
let brutalLapStartTime = 0;    // Date.now() when current lap started (0 = waiting for the first move)
let brutalLapTimes     = [];   // array of lap elapsed-ms values, oldest first
let brutalClockInterval = null; // setInterval handle for the running lap display

// ── Idle-hint timers (Repetition, Brutal, Speedrun) ───────────────────────
let idleHintTimer     = null;   // fires after config.idleHintMs without a move
let idleHintShowTimer = null;   // fires IDLE_HINT_DELAY_MS later and reveals the hint button

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
//  IDLE HINT  (Repetition, Brutal, Speedrun)
//
//  linrock/blitz-tactics (components/puzzle_player/views/puzzle_hint.ts):
//  after 7 s with no move on a puzzle a hint button appears (750 ms later).
//  The timer restarts on every move made on the board (the player's or the
//  opponent's reply) and on every new puzzle. A wrong move does NOT restart it.
//  In Repetition that same 7 s also fires 'move:too_slow', which resets level
//  progress — here that is Brutal (breakStreakOnIdle).
// ═══════════════════════════════════════════════════════════════════════════

/** (Re)start the 7-second idle clock. Called on every puzzle load and every move made on the board. */
function idleHintRestart() {
    idleHintClear();
    const config = MODE_CONFIGS[currentGameMode];
    if (!config || !config.idleHintMs) return;
    idleHintTimer = setTimeout(() => {
        idleHintTimer = null;
        if (config.breakStreakOnIdle) streakBreak();   // Brutal: too slow = failure
        idleHintShowTimer = setTimeout(() => {
            idleHintShowTimer = null;
            idleHintShow();
        }, IDLE_HINT_DELAY_MS);
    }, config.idleHintMs);
}

/** Cancel the idle clock and hide the hint button. */
function idleHintClear() {
    if (idleHintTimer)     { clearTimeout(idleHintTimer);     idleHintTimer = null; }
    if (idleHintShowTimer) { clearTimeout(idleHintShowTimer); idleHintShowTimer = null; }
    idleHintHide();
}

/**
 * Reveal the hint button. Streak modes use their own #brutal-hint-btn (the
 * standard hint buttons stay hidden there); Speedrun reuses the standard ones.
 */
function idleHintShow() {
    if (isStreakMode()) {
        const btn = document.getElementById('brutal-hint-btn');
        if (btn) btn.style.display = 'inline-block';
    } else if (currentGameMode === GAME_MODES.SPEEDRUN) {
        setSpeedrunHintButtons(true);
    }
}

function idleHintHide() {
    const btn = document.getElementById('brutal-hint-btn');
    if (btn) { btn.style.display = 'none'; btn.textContent = 'Show Hint'; }
    if (currentGameMode === GAME_MODES.SPEEDRUN) setSpeedrunHintButtons(false);
}

/** Speedrun only: show/hide the standard hint buttons (they are otherwise hidden in this mode). */
function setSpeedrunHintButtons(show) {
    ['#btn_hint_landscape', '#btn_hint_portrait'].forEach(selector => {
        const button = document.querySelector(selector);
        if (button) button.style.display = show ? 'block' : 'none';
    });
}

// ═══════════════════════════════════════════════════════════════════════════
//  STREAK ENGINE — Repetition and Brutal
//
//  blitz-tactics repetition (game_modes/repetition/index.ts + models/level_status.ts):
//   • PuzzlePlayer({ shuffle: true, loopPuzzles: true }) — the set loops forever and is
//     reshuffled at the end of every lap (the first puzzle of a new lap never equals the
//     last of the previous one).
//   • progress = puzzles solved since the last failure / number of puzzles in the level.
//     It is incremented every time a puzzle is solved — including the puzzle on which the
//     failure happened — and reset to 0 by a wrong move (and, in Brutal, by 7 s of idling).
//     A failure never moves you on: you stay on the same puzzle.
//   • progress == 100 % clears the level and unlocks the next one.
//   • a lap timer runs from the first move, and a time is recorded every lap.
// ═══════════════════════════════════════════════════════════════════════════

/** A failure: wrong move, (Brutal) idling 7 s, or using a hint. Progress goes back to zero. */
function streakBreak() {
    if (!isStreakMode()) return;
    brutalStreakCount = 0;
    brutalUpdateStreakDisplay();
    brutalUpdateProgressBar();
}

/**
 * Called when the player clicks the hint button in Repetition or Brutal Mode.
 * Delegates to the existing showHint() in chess-pgn-trainer.js, which counts the
 * hint as an error and calls handleHintUsed() — that is where the streak breaks
 * (in Brutal it is already 0, the 7 s timeout having fired).
 */
function brutalDoHint() {
    if (typeof showHint === 'function') showHint();
    // Mirror the hint text to the hint button label since the
    // standard hint buttons are hidden in the streak modes
    const moveText = typeof moveHistory !== 'undefined' && typeof game !== 'undefined'
        ? moveHistory[game.history().length] : '?';
    const btn = document.getElementById('brutal-hint-btn');
    if (btn) btn.textContent = moveText;
    // Don't hide the button — leave the move visible until the next move or puzzle
}

/**
 * A puzzle was solved. blitz-tactics counts it whether or not a mistake was made on it
 * (the mistake already reset progress to 0, so a puzzle solved after a mistake is the first
 * of the new run). Returns true the first time progress reaches 100 %.
 */
function streakOnPuzzleSolved() {
    brutalStreakCount++;
    brutalUpdateStreakDisplay();
    brutalUpdateProgressBar();

    if (!brutalCleared && brutalNumPuzzles > 0 && brutalStreakCount >= brutalNumPuzzles) {
        // First clear: latch it and freeze the bar green (blitz: LevelStatus.completed)
        brutalCleared = true;
        brutalUpdateProgressBar();
        const streakEl = document.getElementById('brutal-streak-display');
        if (streakEl) streakEl.innerHTML = '💀 <strong>CLEARED</strong>';
        streakAnnounceCleared();
        return true;
    }
    return false;
}

/**
 * "Level unlocked": a short banner, plus a button in the HUD that loads the next set
 * (blitz shows a link to the next level). The set keeps looping if the player stays.
 */
function streakAnnounceCleared() {
    try {
        const banner = document.createElement('div');
        banner.id = 'streak-cleared-banner';
        banner.textContent = currentGameMode === GAME_MODES.BRUTAL
            ? '💀 Set cleared!' : '✅ Set cleared!';
        banner.style.cssText = 'position:fixed; left:50%; top:12%; transform:translateX(-50%);' +
            'background:#2e7d32; color:#fff; padding:10px 22px; border-radius:8px;' +
            'font-weight:700; z-index:3000; box-shadow:0 4px 14px rgba(0,0,0,.35);';
        document.body.appendChild(banner);
        setTimeout(() => banner.remove(), 3000);
    } catch (e) { /* purely cosmetic */ }

    const rep = document.getElementById('streak-repeat-btn');
    if (rep) rep.style.display = 'inline-block';
    const btn = document.getElementById('streak-next-btn');
    if (btn && typeof getNextPuzzleSet === 'function') {
        const next = getNextPuzzleSet($('#openPGN').val());
        if (next) {
            btn.textContent = 'Next set ➜';
            btn.dataset.path = next.path;
            btn.style.display = 'inline-block';
        }
    }
}

/** HUD button: play the same file again from a clean slate. */
function streakRepeatSet() {
    if (typeof loadAndStartSet === 'function') loadAndStartSet($('#openPGN').val());
}

/** HUD button: continue to the next set in the same mode. */
function streakGoToNextSet() {
    const btn = document.getElementById('streak-next-btn');
    if (btn && btn.dataset.path && typeof loadAndStartSet === 'function') {
        loadAndStartSet(btn.dataset.path);
    }
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
            <button id="streak-next-btn" onclick="streakGoToNextSet()"
                style="display:none; margin:2px 0 4px; padding:4px 12px; font-size:0.78rem; cursor:pointer;
                       background:#2e7d32; color:#fff; border:none; border-radius:var(--lc-radius,4px);">
                Next set ➜
            </button>
            <button id="streak-repeat-btn" onclick="streakRepeatSet()"
                style="display:none; margin:2px 0 4px 4px; padding:4px 12px; font-size:0.78rem; cursor:pointer;
                       background:var(--lc-surface2); color:var(--lc-text); border:1px solid var(--lc-gold);
                       border-radius:var(--lc-radius,4px);">
                🔁 Repeat
            </button>
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
    if (!isStreakMode() || !brutalLapStartTime) return;
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
 * Records the lap time, ALWAYS reshuffles the puzzle order (blitz: shuffle + loopPuzzles —
 * the first lap follows the set's order, or the Randomize checkbox if ticked), and
 * guarantees the first puzzle of the new lap is not the same FEN as the last puzzle of
 * the completed lap.
 */
function brutalCompleteLap() {
    const now = Date.now();
    // The lap clock starts on the first move; a lap can only complete after one.
    const lapMs = brutalLapStartTime ? now - brutalLapStartTime : 0;
    brutalLapTimes.push(lapMs);
    if (brutalLapTimes.length > 5) brutalLapTimes.shift();
    brutalLapStartTime = now;
    brutalUpdateLapsList();

    if (typeof puzzleset !== 'undefined' && puzzleset.length > 1) {
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
 * Full reset of all streak-engine state (Repetition / Brutal) and the idle-hint clock.
 * Called from resetModeState() on every mode change and session start.
 */
function brutalReset() {
    idleHintClear();
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

/** Storage key for a set path (same sanitising the session has always used). */
function srPgnKey(path) {
    return (path || $('#openPGN').val() || 'default').replace(/[^a-zA-Z0-9]/g, '_');
}

/** How many cards are due / how many puzzles are new, for a card map and a puzzle count. */
function srCountDue(cards, total) {
    const now = Date.now();
    let due = 0, seen = 0;
    Object.keys(cards || {}).forEach(k => {
        if (+k >= total) return;
        seen++;
        if (cards[k].nextReview <= now) due++;
    });
    return { due, fresh: Math.max(0, total - seen), seen };
}

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

    for (let i = 0; i < totalPuzzles; i++) {
        const card = srCards[i];
        if (!card) {
            fresh.push(i);
        } else if (card.nextReview <= now) {
            due.push({ i, overdue: now - card.nextReview });
        }
        // cards that are not due yet are left alone: reviewing them early only distorts the schedule
    }

    due.sort((a, b) => b.overdue - a.overdue);

    return [
        ...due.map(x => x.i),
        ...fresh
    ];
}

// ── Session initialisation ───────────────────────────────────────────────────

function srInitSession() {
    srCurrentPgnFile        = srPgnKey();
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
    modeRestoreFromDb();
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
        if (isStreakMode()) brutalGetOrCreateHud();
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
        isActive:       false,
        timerStartMs:   0,
        timeAdjustMs:   0,
        sessionOver:    false
    };

    modeFirstMoveSeen = false;
    modeCombo         = 0;
    modePuzzlesSolved = 0;
    modeMovesTried    = 0;
    modeMovesCorrect  = 0;

    // Always clean up streak-engine / idle-hint resources regardless of which mode we're entering
    brutalReset();

    if (currentGameMode === GAME_MODES.WOODPECKER) {
        if (typeof puzzleset !== 'undefined' && puzzleset.length > 0) {
            const pgnName = ($('#openPGN').val() || 'default').replace(/[^a-zA-Z0-9]/g, '_');
            wpResumePosition = typeof wpCheckResume === 'function' ? wpCheckResume(pgnName, puzzleset.length) : 0;
            if (typeof wpStartCycle === 'function') {
                wpStartCycle(pgnName, puzzleset.length);
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
    updateScoreDisplay();
    toggleModeElements(MODE_CONFIGS[currentGameMode]);
    srUpdateStatsDisplay();
    updateWpUI();
    const srRow = document.getElementById('sr-params-row');
    if (srRow) srRow.style.display = currentGameMode === GAME_MODES.INFINITY ? 'table-row' : 'none';

    // Show or hide the streak HUD (Repetition / Brutal)
    const brutalHud = document.getElementById('brutal-hud');
    if (brutalHud) {
        brutalHud.style.display = isStreakMode() ? 'block' : 'none';
    }
}

/** "Solved: N" — the score in Three, Haste and Countdown (blitz: n-solved / current-score). */
function updateScoreDisplay() {
    const config = MODE_CONFIGS[currentGameMode];
    const container = getModeHudContainer();

    let scoreDiv = document.getElementById('mode-score');

    if (config.showScore) {
        if (scoreDiv && scoreDiv.parentNode !== container) {
            scoreDiv.remove();
            scoreDiv = null;
        }
        if (!scoreDiv) {
            scoreDiv = document.createElement('div');
            scoreDiv.id = 'mode-score';
            scoreDiv.className = 'w3-container w3-center w3-margin-bottom';
            const label = document.createElement('div');
            label.className = 'mode-hud-label';
            label.textContent = 'Solved';
            const display = document.createElement('span');
            display.id = 'score-display';
            display.className = 'w3-text-green w3-large';
            scoreDiv.appendChild(label);
            scoreDiv.appendChild(display);
            if (container) container.appendChild(scoreDiv);
        }
        const display = document.getElementById('score-display');
        if (display) display.textContent = String(modePuzzlesSolved);
        scoreDiv.style.display = 'block';
    } else if (scoreDiv) {
        scoreDiv.style.display = 'none';
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

/**
 * Modes whose clock follows the blitz-tactics timer rules (ms-accurate, combo
 * bonuses, mistake penalties, optional "start on the first move").
 * Woodpecker also has hasTimer:true but keeps its original timer code untouched.
 */
function isBlitzTimedMode() {
    return currentGameMode === GAME_MODES.THREE     ||
           currentGameMode === GAME_MODES.HASTE     ||
           currentGameMode === GAME_MODES.COUNTDOWN ||
           currentGameMode === GAME_MODES.SPEEDRUN;
}

function startModeTimer() {
    const config = MODE_CONFIGS[currentGameMode];
    if (!config.hasTimer) return;
    stopModeTimer();
    modeState.isActive = true;

    if (!isBlitzTimedMode()) {            // Woodpecker: original behaviour, unchanged
        legacyStartModeTimer(config);
        return;
    }

    modeState.timeRemaining = config.isSpeedrun ? 0 : (config.timeLimit || config.baseTime || 0);
    modeState.timerStartMs  = 0;
    modeState.timeAdjustMs  = 0;
    updateTimerDisplay();

    // blitz Three / Countdown / Speedrun: the clock starts on the first move.
    // blitz Haste: the clock runs from the moment the round starts.
    if (!config.startOnFirstMove) modeTimerStart();
}

/** The original 1-second interval timer (still used by Woodpecker). */
function legacyStartModeTimer(config) {
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

/** Actually start the clock (immediately, or on the first move for startOnFirstMove modes). */
function modeTimerStart() {
    if (modeState.modeTimer) clearInterval(modeState.modeTimer);
    modeState.timerStartMs = Date.now();
    modeState.timeAdjustMs = 0;

    // The elapsed time shown in the results also starts at the first move in Speedrun
    if (MODE_CONFIGS[currentGameMode].isSpeedrun && typeof startDateTime !== 'undefined') {
        startDateTime = new Date();
        pauseDateTimeTotal = 0;
    }

    modeState.modeTimer = setInterval(modeTick, MODE_TICK_MS);
    modeTick();
}

/** Milliseconds left on a countdown clock (may be ≤ 0). */
function modeMsLeft() {
    const config = MODE_CONFIGS[currentGameMode];
    const budgetMs = (config.timeLimit || config.baseTime || 0) * 1000;
    return budgetMs + modeState.timeAdjustMs - (Date.now() - modeState.timerStartMs);
}

function modeTick() {
    const config = MODE_CONFIGS[currentGameMode];
    if (!config || !config.hasTimer || !modeState.timerStartMs || modeState.sessionOver) return;

    if (config.isSpeedrun) {                         // stopwatch: counts up, no limit
        modeState.timeRemaining = Math.floor((Date.now() - modeState.timerStartMs) / 1000);
        updateTimerDisplay();
        return;
    }
    const left = modeMsLeft();
    modeState.timeRemaining = Math.max(0, Math.ceil(left / 1000));
    updateTimerDisplay();
    if (left <= 0) handleTimeUp();
}

/** Add (+) or remove (−) time on a running countdown: combo bonuses and mistake penalties. */
function modeAdjustTime(deltaMs) {
    if (!modeState.timerStartMs) return;             // clock hasn't started yet: nothing to adjust
    modeState.timeAdjustMs += deltaMs;
    modeTick();
}

function stopModeTimer() {
    idleHintClear();
    brutalStopLapClock();
    if (modeState.modeTimer) {
        clearInterval(modeState.modeTimer);
        modeState.modeTimer = null;
    }
    modeState.isActive = false;
}

function handleTimeUp() {
    stopModeTimer();
    if      (currentGameMode === GAME_MODES.THREE)     endGameSession('Time\'s up!');
    else if (currentGameMode === GAME_MODES.HASTE)     endGameSession('Time ran out!');
    else if (currentGameMode === GAME_MODES.COUNTDOWN) endGameSession('Time\'s up!');
}

// ---------------------------------------------------------------------------
// Move & puzzle event hooks
// ---------------------------------------------------------------------------

/**
 * Every attempted (legal) move, right or wrong, passes through here first.
 * Keeps accuracy counters and starts the clocks that begin "on the first move".
 */
function modeOnMoveAttempt(correct) {
    modeMovesTried++;
    if (correct) modeMovesCorrect++;
    if (modeFirstMoveSeen) return;
    modeFirstMoveSeen = true;

    const config = MODE_CONFIGS[currentGameMode];
    if (config.hasTimer && config.startOnFirstMove && isBlitzTimedMode() &&
        modeState.isActive && !modeState.timerStartMs) {
        modeTimerStart();
    }
    if (isStreakMode() && !brutalLapStartTime) {
        brutalLapStartTime = Date.now();               // blitz: the lap timer starts on the first move
    }
}

function handleCorrectMove() {
    modeOnMoveAttempt(true);
    const config = MODE_CONFIGS[currentGameMode];

    // Repetition / Brutal / Speedrun: the 7 s idle clock restarts after every move
    if (config.idleHintMs) idleHintRestart();

    if (isStreakMode()) return;
    if (currentGameMode === GAME_MODES.INFINITY)   return;

    modeState.totalSolved++;
    if (currentGameMode === GAME_MODES.HASTE) {
        // blitz Haste: every 10th correct MOVE in a row gains 7 s, plus 3 s more for each
        // further multiple of 10 (10 → +7, 20 → +10, 30 → +13, …)
        modeCombo++;
        if (modeCombo % config.comboEvery === 0) {
            const tier = modeCombo / config.comboEvery;
            modeAdjustTime((config.comboBonus + config.comboBonusStep * (tier - 1)) * 1000);
        }
    }
}

/**
 * Called by the trainer for a wrong move, before the move is undone.
 * @returns {'skip'|undefined} 'skip' = abandon this puzzle and load the next one
 *                             (Three: a mistake costs a life but also moves on).
 */
function handleIncorrectMove() {
    modeOnMoveAttempt(false);
    const config = MODE_CONFIGS[currentGameMode];

    if (isStreakMode()) {
        // blitz: MOVE_FAIL resets progress; you stay on the same puzzle and the idle clock keeps running
        streakBreak();
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
    if (currentGameMode === GAME_MODES.THREE) {
        modeCombo = 0;                                  // combo drops on a mistake
        modeState.livesRemaining--;
        updateLivesDisplay();
        if (modeState.livesRemaining <= 0) {
            endGameSession('No lives left!');
            return;
        }
        return config.skipOnMistake ? 'skip' : undefined;
    } else if (currentGameMode === GAME_MODES.HASTE) {
        modeCombo = 0;
        modeAdjustTime(-config.penalty * 1000);         // −30 s
    } else if (currentGameMode === GAME_MODES.COUNTDOWN) {
        modeAdjustTime(-config.penalty * 1000);         // −30 s
    }
}

function handlePuzzleComplete() {
    const config = MODE_CONFIGS[currentGameMode];

    if (isStreakMode()) {
        idleHintClear();
        streakOnPuzzleSolved();
        return;
    }

    if (currentGameMode === GAME_MODES.INFINITY) {
        srOnPuzzleComplete();
        return;
    }

    if (currentGameMode === GAME_MODES.THREE) {
        modePuzzlesSolved++;
        modeCombo++;
        // blitz Three: every 3 puzzles solved in a row adds 3 seconds
        if (modeCombo % config.comboEvery === 0) modeAdjustTime(config.comboBonus * 1000);
        updateScoreDisplay();
    } else if (currentGameMode === GAME_MODES.HASTE || currentGameMode === GAME_MODES.COUNTDOWN) {
        modePuzzlesSolved++;
        updateScoreDisplay();
    }
}

function handleHintUsed() {
    if (isStreakMode()) {
        // A hint costs your progress. (blitz only offers the hint after the 7 s failure, so
        // in Brutal this is a no-op: progress is already 0.)
        streakBreak();
        return;
    }
    if (currentGameMode === GAME_MODES.INFINITY) {
        srOnError();
    }
    if (MODE_CONFIGS[currentGameMode].hasHints) {
        modeState.hintsRemaining--;
        updateHintsDisplay();
        if (MODE_CONFIGS[currentGameMode].halfHint) showHalfHint();
        if (modeState.hintsRemaining <= 0) {
            ['#btn_hint_landscape', '#btn_hint_portrait'].forEach(s => {
                const b = document.querySelector(s);
                if (b) b.disabled = true;
            });
        }
    }
}

/**
 * blitz Three: a hint shows only half the move — the from-square or the to-square, chosen at
 * random. Replaces the full move text that showHint() just put on the hint button.
 */
function showHalfHint() {
    try {
        const san = moveHistory[game.history().length];
        const move = game.moves({ verbose: true }).find(m => m.san === san);
        if (!move) return;
        const square = Math.random() < 0.5 ? move.from : move.to;
        $('#btn_hint_landscape').text(square);
        $('#btn_hint_portrait').text(square);
        if (typeof board !== 'undefined' && board && typeof MARKER_TYPE !== 'undefined') {
            board.addMarker(MARKER_TYPE.frame, square);
        }
    } catch (e) { /* the hint stays as the full move text */ }
}

// ---------------------------------------------------------------------------
// Puzzle start notification
// ---------------------------------------------------------------------------

function handlePuzzleStart() {
    if (isStreakMode()) {
        idleHintRestart();            // blitz: the 7 s clock starts when the puzzle loads
        brutalGetOrCreateHud();
        brutalUpdateStreakDisplay();
        return;
    }
    if (currentGameMode === GAME_MODES.SPEEDRUN) {
        idleHintRestart();            // hides last puzzle's hint button, restarts the 7 s clock
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
    if (isStreakMode()) {
        const nextIncrement = increment + 1;
        if (nextIncrement >= puzzleset.length) {
            // The puzzle index is about to wrap — record the lap and reshuffle,
            // then reset increment to -1 so chess-pgn-trainer.js sets it to 0.
            brutalCompleteLap();
            increment = -1;
        }
        return true; // blitz loopPuzzles: the loop never ends
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

    if (typeof isMistakeReviewActive !== 'undefined' && isMistakeReviewActive) {
        const total = (typeof PuzzleOrder !== 'undefined' && Array.isArray(PuzzleOrder))
            ? PuzzleOrder.length
            : puzzleset.length;
        return increment + 1 < total;
    }

    return increment + 1 < puzzleset.length;
}

// ---------------------------------------------------------------------------
// Pool sizing — make sure the loaded set is big enough for the selected mode
// ---------------------------------------------------------------------------

/**
 * Called by startTest(). Every mode runs on whatever set is loaded: a single exercise file
 * is a complete round on its own (when it is finished the player can go to the next file or
 * repeat it). Bigger pools are chosen explicitly via the "Combined Sets" collection.
 * @returns {boolean} always true
 */
function ensureAdequatePuzzlePool() { return modeCanStart(); }

/**
 * Pre-start check. Spaced Repetition has nothing to do when no card is due and the set
 * has no new puzzles: say when the next review is instead of replaying the whole file.
 * @returns {boolean} false = don't start
 */
function modeCanStart() {
    if (currentGameMode !== GAME_MODES.INFINITY) return true;
    srCurrentPgnFile = srPgnKey();
    srLoadCards();
    const c = srCountDue(srCards, puzzleset.length);
    if (c.due + c.fresh > 0) return true;
    let next = Infinity;
    Object.values(srCards).forEach(k => { if (k.nextReview < next) next = k.nextReview; });
    alert('Nothing is due in this set right now' +
          (isFinite(next) ? ` — the next review is ${new Date(next).toLocaleString()}.` : '.') +
          '\nPick another set, or switch to a different mode.');
    return false;
}

// ---------------------------------------------------------------------------
// "Continue last session" — Spaced Repetition and Woodpecker each remember the set they
// were last trained on, independently of everything else done in the app.
// ---------------------------------------------------------------------------

const LAST_SESSION_PREFIX = 'lastSession_';

function modeLastSession(mode) {
    try { return JSON.parse(localStorage.getItem(LAST_SESSION_PREFIX + mode) || 'null'); }
    catch (e) { return null; }
}

function modeRememberSession() {
    if (currentGameMode !== GAME_MODES.INFINITY && currentGameMode !== GAME_MODES.WOODPECKER) return;
    const path = $('#openPGN').val();
    if (!path) return;
    try {
        localStorage.setItem(LAST_SESSION_PREFIX + currentGameMode, JSON.stringify({
            path,
            label: (typeof getSetLabel === 'function') ? getSetLabel(path) : path,
            puzzleCount: puzzleset.length,
            at: Date.now()
        }));
    } catch (e) { /* storage full: the button just won't show */ }
}

/** One-line status for the Continue button of the current mode (null = nothing to continue). */
function modeContinueInfo() {
    const mode = currentGameMode;
    if (mode !== GAME_MODES.INFINITY && mode !== GAME_MODES.WOODPECKER) return null;
    const last = modeLastSession(mode);
    if (!last || !last.path) return null;
    const key = srPgnKey(last.path);
    try {
        if (mode === GAME_MODES.INFINITY) {
            const raw = localStorage.getItem(SR_STORAGE_PREFIX + key);
            const c = srCountDue(raw ? JSON.parse(raw) : {}, last.puzzleCount || 0);
            return { last, text: `${c.due} due · ${c.fresh} new` };
        }
        const raw = localStorage.getItem(WP_STORAGE_PREFIX + key);
        const d = raw ? JSON.parse(raw) : null;
        if (d && d.currentCycle) {
            return { last, text: `Cycle ${d.currentCycle.cycleNumber} · puzzle ${d.currentCycle.lastPuzzleIndex + 1}/${d.currentCycle.puzzleCount}` };
        }
        return { last, text: `next: Cycle ${(d && d.cycleHistory ? d.cycleHistory.length : 0) + 1}` };
    } catch (e) { return { last, text: '' }; }
}

function modeRefreshContinueRow() {
    const select = document.getElementById('game-mode-select-manual');
    if (!select || !select.parentNode) return;
    let row = document.getElementById('mode-continue-row');
    const info = modeContinueInfo();
    const startBtn = document.getElementById('btn_starttest_landscape');
    const idle = !startBtn || startBtn.style.display !== 'none';
    if (!info || !idle) { if (row) row.style.display = 'none'; return; }
    if (!row) {
        row = document.createElement('div');
        row.id = 'mode-continue-row';
        row.style.cssText = 'margin:6px 0;';
        select.parentNode.insertAdjacentElement('afterend', row);
    }
    const name = currentGameMode === GAME_MODES.INFINITY ? 'Spaced Repetition' : 'Woodpecker';
    const html = `▶ Continue ${name}: ${info.last.label}${info.text ? ' — ' + info.text : ''}`;
    if (row.dataset.html !== html) {
        row.dataset.html = html;
        row.innerHTML = '';
        const b = document.createElement('button');
        b.className = 'w3-button w3-round-large w3-green w3-small';
        b.textContent = html;
        b.onclick = modeContinueLastSession;
        row.appendChild(b);
    }
    row.style.display = 'block';
}
if (typeof setInterval === 'function') setInterval(modeRefreshContinueRow, 1000);

/** Load the set this mode was last trained on and start straight away, resuming where it left off. */
function modeContinueLastSession() {
    const info = modeContinueInfo();
    if (!info) return;
    const path = info.last.path;
    if (currentGameMode === GAME_MODES.WOODPECKER) wpAutoResume = true;
    if (typeof cancelNextSetCountdown === 'function') cancelNextSetCountdown();
    const rm = document.getElementById('resmodal');
    if (rm) rm.style.display = 'none';
    $('#openPGN').val(path);
    loadPGNFile(() => startTest());
    if (typeof syncBrowserToPath === 'function') syncBrowserToPath(path);
}

/**
 * If the browser dropped localStorage but IndexedDB still has the data, copy it back
 * (Spaced Repetition for every set; Woodpecker for the last-trained set).
 */
function modeRestoreFromDb() {
    if (!window.ChessDB) return;
    try {
        if (typeof ChessDB.srGetPgnFiles === 'function') {
            ChessDB.srGetPgnFiles().then(files => files.forEach(f => {
                const key = SR_STORAGE_PREFIX + f;
                if (localStorage.getItem(key)) return;
                ChessDB.srGetCards(f).then(rows => {
                    const cards = {};
                    Object.values(rows).forEach(r => {
                        cards[r.puzzleIndex] = { index: r.puzzleIndex, interval: r.interval, easeFactor: r.easeFactor,
                                                 repetitions: r.repetitions, nextReview: r.nextReview, due: r.due };
                    });
                    if (Object.keys(cards).length) localStorage.setItem(key, JSON.stringify(cards));
                }).catch(() => {});
            })).catch(() => {});
        }
        const last = modeLastSession(GAME_MODES.WOODPECKER);
        if (last && last.path && typeof ChessDB.wpGetCurrent === 'function') {
            const f = srPgnKey(last.path), key = WP_STORAGE_PREFIX + f;
            if (!localStorage.getItem(key)) {
                Promise.all([ChessDB.wpGetCurrent(f), ChessDB.wpGetCycleHistory(f)]).then(([cur, hist]) => {
                    if (!cur && !(hist && hist.length)) return;
                    const clean = r => { const c = Object.assign({}, r); delete c.pgnFile; return c; };
                    localStorage.setItem(key, JSON.stringify({
                        currentCycle: cur ? clean(cur) : null,
                        cycleHistory: (hist || []).map(h => ({ cycleNumber: h.cycleNumber, totalMs: h.totalMs, puzzleCount: h.puzzleCount,
                                                              mistakeCount: h.mistakeCount, completedAt: h.completedAt, mistakeIndexes: h.mistakeIndexes || [] }))
                    }));
                }).catch(() => {});
            }
        }
    } catch (e) { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Hook called by startTest()
// ---------------------------------------------------------------------------

function onStartTest() {
    if (currentGameMode === GAME_MODES.INFINITY) {
        srInitSession();
        modeRememberSession();
    }

    if (currentGameMode === GAME_MODES.WOODPECKER) {
        // The method needs the same order every cycle, so Randomize is ignored here and the
        // saved position always means the same puzzle.
        PuzzleOrder = Array.from({ length: puzzleset.length }, (_, i) => i);
        increment = Math.min(Math.max(0, wpResumePosition), puzzleset.length - 1);
        wpResumePosition = 0;
        wpSegmentStart = Date.now();
        modeRememberSession();
    }

    // blitz Three / Haste: every round is a fresh random selection of puzzles
    if (MODE_CONFIGS[currentGameMode].randomOrder && puzzleset.length > 1 && typeof shuffle === 'function') {
        PuzzleOrder = shuffle(PuzzleOrder.slice());
    }

    if (isStreakMode()) {
        brutalStreakCount   = 0;
        brutalNumPuzzles   = puzzleset.length;
        brutalCleared      = false;
        brutalLapTimes     = [];
        brutalLapStartTime = 0;            // the lap clock starts on the first move
        modeState.isActive = true;
        brutalGetOrCreateHud();
        brutalUpdateStreakDisplay();
        brutalUpdateProgressBar();
        brutalStartLapClock();
    }
}

// ---------------------------------------------------------------------------
// Session end (Three / Haste / Countdown: the clock ran out or the lives are gone)
// ---------------------------------------------------------------------------

/** True once a Three / Haste / Countdown round has ended (the trainer stops saving progress). */
function modeSessionIsOver() { return !!modeState.sessionOver; }

/**
 * End the round: stop the clock, lock the board, and show the result screen with the score
 * (blitz end screens: Three/Haste show the score, Countdown also shows accuracy).
 * Restart replays the same set; Reset returns to the start screen.
 */
function endGameSession(reason) {
    if (modeState.sessionOver) return;
    modeState.sessionOver = true;
    stopModeTimer();

    try { if (typeof board !== 'undefined' && board) board.disableMoveInput(); } catch (e) { /* ignore */ }
    if (typeof clearSavedGameState === 'function') clearSavedGameState();
    if (typeof setDisplayAndDisabled === 'function') {
        setDisplayAndDisabled(['#btn_pause_landscape', '#btn_pause_portrait'], 'none', true);
        setDisplayAndDisabled(['#btn_restart_landscape', '#btn_restart_portrait'], 'block', false);
    }
    if (typeof setHintButtonVisibility === 'function') setHintButtonVisibility(false, true);

    const title    = document.getElementById('messagecomplete');
    if (title) title.innerHTML = `<h2>${reason}</h2>`;
    ['errors', 'errorRate', 'elapsedTime', 'avgTime'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '';
    });
    const nextPrompt = document.getElementById('next-set-prompt');
    if (nextPrompt) nextPrompt.style.display = 'none';
    modeDecorateResults();

    setTimeout(() => {
        if (typeof showresults === 'function') showresults();
    }, 100);
}

/** Score / accuracy lines for the current mode (empty for modes that don't report them). */
function modeSummaryLines() {
    const config = MODE_CONFIGS[currentGameMode];
    const lines = [];
    if (config.showScore) {
        lines.push(`Score: <strong>${modePuzzlesSolved}</strong> puzzle${modePuzzlesSolved === 1 ? '' : 's'} solved`);
    }
    if ((currentGameMode === GAME_MODES.COUNTDOWN || currentGameMode === GAME_MODES.SPEEDRUN) && modeMovesTried > 0) {
        lines.push(`Accuracy: <strong>${Math.round(100 * modeMovesCorrect / modeMovesTried)}%</strong>`);
    }
    return lines;
}

/**
 * Put the mode's score/accuracy lines on the results screen. Called when a round ends
 * (above) and by the trainer's showStats() when a whole set is completed.
 */
function modeDecorateResults() {
    const lines = modeSummaryLines();
    let el = document.getElementById('mode-results-extra');
    if (!el) {
        if (lines.length === 0) return;
        el = document.createElement('div');
        el.id = 'mode-results-extra';
        const anchor = document.getElementById('avgTime');
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(el, anchor.nextSibling);
        else return;
    }
    el.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
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
            activeMs: 0,
            puzzleCount: puzzleCount,
            mistakesThisCycle: [],
            lastPuzzleIndex: 0
        };
        wpSave();
    }
    wpSegmentStart = Date.now();
    updateWpUI();
}

/** Time actually spent solving in the current cycle (days away from the app don't count). */
function wpFlushActive() {
    if (!wpData || !wpData.currentCycle || !wpSegmentStart) return;
    const now = Date.now();
    wpData.currentCycle.activeMs = (wpData.currentCycle.activeMs || 0) + (now - wpSegmentStart);
    wpSegmentStart = now;
}
function wpActiveMs() {
    if (!wpData || !wpData.currentCycle) return 0;
    return (wpData.currentCycle.activeMs || 0) + (wpSegmentStart ? Date.now() - wpSegmentStart : 0);
}
if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
        if (currentGameMode !== GAME_MODES.WOODPECKER || !wpData || !wpData.currentCycle) return;
        if (document.visibilityState === 'hidden') { wpFlushActive(); wpSegmentStart = 0; wpSave(); }
        else if (!wpSegmentStart) wpSegmentStart = Date.now();
    });
}
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('beforeunload', () => {
        if (currentGameMode === GAME_MODES.WOODPECKER && wpData && wpData.currentCycle) { wpFlushActive(); wpSave(); }
    });
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
    wpFlushActive();
    wpData.currentCycle.lastPuzzleIndex = index;
    wpSave();
}

function wpCompleteCycle() {
    if (!wpData || !wpData.currentCycle) return null;
    wpFlushActive();
    const elapsed = wpData.currentCycle.activeMs || 0;
    const completedCycle = {
        cycleNumber: wpData.currentCycle.cycleNumber,
        startedAt: wpData.currentCycle.startedAt,
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
    if (wpData.currentCycle && wpData.currentCycle.puzzleCount !== puzzleCount) {
        wpData.currentCycle = null;           // the set changed size: the old position is meaningless
        wpSave();
    }
    if (wpData.currentCycle) {
        const cyc = wpData.currentCycle;
        const auto = wpAutoResume;
        wpAutoResume = false;
        const confirmed = auto || confirm(
            `You have an in-progress Cycle ${cyc.cycleNumber} ` +
            `(solving time so far: ${msToHMS(cyc.activeMs || 0)}, at puzzle ${cyc.lastPuzzleIndex + 1}/${puzzleCount}). Resume it?`
        );
        if (confirmed) return cyc.lastPuzzleIndex;
        else { wpData.currentCycle = null; wpSave(); }
    }
    wpAutoResume = false;
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
