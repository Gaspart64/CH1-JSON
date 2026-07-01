/**
 * Handle PGN/JSON file upload from user's device
 */
function handlePGNFileUpload(event) {
    const file = event.target.files[0];
    if (!file) {
        console.warn('No file selected');
        return;
    }

    // Check file size (limit to 10MB)
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
        alert(`File is too large. Maximum size is 10MB. Your file is ${(file.size / 1024 / 1024).toFixed(2)}MB`);
        return;
    }

    // Check file extension
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext !== 'pgn' && ext !== 'json') {
        alert('Please select a valid .pgn or .json file');
        return;
    }

    const reader = new FileReader();
    reader.onerror = () => {
        alert(`Error reading file: ${reader.error}`);
        console.error('File read error:', reader.error);
    };

    reader.onload = (e) => {
        try {
            const content = e.target.result;
            if (!content || content.trim().length === 0) {
                alert('File is empty. Please select a valid file.');
                return;
            }

            // Store the content
            window.uploadedPGNContent = content;
            window.uploadedPGNFileName = file.name;

            const uploadVal = ext === 'json' ? 'uploaded_json' : 'uploaded';

            // Update hidden #openPGN
            $('#openPGN').val(uploadVal);

            // Trigger loadPGNFile to parse and setup the UI
            if (typeof loadPGNFile === 'function') {
                loadPGNFile();

                if (!puzzleset || puzzleset.length === 0) {
                    alert('No valid puzzles found in the file.');
                    return;
                }

                alert(`✓ Loaded: ${file.name}\n${puzzleset.length} puzzles found`);
                console.log(`Successfully loaded ${puzzleset.length} puzzles from ${file.name}`);
            } else {
                console.error("loadPGNFile function not found");
            }
        } catch (err) {
            alert(`Error parsing file: ${err.message}`);
            console.error('Parse Error:', err);
        }
    };

    reader.readAsText(file);
    event.target.value = '';
}
