use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

use crate::playlist::{self, MainConfig, TrackPreview};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub enum ExportStatus {
    New,
    Modified,
    UpToDate,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExportTrackItem {
    pub file_path: String,
    pub relative_path: String,
    pub dest_relative_path: String,
    pub size_bytes: u64,
    pub mtime_secs: u64,
    pub status: ExportStatus,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExportOrphanItem {
    pub file_path: String,
    pub relative_path: String,
    pub size_bytes: u64,
    pub is_playlist: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExportPlaylistItem {
    pub name: String,
    pub filename: String,
    pub track_count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExportDiffReport {
    pub destination: String,
    pub new_files: Vec<ExportTrackItem>,
    pub up_to_date_files: Vec<ExportTrackItem>,
    pub orphan_files: Vec<ExportOrphanItem>,
    pub playlists: Vec<ExportPlaylistItem>,
    pub total_bytes_to_copy: u64,
    pub total_bytes_up_to_date: u64,
    pub total_bytes_orphans: u64,
}

fn sanitize_playlist_filename(name: &str) -> String {
    let invalid_chars = ['/', '\\', '?', '%', '*', ':', '|', '"', '<', '>'];
    let clean: String = name
        .chars()
        .map(|ch| if invalid_chars.contains(&ch) { '_' } else { ch })
        .collect();
    let trimmed = clean.trim();
    if trimmed.is_empty() {
        "playlist".to_string()
    } else {
        trimmed.to_string()
    }
}

fn get_file_mtime_and_size(path: &Path) -> Option<(u64, u64)> {
    let metadata = fs::metadata(path).ok()?;
    let size = metadata.len();
    let mtime = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some((mtime, size))
}

fn canonical_path_str(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
pub async fn analyze_export_diff(
    config_path: String,
    destination: String,
    formats: Vec<String>,
    relative_to_config: bool,
) -> Result<ExportDiffReport, String> {
    let config_file_path = Path::new(&config_path);
    if !config_file_path.exists() {
        return Err(format!("Configuration file not found: {}", config_path));
    }

    let config = playlist::read_config_file(config_file_path)?;

    let resolved_source_dir = playlist::find_right_dir(
        None,
        config.source_dir.clone(),
        relative_to_config,
        config_file_path,
    );

    let formats_set: HashSet<String> = formats
        .iter()
        .map(|s| s.trim().to_lowercase())
        .collect();

    let dest_path = Path::new(&destination);
    let dest_music_dir = dest_path.join("music");
    let dest_playlists_dir = dest_path.join("playlists");

    // Map of unique source tracks across all playlists: relative_path -> (absolute_source_path, TrackPreview)
    let mut required_tracks: HashMap<String, (String, TrackPreview)> = HashMap::new();
    let mut playlist_items: Vec<ExportPlaylistItem> = Vec::new();

    for pl in &config.playlists {
        let (files, _) = playlist::resolve_playlist_files(pl, &resolved_source_dir, &formats_set);
        let sanitized_name = sanitize_playlist_filename(&pl.name);
        let filename = format!("{}.m3u8", sanitized_name);

        playlist_items.push(ExportPlaylistItem {
            name: pl.name.clone(),
            filename,
            track_count: files.len(),
        });

        for file_path_buf in files {
            let track_src_path = file_path_buf.as_path();
            let canonical_src = fs::canonicalize(track_src_path).unwrap_or_else(|_| track_src_path.to_path_buf());
            let track = playlist::get_track_preview(&canonical_src, &resolved_source_dir);

            // Compute relative path from resolved_source_dir
            let rel_path = match canonical_src.strip_prefix(&resolved_source_dir) {
                Ok(p) => p.to_string_lossy().to_string(),
                Err(_) => track_src_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| track.title.clone()),
            };

            let rel_clean = rel_path.replace('\\', "/");
            required_tracks.entry(rel_clean).or_insert((canonical_path_str(&canonical_src), track));
        }
    }

    let mut new_files: Vec<ExportTrackItem> = Vec::new();
    let mut up_to_date_files: Vec<ExportTrackItem> = Vec::new();
    let mut total_bytes_to_copy: u64 = 0;
    let mut total_bytes_up_to_date: u64 = 0;

    let mut expected_dest_rel_paths: HashSet<String> = HashSet::new();

    for (rel_path, (src_abs_path, _track)) in &required_tracks {
        expected_dest_rel_paths.insert(rel_path.clone());

        let src_path = Path::new(src_abs_path);
        let dest_file_path = dest_music_dir.join(rel_path);

        let (src_mtime, src_size) = get_file_mtime_and_size(src_path).unwrap_or((0, 0));

        let status = if dest_file_path.exists() {
            if let Some((dest_mtime, dest_size)) = get_file_mtime_and_size(&dest_file_path) {
                if src_size == dest_size && src_mtime <= dest_mtime {
                    ExportStatus::UpToDate
                } else {
                    ExportStatus::Modified
                }
            } else {
                ExportStatus::New
            }
        } else {
            ExportStatus::New
        };

        let item = ExportTrackItem {
            file_path: src_abs_path.clone(),
            relative_path: rel_path.clone(),
            dest_relative_path: format!("music/{}", rel_path),
            size_bytes: src_size,
            mtime_secs: src_mtime,
            status: status.clone(),
        };

        match status {
            ExportStatus::UpToDate => {
                total_bytes_up_to_date += src_size;
                up_to_date_files.push(item);
            }
            ExportStatus::New | ExportStatus::Modified => {
                total_bytes_to_copy += src_size;
                new_files.push(item);
            }
        }
    }

fn is_os_system_junk(filename: &str) -> bool {
    filename.starts_with('.')
        || filename.starts_with("._")
        || filename.eq_ignore_ascii_case("thumbs.db")
        || filename.eq_ignore_ascii_case("desktop.ini")
}

    // Expected playlist filenames
    let expected_playlists: HashSet<String> = playlist_items.iter().map(|p| p.filename.clone()).collect();

    // Scan destination for orphans
    let mut orphan_files: Vec<ExportOrphanItem> = Vec::new();
    let mut total_bytes_orphans: u64 = 0;

    if dest_music_dir.exists() {
        for entry in WalkDir::new(&dest_music_dir).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                if let Some(file_name) = entry.path().file_name().and_then(|n| n.to_str()) {
                    if is_os_system_junk(file_name) {
                        continue;
                    }
                }
                if let Ok(rel) = entry.path().strip_prefix(&dest_music_dir) {
                    let rel_clean = rel.to_string_lossy().replace('\\', "/");
                    if !expected_dest_rel_paths.contains(&rel_clean) {
                        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        total_bytes_orphans += size;
                        orphan_files.push(ExportOrphanItem {
                            file_path: entry.path().to_string_lossy().to_string(),
                            relative_path: format!("music/{}", rel_clean),
                            size_bytes: size,
                            is_playlist: false,
                        });
                    }
                }
            }
        }
    }

    if dest_playlists_dir.exists() {
        for entry in WalkDir::new(&dest_playlists_dir).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                if let Some(file_name) = entry.path().file_name().and_then(|n| n.to_str()) {
                    if is_os_system_junk(file_name) {
                        continue;
                    }
                }
                if let Ok(rel) = entry.path().strip_prefix(&dest_playlists_dir) {
                    let filename = rel.to_string_lossy().to_string();
                    if !expected_playlists.contains(&filename) {
                        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        total_bytes_orphans += size;
                        orphan_files.push(ExportOrphanItem {
                            file_path: entry.path().to_string_lossy().to_string(),
                            relative_path: format!("playlists/{}", filename),
                            size_bytes: size,
                            is_playlist: true,
                        });
                    }
                }
            }
        }
    }

    new_files.sort_by(|a, b| a.relative_path.to_lowercase().cmp(&b.relative_path.to_lowercase()));
    up_to_date_files.sort_by(|a, b| a.relative_path.to_lowercase().cmp(&b.relative_path.to_lowercase()));
    orphan_files.sort_by(|a, b| a.relative_path.to_lowercase().cmp(&b.relative_path.to_lowercase()));
    playlist_items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(ExportDiffReport {
        destination: destination.to_string(),
        new_files,
        up_to_date_files,
        orphan_files,
        playlists: playlist_items,
        total_bytes_to_copy,
        total_bytes_up_to_date,
        total_bytes_orphans,
    })
}

#[tauri::command]
pub async fn reveal_in_finder(filePath: String) -> Result<(), String> {
    let path = Path::new(&filePath);
    if !path.exists() {
        return Err(format!("File does not exist: {}", filePath));
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&filePath)
            .spawn()
            .map_err(|e| format!("Failed to reveal file in Finder: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&filePath)
            .spawn()
            .map_err(|e| format!("Failed to reveal file in Explorer: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        let dir = path.parent().unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to open directory: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_export_files(filePaths: Vec<String>) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let mut count = 0;
        for path_str in filePaths {
            let path = Path::new(&path_str);
            if path.exists() || path.symlink_metadata().is_ok() {
                if let Ok(metadata) = path.symlink_metadata() {
                    let mut permissions = metadata.permissions();
                    if permissions.readonly() {
                        permissions.set_readonly(false);
                        let _ = fs::set_permissions(path, permissions);
                    }
                }
                if path.is_dir() {
                    if fs::remove_dir_all(path).is_ok() {
                        count += 1;
                    }
                } else {
                    if fs::remove_file(path).is_ok() {
                        count += 1;
                    }
                }
            }
        }
        Ok(count)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

pub static EXPORT_CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
pub struct ExportProgressPayload {
    pub current_file_index: usize,
    pub total_files: usize,
    pub copied_bytes: u64,
    pub total_bytes: u64,
    pub current_file: String,
}

#[tauri::command]
pub async fn cancel_export() -> Result<(), String> {
    EXPORT_CANCELLED.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn execute_export(
    app: tauri::AppHandle,
    taskId: String,
    config_path: String,
    destination: String,
    delete_orphans: bool,
    excluded_paths: Vec<String>,
    formats: Vec<String>,
    relative_to_config: bool,
) -> Result<Vec<String>, String> {
    use tauri::Emitter;

    EXPORT_CANCELLED.store(false, Ordering::SeqCst);

    let mut logs: Vec<String> = Vec::new();
    let push_log = |msg: String, logs: &mut Vec<String>| {
        let _ = app.emit("export-log", msg.clone());
        logs.push(msg);
    };

    push_log("Starting smart sync export process...".to_string(), &mut logs);

    let report = analyze_export_diff(
        config_path.clone(),
        destination.clone(),
        formats.clone(),
        relative_to_config,
    )
    .await?;

    let excluded_set: HashSet<String> = excluded_paths.into_iter().collect();

    let dest_path = Path::new(&destination);
    let dest_music_dir = dest_path.join("music");
    let dest_playlists_dir = dest_path.join("playlists");

    fs::create_dir_all(&dest_music_dir)
        .map_err(|e| format!("Failed to create destination music directory: {}", e))?;
    fs::create_dir_all(&dest_playlists_dir)
        .map_err(|e| format!("Failed to create destination playlists directory: {}", e))?;

    // 1. Copy New & Modified files
    push_log(format!("Found {} new/modified audio files to copy.", report.new_files.len()), &mut logs);
    push_log(format!("Skipping {} up-to-date audio files.", report.up_to_date_files.len()), &mut logs);

    let total_files = report.new_files.len();
    let total_bytes = report.total_bytes_to_copy;
    let mut copied_bytes: u64 = 0;

    for (idx, item) in report.new_files.iter().enumerate() {
        if EXPORT_CANCELLED.load(Ordering::SeqCst) {
            push_log("Export stopped by user!".to_string(), &mut logs);
            return Err("Export stopped by user.".to_string());
        }

        if excluded_set.contains(&item.relative_path) {
            push_log(format!("Skipping user-excluded file: {}", item.relative_path), &mut logs);
            continue;
        }

        let _ = app.emit(
            "export-progress",
            ExportProgressPayload {
                current_file_index: idx + 1,
                total_files,
                copied_bytes,
                total_bytes,
                current_file: item.relative_path.clone(),
            },
        );

        let src_path = Path::new(&item.file_path);
        let dest_file_path = dest_music_dir.join(&item.relative_path);

        if let Some(parent) = dest_file_path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent).ok();
            }
        }

        push_log(format!("[{}/{}] Copying: {}", idx + 1, total_files, item.relative_path), &mut logs);

        if let Err(e) = fs::copy(src_path, &dest_file_path) {
            push_log(format!("WARNING: Failed to copy file '{}': {}", item.file_path, e), &mut logs);
            continue;
        }

        copied_bytes += item.size_bytes;

        // Preserve modification time if possible
        if let Ok(metadata) = fs::metadata(src_path) {
            if let Ok(mtime) = metadata.modified() {
                if let Ok(file) = fs::OpenOptions::new().write(true).open(&dest_file_path) {
                    file.set_modified(mtime).ok();
                }
            }
        }

        let _ = app.emit(
            "task-progress",
            crate::sanitizer::TaskProgress {
                task_id: taskId.clone(),
                task_name: "Smart Sync Export".to_string(),
                index: idx,
                total: total_files,
                status: if idx + 1 == total_files { "completed".to_string() } else { "running".to_string() },
                message: item.relative_path.clone(),
                file_path: None,
            },
        );
    }

    // 2. Generate M3U files in <destination>/playlists/
    push_log(format!("Generating {} M3U8 playlist files...", report.playlists.len()), &mut logs);

    let config_file_path = Path::new(&config_path);
    let config = playlist::read_config_file(config_file_path)?;

    let resolved_source_dir = playlist::find_right_dir(
        None,
        config.source_dir.clone(),
        relative_to_config,
        config_file_path,
    );

    let formats_set: HashSet<String> = formats
        .iter()
        .map(|s| s.trim().to_lowercase())
        .collect();

    for pl in &config.playlists {
        let (files, _) = playlist::resolve_playlist_files(pl, &resolved_source_dir, &formats_set);
        let sanitized_name = sanitize_playlist_filename(&pl.name);
        let filename = format!("{}.m3u8", sanitized_name);
        let m3u_path = dest_playlists_dir.join(&filename);

        if let Ok(mut file) = fs::File::create(&m3u_path) {
            writeln!(file, "#EXTM3U").ok();

            for file_path_buf in files {
                let track_src_path = file_path_buf.as_path();
                let canonical_src = fs::canonicalize(track_src_path).unwrap_or_else(|_| track_src_path.to_path_buf());
                let track = playlist::get_track_preview(&canonical_src, &resolved_source_dir);

                let rel_path = match canonical_src.strip_prefix(&resolved_source_dir) {
                    Ok(p) => p.to_string_lossy().to_string(),
                    Err(_) => track_src_path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| track.title.clone()),
                };

                let rel_clean = rel_path.replace('\\', "/");
                let m3u_track_ref = format!("../music/{}", rel_clean);

                writeln!(file, "#EXTINF:{},{} - {}", track.duration, track.artist, track.title).ok();
                writeln!(file, "{}", m3u_track_ref).ok();
            }
            push_log(format!("Created playlist: {}", filename), &mut logs);
        }
    }

    // 3. Delete Orphans if requested
    if delete_orphans && !report.orphan_files.is_empty() {
        push_log(format!("Cleaning up {} orphan files from destination...", report.orphan_files.len()), &mut logs);
        for orphan in &report.orphan_files {
            let orphan_path = Path::new(&orphan.file_path);
            if orphan_path.exists() {
                if orphan_path.is_dir() {
                    if fs::remove_dir_all(orphan_path).is_ok() {
                        push_log(format!("Removed orphan folder: {}", orphan.relative_path), &mut logs);
                    }
                } else {
                    if fs::remove_file(orphan_path).is_ok() {
                        push_log(format!("Removed orphan file: {}", orphan.relative_path), &mut logs);
                    }
                }
            }
        }
    }

    push_log("Export completed successfully!".to_string(), &mut logs);
    Ok(logs)
}
