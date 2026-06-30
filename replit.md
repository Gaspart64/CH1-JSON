# Chess PGN Trainer

## Overview
A web-based chess training application that allows users to practice chess games and puzzles using PGN (Portable Game Notation) files.

## Project Structure
- `index.html` - Main HTML page with the chess trainer interface
- `server.js` - Simple Node.js static file server
- `assets/` - JavaScript files for game logic and UI
  - `chess-pgn-trainer.js` - Main application logic
  - `game-modes.js` - Different training mode implementations
  - `storage.js` - Local storage handling
- `img/` - Image assets (chess pieces, icons)
- `PGN/` - Sample PGN files for training

## Running the Application
The app runs via a Node.js static file server on port 5000:
```
node server.js
```

## Technical Details
- Pure HTML/CSS/JavaScript frontend
- Uses external CDN libraries:
  - jQuery
  - chessboard.js for board rendering
  - chess.js for move validation
- No build step required

## Recent Changes
- Added server.js for static file serving in Replit environment
