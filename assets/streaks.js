/*
 * Streaks Module for Chess JSON Trainer
 * -----------------------------------------------------------------------
 * Tracks a Duolingo-style DAILY practice streak (calendar days on which the
 * user completed at least one set), separate from the existing in-session
 * "correctness streak" used by Brutal Mode / the results screen.
 *
 * Persisted to localStorage under 'dailyStreakData' using the same
 * readItem/saveItem pattern as the rest of the app's settings.
 *
 * Shape of the stored object:
 * {
 *   current: number,          // current consecutive-day streak
 *   longest: number,          // longest streak ever achieved
 *   lastPlayedDate: string,   // 'YYYY-MM-DD' in the user's local time
 *   lastNotifiedDate: string  // 'YYYY-MM-DD', mirrors what the server last sent (for display only)
 * }
 */

/**
 * Returns today's date as 'YYYY-MM-DD' in the user's local timezone.
 */
function getTodayLocalDateString() { // eslint-disable-line no-unused-vars
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Number of calendar days between two 'YYYY-MM-DD' strings (b - a).
 */
function daysBetweenDateStrings(a, b) {
    const da = new Date(`${a}T00:00:00`);
    const db = new Date(`${b}T00:00:00`);
    return Math.round((db - da) / 86400000);
}

/**
 * Reads the current daily streak state from localStorage.
 */
function getDailyStreakData() { // eslint-disable-line no-unused-vars
    try {
        const raw = (typeof readItem === 'function') ? readItem('dailyStreakData') : localStorage.getItem('dailyStreakData');
        if (!raw) return { current: 0, longest: 0, lastPlayedDate: null, lastNotifiedDate: null };
        const parsed = JSON.parse(raw);
        return {
            current: parsed.current || 0,
            longest: parsed.longest || 0,
            lastPlayedDate: parsed.lastPlayedDate || null,
            lastNotifiedDate: parsed.lastNotifiedDate || null
        };
    } catch (e) {
        return { current: 0, longest: 0, lastPlayedDate: null, lastNotifiedDate: null };
    }
}

function saveDailyStreakData(data) {
    const json = JSON.stringify(data);
    if (typeof saveItem === 'function') { saveItem('dailyStreakData', json); }
    else { localStorage.setItem('dailyStreakData', json); }
}

/**
 * Call this once whenever the user completes a set (full set, mistake
 * review, or slowest review all count — the goal is "did they practice
 * today", not which particular set they ran).
 *
 * Returns { current, longest, streakChanged, isNewRecord } so callers can
 * decide whether to show a celebration.
 */
function recordDailyCompletion() { // eslint-disable-line no-unused-vars
    const today = getTodayLocalDateString();
    const data = getDailyStreakData();

    if (data.lastPlayedDate === today) {
        // Already recorded today — no change, nothing to celebrate again.
        return { current: data.current, longest: data.longest, streakChanged: false, isNewRecord: false };
    }

    let newCurrent;
    if (data.lastPlayedDate && daysBetweenDateStrings(data.lastPlayedDate, today) === 1) {
        // Played yesterday -> extend the streak
        newCurrent = data.current + 1;
    } else {
        // First time ever, or the streak was broken (gap of 2+ days)
        newCurrent = 1;
    }

    const newLongest = Math.max(data.longest || 0, newCurrent);
    const isNewRecord = newCurrent > (data.longest || 0) && newCurrent > 1;

    saveDailyStreakData({
        current: newCurrent,
        longest: newLongest,
        lastPlayedDate: today,
        lastNotifiedDate: data.lastNotifiedDate || null
    });

    return { current: newCurrent, longest: newLongest, streakChanged: true, isNewRecord };
}

/**
 * Renders the small streak badge shown near the app title in both the
 * portrait header and the landscape sidebar. Safe to call any time
 * (e.g. on load, and again after recordDailyCompletion()).
 */
function renderStreakBadge() { // eslint-disable-line no-unused-vars
    const data = getDailyStreakData();
    const ids = ['streak-badge-portrait', 'streak-badge-landscape'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (data.current > 0) {
            el.textContent = `🔥 ${data.current}`;
            el.title = `${data.current}-day streak (best: ${data.longest})`;
            el.style.display = 'inline-block';
        } else {
            el.style.display = 'none';
        }
    });
}
