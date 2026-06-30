function handlePGNFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
        alert(`File too large (max 10 MB). Yours: ${(file.size/1024/1024).toFixed(2)} MB`);
        return;
    }

    const ext = file.name.split('.').pop().toLowerCase();
    if (ext !== 'pgn' && ext !== 'json') {
        alert('Please select a .pgn or .json file');
        return;
    }

    const reader = new FileReader();
    reader.onerror = () => alert('Error reading file: ' + reader.error);

    reader.onload = (e) => {
        try {
            const content = e.target.result;
            if (!content || content.trim().length === 0) {
                alert('File is empty.');
                return;
            }

            window.uploadedPGNContent  = content;
            window.uploadedPGNFileName = file.name;

            const uploadVal = ext === 'json' ? 'uploaded_json' : 'uploaded';

            // Update hidden #openPGN so downstream code has a value
            const hiddenDropdown = document.getElementById('openPGN');
            hiddenDropdown.innerHTML =
                `<option value="${uploadVal}" selected>📤 ${file.name}</option>`;

            if (ext === 'json') parseJSON(content);
            else parsePGN(content.trim());

            if (!puzzleset || puzzleset.length === 0) {
                alert('No valid puzzles found in file.');
                return;
            }

            $('#puzzleNumber_landscape').text('1');
            $('#puzzleNumber_portrait').text('1');
            $('#puzzleNumbertotal_landscape').text(puzzleset.length);
            $('#puzzleNumbertotal_portrait').text(puzzleset.length);
            setDisplayAndDisabled(
                ['#btn_starttest_landscape','#btn_starttest_portrait'],
                'block', false);
            setCheckboxSelectability(true);

            alert(`✓ Loaded: ${file.name}\n${puzzleset.length} puzzles`);
        } catch (err) {
            alert('Error parsing file: ' + err.message);
            console.error(err);
        }
    };

    reader.readAsText(file);
    event.target.value = '';
}
