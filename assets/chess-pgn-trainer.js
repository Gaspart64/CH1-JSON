/*
* Chess-PGN-Trainer
*/

/* eslint linebreak-style: ["error", "unix"] */
/* eslint indent: ["error", "tab"] */
/* eslint semi-style: ["error", "last"] */
/* eslint semi: ["error"] */

/* eslint no-undef: "error"*/
/* global Chess, PgnParser, FileReader */
/* global $, document, localStorage, alert, navigator, window */
/* global w3_close, showresults */

/* eslint no-unused-vars: ["error", { "vars": "all", "args": "none"}] */


/*

Features for this version:
* Fixed regression bug with move indication when using both flipped and opposite side functions.

*/



// -----------------------
// Define global variables
// -----------------------

// Board & Overall configuration-related variables
const version = '1.8.2';
let board;
// blankBoard element is used for pause overlay (no longer a Chessboard instance)
let pieceThemePath;
let game;
let config;
let PieceList;
let lastCompletedSet = null; // Track the last finished JSON set for resume suggestions

// Game & Performance variables
let moveCfg;
let moveHistory;
let puzzleset;
let errorcount;
let error;
let ElapsedTimehhmmss;
let AvgTimehhmmss;
let ErrorRate;
let setcomplete;
let stats;
let puzzlecomplete = false;
let pauseflag = false;
let increment = 0;
let PuzzleOrder = [];

// Promotion variables
let promoteTo;
let promotionDialog;

// Time-related variables
let PauseStartDateTime;
let PauseendDateTime;
let startDateTime = new Date();
let pauseDateTimeTotal = 0;
let puzzleStartTime = null;
let puzzleTimes = [];  // { puzzleIndex, name, timeMs, hadError }
let currentStreak = 0;
let bestStreak = 0;
let mistakeList = [];  // puzzle indices where error === true at completion
let isMistakeReviewActive = false;
let persistentMistakeList = []; // Persists across review sessions
let persistentSlowestPuzzles = []; // Persists across review sessions



// -------------
// Initial Setup
// -------------

// Version number of the app
$('#versionnumber').text(`version ${version}`);

// Collection of checkboxes used in the app
let checkboxlist = ['#playbothsides', '#playoppositeside', '#randomizeSet', '#flipped'];

// Collection of text elements
let messagelist = ['#messagecomplete', '#puzzlename_landscape', '#puzzlename_portrait', '#errors', '#errorRate', '#elapsedTime', '#avgTime'];

// cm-chessboard: assetsUrl points to the cm-chessboard assets folder you downloaded.
// See MIGRATION.md for setup instructions.
const CM_ASSETS_URL = './assets/cm-chessboard/assets/';

// pieceThemePath is kept for the promotion dialog image population (getPieces).
// cm-chessboard uses its own SVG sprite for rendering pieces on the board.
pieceThemePath = 'img/chesspieces/staunty/{piece}.svg';

promotionDialog = $('#promotion-dialog');



// -----------------------
// Local stoarge Functions
// -----------------------

/**
 * Save current game progress to resume later
 */
function saveCurrentGameProgress() {
        if (!puzzleset || puzzleset.length === 0 || setcomplete) {
                return;
        }

        const gameState = {
                increment: increment,
                PuzzleOrder: PuzzleOrder,
                puzzleset: puzzleset,
                errorcount: errorcount,
                pauseDateTimeTotal: pauseDateTimeTotal,
                startDateTime: startDateTime.getTime(),
                lastSelectedPgnFile: $('#openPGN').val(),
                gameMode: typeof getCurrentGameMode === 'function' ? getCurrentGameMode() : 'standard',
                timestamp: new Date().getTime()
        };

        saveGameState(gameState);
}

/**
 * Resume game from saved state
 */
function resumeSavedGame() {
        const savedState = loadGameState();
        if (!savedState) return false;

        // Basic validation of saved state
        if (!savedState.puzzleset || savedState.puzzleset.length === 0) return false;

        // Restore state variables
        puzzleset = savedState.puzzleset;
        PuzzleOrder = savedState.PuzzleOrder;
        increment = savedState.increment;
        errorcount = savedState.errorcount;
        pauseDateTimeTotal = savedState.pauseDateTimeTotal;
        startDateTime = new Date(savedState.startDateTime);

        if (savedState.lastSelectedPgnFile) {
                $('#openPGN').val(savedState.lastSelectedPgnFile);
        }

        // Restore game mode
        if (savedState.gameMode && typeof setGameMode === 'function') {
                setGameMode(savedState.gameMode);
        }

        // Setup UI for the resumed game
        $('#puzzleNumbertotal_landscape').text(puzzleset.length);
        $('#puzzleNumbertotal_portrait').text(puzzleset.length);

        // Load the puzzle we were on
        loadPuzzle(puzzleset[PuzzleOrder[increment]]);

        // UI adjustments - Match startTest UI state
        setDisplayAndDisabled(
                ['#btn_starttest_landscape', '#btn_starttest_portrait',
                        '#btn_restart_landscape', '#btn_restart_portrait', '#btn_showresults'], 'none');
        setDisplayAndDisabled(
                ['#btn_pause_landscape', '#btn_pause_portrait'], 'block', false);
        setHintButtonVisibility(true, false);
        setCheckboxSelectability(false);

        return true;
}

window.addEventListener('beforeunload', () => {
        saveCurrentGameProgress();
});

document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
                saveCurrentGameProgress();
        }
});

/**
 * Save a key/value pair to local storage
 * @param {string} key - The name of the key 
 * @param {string} value - The value of the key
 */
function saveItem(key, value) { localStorage.setItem(key, value); }

/**
 * Read the value of a specific key from local storage
 * @param {String} key - The key name for which the value is to be read
 * @returns {string}
 */
function readItem(key) {
        let value = localStorage.getItem(key);
        return value;
}

/**
 * Deletes the specified key from local storage
 * @param {string} key - The key to delete
 */
function deleteItem(key) { localStorage.removeItem(key); } // eslint-disable-line no-unused-vars

/**
 * Clear all items in local storage
 */
function clearItems() { localStorage.clear(); }



// -----------------------------------
// Functions for related to appearance
// -----------------------------------

/**
 * Populate the piece selection drop down with the list of pieces
 */
function addPieceSetNames() {

        // Clear any pre-existing values
        $('#piece-select').find('option').remove().end();

        // Populate the dropdown with the available options
        PieceList.forEach(
                (theme) => {
                        var newOption = $('<option>');
                        newOption.attr('value', theme.DirectoryName).text(theme.Name);
                        $('#piece-select').append(newOption);
                }
        );

        // Set the drop down to the saved value
        document.getElementById("piece-select").selectedIndex = readItem('pieceIndex');

}

/**
 * Sets the piece theme.  Warming: This will reset the board. Don't use while doing a set.
 */
function changePieces() {

        // TODO: Revisit this to see if I can use the text value instead of the index...
        saveItem('pieceIndex', document.getElementById("piece-select").selectedIndex);

        // Load the selected piece theme into a temp object
        var pieceObject;
        pieceObject = PieceList.find(x => x.DirectoryName === document.getElementById('piece-select').value);

        // Build the path to the piece theme using the object properties
        pieceThemePath = 'img/chesspieces/' + pieceObject.DirectoryName + '/{piece}.' + pieceObject.Type;

        // cm-chessboard uses SVG sprites — piece theme path is kept only for
        // the jQuery UI promotion popup images (getPieces).
        // Board re-creation on piece change is handled by resetGame().
        changecolor();
        resetGame();
}

/**
 * Applies the specified color values (RGB) to the board
 * 
 * @param {string} light - The RGB color value for the light squares (such as h1)
 * @param {string} dark - The RGB color value for the dark squares (such as a1) 
 */
function setBoardColor(light, dark) {
        // cm-chessboard uses CSS custom properties on the board element for square colours.
        const boardEl = document.getElementById('myBoard');
        if (boardEl) {
                boardEl.style.setProperty('--cm-chessboard-white-square-color', '#' + light);
                boardEl.style.setProperty('--cm-chessboard-black-square-color', '#' + dark);
        }
}

/**
 * Sets the values for the board color based on selections via the color picker or manual entry
 * and then applies the values to the board
 */
function changecolor() {

        // Read the values from the color picker inputs
        var light = document.getElementById('Light-Color').value.replace("#", "").trim();
        var dark = document.getElementById('Dark-Color').value.replace("#", "").trim();

        // Update the board colors based on the values
        setBoardColor(light, dark);

        // Save updated values
        saveItem('light', light);
        saveItem('dark', dark);

}

/**
 * Toggles the application between dark and light mode.  Saves current setting to file
 */
function toggleDarkMode() {

        document.body.classList.toggle("darkmode");

        var elmWitchChange = document.getElementsByClassName('light-mode');
        var i;

        for (i = 0; i < elmWitchChange.length; i++) {
                elmWitchChange[i].classList.toggle('darkmode');
        }

        elmWitchChange = document.getElementsByClassName('light-mode-control');
        for (i = 0; i < elmWitchChange.length; i++) {
                elmWitchChange[i].classList.toggle('darkmode-control');
        }

        // Check current status of the setting and save 
        if ($('#title_header').hasClass('darkmode')) {
                saveItem('darkmode', '1');
                // change logo
                $("#img_logo").attr("src", "./img/github-mark-white.svg");
                $('#chk_darkmode').prop('checked', true);

        } else {
                saveItem('darkmode', '0');
                // change logo
                $("#img_logo").attr("src", "./img/github-mark.svg");
                $('#chk_darkmode').prop('checked', false);
        }

}

/**
 * Resize both boards to available space
 */
function resizeBoards() { // eslint-disable-line no-unused-vars
        // cm-chessboard is SVG-based and resizes automatically — no manual resize needed.
        changecolor();
}

/**
 * Update the on-screen board with the current status of the game
 *
 * @param {boolean} animate - Set to True to animate the pieces while setting up the position.  
 *                                                        Setting to false sets the pieces instantly.
 */
function updateBoard(animate) {
        board.setPosition(game.fen(), animate);
}



// ------------------------------------
// Settings and configuration functions
// ------------------------------------

/**
 * Handle user choice for resuming game
 * @param {boolean} resume - True to resume, false to start new
 */
function handleResumeChoice(resume) {
        document.getElementById('resume-modal').style.display = 'none';
        if (resume) {
                if (loadGameState()) {
                        resumeSavedGame();
                } else if (window.suggestedNextSet) {
                        // Automatically load the suggested next set
                        $('#openPGN').val(window.suggestedNextSet);
                        loadPGNFile();
                        // Sync the dropdowns if possible
                        syncBrowserToPath(window.suggestedNextSet);
                        // Auto-start the test after loading
                        setTimeout(() => startTest(), 500);
                }
        } else {
                clearSavedGameState();
                resetGame();
        }
}

/**
 * Helper to get the next puzzle set from the manifest
 */
function getNextPuzzleSet(currentPath) {
        if (typeof PUZZLE_MANIFEST === 'undefined') return null;
        let allFiles = [];
        PUZZLE_MANIFEST.forEach(col => {
                col.files.forEach(f => {
                        allFiles.push({ label: `${col.label} ${f.label}`, path: f.path });
                });
        });
        const currentIndex = allFiles.findIndex(f => f.path === currentPath);
        if (currentIndex !== -1 && currentIndex < allFiles.length - 1) {
                return allFiles[currentIndex + 1];
        }
        return null;
}

/**
 * Helper to get a human-readable label for a path
 */
function getSetLabel(path) {
        if (typeof PUZZLE_MANIFEST === 'undefined') return path;
        for (const col of PUZZLE_MANIFEST) {
                for (const f of col.files) {
                        if (f.path === path) return `${col.label} ${f.label}`;
                }
        }
        return path;
}

/**
 * Sync the two-level browser dropdowns to a specific path
 */
function syncBrowserToPath(path) {
        if (typeof PUZZLE_MANIFEST === 'undefined') return;
        const folderSel = document.getElementById('folderSelect');
        const fileSel = document.getElementById('fileSelect');
        if (!folderSel || !fileSel) return;

        for (let i = 0; i < PUZZLE_MANIFEST.length; i++) {
                const col = PUZZLE_MANIFEST[i];
                const fileIdx = col.files.findIndex(f => f.path === path);
                if (fileIdx !== -1) {
                        folderSel.value = i;
                        onFolderChange();
                        fileSel.value = path;
                        break;
                }
        }
}

/**
 * Initializes the application upon load
 */
function initalize() {

        loadSettings();
        addPieceSetNames();
        changePieces(); // changePieces() calls resetGame() internally — don't call it again

        // Try to resume a saved game
        setTimeout(() => {
                const savedState = loadGameState();
                const lastCompleted = localStorage.getItem('lastCompletedSet');
                const modal = document.getElementById('resume-modal');
                const modalContent = modal ? modal.querySelector('p') : null;

                if (savedState) {
                        // Case 1: Active game in progress
                        if (modalContent) modalContent.textContent = "You have a game in progress. Would you like to continue where you left off?";
                        if (modal) modal.style.display = 'block';
                } else if (lastCompleted && typeof getNextPuzzleSet === 'function') {
                        // Case 2: Just finished a set, suggest the next one
                        const nextSet = getNextPuzzleSet(lastCompleted);
                        if (nextSet) {
                                window.suggestedNextSet = nextSet.path;
                                if (modalContent) {
                                        const lastLabel = getSetLabel(lastCompleted);
                                        // nextSet.label already includes the folder name in my helper, 
                                        // but let's make it explicitly clear.
                                        modalContent.textContent = `You finished ${lastLabel}. Would you like to solve ${nextSet.label}?`;
                                }
                                if (modal) {
                                    const modalTitle = modal.querySelector('h2');
                                    if (modalTitle) modalTitle.textContent = "Next Puzzles?";
                                    modal.style.display = 'block';
                                }
                        }
                }
        }, 500);

        // Initialize game modes system
        if (typeof initializeGameModes === 'function') {
                initializeGameModes();
        }

        if (typeof initPuzzleBrowser === 'function') {
                initPuzzleBrowser();
        }
}

/**
 * Sets default values for board color and piece theme
 */
function resetSettings() { // eslint-disable-line no-unused-vars

        clearItems();
        initalize();

        // Check to see if dark mode is active currently which is not the default and change back to light mode if that is the case
        if ($('#title_header').hasClass('darkmode') && readItem('darkmode') == "0") { toggleDarkMode(); }

}

/**
 * Load the settings for the application.  Sets defaults if values are not found
 */
function loadSettings() {

        // Set defaults if running for the first time

        // Default keys and values
        var defaults = { light: 'DEE3E6', dark: '769457', pieceIndex: '0', darkmode: '1', copy2clipboard: '1', csvheaders: '1' };

        // Load defaults if any keys are missing
        for (const [key, value] of Object.entries(defaults)) {
                if (readItem(key) == null || readItem(key) == "") { saveItem(key, value); }
        }

        // Load color values into the settings modal UI
        document.getElementById('Light-Color').value = readItem('light');
        document.getElementById('Dark-Color').value = readItem('dark');

        // Toggle dark mode if previously set
        if (readItem('darkmode') == "1") { toggleDarkMode(); }

        // Auto-copy to clipboard setting
        if (readItem('copy2clipboard') == "1") { $("#chk_clipboard").prop("checked", true); }

        // CSV Headers setting
        if (readItem('csvheaders') == "1") { $("#chk_csvheaders").prop("checked", true); }

}

/**
 * Show the settings modal
 */
function showSettings() { // eslint-disable-line no-unused-vars
        document.getElementById('settings-dialog').style.display = 'block';
}

/**
 * Since it is non-sensical to have both selected, only allow either "Play both sides" or "Play opposite side" 
 * to be checked but not both.
 */
function confirmOnlyOneOption() {

        // Clear both options if somehow both options get checked (ex: both options enabled via PGN tag)
        if ($('#playoppositeside').is(':checked') && $('#playbothsides').is(':checked')) {
                $('#playbothsides').prop('checked', false);
                $('#playoppositeside').prop('checked', false);
                $('#playbothsides').prop('disabled', false);
                $('#playoppositeside').prop('disabled', false);
        }

        // Enable both options as long as neither option is already checked
        if (!$('#playoppositeside').is(':checked') && !$('#playbothsides').is(':checked')) {
                $('#playbothsides').prop('disabled', false);
                $('#playoppositeside').prop('disabled', false);
        }

        // Disable "Play opposite side" since "Play both sides" is checked
        if ($('#playbothsides').is(':checked')) {
                $('#playoppositeside').prop('disabled', true);
        }

        // Disable "Play both sides" since "Play opposite side" is checked
        if ($('#playoppositeside').is(':checked')) {
                $('#playbothsides').prop('disabled', true);
        }

}

/**
 * Either turn on or off the ability to select options (ie: don't allow changes while in a game)
 *
 * @param {boolean} state - Set to true to enable the checkboxes. Set to false to disable the checkboxes.
 */
function setCheckboxSelectability(state) {

        for (var checkboxelement of checkboxlist) {
                if (state) {
                        if ($(checkboxelement).prop('disabled')) {
                                $(checkboxelement).removeAttr('disabled');
                                confirmOnlyOneOption();
                        }
                } else {
                        $(checkboxelement).attr('disabled', true);
                }
        }
}

/**
 * Set the CSS display and disabled properties of a given element
 * 
 * @param {array} listofElements - Array of controls to set in JQuery naming format (ie: prefaced with #)
 * @param {boolean} visible - Set to true to make the control visible. Set to false to hide the control.
 * @param {boolean} disabled - Set to true to disable the control. Set to false to enable the control.
 */
function setDisplayAndDisabled(listofElements, visible, disabled) {

        for (var elementName of listofElements) {
                // Set the visibility of the element
                if (visible !== undefined) {
                        $(elementName).css('display', visible);
                }

                // Set the status of the disabled property of the element
                if (disabled !== undefined) {
                        $(elementName).prop('disabled', disabled);
                }
        }

}

/**
 * Show or hide hint buttons using visibility instead of display,
 * so their reserved layout space is always maintained and the board never shifts.
 * @param {boolean} visible - true to show, false to hide
 * @param {boolean} disabled - true to disable the button
 */
function setHintButtonVisibility(visible, disabled) {
    ['#btn_hint_landscape', '#btn_hint_portrait'].forEach(sel => {
        const btn = document.querySelector(sel);
        if (!btn) return;
        btn.style.visibility = visible ? 'visible' : 'hidden';
        if (disabled !== undefined) btn.disabled = disabled;
    });
}

/**
 * Toggle the local file value for a specific setting based on checkbox status
 *
 * @param {string} elementname - The name of the checkbox (pre-pend with a #)
 * @param {string} dataname - The key name of the element in local storage
 */
function toggleSetting(elementname, dataname) { // eslint-disable-line no-unused-vars

        // Default value
        saveItem(dataname, '0');

        // Set to "1" (aka "True" or "On") if checked
        if ($(elementname).is(':checked')) { saveItem(dataname, '1'); }

}



// ------------------
// Gameplay functions
// ------------------

/**
 * Compare latest played move to the move in the same position as the PGN
 *
 * @returns {string}
 */
function checkAndPlayNext() {
        // Save progress after every move
        saveCurrentGameProgress();

        // Need to go this way since .moveNumber isn't working...
        if (game.history()[game.history().length - 1] === moveHistory[game.history().length - 1]) { // correct move

                // Handle correct move in current game mode
                if (typeof handleCorrectMove === 'function') {
                        handleCorrectMove();
                }

                // play next move if the "Play both sides" box is unchecked
                if (!$('#playbothsides').is(':checked')) {
                        // Play the opponent's next move from the PGN
                        const opponentMove = game.move(moveHistory[game.history().length]);
                        // Highlight the opponent's move
                        if (opponentMove) {
                                board.addMarker(MARKER_TYPE.lastMove, opponentMove.from);
                                board.addMarker(MARKER_TYPE.lastMove, opponentMove.to);
                        }

                        // In Brutal Mode, each opponent move also resets the 7-second player timer
                        if (typeof getCurrentGameMode === 'function' && getCurrentGameMode() === 'brutal') {
                                if (typeof brutalStartMoveTimer === 'function') brutalStartMoveTimer();
                        }
                }
                // Board sync is handled by handleMoveInput after the move
                // animation promise resolves — do not call updateBoard here.

        } else { // wrong move

                if (error === false) { // Add one to the error count for any given puzzle
                        errorcount += 1;
                }
                error = true;

                // Handle incorrect move in current game mode
                if (typeof handleIncorrectMove === 'function') {
                        handleIncorrectMove();
                }

                // Undo that move from the game
                game.undo();

                // Snap the bad piece back
                return 'snapback';
        }

        // Check if all the expected moves have been played
        if (game.history().length === moveHistory.length) {
                puzzlecomplete = true;

                // Record puzzle solve time
                if (puzzleStartTime !== null) {
                        puzzleTimes.push({
                                puzzleIndex: PuzzleOrder[increment],
                                name: puzzleset[PuzzleOrder[increment]].Event || `Puzzle ${increment + 1}`,
                                timeMs: Date.now() - puzzleStartTime,
                                hadError: error
                        });
                        puzzleStartTime = null;
                }

                // Update streak tracking
                if (!error) {
                        currentStreak++;
                        if (currentStreak > bestStreak) bestStreak = currentStreak;
                } else {
                        currentStreak = 0;
                        mistakeList.push(PuzzleOrder[increment]);
                }
                updateStreakDisplay();

                // Notify game mode that a puzzle is complete
                if (typeof handlePuzzleComplete === 'function') {
                        handlePuzzleComplete();
                }

                // Check to see if this is the last puzzle.
                // For SR/Infinity mode, defer to the mode — the queue may be
                // longer than puzzleset.length due to reinserted retries.
                const isInfinityMode = typeof getCurrentGameMode === 'function' &&
                        getCurrentGameMode() === 'infinity';
                const isBrutalMode = typeof getCurrentGameMode === 'function' &&
                        getCurrentGameMode() === 'brutal';
                if (!isInfinityMode && !isBrutalMode && increment + 1 === PuzzleOrder.length) {
                        setcomplete = true;
                }

                // Check if we should continue to next puzzle based on current game mode
                const shouldContinue = typeof shouldContinueToNextPuzzle === 'function' ?
                        shouldContinueToNextPuzzle() : (increment < PuzzleOrder.length - 1);

                // Are there more puzzles to go?  If yes, load the next one in the sequence.
                // Deferred with setTimeout so cm-chessboard finishes processing the current
                // validateMoveInput event before we call disableMoveInput/enableMoveInput
                // for the next puzzle — otherwise cm-chessboard's state machine deadlocks.
                if (shouldContinue) {
                        increment += 1;
                        setTimeout(() => loadPuzzle(puzzleset[PuzzleOrder[increment]]), 0);
                } else if (isInfinityMode) {
                        // SR session complete — trigger end-of-session UI
                        setcomplete = true;
                }
        }

        // Stop once all the puzzles in the set are done.
        // Deferred so cm-chessboard finishes the current move event first.
        if (setcomplete && puzzlecomplete) {
                setTimeout(() => {
                        // Clear saved progress as the set is finished
                        clearSavedGameState();

                        // Save the completion for resume suggestions
                        lastCompletedSet = $('#openPGN').val();
                        if (lastCompletedSet) {
                                localStorage.setItem('lastCompletedSet', lastCompletedSet);
                        }

                        // Stop any mode-specific timers
                        if (typeof stopModeTimer === 'function') {
                                stopModeTimer();
                        }

                        // Show the stats
                        generateStats();
                        showStats();

                        // Hide & disable the "Start" and "Pause" buttons
                        setDisplayAndDisabled(
                                ['#btn_starttest_landscape', '#btn_starttest_portrait',
                                        '#btn_pause_landscape', '#btn_pause_portrait'], 'none', true);

                        // Show "Restart" button
                        setDisplayAndDisabled(['#btn_restart_landscape', '#btn_restart_portrait'], 'block', false);

                        // Clear the move indicator
                        $('#moveturn').text('');
                }, 0);
        }
}

/**
 * Clear all the on-screen messages
 */
function clearMessages() {

        for (var messageelement of messagelist) {
                $(messageelement).text('');
        }
}

/**
 * Indicate who's turn it is to move
 */
function indicateMove() {
        $('#moveturn').text('White to move');

        if (game.turn() === 'b') {
                $('#moveturn').text('Black to move');
        }
}

/**
 * Attempt to add the chosen move to the current game
 *
 * @param {chess} game - The current chess.js object
 * @param {object} cfg - The configuration of the current move (from, to, promotion)
 * @returns {string}
 */
function makeMove(game, cfg) {
        // see if the move is legal
        const move = game.move(cfg);

        // illegal move
        if (move === null) {
                return 'snapback';
        }
}

/**
 * Handle when a user presses the "pause" button
 */
function pauseGame() {
        // Start a new counter (to then subtract from overall total)
        //$(window).trigger('resize');
        switch (pauseflag) {
                case false:
                        $('#btn_pause_landscape').text('Resume');
                        $('#btn_pause_portrait').text('Resume');
                        pauseflag = true;
                        PauseStartDateTime = new Date();

                        // hide the board
                        $('#myBoard').css('display', 'none');
                        $('#blankBoard').css('display', 'block');

                        // Remove focus on the pause/resume button
                        $('#btn_pause_landscape').blur();
                        $('#btn_pause_portrait').blur();

                        // Disable the Hint, Reset and Open PGN buttons while paused
                        $('#btn_reset').prop('disabled', true);
                        $('#openPGN_button').prop('disabled', true);
                        $('#btn_hint_landscape').prop('disabled', true);
                        $('#btn_hint_portrait').prop('disabled', true);

                        // Suspend Brutal Mode move timer during pause
                        if (typeof brutalClearMoveTimer === 'function') brutalClearMoveTimer();
                        break;

                case true:
                        $('#btn_pause_landscape').text('Pause');
                        $('#btn_pause_portrait').text('Pause');
                        pauseflag = false;
                        PauseendDateTime = new Date();

                        // Keep running total of paused time
                        pauseDateTimeTotal += (PauseendDateTime - PauseStartDateTime);

                        // show the board
                        $('#myBoard').css('display', 'block');
                        $('#blankBoard').css('display', 'none');

                        // Remove focus on the pause/resume button 
                        $('#btn_pause_landscape').blur();
                        $('#btn_pause_portrait').blur();

                        // Re-enable the Hint, Reset and Open PGN buttons
                        $('#btn_reset').prop('disabled', false);
                        $('#openPGN_button').prop('disabled', false);
                        $('#btn_hint_landscape').prop('disabled', false);
                        $('#btn_hint_portrait').prop('disabled', false);

                        // Resume Brutal Mode move timer on unpause
                        if (typeof getCurrentGameMode === 'function' && getCurrentGameMode() === 'brutal') {
                            if (typeof brutalStartMoveTimer === 'function') brutalStartMoveTimer();
                        }
                        break;
        }
        $(window).trigger('resize');
        changecolor();
}

/**
 * Reset everything in order to start a new testing session
 */
function resetGame() {
        // Stop any mode-specific timers
        if (typeof stopModeTimer === 'function') {
                stopModeTimer();
        }

        // Reset the current game in memory
        board = null;
        blankBoard = null;
        game = new Chess();
        moveHistory = [];
        // Note: We don't clear puzzleset here if we're in the middle of loading one
        // but for safety, let's keep it as is and ensure loadPGNFile handles it.
        puzzleset = [];
        errorcount = 0;
        pauseDateTimeTotal = 0;
        error = false;
        setcomplete = false;



        puzzlecomplete = false;
        pauseflag = false;
        increment = 0;
        PuzzleOrder = [];
        puzzleStartTime = null;
        puzzleTimes = [];
        currentStreak = 0;
        bestStreak = 0;
        mistakeList = [];
        isMistakeReviewActive = false;


        // Destroy existing board cleanly before recreating
        if (board) {
                board.destroy();
                board = null;
        }
        // Clear the DOM element — cm-chessboard appends SVG children and
        // destroy() may not remove them, causing multiple boards on screen.
        const boardEl = document.getElementById('myBoard');
        if (boardEl) boardEl.innerHTML = '';

        // Create the cm-chessboard instance with move input enabled
        board = new Chessboard(document.getElementById('myBoard'), {
                position: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                assetsUrl: CM_ASSETS_URL,
                style: {
                        cssClass: 'default',
                        showCoordinates: true,
                        pieces: { file: 'pieces/staunty.svg' },
                        animationDuration: 0  // disable animation to prevent race with setPosition
                },
                extensions: [
                        { class: Markers },
                        { class: PromotionDialog }
                ]
        });

        // Move input is enabled per-puzzle in loadPuzzle(), not here,
        // because it must be set after the position and orientation are established.

        // Set the counters back to zero
        $('#puzzleNumber_landscape').text('0');
        $('#puzzleNumber_portrait').text('0');
        $('#puzzleNumbertotal_landscape').text('0');
        $('#puzzleNumbertotal_portrait').text('0');

        // Show Start button and hide "Pause" and "Restart" buttons
        setDisplayAndDisabled(['#btn_starttest_landscape', '#btn_starttest_portrait'], 'block', true);
        setDisplayAndDisabled(
                ['#btn_pause_landscape', '#btn_pause_portrait',
                        '#btn_restart_landscape', '#btn_restart_portrait'], 'none', false);

        // Hide & disable the "Hint" and the "Show Results" buttons
        setDisplayAndDisabled(['#btn_showresults'], 'none', true);
        setHintButtonVisibility(false, true);

        // Show the full board (in case the reset happened during a pause)
        $('#myBoard').css('display', 'block');
        $('#blankBoard').css('display', 'none');

        // Reset the progress bar
        $('#progressbar_landscape').width("0%");
        $('#progressbar_landscape').text("0%");

        $('#progressbar_portrait').width("0%");
        $('#progressbar_portrait').text("0%");

        // Disable options checkboxes
        setCheckboxSelectability(false);

        // Clear the checkboxes
        for (var checkboxelement of checkboxlist) {
                $(checkboxelement).prop('checked', false);
        }

        // Remove focus on the reset button
        $('#btn_reset').blur();

        // Clear any prior results/statistics
        clearMessages();

        // Clear the move indicator
        $('#moveturn').text('');

        // Reset mode state
        if (typeof resetModeState === 'function') {
                resetModeState();
        }

        // Close hover
        w3_close();

}

/**
 * Show the hint
 */
function showHint() {

        // Check if hint is available in current game mode
        if (typeof isHintAvailable === 'function' && !isHintAvailable()) {
                return;
        }

        // Change the text of the button to the correct move
        $('#btn_hint_landscape').text(moveHistory[game.history().length]);
        $('#btn_hint_portrait').text(moveHistory[game.history().length]);

        // Set error flag for this puzzle since hint was used.
        if (error === false) {
                errorcount += 1;
        }
        error = true;

        // Handle hint usage in current game mode
        if (typeof handleHintUsed === 'function') {
                handleHintUsed();
        }
}

/**
 * Starts the test and timer
 */
function startTest() {
        // Close hover
        w3_close();

        // Check to make sure that a PGN File was loaded
        if (puzzleset.length === 0) {
                return;
        }

        // Reset mode state when starting
        if (typeof resetModeState === 'function') {
                resetModeState();
        }

        // Hide "Start", "Restart" & "Show Results" buttons
        setDisplayAndDisabled(
                ['#btn_starttest_landscape', '#btn_starttest_portrait',
                        '#btn_restart_landscape', '#btn_restart_portrait', '#btn_showresults'], 'none');

        // Show & enable the "Hint" and "Pause" buttons
        setDisplayAndDisabled(
                ['#btn_pause_landscape', '#btn_pause_portrait'], 'block', false);
        setHintButtonVisibility(true, false);

        // Disable changing options
        setCheckboxSelectability(false);

        // Clear any messages
        clearMessages();

        // Any prior mistake review session is no longer active
        isMistakeReviewActive = false;

        // Load first puzzle and start counting for errors (for now...)
        errorcount = 0;

        // Get current date/time
        startDateTime = new Date();
        pauseDateTimeTotal = 0;
        increment = 0;

        // Neat bit here from https://www.freecodecamp.org/news/javascript-range-create-an-array-of-numbers-with-the-from-method/
        const arrayRange = (start, stop, step) => Array.from(
                { length: (stop - start) / step + 1 },
                (value, index) => start + index * step,
        );

        // Shuffle the set if the box is checked
        if ($('#randomizeSet').is(':checked')) {
                // Generate numbers between 1 and the number of puzzles in the PGN and then shuffle them
                PuzzleOrder = shuffle(arrayRange(0, puzzleset.length - 1, 1));
        } else {
                // Generate numbers between 1 and the number of puzzles in the PGN in order
                PuzzleOrder = arrayRange(0, puzzleset.length - 1, 1);
        }

        // Start mode-specific timer if applicable
        if (typeof startModeTimer === 'function') {
                startModeTimer();
        }

        // Update mode UI
        if (typeof updateModeUI === 'function') {
                updateModeUI();
        }

        // Allow game mode to override PuzzleOrder before first puzzle loads
        if (typeof onStartTest === 'function') {
                onStartTest();
        }

        // Now just need to send the desired puzzle to the board.
        if (increment >= 0 && typeof PuzzleOrder[increment] !== 'undefined') {
                loadPuzzle(puzzleset[PuzzleOrder[increment]]);
        }
}

/**
 * Shuffle contents of an array into random order
 *
 * Credit for this function goes to https://stackoverflow.com/questions/2450954/how-to-randomize-shuffle-a-javascript-array
 *
 * @param {array} array - The array to be shuffled
 * @returns {array}
 */
function shuffle(array) {
        let currentIndex = array.length;
        let randomIndex;

        // While there remain elements to shuffle.
        while (currentIndex !== 0) {
                // Pick a remaining element.
                randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex -= 1;

                // And swap it with the current element.
                [array[currentIndex], array[randomIndex]] = [
                        array[randomIndex], array[currentIndex],
                ];
        }

        return array;
}

/**
 * Updates the progres bar on the screen
 *
 * @param {int} partial_value - The number of completed puzzles (numerator)
 * @param {int} total_value - The total number of puzzles (denominator)
 */
function updateProgressBar(partial_value, total_value) {
        // In Brutal Mode, the progress bar is managed by brutalUpdateProgressBar()
        if (typeof getCurrentGameMode === 'function' && getCurrentGameMode() === 'brutal') {
                return;
        }
        // Do the math
        const progress = Math.round((partial_value / total_value) * 100);

        // Show the result
        let progresspercent = progress + "%";
        $('#progressbar_landscape').width(progresspercent);
        $('#progressbar_landscape').text(progresspercent);

        $('#progressbar_portrait').width(progresspercent);
        $('#progressbar_portrait').text(progresspercent);
}

/**
 * Load the desired puzzle or position from the PGN to the screen
 *
 * @param {object} PGNPuzzle - The object representing a specific position and move sequence
 */
function loadPuzzle(PGNPuzzle) {
        // Clear any markers left over from the previous puzzle immediately.
        board.removeMarkers();
        // Force clear any stuck promotion dialog overlay
        $('.promotion-dialog-group').empty();
        // Start puzzle timer
        puzzleStartTime = Date.now();

        // Save progress when a new puzzle is loaded
        saveCurrentGameProgress();

        // Display current puzzle number in the sequence
        $('#puzzleNumber_landscape').text(increment + 1);
        $('#puzzleNumber_portrait').text(increment + 1);

        updateProgressBar(increment, puzzleset.length);

        // Set the error flag to false for this puzzle (ie: only count 1 error per puzzle)
        error = false;
        puzzlecomplete = false;

        // Notify game mode that a new puzzle is starting
        if (typeof handlePuzzleStart === 'function') {
                handlePuzzleStart();
        }

        // Load the board position into memory
        game = new Chess(PGNPuzzle.FEN);

        // Load the moves of the PGN into memory
        PGNPuzzle.Moves.forEach(
                (move) => game.move(move.notation.notation),
        );

        // Copy the move order from the PGN into memory
        moveHistory = game.history();

        // Set the board position to the opening in the puzzle (ie: undo all steps in the PGN)
        while (game.undo() !== null) { }

        // Set the board to the beginning position of the puzzle
        updateBoard(false);

        // Ensure the orientation is set to match the puzzle
        // Default is white
        let boardOrientation = COLOR.white;

        // Flip the board if Black to play
        if (game.turn() === 'b') {
                boardOrientation = COLOR.black;
        }

        // Flip board if "Flipped" checkbox is checked
        if ($('#flipped').is(':checked')) {
                boardOrientation = (boardOrientation === COLOR.white) ? COLOR.black : COLOR.white;
        }

        board.setOrientation(boardOrientation);

        // Store the FEN so openAnalysis() can use it at any time
        window._currentAnalysisFEN = PGNPuzzle.FEN || null;

        // Update the screen with the value of the PGN Event tag (if any)
        $('#puzzlename_landscape').html(PGNPuzzle.Event);
        $('#puzzlename_portrait').html(PGNPuzzle.Event);


        // Play the first move if player is playing second and not both sides
        if ($('#playoppositeside').is(':checked') && !$('#playbothsides').is(':checked')) {
                const initialMove = game.move(moveHistory[0]);
                updateBoard(true);
                // Highlight the computer's initial move
                if (initialMove) {
                        board.addMarker(MARKER_TYPE.lastMove, initialMove.from);
                        board.addMarker(MARKER_TYPE.lastMove, initialMove.to);
                }
        }

        // Update the status of the game in memory with the new data
        indicateMove();

        changecolor();

        // Enable move input for this puzzle.
        // Disable first in case it's already active from the previous puzzle.
        board.disableMoveInput();
        board.enableMoveInput(handleMoveInput);
}



// -----------------------
// cm-chessboard move input
// -----------------------

/**
 * Determines whether the current player is allowed to interact with a square.
 * Replaces the old dragStart() side-to-move guard logic.
 */
function isMoveAllowed() {
        if (pauseflag) return false;
        if (game.history().length === moveHistory.length) return false;

        if (!$('#playbothsides').is(':checked')) {
                if (!$('#playoppositeside').is(':checked') && game.history().length % 2 !== 0) {
                        return false;
                }
                if ($('#playoppositeside').is(':checked') && (game.history().length % 2 === 0 || game.history().length === 0)) {
                        return false;
                }
        }
        return true;
}

/**
 * Single unified move input handler for cm-chessboard.
 * Replaces dragStart(), dropPiece(), and snapEnd().
 *
 * @param {object} event - cm-chessboard input event
 */
function handleMoveInput(event) {
        switch (event.type) {

                case INPUT_EVENT_TYPE.moveInputStarted: {
                        // User clicked a piece — check if move is allowed first.
                        if (!isMoveAllowed()) return false;

                        // Clear previous highlights and dots at the start of a new move input
                        board.removeMarkers();

                        // Show legal move destinations as dots, and highlight the
                        // selected piece square with a frame — same as Lichess/Chess.com.
                        const legalMoves = game.moves({ square: event.square, verbose: true });
                        if (legalMoves.length === 0) return false;

                        // Highlight the selected piece square
                        board.addMarker(MARKER_TYPE.frame, event.square);

                        // Add a dot on each legal target square
                        legalMoves.forEach(move => {
                                board.addMarker(MARKER_TYPE.dot, move.to);
                        });

                        return true;
                }

                case INPUT_EVENT_TYPE.validateMoveInput: {
                        // User completed a move gesture — validate and execute it.
                        const source = event.squareFrom;
                        const target = event.squareTo;

                        // Test legality with a queen promotion placeholder
                        const testMove = game.move({ from: source, to: target, promotion: 'q' });
                        if (testMove === null) {
                                return false; // illegal — cm-chessboard snaps piece back
                        }
                        game.undo();

                        // Check for pawn promotion
                        const piece = game.get(source);
                        const isPromotion = piece && piece.type === 'p' &&
                                ((piece.color === 'w' && target[1] === '8') ||
                                        (piece.color === 'b' && target[1] === '1'));

                        if (isPromotion) {
                                // Use cm-chessboard's built-in PromotionDialog extension
                                board.showPromotionDialog(target, piece.color === 'w' ? COLOR.white : COLOR.black,
                                        (result) => {
                                                if (!result || result.type === PROMOTION_DIALOG_RESULT_TYPE.canceled) {
                                                        // User cancelled — reset the board position
                                                        board.setPosition(game.fen(), false);
                                                        board.disableMoveInput();
                                                        board.enableMoveInput(handleMoveInput);
                                                        return;
                                                }
                                                const promotionPiece = result.piece.charAt(1); // e.g. 'wq' → 'q'
                                                moveCfg = { from: source, to: target, promotion: promotionPiece };
                                                makeMove(game, moveCfg);
                                                board.setPosition(game.fen(), true);
                                                checkAndPlayNext();
                                                indicateMove();
                                                board.disableMoveInput();
                                                board.enableMoveInput(handleMoveInput);
                                                $('#btn_hint_landscape').text('Hint');
                                                $('#btn_hint_portrait').text('Hint');
                                        });
                                return true; // accept the move visually while dialog shows
                        }

                        // Normal (non-promotion) move.
                        moveCfg = { from: source, to: target, promotion: 'q' };
                        makeMove(game, moveCfg);

                        const result = checkAndPlayNext();
                        indicateMove();

                        if (setcomplete && puzzlecomplete) {
                                $('#moveturn').text('');
                        }

                        $('#btn_hint_landscape').text('Hint');
                        $('#btn_hint_portrait').text('Hint');

                        if (result === 'snapback') {
                                // Wrong move — reject so cm-chessboard snaps piece back.
                                return false;
                        }

                        // Only sync board position if the puzzle isn't complete.
                        // If puzzlecomplete, loadPuzzle() is about to be called via
                        // setTimeout and will set the correct position itself.
                        if (!puzzlecomplete) {
                                board.setPosition(game.fen(), false);
                        }

                        return true;
                }

                case INPUT_EVENT_TYPE.moveInputCanceled:
                case INPUT_EVENT_TYPE.moveInputFinished:
                        // Clear all temporary dot and frame markers when the move is completed or cancelled.
                        board.removeMarkers();
                        // Re-add the highlight for the actual last move made.
                        // This ensures the computer's response (or the player's own move) stays visible.
                        const history = game.history({ verbose: true });
                        if (history.length > 0) {
                                const lastMove = history[history.length - 1];
                                board.addMarker(MARKER_TYPE.lastMove, lastMove.from);
                                board.addMarker(MARKER_TYPE.lastMove, lastMove.to);
                        }
                        break;
        }
}



// ------------------------
// Pawn Promotion functions
// ------------------------
/**
 * Get an individual piece image
 *
 * @param {chess} piece - A chess.js game piece
 * @returns {*}
 */
function getImgSrc(piece) {
        return pieceThemePath.replace('{piece}', game.turn() + piece.toLocaleUpperCase());
}

/**
 * Populate the pawn promotion popup based on the color of the current player
 */
function getPieces() {
        $('.promotion-piece-q').attr('src', getImgSrc('q'));
        $('.promotion-piece-r').attr('src', getImgSrc('r'));
        $('.promotion-piece-n').attr('src', getImgSrc('n'));
        $('.promotion-piece-b').attr('src', getImgSrc('b'));
}

/**
 * Set the promotion value in the move config and make the move
 */
function onDialogClose() {
        moveCfg.promotion = promoteTo;
        makeMove(game, moveCfg);
        checkAndPlayNext();
}



// ---------------------
// PGN related Functions
// ---------------------

/**
 * Feed the PGN file provided by the user here to the PGN Parser and update/enable the controls
 */
function loadPGNFile() { // eslint-disable-line no-unused-vars
        const selectedFile = document.getElementById('openPGN').value;
        if (!selectedFile) return;

        resetGame();
        // Restore the value because resetGame() might clear it if not careful
        document.getElementById('openPGN').value = selectedFile;

        console.log('Attempting to load:', selectedFile);

        if (selectedFile) {
                if (selectedFile === 'uploaded' || selectedFile === 'uploaded_json') {
                        try {
                                const isJson = selectedFile === 'uploaded_json';
                                if (isJson) parseJSON(window.uploadedPGNContent);
                                else        parsePGN(window.uploadedPGNContent.trim());

                                $('#puzzleNumber_landscape').text('1');
                                $('#puzzleNumber_portrait').text('1');

                                $('#puzzleNumbertotal_landscape').text(puzzleset.length);
                                $('#puzzleNumbertotal_portrait').text(puzzleset.length);

                                setDisplayAndDisabled(['#btn_starttest_landscape', '#btn_starttest_portrait'], 'block', false);
                        }
                        catch (err) {
                                alert('There is an issue with the file. Error message is as follows:\n\n' + err
                                        + '\n\nPuzzles loaded successfully before error: ' + puzzleset.length);
                                resetGame();
                        }
                        setCheckboxSelectability(true);
                        return;
                }

                fetch(selectedFile)
                        .then(response => {
                                if (!response.ok) {
                                        throw new Error('Network response was not ok');
                                }
                                return response.text();
                        })
                        .then(PGNFile => {
                                try {
                                        const isJson = selectedFile.endsWith('.json') || selectedFile === 'uploaded_json';
                                        if (isJson) parseJSON(PGNFile);
                                        else        parsePGN(PGNFile.trim());

                                        $('#puzzleNumber_landscape').text('1');
                                        $('#puzzleNumber_portrait').text('1');

                                        $('#puzzleNumbertotal_landscape').text(puzzleset.length);
                                        $('#puzzleNumbertotal_portrait').text(puzzleset.length);

                                        setDisplayAndDisabled(['#btn_starttest_landscape', '#btn_starttest_portrait'], 'block', false);
                                }
                                catch (err) {
                                        alert('There is an issue with the file. Error message is as follows:\n\n' + err
                                                + '\n\nPuzzles loaded successfully before error: ' + puzzleset.length);
                                        resetGame();
                                }
                        })
                        .catch(error => {
                                alert('Error loading file: ' + error);
                                resetGame();
                        });

                setCheckboxSelectability(true);
        }
}

/**
 * PGN file parser
 *
 * @param {string} PGNData - The PGN text data to parse. Can comprise of one or more games
 */
function parsePGN(PGNData) {
        const splitGames = (string) => PgnParser.split(string, { startRule: 'games' });
        const games = splitGames(PGNData);

        puzzleset = [];

        games.forEach(
                (game) => {
                        const { tags } = PgnParser.parse(game.tags, { startRule: 'tags' });
                        const { moves } = PgnParser.parse(game.pgn, { startRule: 'game' });

                        // Set the options checkboxes if any of the special tags have a value of 1
                        if (tags.PGNTrainerBothSides === '1') { $("#playbothsides").prop("checked", true); }
                        if (tags.PGNTrainerOppositeSide === '1') { $("#playoppositeside").prop("checked", true); }
                        if (tags.PGNTrainerRandomize === '1') { $("#randomizeSet").prop("checked", true); }
                        if (tags.PGNTrainerFlipped === '1') { $("#flipped").prop("checked", true); }

                        // Make sure that both "Play both sides" and "Play opposite side" are not selected (if yes, clear both)
                        confirmOnlyOneOption();

                        const puzzle = {};
                        puzzle.Event = (tags.Event);
                        puzzle.Series = (tags.Event);

                        puzzle.White = (tags.White);
                        puzzle.Black = (tags.Black);

                        if ((puzzle.White && puzzle.Black) && (puzzle.White !== '?' && puzzle.Black !== '?')) {
                                puzzle.Event = puzzle.Event + '<br><br>White: ' + puzzle.White + '<br>Black: ' + puzzle.Black;
                        }

                        puzzle.FEN = (tags.FEN);
                        puzzle.PGN = (game.pgn);
                        puzzle.Moves = moves;

                        puzzleset.push(puzzle);
                },
        );
}



// -------------------------
// Results related functions
// -------------------------

/**
 * Output the stats to the clipboard
 */
function outputStats2Clipboard() {

        // Copy Tab-delimited version to clipboard for easy pasting to spreadsheets
        navigator.clipboard.writeText(
                Object.values(stats).join('\t')
        );
}

/**
 * Output the stats to a csv file
 */
function outputStats2CSV() { // eslint-disable-line no-unused-vars

        // Adapted from https://stackoverflow.com/questions/61339206/how-to-export-data-to-csv-using-javascript
        let csvHeader = '';
        let csvBody = Object.values(stats).join(',') + '\n';
        let datetimestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
        var hiddenElement = document.createElement('a');

        // add the header row if option is selected
        if (readItem('csvheaders') == "1") { csvHeader = Object.keys(stats).join(',') + '\n'; }

        hiddenElement.href = 'data:text/csv;charset=utf-8,' + encodeURI(csvHeader + csvBody);
        hiddenElement.target = '_blank';
        hiddenElement.download = datetimestamp + '.csv';
        hiddenElement.click();

}

/**
 * Generate the statistics for this run
 */
function generateStats() {

        // Compute the time and error values
        const currentDate = new Date().toJSON().slice(0, 10);
        const endDateTime = new Date();
        const ElapsedTimeSeconds = (endDateTime - startDateTime - pauseDateTimeTotal) / 1000; // Subtracting the paused time from total elapsed time
        ElapsedTimehhmmss = new Date(ElapsedTimeSeconds * 1000).toISOString().slice(11, 19);
        const AvgTimeSeconds = Math.round(ElapsedTimeSeconds / puzzleset.length);
        AvgTimehhmmss = new Date(AvgTimeSeconds * 1000).toISOString().slice(11, 19);
        ErrorRate = (errorcount / puzzleset.length);

        // Get the filename of the PGN file
        // Adapted from https://stackoverflow.com/questions/857618/javascript-how-to-extract-filename-from-a-file-input-control
        var fullPath = document.getElementById('openPGN').value;
        var startIndex = (fullPath.indexOf('\\') >= 0 ? fullPath.lastIndexOf('\\') : fullPath.lastIndexOf('/'));
        var filename = fullPath.substring(startIndex);

        if (filename.indexOf('\\') === 0 || filename.indexOf('/') === 0) { filename = filename.substring(1); }

        filename = filename.substring(0, filename.lastIndexOf('.'));


        // Get the mode (random or sequential)
        var mode = 'Sequential';
        if ($('#randomizeSet').is(':checked')) { mode = 'Random'; };


        // Build the stats object
        stats = {};

        stats.date = (currentDate);
        stats.filename = filename;
        stats.round = '';
        stats.series = puzzleset[0].Series;
        stats.mode = mode;
        stats.setlength = puzzleset.length;
        stats.errors = errorcount;
        stats.totaltime = ElapsedTimehhmmss;
        stats.avgtime = AvgTimehhmmss;
        stats.errorrate = ErrorRate;

        // Add slowest puzzles if available
        if (puzzleTimes.length > 0) {
                const sorted = [...puzzleTimes].sort((a, b) => b.timeMs - a.timeMs);
                stats.slowestPuzzles = sorted.slice(0, 5).map(p => ({
                        puzzleIndex: p.puzzleIndex,
                        name: p.name,
                        time: new Date(p.timeMs).toISOString().slice(14, 19),
                        hadError: p.hadError
                }));
        }

        // Add best streak
        stats.bestStreak = bestStreak;

        // Persist mistakes and slowest puzzles if this was a full set
        // This allows users to switch between review modes after completing one.
        if (!isMistakeReviewActive) {
                persistentMistakeList = [...mistakeList];
                persistentSlowestPuzzles = [...stats.slowestPuzzles];
        }
}

/**
 * Show the final stats after finishing all the puzzles in the set
 */
function showStats() {

        // Format the error rate to 1 decimal place
        const ErrorRate1Dec = stats.errorrate.toFixed(3) * 100;

        // Show 100% on the progress bar
        updateProgressBar(1, 1);

        // Show & enable "Show Results" button
        setDisplayAndDisabled(['#btn_showresults'], 'block', false);

        // Hide & disable the "hint" button
        setHintButtonVisibility(false, true);

        // Update the results modal with the details
        $('#messagecomplete').html('<h2>Set Complete</h2>');
        $('#elapsedTime').text(`Elapsed time (hh:mm:ss): ${stats.totaltime}`);
        $('#avgTime').text(`Average time/puzzle (hh:mm:ss): ${stats.avgtime}`);
        $('#errors').text(`Number of errors: ${stats.errors}`);
        $('#errorRate').text(`Error Rate: ${ErrorRate1Dec.toFixed(1)}%`);

        // Display best streak if >= 2
        if (stats.bestStreak && stats.bestStreak >= 2) {
                const streakEl = document.getElementById('streakResult');
                if (streakEl) {
                        streakEl.textContent = 'Best Streak: ' + stats.bestStreak;
                        streakEl.style.display = 'block';
                }
        }

        // Display slowest puzzles if available
        if (stats.slowestPuzzles && stats.slowestPuzzles.length > 0) {
                const listEl = document.getElementById('slowest-puzzles-list');
                if (listEl) {
                        listEl.innerHTML = '';
                        stats.slowestPuzzles.forEach(p => {
                                const li = document.createElement('li');
                                const errorMark = p.hadError ? ' [ERROR]' : '';
                                li.textContent = p.name + ' - ' + p.time + errorMark;
                                listEl.appendChild(li);
                        });
                        const headingEl = document.getElementById('slowest-puzzles-heading');
                        if (headingEl) headingEl.style.display = 'block';
                        if (listEl) listEl.style.display = 'block';
                }
        }

        // If we are currently in a review, use the persistent list from the original set
        const displayList = isMistakeReviewActive ? persistentMistakeList : mistakeList;
        // Prioritize persistent list if it exists (from the original full set)
        const slowestToReview = persistentSlowestPuzzles.length > 0 ? persistentSlowestPuzzles : (stats.slowestPuzzles || []);

        // Display mistake review button
        const btn = document.getElementById('btn_review_mistakes');
        if (btn) {
                if (displayList.length > 0) {
                        btn.textContent = `Review ${displayList.length} Mistake${displayList.length > 1 ? 's' : ''}`;
                        btn.style.display = 'block';
                } else {
                        btn.style.display = 'none';
                }
        }

        // Display slowest review button
        const btnSlow = document.getElementById('btn_review_slowest');
        if (btnSlow) {
                if (slowestToReview.length > 0) {
                        btnSlow.textContent = `Review ${slowestToReview.length} Slowest Puzzle${slowestToReview.length > 1 ? 's' : ''}`;
                        btnSlow.style.display = 'block';
                } else {
                        btnSlow.style.display = 'none';
                }
        }

        // Display "Download mistakes.pgn" button — same condition as Review Mistakes
        const btnDownloadMistakes = document.getElementById('btn_download_mistakes_pgn');
        if (btnDownloadMistakes) {
                btnDownloadMistakes.style.display = displayList.length > 0 ? 'block' : 'none';
        }

        // Display "Download slowest.pgn" button — same condition as Review Slowest
        const btnDownloadSlowest = document.getElementById('btn_download_slowest_pgn');
        if (btnDownloadSlowest) {
                btnDownloadSlowest.style.display = slowestToReview.length > 0 ? 'block' : 'none';
        }

        // Handle Woodpecker mode results
        if (typeof getCurrentGameMode === 'function' && getCurrentGameMode() === 'woodpecker') {
                if (typeof wpCompleteCycle === 'function') {
                        const cycle = wpCompleteCycle();
                        if (cycle && typeof wpData !== 'undefined' && wpData) {
                                const history = wpData.cycleHistory;
                                const lastMs = history.length >= 2 ? history[history.length - 2].totalMs : null;
                                const improvement = lastMs ? lastMs - cycle.totalMs : null;
                                const faster = improvement > 0;

                                const chartSvg = typeof wpBuildCycleChart === 'function' ? wpBuildCycleChart(history) : '';

                                const extraHtml = `
                                        <div style="padding: 12px 0;">
                                                <div style="font-size:1.3rem; font-weight:bold; text-align:center; margin-bottom:8px;">
                                                        🪵 Cycle ${cycle.cycleNumber} Complete
                                                </div>
                                                <div>Time: <strong>${typeof msToHMS === 'function' ? msToHMS(cycle.totalMs) : 'N/A'}</strong></div>
                                                <div>Mistakes: <strong>${cycle.mistakeCount}</strong> / ${cycle.puzzleCount}</div>
                                                ${improvement !== null
                                                ? `<div style="color:${faster ? 'green' : 'red'}">
                                                            ${faster ? '\u25b2 ' : '\u25bc '}${typeof msToHMS === 'function' ? msToHMS(Math.abs(improvement)) : 'N/A'} vs last cycle
                                                           </div>`
                                                : ''}
                                                <div style="margin-top:12px;">${chartSvg}</div>
                                                ${cycle.mistakeCount > 0
                                                ? `<div style="margin-top:10px; font-size:0.9rem;">
                                                            ⚠️ ${cycle.mistakeCount} puzzle(s) flagged for review — see list below.
                                                           </div>`
                                                : '<div style="color:green; margin-top:8px;">✅ Perfect cycle!</div>'}
                                        </div>
                                `;

                                const slot = document.getElementById('wp-results-slot');
                                if (slot) slot.innerHTML = extraHtml;

                                if (typeof wpPopulateFlaggedList === 'function') {
                                        wpPopulateFlaggedList(cycle.mistakeIndexes);
                                }
                        }
                }
        }

        // Display the modal
        showresults();

        // Copy results to clipboard for pasting into spreadsheet
        if ($('#chk_clipboard').is(':checked')) { outputStats2Clipboard(); };

        // Re-enable options checkboxes
        setCheckboxSelectability(true);
}



// ------------------
// Button assignments
// ------------------
/**
 * Assign actions to the buttons
 */
$(() => {

        // Buttons
        document.getElementById('openPGN_button').addEventListener('click', function () {
                const fileInput = document.getElementById('pgn_file_input');
                if (fileInput) {
                        fileInput.click();
                }
        });

        document.getElementById('btn_reset').addEventListener('click', resetGame, false);

        document.getElementById('btn_showresults').addEventListener('click', showresults, false);

        $('#btn_hint_landscape').on('click', showHint);
        $('#btn_hint_portrait').on('click', showHint);

        $('#btn_starttest_landscape').on('click', startTest);
        $('#btn_starttest_portrait').on('click', startTest);

        $('#btn_restart_landscape').on('click', startTest);
        $('#btn_restart_portrait').on('click', startTest);

        $('#btn_pause_landscape').on('click', pauseGame);
        $('#btn_pause_portrait').on('click', pauseGame);

        $('#btn_test').on('click', changecolor);

        $('#promote-to').selectable({
                stop() {
                        $('.ui-selected', this).each(function () {
                                const selectable = $('#promote-to li');
                                const index = selectable.index(this);
                                let promoteTo_html;
                                let span;

                                if (index > -1) {
                                        promoteTo_html = selectable[index].innerHTML;
                                        span = $(`<div>${promoteTo_html}</div>`).find('span');
                                        promoteTo = span[0].innerHTML;
                                }
                                promotionDialog.dialog('close');
                                $('.ui-selectee').removeClass('ui-selected');
                                updateBoard(false);
                                //promoting = false;
                        });
                },
        });
});

/**
 * Update the streak display on the screen
 */
function updateStreakDisplay() {
        let el = document.getElementById('streak-display');
        if (!el) {
                el = document.createElement('div');
                el.id = 'streak-display';
                el.className = 'w3-container w3-center w3-margin-bottom w3-small';
                const pb = document.getElementById('progressbar_landscape');
                if (pb && pb.parentNode) pb.parentNode.insertBefore(el, pb.nextSibling);
        }
        if (currentStreak >= 2) {
                el.innerHTML = 'Streak: <strong>' + currentStreak + '</strong> &nbsp;|&nbsp; Best: <strong>' + bestStreak + '</strong>';
                el.style.display = 'block';
        } else if (bestStreak > 0) {
                el.innerHTML = 'Best streak this session: <strong>' + bestStreak + '</strong>';
                el.style.display = 'block';
        } else {
                el.style.display = 'none';
        }
}

/**
 * Start a mistake review session with only puzzles that had errors
 */
function startMistakeReview() {
        const saved = isMistakeReviewActive ? [...persistentMistakeList] : [...mistakeList];
        if (!saved.length) return;

        // Preserve the original puzzleset before resetGame() clears it
        const originalPuzzleset = puzzleset;

        document.getElementById('resmodal').style.display = 'none';
        if (typeof setGameMode === 'function') setGameMode('standard');

        // Full UI/game reset, then restore the original puzzleset so we can
        // replay only the mistaken indices from that set.
        resetGame();
        puzzleset = originalPuzzleset;
        isMistakeReviewActive = true;

        PuzzleOrder = saved;
        increment = 0;
        setDisplayAndDisabled(
                ['#btn_starttest_landscape', '#btn_starttest_portrait',
                        '#btn_restart_landscape', '#btn_restart_portrait',
                        '#btn_showresults', '#btn_review_mistakes', '#btn_review_slowest'], 'none');
        setDisplayAndDisabled(
                ['#btn_pause_landscape', '#btn_pause_portrait'], 'block', false);
        setHintButtonVisibility(true, false);
        setCheckboxSelectability(false);
        clearMessages();
        errorcount = 0;
        mistakeList = [];
        startDateTime = new Date();
        pauseDateTimeTotal = 0;
        loadPuzzle(puzzleset[PuzzleOrder[0]]);
}

/**
 * Start a review session with the top 5 slowest puzzles from the last session
 */
function startSlowestReview() {
        const slowestEntries = (persistentSlowestPuzzles && persistentSlowestPuzzles.length > 0)
                ? persistentSlowestPuzzles
                : (stats && stats.slowestPuzzles ? stats.slowestPuzzles : []);

        if (!slowestEntries || slowestEntries.length === 0) return;

        // Get the puzzle indices from stats.slowestPuzzles (which now includes puzzleIndex)
        const slowestIndices = slowestEntries.map(p => p.puzzleIndex);

        if (!slowestIndices.length) return;

        // Preserve the original puzzleset before resetGame() clears it
        const originalPuzzleset = puzzleset;

        document.getElementById('resmodal').style.display = 'none';
        if (typeof setGameMode === 'function') setGameMode('standard');

        resetGame();
        puzzleset = originalPuzzleset;
        isMistakeReviewActive = true;

        PuzzleOrder = slowestIndices;
        increment = 0;
        setDisplayAndDisabled(
                ['#btn_starttest_landscape', '#btn_starttest_portrait',
                        '#btn_restart_landscape', '#btn_restart_portrait',
                        '#btn_showresults', '#btn_review_mistakes', '#btn_review_slowest'], 'none');
        setDisplayAndDisabled(
                ['#btn_pause_landscape', '#btn_pause_portrait'], 'block', false);
        setHintButtonVisibility(true, false);
        setCheckboxSelectability(false);
        clearMessages();
        errorcount = 0;
        mistakeList = [];
        startDateTime = new Date();
        pauseDateTimeTotal = 0;
        loadPuzzle(puzzleset[PuzzleOrder[0]]);
}

/**
 * Build a PGN string from a list of puzzle indices, in the order given.
 * Reuses each puzzle's original FEN and movetext so the file can be
 * re-loaded straight back into the trainer for targeted follow-up.
 *
 * @param {number[]} indices - indices into the global puzzleset array
 * @returns {string}
 */
function buildPGNFromIndices(indices) {
        let output = '';

        indices.forEach((idx) => {
                const puzzle = puzzleset[idx];
                if (!puzzle) return;

                // puzzle.Event may have "<br><br>White: ... Black: ..." appended
                // for on-screen display — strip HTML before writing it as a tag.
                let eventName = puzzle.Event || `Puzzle ${idx + 1}`;
                eventName = eventName.replace(/<br\s*\/?>/gi, ' — ').replace(/<\/?[^>]+(>|$)/g, '').trim();
                eventName = eventName.replace(/"/g, "'"); // PGN tag values can't contain quotes

                const white = (puzzle.White || '').replace(/"/g, "'");
                const black = (puzzle.Black || '').replace(/"/g, "'");

                output += `[Event "${eventName}"]\n`;
                output += `[Site ""]\n`;
                output += `[Date "????.??.??"]\n`;
                output += `[Round "?"]\n`;
                output += `[White "${white}"]\n`;
                output += `[Black "${black}"]\n`;
                output += `[Result "*"]\n`;
                output += `[SetUp "1"]\n`;
                output += `[FEN "${puzzle.FEN}"]\n`;
                output += `\n`;
                output += `${(puzzle.PGN || '').trim()}\n\n`;
        });

        return output;
}

/**
 * Trigger a browser download of a text blob — same data-URI approach
 * already used by outputStats2CSV().
 */
function downloadTextFile(content, filename) {
        const hiddenElement = document.createElement('a');
        hiddenElement.href = 'data:application/x-chess-pgn;charset=utf-8,' + encodeURIComponent(content);
        hiddenElement.target = '_blank';
        hiddenElement.download = filename;
        hiddenElement.click();
}

/** Download mistakes.pgn — only the puzzles that had an error this session. */
function downloadMistakesPGN() { // eslint-disable-line no-unused-vars
        const list = isMistakeReviewActive ? persistentMistakeList : mistakeList;
        if (!list || list.length === 0) return;
        downloadTextFile(buildPGNFromIndices(list), 'mistakes.pgn');
}

/** Download slowest.pgn — the top 5 slowest-solved puzzles this session. */
function downloadSlowestPGN() { // eslint-disable-line no-unused-vars
        const entries = (persistentSlowestPuzzles && persistentSlowestPuzzles.length > 0)
                ? persistentSlowestPuzzles
                : (stats && stats.slowestPuzzles ? stats.slowestPuzzles : []);
        if (!entries || entries.length === 0) return;
        downloadTextFile(buildPGNFromIndices(entries.map(p => p.puzzleIndex)), 'slowest.pgn');
}

/**
 * openAnalysis()
 * Opens the currently displayed puzzle position in Lichess's analysis board.
 * The FEN is stored in window._currentAnalysisFEN each time loadPuzzle() runs.
 * Uses the Lichess URL format: https://lichess.org/analysis/6k1/P1r2ppq/7p/8/3Q4/8/5PPP/6K1_w_-_-_0_1
 */
function openAnalysis() {
        let fen = window._currentAnalysisFEN;

        // Fallback: ask chess.js for the live FEN if the stored one is missing
        if (!fen && typeof game !== 'undefined' && game && game.fen) {
                fen = game.fen();
        }

        if (!fen) {
                alert('No position available to analyse yet.');
                return;
        }

        // Convert standard FEN to Lichess URL format
        // Standard FEN: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        // Lichess format: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR_w_KQkq_-_0_1"
        // Replace all spaces with underscores (no encoding needed)
        const lichessFen = fen.replace(/ /g, '_');
        const url = 'https://lichess.org/analysis/' + lichessFen;
        window.open(url, '_blank', 'noopener,noreferrer');
}
