# 💎 Diamond Music Manager

A high-performance, Rust-powered desktop studio built with Tauri, React, and TypeScript. **Diamond Music Manager** offers a seamless, premium interface for managing, tagging, sanitizing, and transcoding local music collections.

---

## ✨ Key Features

* **📂 Movable split-pane Library tree**: Drag-and-resize the sidebar separator to adjust the file tree explorer width dynamically.
* **🏷️ Full ID3 Tag & Batch Cover Art Editor**:
  * Edit metadata tags (Title, Artist, Album, Genre, Year, Track #) for individual files.
  * Update directory audio files recursively with a batch cover art image (JPG/PNG converted to base64) or strip all picture frames recursively.
  * Deleting metadata fields automatically removes tag headers instead of writing empty strings.
* **🧹 Customizable Rules Sanitizer & Cleaner**:
  * **Filename Cleaner**: Filter case-insensitive web-phrases, numbering patterns, and symbols out of filenames.
  * **Metadata Tags Cleaner**: Deep-scans Title, Artist, Album, and Comment/Description fields to clean or remove unwanted strip phrases recursively.
  * **Hidden Junk Remover**: Automatically find and wipe hidden system files (like `.DS_Store`, etc.) from your workspace.
* **⚡ Multithreaded FLAC Transcoder**: Batch-convert lossless FLAC audio files to high-quality MP3 configurations (CBR up to 320kbps) inside a background Tokio execution thread.
* **🎵 Local Audio Player & Playlists Generator**:
  * Stream audio tracks directly inside the app with a sleek floating sticky player. The player collapses and yields layout padding when idle.
  * Compile `.m3u` playlists using preferences for absolute path declarations or configuration-relative mappings.
* **🔄 Parallel Task Manager**: All major directory operations run in tokio blocking workers, feeding real-time percentage loops (`Item 120 of 1000 (12%)`) to the frontend status drawer.
* **🔒 Last Configuration Persistence**: Automatically remembers and restores your last active workspace session configuration on startup.

---

## 🛠️ Tech Stack & Architecture

### Backend (Rust/Tokio)
* **Tauri v2**: Low-overhead native web view wrapper.
* **Lofty**: Fast audio metadata read/write backend supporting ID3, Vorbis Comments, and MP4 tags.
* **Claxon & Shine-rs**: Pure Rust FLAC parsing and MP3 encoding.
* **RFD**: Native desktop file-dialog overlays.

### Frontend (React/TypeScript)
* **Vite**: Rapid hot-reloading dev server.
* **CSS Variables**: Curated premium dark-mode theme colors (glassmorphic gradients, glowing indicators, layout adjustments).

---

## 🚀 Getting Started

### 📋 Prerequisites
Ensure you have Rust, Node.js, and package manager `pnpm` installed:
```bash
# Verify Rust compiler
rustc --version

# Verify pnpm package manager
pnpm --version
```

### 💻 Installation
Clone this repository and download frontend dependencies:
```bash
git clone https://github.com/imranhasanhira/playlist-maker.git
cd playlist-maker
pnpm install
```

### 💻 Running Development Mode
Start the interactive hot-reloading desktop development application:
```bash
pnpm tauri dev
```

### 📦 Compiling Executables (Production Build)
Generate production bundles with your native app name:
```bash
pnpm tauri build --bundles app
```
The compiled binaries will be outputted under:
* **macOS**: `src-tauri/target/release/bundle/macos/Diamond Music Manager.app`
* **Windows**: `src-tauri/target/release/bundle/nsis/Diamond Music Manager.exe`

---

## 📁 Repository Layout
```
├── src/                  # React Frontend Views & Components
│   ├── components/       # Reusable components (AudioPlayer, etc.)
│   ├── views/            # Screen views (Library, Playlists, Sanitizer, Settings)
│   ├── App.tsx           # Application frame layout and state machine
│   └── App.css           # Global typography & dark glassmorphic styling
├── src-tauri/            # Rust Backend source
│   ├── src/
│   │   ├── library.rs    # Library explorer & batch tag editing
│   │   ├── playlist.rs   # Workspace config loader & M3U compiling
│   │   ├── sanitizer.rs  # Count-first sanitizers & hidden files cleanups
│   │   ├── transcoder.rs # Multithreaded FLAC to MP3 transcoding
│   │   └── lib.rs        # Tauri entrypoint and API registration
│   └── Cargo.toml        # Rust package dependencies and targets
├── archive/              # Legacy resources & scripts
│   └── python/           # Python source files
├── index.html            # Web entry point
└── package.json          # Node.js dependencies
```
