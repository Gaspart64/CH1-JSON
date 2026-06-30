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
    INFINITY:   'infinity'
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

// ---------------------------------------------------------------------------
// ═══════════════════════════════════════════════════════════════════════════
//  SPACED REPETITION (SM-2) — Infinity Mode
// ═══════════════════════════════════════════════════════════════════════════
//
//  Each puzzle has a "card" stored in localStorage under the key
//  'sr_cards_<pgnFile>'.  A card looks like:
//
//    {
//      index:       <number>   -- index into puzzleset[]
//      interval:    <days>     -- current review interval (starts 1)
//      easeFactor:  <float>    -- SM-2 ease factor (starts 2.5, min 1.3)
//      repetitions: <number>   -- consecutive correct solves
//      nextReview:  <ms>       -- Date.now() value when due next
//      due:         <boolean>  -- convenience flag set at queue-build time
//    }
//
//  The session queue (srQueue) is an ordered list of puzzle indices built
//  fresh each time the user presses Start.  It is stored in PuzzleOrder so
//  the rest of chess-pgn-trainer.js works without modification.
//
//  Per-puzzle error tracking uses srCurrentPuzzleHadError (reset each puzzle).
//
//  Within-session retry: failed puzzles are reinserted ~4 positions ahead in
//  the live queue (srQueue), not immediately next and not at the very front.
//  Cross-session: on clean solve the SM-2 card is updated and saved.
//  If the session ends while a puzzle is still failing, its card already has
//  nextReview in the past so it comes back first next session.
// ---------------------------------------------------------------------------

const SR_STORAGE_PREFIX  = 'sr_cards_';
const SR_REINSERT_AFTER  = 4;   // reinsert failed card this many puzzles later

let srCards                 = {};   // puzzleIndex → SM-2 card, persisted to localStorage
let srCurrentPgnFile        = '';   // key suffix for localStorage
let srCurrentPuzzleHadError = false;// true if any wrong move on the current puzzle
let srQueue                 = [];   // live ordered list of puzzle indices for this session
// srQueue is the source of truth within a session; PuzzleOrder is kept in sync.
// Failed puzzles are spliced back into srQueue at position (currentPos + SR_REINSERT_AFTER).
// srPendingRetry tracks which puzzles are currently awaiting a retry in srQueue,
// so we don't apply SM-2 until they're solved cleanly.
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
}

function srClearCards() {
    localStorage.removeItem(srGetStorageKey());
    srCards = {};
}

// ── Card initialisation ──────────────────────────────────────────────────────

function srGetCard(puzzleIndex) {
    if (!srCards[puzzleIndex]) {
        srCards[puzzleIndex] = {
            index:       puzzleIndex,
            interval:    1,
            easeFactor:  2.5,
            repetitions: 0,
            nextReview:  Date.now(),  // new cards are immediately due
            due:         true
        };
    }
    return srCards[puzzleIndex];
}

// ── SM-2 update ──────────────────────────────────────────────────────────────
//  Only called on a CLEAN solve (no errors, or cleaned up after retry).
//  quality 4 = first-time clean; quality 1 = eventually cleaned after errors.
//  Failed cards pending retry keep nextReview in the past so they're overdue
//  if the session ends before they're solved.

function srApplySM2(card, quality) {
    card.easeFactor = Math.max(
        1.3,
        card.easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
    );

    const msPerDay = 24 * 60 * 60 * 1000;

    if (quality < 3) {
        // Shouldn't happen in normal flow (we only call SM-2 on clean solve)
        // but guard just in case.
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
//  Builds the queue at session start from card history.
//  Order: overdue (most overdue first) → new (never seen) → future (not yet due).

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
        // Failed this attempt.
        // 1. Mark the card as overdue right now so it survives a session close.
        const card = srGetCard(puzzleIndex);
        card.nextReview = Date.now() - 1;
        card.due        = true;
        srSaveCards();

        // 2. Add to pending retry set so we know it needs a clean solve.
        srPendingRetry.add(puzzleIndex);

        // 3. Reinsert into srQueue ~SR_REINSERT_AFTER positions ahead.
        //    We insert AFTER increment because increment hasn't been bumped yet
        //    (caller does += 1 after this returns via srAdvance → no-op path).
        const insertAt = Math.min(
            increment + SR_REINSERT_AFTER,
            srQueue.length   // append at end if queue is short
        );
        srQueue.splice(insertAt, 0, puzzleIndex);
        PuzzleOrder = srQueue;

        srCurrentPuzzleHadError = false;
        srUpdateStatsDisplay();
        return;
    }

    // Clean solve.
    // Determine quality: penalised (1) if this was a retry, full (4) if first-time clean.
    const quality = wasInRetry ? 1 : 4;
    const card    = srGetCard(puzzleIndex);
    srApplySM2(card, quality);
    srSaveCards();

    // Remove from pending retry — it's been mastered for this session.
    srPendingRetry.delete(puzzleIndex);

    srCurrentPuzzleHadError = false;
    srUpdateStatsDisplay();
}

// ── Queue advance ─────────────────────────────────────────────────────────────
//  Called by shouldContinueToNextPuzzle after every puzzle.
//  Returns true if there is a next puzzle to load, false if the session is done.

function srAdvance() {
    const nextIncrement = increment + 1;

    if (nextIncrement < srQueue.length) {
        // Queue still has items ahead — continue normally.
        return true;
    }

    // Reached the end of the queue. Check if there's anything left to do.
    const now       = Date.now();
    const hasPending = srPendingRetry.size > 0;
    const hasDueOrNew = [...Array(puzzleset.length).keys()].some(i => {
        if (srPendingRetry.has(i)) return false; // already counted
        const card = srCards[i];
        return !card || card.nextReview <= now;  // new or overdue
    });

    if (!hasPending && !hasDueOrNew) {
        // Nothing left due or pending — session is genuinely complete.
        return false;
    }

    // There are still pending retries or due cards — rebuild queue and continue.
    const retryList = [...srPendingRetry];
    const baseQueue = srBuildInitialQueue(puzzleset.length);
    const retrySet  = new Set(retryList);
    const remainder = baseQueue.filter(i => !retrySet.has(i));

    srQueue     = [...retryList, ...remainder];
    PuzzleOrder = srQueue;
    increment   = -1;  // caller does += 1, lands on 0
    return true;
}

// ── Stats display ─────────────────────────────────────────────────────────────

function srUpdateStatsDisplay() {
    let statsDiv = document.getElementById('sr-stats');
    if (!statsDiv) {
        statsDiv = document.createElement('div');
        statsDiv.id = 'sr-stats';
        statsDiv.className = 'w3-container w3-center w3-margin-bottom w3-small';
        const landscapeDiv = document.querySelector('.landscapemode .w3-container.w3-center');
        if (landscapeDiv) landscapeDiv.appendChild(statsDiv);
    }

    if (currentGameMode !== GAME_MODES.INFINITY) {
        statsDiv.style.display = 'none';
        return;
    }

    const now    = Date.now();
    let due      = srPendingRetry.size;  // currently failing this session
    let learned  = 0;
    let newCount = 0;

    for (let i = 0; i < puzzleset.length; i++) {
        if (srPendingRetry.has(i)) continue;  // already counted above
        const card = srCards[i];
        if (!card) {
            newCount++;
        } else if (card.nextReview <= now) {
            due++;      // overdue from a previous session
        } else if (card.repetitions > 0) {
            learned++;  // at least one clean solve, scheduled for future
        } else {
            newCount++; // seen but no clean solve yet, not currently pending
        }
    }

    statsDiv.innerHTML =
        `<span style="color:#e53935;">⏰ Due: ${due}</span> &nbsp;|&nbsp; ` +
        `<span style="color:#43a047;">✓ Learned: ${learned}</span> &nbsp;|&nbsp; ` +
        `<span style="color:#1e88e5;">★ New: ${newCount}</span>`;
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
    resetModeState();
}

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
}

function updateTimerDisplay() {
    const config = MODE_CONFIGS[currentGameMode];
    let timerDiv = document.getElementById('mode-timer');
    if (config.hasTimer) {
        if (!timerDiv) {
            timerDiv = document.createElement('div');
            timerDiv.id = 'mode-timer';
            timerDiv.className = 'w3-container w3-center w3-margin-bottom';
            const label = document.createElement('div');
            label.textContent = 'Time: ';
            label.className = 'w3-text-indigo';
            const display = document.createElement('span');
            display.id = 'timer-display';
            display.className = 'w3-text-red w3-large';
            timerDiv.appendChild(label);
            timerDiv.appendChild(display);
            const landscapeDiv = document.querySelector('.landscapemode .w3-container.w3-center');
            if (landscapeDiv) landscapeDiv.appendChild(timerDiv);
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
    let livesDiv = document.getElementById('mode-lives');
    if (config.hasLives) {
        if (!livesDiv) {
            livesDiv = document.createElement('div');
            livesDiv.id = 'mode-lives';
            livesDiv.className = 'w3-container w3-center w3-margin-bottom';
            const label = document.createElement('div');
            label.textContent = 'Lives: ';
            label.className = 'w3-text-indigo';
            const display = document.createElement('span');
            display.id = 'lives-display';
            display.className = 'w3-text-red w3-large';
            livesDiv.appendChild(label);
            livesDiv.appendChild(display);
            const landscapeDiv = document.querySelector('.landscapemode .w3-container.w3-center');
            if (landscapeDiv) landscapeDiv.appendChild(livesDiv);
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
    let hintsDiv = document.getElementById('mode-hints');
    if (config.hasHints) {
        if (!hintsDiv) {
            hintsDiv = document.createElement('div');
            hintsDiv.id = 'mode-hints';
            hintsDiv.className = 'w3-container w3-center w3-margin-bottom';
            const label = document.createElement('div');
            label.textContent = 'Hints: ';
            label.className = 'w3-text-indigo';
            const display = document.createElement('span');
            display.id = 'hints-display';
            display.className = 'w3-text-blue w3-large';
            hintsDiv.appendChild(label);
            hintsDiv.appendChild(display);
            const landscapeDiv = document.querySelector('.landscapemode .w3-container.w3-center');
            if (landscapeDiv) landscapeDiv.appendChild(hintsDiv);
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
    let levelDiv = document.getElementById('mode-level');
    if (config.hasLevels) {
        if (!levelDiv) {
            levelDiv = document.createElement('div');
            levelDiv.id = 'mode-level';
            levelDiv.className = 'w3-container w3-center w3-margin-bottom';
            const label = document.createElement('div');
            label.textContent = 'Level: ';
            label.className = 'w3-text-indigo';
            const display = document.createElement('span');
            display.id = 'level-display';
            display.className = 'w3-text-green w3-large';
            levelDiv.appendChild(label);
            levelDiv.appendChild(display);
            const landscapeDiv = document.querySelector('.landscapemode .w3-container.w3-center');
            if (landscapeDiv) landscapeDiv.appendChild(levelDiv);
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
    if (currentGameMode === GAME_MODES.REPETITION) return;
    if (currentGameMode === GAME_MODES.INFINITY)   return;  // handled at puzzle level

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
    if (currentGameMode === GAME_MODES.INFINITY) {
        srOnError();
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
}

function handleHintUsed() {
    if (currentGameMode === GAME_MODES.INFINITY) {
        // Treat hint as an error for spaced repetition scoring
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
// Called from loadPuzzle() in chess-pgn-trainer.js via the hook below.
// ---------------------------------------------------------------------------

function handlePuzzleStart() {
    if (currentGameMode === GAME_MODES.INFINITY) {
        srOnPuzzleStart();
    }
}

// ---------------------------------------------------------------------------
// Puzzle advancement
// ---------------------------------------------------------------------------

function shouldContinueToNextPuzzle() {
    if (currentGameMode === GAME_MODES.INFINITY) {
        const hasMore = srAdvance();
        if (!hasMore) {
            // All due and pending puzzles solved — show completion message.
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

    return increment + 1 < puzzleset.length;
}

// ---------------------------------------------------------------------------
// Hook called by startTest() in chess-pgn-trainer.js
// Allows Infinity mode to override PuzzleOrder before the first puzzle loads.
// ---------------------------------------------------------------------------

function onStartTest() {
    if (currentGameMode === GAME_MODES.INFINITY) {
        srInitSession();
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
        srClearCards
    };
}
