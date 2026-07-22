# 💎 Diamond Music Manager

[![Tauri](https://img.shields.io/badge/Tauri-v2.0-blue?logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-1.80+-orange?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![React](https://img.shields.io/badge/React-19.0-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A high-performance, studio-grade desktop application for organizing, sanitizing, tagging, transcoding, and exporting large local music collections. Built with **Rust**, **Tauri v2**, **React 19**, and **TypeScript**.

---

## 🌟 Overview

**Diamond Music Manager** is engineered for audiophiles, DJs, and music collectors with extensive offline audio libraries. Managing thousands of local tracks often involves messy filenames (e.g. `Song_Name_music.com.bd_128kbps.mp3`), missing cover art, hidden OS system junk (`._*` AppleDouble files, `.DS_Store`), out-of-sync USB drives, and fragmented playlist files.

Diamond Music Manager unifies library management, metadata tag editing, rule-based playlist creation, smart sync exports, and multi-threaded audio transcoding into a single, lightning-fast desktop application.

---

## ✨ Key Features

### 📂 1. Music Library Explorer & Batch Tag Editor
* **Dynamic Split-Pane Directory Tree**: Drag-and-resize the sidebar separator to adjust the library explorer tree width on the fly.
* **Auto-Sync & OS File Watcher**: Native filesystem watcher using `notify` with 3-second debouncing. Real-time OS file changes automatically reflect in the UI. Toggle `⚡ Auto-Sync` or trigger a manual `🔄 Refresh` directly inside the Library header.
* **ID3 Metadata & Cover Art Editor**: Edit Title, Artist, Album, Genre, Year, and Track Number for individual files.
* **Recursive Folder Batch Tagging**: Recursively update metadata tags or embed cover art across entire folder hierarchies (or strip existing cover picture frames clean).
* **Smart Field Cleaning**: Deleting tag text fields completely strips the corresponding metadata frames instead of saving empty strings.

### ⚡ 2. Smart Sync Export Engine
* **Differential Export Sync**: Analyzes destination directories (e.g., external USB pendrives, SD cards, DAP players) and identifies **New Files**, **Up-To-Date Files**, and **Orphan Files**.
* **OS System Junk Filtering**: Automatically ignores macOS AppleDouble `._*` resource fork files, `.DS_Store`, `Thumbs.db`, and `desktop.ini` during orphan analysis and copy operations.
* **Byte Statistics & Speed Metrics**: Displays real-time copy progress, transfer speed (`MB/s`), and estimated time remaining (`ETA`).
* **Sticky Table Headers**: Data tables maintain fixed headers (`position: sticky`) for effortless scrolling over thousands of tracks.
* **Safe Deletion Modal**: Confirm permanent deletion of selected orphan files with multi-selection actions and paths clipboard export.

### 🧹 3. Rule Sanitizer & Junk Cleaner
* **Filename Sanitizer**: Strips website promo names (`music.com.bd`, `Tseries`), numbers, symbols, and custom phrase lists from audio filenames.
* **Metadata Tags Cleaner**: Deep-scans ID3/Vorbis tag fields (Title, Artist, Album, Comments) to clean unwanted text phrases recursively.
* **Hidden Files Remover**: Scans and removes hidden OS junk (`.DS_Store`, `._*`, `Thumbs.db`) from your music directories.
* **Task-Specific Cancellation**: Progress bar widget features inline `❌` stop buttons that cancel **only** the target task without interrupting parallel scans.

### 🎵 4. Smart Rule-Based Playlist Builder
* **Dynamic Rule Engine**: Create smart playlists based on rules (`Include Genre`, `Exclude Genre`, `Include Artist`, `Exclude Artist`, `Min/Max Year`).
* **Flexible Sorting & Limits**: Sort playlists by Artist, Title, Year, Duration, or Random, with optional track count caps.
* **Live Track Preview**: Instant track resolution and preview pane before generating playlist files.
* **M3U & M3U8 Export**: Export playlists with absolute or workspace-relative path declarations.

### 🎛️ 5. Multi-Threaded Audio Transcoder
* **Lossless to Lossy Conversion**: Batch-convert FLAC and WAV files into MP3, AAC, OGG, or M4A formats.
* **Configurable Bitrates**: Support for CBR bitrates from 128 kbps up to 320 kbps (Highest Quality).
* **Parallel Background Execution**: Powered by Tokio thread pools with real-time per-file progress status indicators.

### 🔊 6. Floating Audio Player & Queue Drawer
* **HTML5 Floating Player**: Sticky player supporting play/pause, seek slider, volume control, shuffle, single-song looping, and track queue drawer.
* **Lossless Audio Streaming**: Stream high-resolution FLAC, MP3, AAC, and WAV audio directly inside the application using Tauri's native custom protocol.

---

## 🛠️ Technology Stack & Architecture

```
                       ┌─────────────────────────────────────────┐
                       │     React 19 + TypeScript Frontend      │
                       │    (Vite, CSS Variables, Glassmorphism) │
                       └────────────────────┬────────────────────┘
                                            │ Tauri IPC Commands & Events
                       ┌────────────────────▼────────────────────┐
                       │           Tauri v2 Rust Core            │
                       └─────┬──────────────┬──────────────┬─────┘
                             │              │              │
                    ┌────────▼───────┐┌─────▼──────┐┌──────▼────────┐
                    │ Lofty Tagging  ││ Tokio Async││ Notify File   │
                    │ Engine         ││ Workers    ││ System Watcher│
                    └────────────────┘└────────────┘└───────────────┘
```

### Backend (Rust)
* **Tauri v2**: Low-overhead native desktop application wrapper.
* **Lofty**: Comprehensive audio metadata read/write engine for ID3v1/v2, Vorbis Comments, and MP4 tags.
* **Tokio**: Asynchronous runtime for non-blocking file scanning, parallel transcoding, and background tasks.
* **Notify**: Native OS filesystem event monitoring with debounce handling.
* **Claxon & Shine-rs**: FLAC parsing and MP3 encoding binaries.

### Frontend (React & TypeScript)
* **React 19**: Modern component architecture with `useMemo`, `useCallback`, and custom hooks.
* **TypeScript**: Strict type definitions (`src/types/index.ts`) for IPC data structures.
* **Vanilla CSS**: Custom dark mode design system with glassmorphic cards, CSS variables, sticky headers, and smooth transitions.
* **Vite**: Rapid hot-reloading development server and production bundler.

---

## 📁 Repository Layout

```
playlist-maker/
├── src/                          # Frontend Source Code
│   ├── components/               # React UI Components
│   │   ├── common/               # Shared Reusable Components
│   │   │   ├── ConfirmModal.tsx  # Accessible Modal Dialog Backdrop
│   │   │   └── ProgressBar.tsx   # Theme-Aware Progress Bar & Cancel Control
│   │   ├── AudioPlayer.tsx       # Global Floating HTML5 Player & Queue Drawer
│   │   ├── ResolvedTracksPanel.tsx# Shared Reusable Preview Track List
│   │   └── Sidebar.tsx           # Left Navigation Bar & Workspace Switcher
│   ├── hooks/                    # Custom React Hooks
│   │   └── useDebounce.ts        # Debounce Hook for Search Inputs
│   ├── types/                    # Shared TypeScript Interface Definitions
│   │   └── index.ts              # Data Contracts (Config, Track, DiffReport)
│   ├── utils/                    # Utility Modules
│   │   └── formatters.ts         # Shared Formatters (formatSize, formatDuration, etc.)
│   ├── views/                    # Main Application Views
│   │   ├── ExportView.tsx        # Smart Sync Export Engine & Diff Tables
│   │   ├── LibraryView.tsx       # Library Explorer & ID3 Batch Tag Editor
│   │   ├── PlaylistView.tsx      # Smart Rule-Based Playlist Generator
│   │   ├── SanitizerView.tsx     # Filename, Tag, & Hidden Junk Cleaner
│   │   ├── SettingsView.tsx      # Global Settings & Workspace Path Config
│   │   ├── ToolsView.tsx         # Sanitizer & Transcoder Container Tab
│   │   └── TranscoderView.tsx    # Multi-Threaded Audio Conversion Tool
│   ├── App.tsx                   # Central App Shell, State Machine, & IPC Listener
│   ├── App.css                   # Design System Tokens, CSS Variables, & Sticky Tables
│   └── main.tsx                  # React Application Entry Point
├── src-tauri/                    # Rust Backend Source Code
│   ├── src/
│   │   ├── export.rs             # Smart Sync Diff Analyzer & Export Logic
│   │   ├── library.rs            # Directory Tree Builder & Tag Metadata Writer
│   │   ├── playlist.rs           # Workspace Config Loader & M3U Compiler
│   │   ├── sanitizer.rs          # Filename, Tag, & Hidden File Sanitizers
│   │   ├── transcoder.rs         # Multithreaded Audio Transcoder Worker
│   │   ├── utils.rs              # Path Canonicalization & OS System Junk Checker
│   │   ├── watcher.rs            # Native OS File Watcher & Debounce Event Emitter
│   │   ├── lib.rs                # Tauri Command Registry & App Builder
│   │   └── main.rs               # Binary Entry Point
│   ├── Cargo.toml                # Rust Dependencies & Features
│   └── tauri.conf.json           # Tauri Desktop App Configuration
├── archive/                      # Legacy Scripts & Resources
├── package.json                  # Node.js Package Dependencies
└── README.md                     # Documentation
```

---

## 🚀 Getting Started

### 📋 Prerequisites

Make sure you have the following installed on your machine:
* **Rust**: `1.80+` ([Install Rust](https://www.rust-lang.org/tools/install))
* **Node.js**: `18.0+` ([Install Node.js](https://nodejs.org/))
* **pnpm**: `9.0+` (`npm install -g pnpm`)

Verify your environment:
```bash
rustc --version
node --version
pnpm --version
```

---

### 💻 Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/imranhasanhira/playlist-maker.git
   cd playlist-maker
   ```

2. **Install frontend dependencies**:
   ```bash
   pnpm install
   ```

---

### 🏃 Development Mode

Start the Tauri development desktop environment with hot-reloading:
```bash
pnpm tauri dev
```

---

### 📦 Production Build

Compile optimized release binaries for your operating system:

```bash
pnpm tauri build
```

The output executables will be generated in:
* **macOS**: `src-tauri/target/release/bundle/macos/Diamond Music Manager.app`
* **Windows**: `src-tauri/target/release/bundle/nsis/Diamond Music Manager.exe`
* **Linux**: `src-tauri/target/release/bundle/appimage/Diamond Music Manager.AppImage`

---

## 📖 Usage Guide

### 1. Setting Up Your Workspace
1. Launch **Diamond Music Manager**.
2. Navigate to **Settings** and select your **Music Source Directory** and **Playlists Export Directory**.
3. Save your configuration. The workspace configuration file (`workspace.json`) persists automatically.

### 2. Sanitizing Dirty Filenames & Metadata
1. Go to the **Tools > Sanitizer** tab.
2. Select a folder to scan.
3. Click **`📁 Scan Filenames`**, **`🏷️ Scan Metadata Tags`**, or **`👻 Scan Hidden Files`**.
4. Review preview changes in the results table.
5. Click **Apply Changes** to update filenames or wipe hidden system junk safely.

### 3. Smart Syncing to USB / Portable Drives
1. Navigate to the **Export** tab.
2. Select your target destination drive (e.g. `/Volumes/MY_USB_DRIVE/Music`).
3. Click **🔍 Analyze Export Differences**.
4. Review the diff tabs (**New Files**, **Up To Date**, **Orphans**).
5. Toggle **Delete Orphans** if you wish to remove obsolete tracks from the target drive automatically.
6. Click **⚡ Start Smart Export**.

---

## 🧪 Verification & Testing

Run backend tests and compilation checks:
```bash
# Verify Rust compilation & lints
cd src-tauri && cargo check

# Build production React frontend
cd .. && pnpm run build
```

---

## 📄 License

This project is licensed under the **MIT License**. See [LICENSE](LICENSE) for details.
