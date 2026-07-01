/**
 * puzzle-manifest.js
 *
 * Declares the 18 puzzle collections and their JSON files.
 *
 * HOW TO ADD YOUR FILES:
 *  1. Place each JSON file inside the Puzzles/ directory:
 *       Puzzles/
 *         FolderName1/
 *           Exe-01.json
 *           Exe-02.json
 *         FolderName2/
 *           Exe-10.json
 *         ...
 *
 *  2. Add an entry to PUZZLE_MANIFEST for each folder,
 *     listing every JSON file it contains.
 *
 *  3. The "label" fields are what the user sees in the dropdowns.
 *     The "path" fields must exactly match the file locations on disk.
 */
const PUZZLE_MANIFEST = [
    // ── Placeholder entries — replace with real folder/file names ──
    {
        label: "Collection 01",
        files: [
            { label: "Exercise 01", path: "./Puzzles/Mod-01/Exe-01.json" },
            { label: "Exercise 02", path: "./Puzzles/Mod-01/Exe-02.json" },
        ]
    },
    {
        label: "Collection 02",
        files: [
            { label: "Exercise 10", path: "./Puzzles/Col02/Exe-10.json" },
        ]
    },
    // ... repeat for all 18 collections
];

// ── Browser initialisation ────────────────────────────────────────────────────

function initPuzzleBrowser() {
    const folderSel = document.getElementById('folderSelect');
    const fileSel   = document.getElementById('fileSelect');
    if (!folderSel || !fileSel) return;

    folderSel.innerHTML = '<option value="">— Select a collection —</option>';
    PUZZLE_MANIFEST.forEach((col, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = col.label;
        folderSel.appendChild(opt);
    });
}

function onFolderChange() {
    const folderSel = document.getElementById('folderSelect');
    const fileSel   = document.getElementById('fileSelect');
    const idx = parseInt(folderSel.value, 10);

    fileSel.innerHTML = '<option value="">— Select a file —</option>';

    if (isNaN(idx) || !PUZZLE_MANIFEST[idx]) {
        fileSel.style.display = 'none';
        return;
    }

    PUZZLE_MANIFEST[idx].files.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.path;
        opt.textContent = f.label;
        fileSel.appendChild(opt);
    });

    fileSel.style.display = 'block';
    fileSel.value = '';

    // Clear stale value so SR keying starts fresh
    document.getElementById('openPGN').value = '';
    resetGame();
}
