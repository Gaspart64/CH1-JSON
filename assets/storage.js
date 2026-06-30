/*
 * Storage Module for Chess PGN Trainer
 * Handles saving and loading game state to/from localStorage.
 */

/**
 * Saves the current game state object to localStorage.
 * @param {Object} state - The game state to persist
 */
function saveGameState(state) {
    localStorage.setItem('savedGameState', JSON.stringify(state));
}

/**
 * Loads the saved game state from localStorage.
 * @returns {Object|null} The saved state, or null if nothing is stored
 */
function loadGameState() {
    const state = localStorage.getItem('savedGameState');
    return state ? JSON.parse(state) : null;
}

/**
 * Clears the saved game state from localStorage.
 * Called when a set completes normally or the user chooses Start New.
 */
function clearSavedGameState() {
    localStorage.removeItem('savedGameState');
}
