/**
 * json-parser.js
 * Parses the custom JSON puzzle format into the internal puzzleset array
 * used by chess-pgn-trainer.js.
 *
 * JSON schema (one element of the array):
 * {
 *   "title": "",
 *   "white": "2",
 *   "black": "?",
 *   "date": "",
 *   "event": { "en": "(557)" },
 *   "fen": "5rk1/6p1/...",
 *   "moves": [ { "move": "1... Be3+ 2. Qxe3 Rxe3 3. Nxe3 Qxb1+", "comment": [] } ],
 *   "game_terminator": "0-1"
 * }
 */

/**
 * parseMoveString(str)
 *
 * Converts a formatted move string into a clean ordered array of SAN tokens.
 *
 * Rules applied in order:
 *  1. Strip parenthetical variations including nested parens: (5. Bd5), (3... Qa1+ $11)
 *  2. Split on whitespace
 *  3. Discard move-number tokens:  1.  1...  26.  27.
 *  4. Discard NAG codes:  $1  $11  $18
 *  5. Discard result tokens:  1-0  0-1  1/2-1/2  *
 *
 * Examples:
 *  "1... Be3+ 2. Qxe3 Rxe3 3. Nxe3 Qxb1+"
 *    → ["Be3+","Qxe3","Rxe3","Nxe3","Qxb1+"]
 *
 *  "1. Bxe5 fxe5 2. Rxf7 Kxf7 3. Bd5+ Kf6 4. Bxa2 a4 5. Bc4 (5. Bd5)"
 *    → ["Bxe5","fxe5","Rxf7","Kxf7","Bd5+","Kf6","Bxa2","a4","Bc4"]
 *
 *  "1... Re2 2. Qxe2 Bxg5+ 3. Ne3 Qb1+ (3... Qa1+ $11) 4. Kd2 Qxh1"
 *    → ["Re2","Qxe2","Bxg5+","Ne3","Qb1+","Kd2","Qxh1"]
 *
 *  "26. Rxd8+ Rxd8 27. Nxe6 fxe6 28. Bc5 Rxc3 29. Bxe7"
 *    → ["Rxd8+","Rxd8","Nxe6","fxe6","Bc5","Rxc3","Bxe7"]
 */
function parseMoveString(str) {
    if (!str || typeof str !== 'string') return [];

    // Step 1: strip parenthetical variations (handle nested by looping)
    let s = str;
    let prev;
    do {
        prev = s;
        s = s.replace(/\([^()]*\)/g, '');
    } while (s !== prev);

    // Step 2-5: tokenise and filter
    return s.split(/\s+/)
        .map(t => t.trim())
        .filter(t => t.length > 0)
        .filter(t => !/^\d+\.+$/.test(t))                   // move numbers
        .filter(t => !/^\$\d+$/.test(t))                    // NAG codes
        .filter(t => !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t)); // result tokens
}

/**
 * parseJSON(jsonText)
 *
 * Parses a JSON string and populates the global puzzleset array.
 * Skips puzzles with missing required fields or illegal moves (logs a warning).
 * Relies on the global Chess constructor (chess.js) being available.
 */
function parseJSON(jsonText) {
    let raw;
    try {
        raw = JSON.parse(jsonText);
    } catch (e) {
        throw new Error('Invalid JSON: ' + e.message);
    }

    if (!Array.isArray(raw)) {
        throw new Error('JSON root must be an array of puzzle objects');
    }

    puzzleset = [];

    raw.forEach((p, i) => {
        // Validate required fields
        if (!p.fen) {
            console.warn(`[parseJSON] Puzzle ${i}: missing "fen" — skipped`);
            return;
        }
        if (!p.moves || !Array.isArray(p.moves) || !p.moves[0] || !p.moves[0].move) {
            console.warn(`[parseJSON] Puzzle ${i}: missing "moves" — skipped`);
            return;
        }

        const sanList = parseMoveString(p.moves[0].move);
        if (sanList.length === 0) {
            console.warn(`[parseJSON] Puzzle ${i}: move string produced no tokens — skipped`);
            return;
        }

        // Validate every move against a temporary Chess instance
        let tempGame;
        try {
            tempGame = new Chess(p.fen);
        } catch (e) {
            console.warn(`[parseJSON] Puzzle ${i}: invalid FEN "${p.fen}" — skipped`);
            return;
        }

        const parsedMoves = [];
        let valid = true;
        for (const san of sanList) {
            const result = tempGame.move(san);
            if (!result) {
                console.warn(`[parseJSON] Puzzle ${i}: illegal move "${san}" in "${p.moves[0].move}" — skipped`);
                valid = false;
                break;
            }
            // Store in the same shape parsePGN() produces
            parsedMoves.push({ notation: { notation: result.san } });
        }
        if (!valid) return;

        const eventName   = (p.event && p.event.en) ? p.event.en : `Puzzle ${i + 1}`;
        const gameResult  = p.game_terminator || '*';
        const moveText    = sanList.join(' ') + ' ' + gameResult; // for PGN export

        puzzleset.push({
            Event:  eventName,
            Series: eventName,
            White:  (p.white && p.white !== '?' && p.white !== '2') ? p.white : '',
            Black:  (p.black && p.black !== '?') ? p.black : '',
            FEN:    p.fen,
            Moves:  parsedMoves,
            PGN:    moveText,
        });
    });

    console.log(`[parseJSON] ${puzzleset.length} / ${raw.length} puzzles loaded`);
}
