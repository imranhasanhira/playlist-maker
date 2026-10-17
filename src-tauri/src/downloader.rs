use lofty::probe::Probe;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::Accessor;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DownloadLogPayload {
    pub job_id: String,
    pub line: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DownloadProgressPayload {
    pub job_id: String,
    pub status: String,
    pub progress: f64,
    pub current_item: Option<u32>,
    pub total_items: Option<u32>,
    pub title: Option<String>,
    pub error: Option<String>,
}

static ACTIVE_PROCESSES: OnceLock<Arc<Mutex<HashMap<String, Child>>>> = OnceLock::new();

fn get_active_processes() -> &'static Arc<Mutex<HashMap<String, Child>>> {
    ACTIVE_PROCESSES.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

pub fn sanitize_folder_name(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect();
    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        "Default".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Unified yt-dlp audio extraction arguments shared across playlist downloads and MP3-to-M4A upgrades.
/// Ensures consistent audio stream selection, format conversion, quality settings, and tag/thumbnail embedding.
pub fn get_standard_ytdlp_audio_args(audio_format: &str) -> Vec<String> {
    vec![
        "-f".to_string(),
        "ba[ext=m4a]/ba".to_string(),
        "-x".to_string(),
        "--audio-format".to_string(),
        audio_format.to_string(),
        "--audio-quality".to_string(),
        "0".to_string(),
        "--embed-thumbnail".to_string(),
        "--embed-metadata".to_string(),
        "--convert-thumbnails".to_string(),
        "jpg".to_string(),
    ]
}

#[tauri::command]
pub async fn start_download_job(
    app: AppHandle,
    job_id: String,
    url: String,
    output_dir: String,
    audio_format: String,
    use_archive: bool,
    archive_path: String,
    ignore_errors: bool,
    folder_name: Option<String>,
) -> Result<(), String> {
    let mut args = get_standard_ytdlp_audio_args(&audio_format);

    if ignore_errors {
        args.insert(0, "--ignore-errors".to_string());
    }

    if use_archive {
        let arch = if archive_path.trim().is_empty() {
            format!("{}/archive.txt", output_dir)
        } else {
            archive_path.clone()
        };
        args.push("--download-archive".to_string());
        args.push(arch);
    }

    // Output template: use user's entry name if provided, otherwise default to YouTube's %(playlist_title)s
    let folder_part = folder_name
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(sanitize_folder_name)
        .unwrap_or_else(|| "%(playlist_title)s".to_string());
    let out_template = format!("{}/{}/%(title)s.%(ext)s", output_dir, folder_part);
    args.push("-o".to_string());
    args.push(out_template);

    args.push(url.clone());

    let mut command = Command::new("yt-dlp");
    command
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let formatted_args = args
        .iter()
        .map(|a| {
            if a.contains(' ') || a.contains('"') || a.contains('\'') || a.contains('[') || a.contains(']') || a.contains('$') || a.contains('%') {
                format!("\"{}\"", a.replace('\\', "\\\\").replace('"', "\\\""))
            } else {
                a.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let full_command = format!("$ yt-dlp {}", formatted_args);

    let _ = app.emit(
        "download-log",
        DownloadLogPayload {
            job_id: job_id.clone(),
            line: full_command,
        },
    );

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start yt-dlp. Make sure yt-dlp is installed and in PATH: {}", e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Store child process handle
    if let Ok(mut guard) = get_active_processes().lock() {
        guard.insert(job_id.clone(), child);
    }

    let job_id_clone = job_id.clone();
    let app_clone = app.clone();

    // Monitor process execution asynchronously
    tokio::spawn(async move {
        let mut last_progress: f64 = 0.0;
        let mut detected_title: Option<String> = None;
        let mut current_item: Option<u32> = None;
        let mut total_items: Option<u32> = None;
        let mut playlist_finished = false;

        if let Some(stdout_stream) = stdout {
            let mut reader = BufReader::new(stdout_stream).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                // Check playlist completion signal
                if line.contains("Finished downloading playlist:") {
                    playlist_finished = true;
                }

                let mut item_updated = false;

                // Parse "Downloading item 33 of 34"
                if line.contains("Downloading item ") && line.contains(" of ") {
                    if let Some(idx) = line.find("Downloading item ") {
                        let rest = &line[idx + "Downloading item ".len()..];
                        let parts: Vec<&str> = rest.split_whitespace().collect();
                        if parts.len() >= 3 && parts[1] == "of" {
                            if let (Ok(curr), Ok(tot)) = (parts[0].parse::<u32>(), parts[2].parse::<u32>()) {
                                current_item = Some(curr);
                                total_items = Some(tot);
                                item_updated = true;
                            }
                        }
                    }
                }
                // Parse "Downloading 34 items of 34"
                else if line.contains("Downloading ") && line.contains(" items of ") {
                    if let Some(idx) = line.find("Downloading ") {
                        let rest = &line[idx + "Downloading ".len()..];
                        let parts: Vec<&str> = rest.split_whitespace().collect();
                        if parts.len() >= 4 && parts[1] == "items" && parts[2] == "of" {
                            if let (Ok(curr), Ok(tot)) = (parts[0].parse::<u32>(), parts[3].parse::<u32>()) {
                                current_item = Some(curr);
                                total_items = Some(tot);
                                item_updated = true;
                            }
                        }
                    }
                }
                else if line.contains("has already been recorded in the archive") {
                    item_updated = true;
                }

                // Emit raw log line
                let _ = app_clone.emit(
                    "download-log",
                    DownloadLogPayload {
                        job_id: job_id_clone.clone(),
                        line: line.clone(),
                    },
                );

                if item_updated {
                    let overall_progress = match (current_item, total_items) {
                        (Some(curr), Some(tot)) if tot > 0 => {
                            let completed = if curr > 0 { curr - 1 } else { 0 };
                            (completed as f64 / tot as f64 * 100.0).min(99.0)
                        }
                        _ => last_progress,
                    };
                    last_progress = overall_progress;
                    let _ = app_clone.emit(
                        "download-progress",
                        DownloadProgressPayload {
                            job_id: job_id_clone.clone(),
                            status: "running".to_string(),
                            progress: last_progress,
                            current_item,
                            total_items,
                            title: detected_title.clone(),
                            error: None,
                        },
                    );
                }

                // Parse progress percentage from yt-dlp stdout (e.g. "[download]  45.2% of  12.30MiB")
                if line.contains("[download]") && line.contains('%') {
                    if let Some(percent_idx) = line.find('%') {
                        let prefix = &line[..percent_idx];
                        if let Some(num_str) = prefix.split_whitespace().last() {
                            if let Ok(p) = num_str.parse::<f64>() {
                                let overall_progress = match (current_item, total_items) {
                                    (Some(curr), Some(tot)) if tot > 0 => {
                                        let completed_items = if curr > 0 { curr - 1 } else { 0 };
                                        let item_fraction = (p.min(100.0) / 100.0).max(0.0);
                                        ((completed_items as f64 + item_fraction) / tot as f64 * 100.0).min(99.9)
                                    }
                                    _ => p.min(99.0),
                                };

                                last_progress = overall_progress;
                                let _ = app_clone.emit(
                                    "download-progress",
                                    DownloadProgressPayload {
                                        job_id: job_id_clone.clone(),
                                        status: "running".to_string(),
                                        progress: last_progress,
                                        current_item,
                                        total_items,
                                        title: detected_title.clone(),
                                        error: None,
                                    },
                                );
                            }
                        }
                    }
                }


                // Extract playlist or video title if available
                if line.contains("[download] Downloading playlist:") || line.contains("Extracting URL:") {
                    let title_text = line.replace("[download] Downloading playlist:", "").trim().to_string();
                    if !title_text.is_empty() {
                        detected_title = Some(title_text);
                    }
                }
            }
        }

        if let Some(stderr_stream) = stderr {
            let mut reader = BufReader::new(stderr_stream).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_clone.emit(
                    "download-log",
                    DownloadLogPayload {
                        job_id: job_id_clone.clone(),
                        line: format!("[ERR] {}", line),
                    },
                );
            }
        }

        // Pop child process out of mutex before awaiting completion
        let mut child_opt = {
            let mut guard = get_active_processes().lock().unwrap();
            guard.remove(&job_id_clone)
        };

        let final_status = if let Some(mut process) = child_opt.take() {
            match process.wait().await {
                Ok(exit_status) => {
                    if exit_status.success() || playlist_finished {
                        "completed"
                    } else {
                        "failed"
                    }
                }
                Err(_) => {
                    if playlist_finished {
                        "completed"
                    } else {
                        "failed"
                    }
                }
            }
        } else {
            "cancelled"
        };

        let _ = app_clone.emit(
            "download-progress",
            DownloadProgressPayload {
                job_id: job_id_clone.clone(),
                status: final_status.to_string(),
                progress: if final_status == "completed" { 100.0 } else { last_progress },
                current_item,
                total_items,
                title: detected_title,
                error: if final_status == "failed" { Some("yt-dlp process returned non-zero exit code".to_string()) } else { None },
            },
        );
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_download_job(job_id: String) -> Result<(), String> {
    let mut child_to_kill = None;
    if let Ok(mut guard) = get_active_processes().lock() {
        child_to_kill = guard.remove(&job_id);
    }

    if let Some(mut child) = child_to_kill {
        let _ = child.kill().await;
        Ok(())
    } else {
        Ok(())
    }
}

fn resolve_archive_path(archive_path: &str, output_dir: &str) -> String {
    if archive_path.trim().is_empty() {
        format!("{}/archive.txt", output_dir)
    } else {
        archive_path.to_string()
    }
}

#[tauri::command]
pub async fn reset_archive_file(archive_path: String, output_dir: String) -> Result<(), String> {
    let resolved = resolve_archive_path(&archive_path, &output_dir);
    let path = std::path::Path::new(&resolved);
    if path.exists() {
        std::fs::write(path, "")
            .map_err(|e| format!("Failed to clear archive file: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn reset_playlist_archive_ids(
    url: String,
    archive_path: String,
    output_dir: String,
) -> Result<usize, String> {
    if url.trim().is_empty() {
        return Err("Please enter a valid YouTube playlist URL".to_string());
    }

    let resolved = resolve_archive_path(&archive_path, &output_dir);
    let archive_file_path = std::path::Path::new(&resolved);

    if !archive_file_path.exists() {
        return Err(format!("Archive file not found at: {}", resolved));
    }

    // 1. Fetch video IDs from playlist using yt-dlp --flat-playlist --print id <url>
    let output = Command::new("yt-dlp")
        .args(&["--flat-playlist", "--print", "id", &url])
        .output()
        .await
        .map_err(|e| format!("Failed to execute yt-dlp to query playlist video IDs: {}", e))?;

    if !output.status.success() {
        let err_msg = String::from_utf8_lossy(&output.stderr);
        return Err(format!("yt-dlp error fetching playlist IDs: {}", err_msg));
    }

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let video_ids: std::collections::HashSet<String> = stdout_str
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();

    if video_ids.is_empty() {
        return Err("No video IDs found for the specified playlist URL".to_string());
    }

    // 2. Filter archive file content
    let content = std::fs::read_to_string(archive_file_path)
        .map_err(|e| format!("Failed to read archive file: {}", e))?;

    let mut remaining_lines = Vec::new();
    let mut removed_count = 0;

    for line in content.lines() {
        let trimmed = line.trim();
        let is_match = video_ids.iter().any(|id| {
            trimmed.ends_with(id) || trimmed.contains(id)
        });

        if is_match {
            removed_count += 1;
        } else {
            remaining_lines.push(line);
        }
    }

    // 3. Write back filtered lines
    let new_content = if remaining_lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", remaining_lines.join("\n"))
    };

    std::fs::write(archive_file_path, new_content)
        .map_err(|e| format!("Failed to update archive file: {}", e))?;

    Ok(removed_count)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlaylistMetadata {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub total_songs: u32,
    pub video_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DeleteFilesReport {
    pub files: Vec<String>,
    pub total_bytes: u64,
}

#[tauri::command]
pub async fn dl_fetch_playlist_metadata(url: String) -> Result<PlaylistMetadata, String> {
    if url.trim().is_empty() {
        return Err("URL cannot be empty".to_string());
    }

    let output = Command::new("yt-dlp")
        .args(&["--flat-playlist", "--dump-single-json", &url])
        .output()
        .await
        .map_err(|e| format!("Failed to execute yt-dlp: {}", e))?;

    if !output.status.success() {
        let err_msg = String::from_utf8_lossy(&output.stderr);
        return Err(format!("yt-dlp failed: {}", err_msg));
    }

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(&stdout_str)
        .map_err(|e| format!("Failed to parse metadata JSON: {}", e))?;

    let mut video_ids = Vec::new();

    let _type = json.get("_type").and_then(|v| v.as_str()).unwrap_or("");

    let (title, artist, album) = if _type == "playlist" || json.get("entries").is_some() {
        let t = json.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let art = json.get("uploader").or_else(|| json.get("channel")).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let alb = json.get("album").and_then(|v| v.as_str()).unwrap_or("").to_string();

        if let Some(entries) = json.get("entries").and_then(|v| v.as_array()) {
            for entry in entries {
                if let Some(id) = entry.get("id").and_then(|v| v.as_str()) {
                    video_ids.push(id.to_string());
                }
            }
        }
        (t, art, alb)
    } else {
        // Single video
        let t = json.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let art = json.get("uploader").or_else(|| json.get("artist")).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let alb = json.get("album").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if let Some(id) = json.get("id").and_then(|v| v.as_str()) {
            video_ids.push(id.to_string());
        }
        (t, art, alb)
    };


    let total_songs = video_ids.len() as u32;

    Ok(PlaylistMetadata {
        title,
        artist,
        album,
        total_songs,
        video_ids,
    })
}

#[tauri::command]
pub async fn dl_rename_entry_folder(
    output_dir: String,
    old_name: String,
    new_name: String,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let base_path = std::path::Path::new(&output_dir);
        let old_clean = sanitize_folder_name(&old_name);
        let new_clean = sanitize_folder_name(&new_name);
        if old_clean == new_clean {
            return Ok(false);
        }

        // Check if old folder exists (try sanitized name first, then raw old_name)
        let old_path = if base_path.join(&old_clean).exists() {
            base_path.join(&old_clean)
        } else if base_path.join(old_name.trim()).exists() {
            base_path.join(old_name.trim())
        } else {
            return Ok(false); // No folder on disk yet to rename
        };

        let new_path = base_path.join(&new_clean);
        if new_path.exists() && old_path != new_path {
            return Err(format!("Target folder '{}' already exists on disk", new_clean));
        }

        std::fs::rename(&old_path, &new_path)
            .map_err(|e| format!("Failed to rename folder from '{}' to '{}': {}", old_clean, new_clean, e))?;

        Ok(true)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
pub async fn dl_count_songs_on_disk(
    output_dir: String,
    playlist_title: String,
    formats: Vec<String>,
) -> Result<u32, String> {
    tokio::task::spawn_blocking(move || {
        let base_path = std::path::Path::new(&output_dir);
        let sanitized = sanitize_folder_name(&playlist_title);
        let target_dir = if !playlist_title.trim().is_empty() {
            if base_path.join(playlist_title.trim()).exists() {
                base_path.join(playlist_title.trim())
            } else if base_path.join(&sanitized).exists() {
                base_path.join(&sanitized)
            } else {
                base_path.join(playlist_title.trim())
            }
        } else {
            base_path.to_path_buf()
        };

        if !target_dir.exists() {
            return Ok(0);
        }

        let formats_set: std::collections::HashSet<String> = if formats.is_empty() {
            vec!["mp3", "m4a", "wav", "flac", "ogg", "aac", "wma", "alac", "opus"]
                .into_iter()
                .map(|s| s.to_string())
                .collect()
        } else {
            formats.into_iter().map(|s| s.to_lowercase()).collect()
        };

        let mut count = 0;
        for entry in walkdir::WalkDir::new(&target_dir).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                if let Some(ext) = entry.path().extension().and_then(|s| s.to_str()) {
                    if formats_set.contains(&ext.to_lowercase()) {
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

#[tauri::command]
pub async fn dl_get_delete_files_report(
    output_dir: String,
    playlist_title: String,
) -> Result<DeleteFilesReport, String> {
    tokio::task::spawn_blocking(move || {
        let base_path = std::path::Path::new(&output_dir);
        let sanitized = sanitize_folder_name(&playlist_title);
        let target_dir = if !playlist_title.trim().is_empty() {
            if base_path.join(playlist_title.trim()).exists() {
                base_path.join(playlist_title.trim())
            } else if base_path.join(&sanitized).exists() {
                base_path.join(&sanitized)
            } else {
                base_path.join(playlist_title.trim())
            }
        } else {
            base_path.to_path_buf()
        };

        if !target_dir.exists() {
            return Ok(DeleteFilesReport {
                files: Vec::new(),
                total_bytes: 0,
            });
        }

        let mut files = Vec::new();
        let mut total_bytes: u64 = 0;

        for entry in walkdir::WalkDir::new(&target_dir).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                if let Ok(meta) = entry.metadata() {
                    total_bytes += meta.len();
                }
                files.push(entry.path().to_string_lossy().to_string());
            }
        }

        files.sort();

        Ok(DeleteFilesReport { files, total_bytes })
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
pub async fn dl_execute_delete_files(
    output_dir: String,
    playlist_title: String,
    archive_path: String,
    video_ids: Vec<String>,
) -> Result<u32, String> {
    tokio::task::spawn_blocking(move || {
        let base_path = std::path::Path::new(&output_dir);
        let sanitized = sanitize_folder_name(&playlist_title);
        let target_dir = if !playlist_title.trim().is_empty() {
            if base_path.join(playlist_title.trim()).exists() {
                base_path.join(playlist_title.trim())
            } else if base_path.join(&sanitized).exists() {
                base_path.join(&sanitized)
            } else {
                base_path.join(playlist_title.trim())
            }
        } else {
            base_path.to_path_buf()
        };

        let mut deleted_count = 0;
        if target_dir.exists() {
            // Delete all files inside target_dir
            for entry in walkdir::WalkDir::new(&target_dir).into_iter().filter_map(|e| e.ok()) {
                if entry.file_type().is_file() {
                    if std::fs::remove_file(entry.path()).is_ok() {
                        deleted_count += 1;
                    }
                }
            }
            // Remove target directory if empty or remove directory tree
            let _ = std::fs::remove_dir_all(&target_dir);
        }

        // Clean up archive file if specified
        if !video_ids.is_empty() {
            let resolved_archive = resolve_archive_path(&archive_path, &output_dir);
            let archive_file_path = std::path::Path::new(&resolved_archive);
            if archive_file_path.exists() {
                if let Ok(content) = std::fs::read_to_string(archive_file_path) {
                    let id_set: std::collections::HashSet<String> = video_ids.into_iter().collect();
                    let remaining_lines: Vec<&str> = content
                        .lines()
                        .filter(|line| {
                            let trimmed = line.trim();
                            !id_set.iter().any(|id| trimmed.ends_with(id) || trimmed.contains(id))
                        })
                        .collect();

                    let new_content = if remaining_lines.is_empty() {
                        String::new()
                    } else {
                        format!("{}\n", remaining_lines.join("\n"))
                    };
                    let _ = std::fs::write(archive_file_path, new_content);
                }
            }
        }

        Ok(deleted_count)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReconcilePlaylistReport {
    pub playlist_title: String,
    pub total_online: u32,
    pub songs_on_disk: u32,
    pub matched_on_disk: u32,
    pub missing_count: u32,
    pub missing_ids: Vec<String>,
    pub missing_titles: Vec<String>,
    pub pruned_from_archive: usize,
    pub added_to_archive: usize,
    pub logs: Vec<String>,
}

fn normalize_match_str(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

pub fn is_valid_standalone_youtube_id(id: &str) -> bool {
    let trimmed = id.trim();
    if trimmed.len() != 11 {
        return false;
    }
    // Must contain only ASCII URL-safe base64 characters [a-zA-Z0-9_-]
    if !trimmed.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return false;
    }

    let has_digit = trimmed.chars().any(|c| c.is_ascii_digit());
    let has_symbol = trimmed.contains('-') || trimmed.contains('_');

    // A real YouTube video ID almost always contains at least one digit or symbol
    if has_digit || has_symbol {
        return true;
    }

    // If it contains ONLY letters (no digits, no symbols):
    let chars: Vec<char> = trimmed.chars().collect();
    let is_all_lower = chars.iter().all(|c| c.is_ascii_lowercase());
    let is_all_upper = chars.iter().all(|c| c.is_ascii_uppercase());
    let is_titlecase = chars[0].is_ascii_uppercase() && chars[1..].iter().all(|c| c.is_ascii_lowercase());

    // Filter out common English/human words, artist names, genre names, etc.
    // e.g. "Chakraborty", "Alternative", "Performance", "Composition", "Traditional"
    if is_all_lower || is_all_upper || is_titlecase {
        return false;
    }

    true
}

struct LocalFileScanned {
    detected_id: Option<String>,
    normalized_title: String,
}

#[tauri::command]
pub async fn dl_reconcile_playlist_archive(
    app: AppHandle,
    job_id: Option<String>,
    url: String,
    output_dir: String,
    playlist_title: String,
    archive_path: String,
) -> Result<ReconcilePlaylistReport, String> {
    if url.trim().is_empty() {
        return Err("Playlist URL cannot be empty".to_string());
    }

    let display_title = if !playlist_title.trim().is_empty() {
        playlist_title.trim().to_string()
    } else {
        url.clone()
    };

    let base_path = Path::new(&output_dir);
    let target_dir = if !playlist_title.trim().is_empty() {
        base_path.join(playlist_title.trim())
    } else {
        base_path.to_path_buf()
    };

    let mut logs: Vec<String> = Vec::new();
    let emit_line = |line: &str, logs: &mut Vec<String>| {
        logs.push(line.to_string());
        if let Some(ref jid) = job_id {
            let _ = app.emit(
                "download-log",
                DownloadLogPayload {
                    job_id: jid.clone(),
                    line: line.to_string(),
                },
            );
        }
    };

    // Prepend clear visual separation if anything else exists in logs
    emit_line("", &mut logs);
    emit_line("================================================================================", &mut logs);
    emit_line(&format!("🔄 RECONCILING ARCHIVE FROM DISK: {}", display_title), &mut logs);
    emit_line(&format!("Folder: {}", target_dir.display()), &mut logs);
    emit_line("================================================================================", &mut logs);

    // 1. Scan local files on disk
    emit_line(&format!("[reconcile] Scanning local audio files in \"{}\"...", target_dir.display()), &mut logs);

    let id_bracket_re = Regex::new(r"\[([a-zA-Z0-9_-]{11})\]").unwrap();
    let id_paren_re = Regex::new(r"\(([a-zA-Z0-9_-]{11})\)").unwrap();
    let id_trailing_re = Regex::new(r"(?:^|[-_])([a-zA-Z0-9_-]{11})\.(?:mp3|m4a|flac|wav|ogg|opus|aac|alac)$").unwrap();
    let yt_url_re = Regex::new(r"(?:v=|youtu\.be/|/embed/|/v/|/watch\?v=)([a-zA-Z0-9_-]{11})").unwrap();

    let formats_set: HashSet<&str> = ["mp3", "m4a", "wav", "flac", "ogg", "aac", "wma", "alac", "opus"]
        .into_iter()
        .collect();

    let mut local_files: Vec<LocalFileScanned> = Vec::new();

    if target_dir.exists() {
        for entry in walkdir::WalkDir::new(&target_dir).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                let path = entry.path();
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if formats_set.contains(ext.to_lowercase().as_str()) {
                        let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();

                        // Detect ID from filename: prefer explicit URL first, then bracketed/trailing candidate validated as real YouTube ID
                        let mut detected_id = yt_url_re.captures(&filename)
                            .and_then(|c| c.get(1))
                            .map(|m| m.as_str().to_string());

                        if detected_id.is_none() {
                            detected_id = id_bracket_re.captures(&filename)
                                .or_else(|| id_paren_re.captures(&filename))
                                .or_else(|| id_trailing_re.captures(&filename))
                                .and_then(|c| c.get(1))
                                .map(|m| m.as_str().to_string())
                                .filter(|id| is_valid_standalone_youtube_id(id));
                        }

                        let mut tag_title = String::new();

                        // Probe audio tags if not detected in filename or to get tag title
                        if let Ok(tagged_file) = Probe::open(path).and_then(|p| p.read()) {
                            if let Some(tag) = tagged_file.primary_tag() {
                                if let Some(t) = tag.title() {
                                    tag_title = t.to_string();
                                }
                                if detected_id.is_none() {
                                    if let Some(comment) = tag.comment() {
                                        if let Some(caps) = yt_url_re.captures(&comment) {
                                            detected_id = caps.get(1).map(|m| m.as_str().to_string());
                                        }
                                    }
                                }
                                if detected_id.is_none() {
                                    for item in tag.items() {
                                        if let Some(val) = item.value().text() {
                                            if let Some(caps) = yt_url_re.captures(val) {
                                                detected_id = caps.get(1).map(|m| m.as_str().to_string());
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        let normalized_title = if !tag_title.trim().is_empty() {
                            normalize_match_str(&tag_title)
                        } else {
                            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                            normalize_match_str(stem)
                        };

                        local_files.push(LocalFileScanned {
                            detected_id,
                            normalized_title,
                        });
                    }
                }
            }
        }
    }

    emit_line(&format!("[reconcile] Found {} audio file(s) on disk.", local_files.len()), &mut logs);

    // 2. Query online playlist tracks via yt-dlp
    emit_line(&format!("$ yt-dlp --flat-playlist --dump-single-json \"{}\"", url), &mut logs);
    emit_line("[reconcile] Querying YouTube playlist metadata...", &mut logs);

    let output = Command::new("yt-dlp")
        .args(&["--flat-playlist", "--dump-single-json", &url])
        .output()
        .await
        .map_err(|e| format!("Failed to query YouTube playlist via yt-dlp: {}", e))?;

    if !output.status.success() {
        let err_msg = String::from_utf8_lossy(&output.stderr);
        emit_line(&format!("[reconcile] ❌ yt-dlp error: {}", err_msg), &mut logs);
        return Err(format!("yt-dlp error: {}", err_msg));
    }

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(&stdout_str)
        .map_err(|e| format!("Failed to parse metadata JSON: {}", e))?;

    struct OnlineTrack {
        id: String,
        title: String,
        normalized_title: String,
    }

    let mut online_tracks: Vec<OnlineTrack> = Vec::new();

    if let Some(entries) = json.get("entries").and_then(|v| v.as_array()) {
        for entry in entries {
            if let Some(id) = entry.get("id").and_then(|v| v.as_str()) {
                let title = entry.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let normalized_title = normalize_match_str(&title);
                online_tracks.push(OnlineTrack {
                    id: id.to_string(),
                    title,
                    normalized_title,
                });
            }
        }
    } else if let Some(id) = json.get("id").and_then(|v| v.as_str()) {
        let title = json.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let normalized_title = normalize_match_str(&title);
        online_tracks.push(OnlineTrack {
            id: id.to_string(),
            title,
            normalized_title,
        });
    }

    emit_line(&format!("[reconcile] YouTube playlist has {} track(s).", online_tracks.len()), &mut logs);
    emit_line("[reconcile] Cross-matching local files against YouTube tracks...", &mut logs);

    // 3. Match online tracks against local files
    let mut matched_disk_ids: HashSet<String> = HashSet::new();
    let mut missing_ids: Vec<String> = Vec::new();
    let mut missing_titles: Vec<String> = Vec::new();

    for track in &online_tracks {
        // Priority A: Exact ID match
        let mut found = local_files.iter().any(|f| f.detected_id.as_deref() == Some(&track.id));

        // Priority B: Normalized title match (fallback if song was sanitized without ID)
        if !found && !track.normalized_title.is_empty() && track.normalized_title.len() >= 6 {
            found = local_files.iter().any(|f| {
                if f.normalized_title.is_empty() || f.normalized_title.len() < 6 {
                    return false;
                }
                f.normalized_title == track.normalized_title
                    || f.normalized_title.contains(&track.normalized_title)
                    || track.normalized_title.contains(&f.normalized_title)
            });
        }

        if found {
            matched_disk_ids.insert(track.id.clone());
        } else {
            missing_ids.push(track.id.clone());
            missing_titles.push(track.title.clone());
        }
    }

    emit_line(&format!("[reconcile] Match result: {} verified on disk, {} missing from disk.", matched_disk_ids.len(), missing_ids.len()), &mut logs);

    if !missing_titles.is_empty() {
        emit_line("[reconcile] Missing tracks to be re-downloaded:", &mut logs);
        for (i, t) in missing_titles.iter().take(12).enumerate() {
            emit_line(&format!("  {:2}. {}", i + 1, t), &mut logs);
        }
        if missing_titles.len() > 12 {
            emit_line(&format!("  ... and {} more track(s)", missing_titles.len() - 12), &mut logs);
        }
    }

    // 4. Update archive file
    let resolved_archive = resolve_archive_path(&archive_path, &output_dir);
    let archive_file_path = Path::new(&resolved_archive);

    let mut existing_archive_lines: Vec<String> = if archive_file_path.exists() {
        std::fs::read_to_string(archive_file_path)
            .unwrap_or_default()
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    } else {
        Vec::new()
    };

    let initial_line_count = existing_archive_lines.len();

    // Prune missing IDs
    existing_archive_lines.retain(|line| {
        !missing_ids.iter().any(|mid| line.ends_with(mid) || line.contains(mid))
    });
    let pruned_count = initial_line_count - existing_archive_lines.len();

    // Ensure matched disk IDs are in archive
    let mut added_count = 0;
    for matched_id in &matched_disk_ids {
        let exists = existing_archive_lines.iter().any(|line| line.ends_with(matched_id) || line.contains(matched_id));
        if !exists {
            existing_archive_lines.push(format!("youtube {}", matched_id));
            added_count += 1;
        }
    }

    // Write back archive file
    if let Some(parent) = archive_file_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let new_archive_content = if existing_archive_lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", existing_archive_lines.join("\n"))
    };

    std::fs::write(archive_file_path, new_archive_content)
        .map_err(|e| format!("Failed to write updated archive file: {}", e))?;

    emit_line(&format!("[reconcile] Updated archive file: \"{}\"", resolved_archive), &mut logs);
    emit_line(&format!("  - Pruned {} missing track ID(s) from archive so yt-dlp will download them", pruned_count), &mut logs);
    emit_line(&format!("  + Ensured {} existing track ID(s) are recorded in archive to prevent re-downloading", added_count), &mut logs);
    emit_line("================================================================================", &mut logs);

    if missing_ids.is_empty() {
        emit_line("✨ All playlist tracks are already present on disk! Archive is 100% in sync.", &mut logs);
    } else {
        emit_line(&format!("✨ Done! {} missing track(s) ready to download without touching existing files.", missing_ids.len()), &mut logs);
        emit_line("👉 Click \"Download\" on this entry to fetch the missing tracks.", &mut logs);
    }
    emit_line("================================================================================\n", &mut logs);

    Ok(ReconcilePlaylistReport {
        playlist_title: display_title,
        total_online: online_tracks.len() as u32,
        songs_on_disk: local_files.len() as u32,
        matched_on_disk: matched_disk_ids.len() as u32,
        missing_count: missing_ids.len() as u32,
        missing_ids,
        missing_titles,
        pruned_from_archive: pruned_count,
        added_to_archive: added_count,
        logs,
    })
}

static UPGRADE_CANCEL_FLAG: OnceLock<Arc<AtomicBool>> = OnceLock::new();

fn get_upgrade_cancel_flag() -> &'static Arc<AtomicBool> {
    UPGRADE_CANCEL_FLAG.get_or_init(|| Arc::new(AtomicBool::new(false)))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Mp3UpgradeCandidate {
    pub path: String,
    pub filename: String,
    pub youtube_id: String,
    pub youtube_url: String,
    pub title: String,
    pub artist: String,
    pub file_size_bytes: u64,
    pub format_ext: String,
    pub is_mp3: bool,
    pub missing_tags: bool,
    pub missing_artwork: bool,
    pub reason: String,
    pub m4a_already_exists: bool,
    pub m4a_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Mp3UpgradeScanReport {
    pub folder: String,
    pub total_files_scanned: usize,
    pub total_mp3s_found: usize,
    pub candidates: Vec<Mp3UpgradeCandidate>,
    pub skipped_no_id_count: usize,
    pub already_upgraded_count: usize,
    pub param_issues_count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Mp3UpgradeProgressPayload {
    pub current: usize,
    pub total: usize,
    pub current_file: String,
    pub status: String,
    pub success_count: usize,
    pub failed_count: usize,
    pub saved_bytes: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Mp3UpgradeResultItem {
    pub path: String,
    pub filename: String,
    pub youtube_id: String,
    pub success: bool,
    pub m4a_path: Option<String>,
    pub error: Option<String>,
    pub original_size_bytes: u64,
    pub new_size_bytes: u64,
    pub dead_tag_cleaned: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Mp3UpgradeExecutionReport {
    pub total: usize,
    pub success_count: usize,
    pub failed_count: usize,
    pub skipped_count: usize,
    pub freed_bytes: i64,
    pub results: Vec<Mp3UpgradeResultItem>,
}

#[tauri::command]
pub async fn cancel_mp3_to_m4a_upgrade() -> Result<(), String> {
    get_upgrade_cancel_flag().store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn scan_mp3s_for_m4a_upgrade(
    folder_path: String,
    check_mp3_to_m4a: Option<bool>,
    check_tags_params: Option<bool>,
    check_cover_art: Option<bool>,
) -> Result<Mp3UpgradeScanReport, String> {
    tokio::task::spawn_blocking(move || {
        let root = Path::new(&folder_path);
        if !root.exists() {
            return Err(format!("Directory does not exist: {}", folder_path));
        }

        let do_check_mp3 = check_mp3_to_m4a.unwrap_or(true);
        let do_check_tags = check_tags_params.unwrap_or(true);
        let do_check_art = check_cover_art.unwrap_or(true);

        let id_bracket_re = Regex::new(r"\[([a-zA-Z0-9_-]{11})\]").unwrap();
        let id_paren_re = Regex::new(r"\(([a-zA-Z0-9_-]{11})\)").unwrap();
        let id_trailing_re = Regex::new(r"(?:^|[-_])([a-zA-Z0-9_-]{11})\.(?:mp3|m4a)$").unwrap();
        let yt_url_re = Regex::new(r"(?:v=|youtu\.be/|/embed/|/v/|/watch\?v=)([a-zA-Z0-9_-]{11})").unwrap();

        let mut total_files_scanned = 0usize;
        let mut total_mp3s_found = 0usize;
        let mut skipped_no_id_count = 0usize;
        let mut already_upgraded_count = 0usize;
        let mut param_issues_count = 0usize;
        let mut candidates = Vec::new();

        for entry in walkdir::WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let ext = match path.extension().and_then(|e| e.to_str()) {
                Some(e) => e.to_lowercase(),
                None => continue,
            };

            if ext != "mp3" && ext != "m4a" {
                continue;
            }

            total_files_scanned += 1;
            let is_mp3 = ext == "mp3";
            if is_mp3 {
                total_mp3s_found += 1;
            }

            let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            let file_size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

            // 1. Check filename for explicit URL, or bracketed/trailing candidate validated as real YouTube ID
            let mut detected_id = yt_url_re.captures(&filename)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().to_string());

            if detected_id.is_none() {
                detected_id = id_bracket_re.captures(&filename)
                    .or_else(|| id_paren_re.captures(&filename))
                    .or_else(|| id_trailing_re.captures(&filename))
                    .and_then(|c| c.get(1))
                    .map(|m| m.as_str().to_string())
                    .filter(|id| is_valid_standalone_youtube_id(id));
            }

            let mut title = String::new();
            let mut artist = String::new();
            let mut has_artwork = false;

            // 2. Probe audio tags
            if let Ok(tagged_file) = Probe::open(path).and_then(|p| p.read()) {
                if let Some(tag) = tagged_file.primary_tag() {
                    if let Some(t) = tag.title() {
                        title = t.trim().to_string();
                    }
                    if let Some(a) = tag.artist() {
                        artist = a.trim().to_string();
                    }
                    has_artwork = !tag.pictures().is_empty();

                    if detected_id.is_none() {
                        if let Some(comment) = tag.comment() {
                            if let Some(caps) = yt_url_re.captures(&comment) {
                                detected_id = caps.get(1).map(|m| m.as_str().to_string());
                            } else if is_valid_standalone_youtube_id(comment.trim()) {
                                detected_id = Some(comment.trim().to_string());
                            }
                        }
                    }

                    if detected_id.is_none() {
                        for item in tag.items() {
                            if let Some(val) = item.value().text() {
                                if let Some(caps) = yt_url_re.captures(val) {
                                    detected_id = caps.get(1).map(|m| m.as_str().to_string());
                                    break;
                                } else if is_valid_standalone_youtube_id(val.trim()) {
                                    let key_str = format!("{:?}", item.key()).to_lowercase();
                                    if key_str.contains("comment") || key_str.contains("description") || key_str.contains("purl") || key_str.contains("txxx") {
                                        detected_id = Some(val.trim().to_string());
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if title.is_empty() {
                title = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            }

            let missing_tags = title.is_empty() || artist.is_empty();
            let missing_artwork = !has_artwork;

            let needs_mp3_upgrade = is_mp3 && do_check_mp3;
            let needs_tag_repair = do_check_tags && missing_tags;
            let needs_art_repair = do_check_art && missing_artwork;

            let is_candidate = needs_mp3_upgrade || needs_tag_repair || needs_art_repair;

            // Check if M4A already exists when this is an MP3
            let m4a_path_buf = if is_mp3 {
                path.with_extension("m4a")
            } else {
                path.to_path_buf()
            };
            let m4a_already_exists = if is_mp3 {
                m4a_path_buf.is_file()
                    && std::fs::metadata(&m4a_path_buf).map(|m| m.len()).unwrap_or(0) > 10240
            } else {
                false
            };

            if is_mp3 && m4a_already_exists {
                already_upgraded_count += 1;
            }

            if !is_candidate {
                continue;
            }

            if let Some(id) = detected_id {
                let reason = if is_mp3 {
                    if missing_tags && missing_artwork {
                        "MP3 → M4A (Missing Tags & Art)".to_string()
                    } else if missing_tags {
                        "MP3 → M4A (Missing Tags)".to_string()
                    } else if missing_artwork {
                        "MP3 → M4A (Missing Art)".to_string()
                    } else {
                        "MP3 → M4A Upgrade".to_string()
                    }
                } else {
                    param_issues_count += 1;
                    if missing_tags && missing_artwork {
                        "In-place: Missing Tags & Art".to_string()
                    } else if missing_tags {
                        "In-place: Missing Title/Artist".to_string()
                    } else if missing_artwork {
                        "In-place: Missing Cover Art".to_string()
                    } else {
                        "Audio Parameter Upgrade".to_string()
                    }
                };

                candidates.push(Mp3UpgradeCandidate {
                    path: path.to_string_lossy().to_string(),
                    filename,
                    youtube_id: id.clone(),
                    youtube_url: format!("https://www.youtube.com/watch?v={}", id),
                    title,
                    artist,
                    file_size_bytes,
                    format_ext: ext,
                    is_mp3,
                    missing_tags,
                    missing_artwork,
                    reason,
                    m4a_already_exists,
                    m4a_path: m4a_path_buf.to_string_lossy().to_string(),
                });
            } else {
                skipped_no_id_count += 1;
            }
        }

        // Sort candidates: un-upgraded / needs action first, then alphabetically
        candidates.sort_by(|a, b| {
            a.m4a_already_exists.cmp(&b.m4a_already_exists)
                .then_with(|| a.filename.to_lowercase().cmp(&b.filename.to_lowercase()))
        });

        Ok(Mp3UpgradeScanReport {
            folder: folder_path,
            total_files_scanned,
            total_mp3s_found,
            candidates,
            skipped_no_id_count,
            already_upgraded_count,
            param_issues_count,
        })
    })
    .await
    .map_err(|e| format!("Failed to scan tracks for upgrade: {}", e))?
}

pub fn is_permanently_unavailable_youtube_error(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    // 1. Guard against transient network errors (never clean tags for temporary network issues)
    if lower.contains("429")
        || lower.contains("too many requests")
        || lower.contains("503")
        || lower.contains("502")
        || lower.contains("500")
        || lower.contains("504")
        || lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("connection reset")
        || lower.contains("connection refused")
        || lower.contains("network is unreachable")
        || lower.contains("incompleteread")
        || lower.contains("name resolution")
        || lower.contains("name or service not known")
    {
        return false;
    }

    // 2. Definitive permanent video absence on YouTube
    lower.contains("this video is unavailable")
        || lower.contains("video unavailable")
        || lower.contains("this video has been removed")
        || lower.contains("is no longer available")
        || lower.contains("private video")
        || lower.contains("account associated with this video has been terminated")
        || lower.contains("video does not exist")
        || lower.contains("does not exist")
        || lower.contains("not a valid video id")
        || lower.contains("copyright grounds")
        || lower.contains("copyright infringement")
}

pub fn clean_youtube_id_from_file_tags(file_path: &Path, youtube_id: &str) -> bool {
    let mut modified = false;
    if let Ok(mut tagged_file) = Probe::open(file_path).and_then(|f| f.read()) {
        let tag = if tagged_file.primary_tag().is_some() {
            tagged_file.primary_tag_mut()
        } else {
            tagged_file.first_tag_mut()
        };

        if let Some(tag) = tag {
            if let Some(c) = tag.comment().map(|s| s.to_string()) {
                if c.contains(youtube_id) || c.contains("youtube.com") || c.contains("youtu.be") {
                    let cleaned = c
                        .replace(&format!("https://www.youtube.com/watch?v={}", youtube_id), "")
                        .replace(&format!("http://www.youtube.com/watch?v={}", youtube_id), "")
                        .replace(&format!("https://youtu.be/{}", youtube_id), "")
                        .replace(&format!("http://youtu.be/{}", youtube_id), "")
                        .replace(youtube_id, "");
                    let trimmed = cleaned.trim();
                    if trimmed.is_empty() {
                        tag.set_comment(String::new());
                    } else {
                        tag.set_comment(trimmed.to_string());
                    }
                    modified = true;
                }
            }

            let initial_len = tag.item_count();
            tag.retain(|item| {
                if let Some(val) = item.value().text() {
                    if val.contains(youtube_id) || val.contains("youtube.com/watch") || val.contains("youtu.be/") {
                        return false;
                    }
                }
                true
            });
            if tag.item_count() != initial_len {
                modified = true;
            }
        }

        if modified {
            if tagged_file.save_to_path(file_path, lofty::config::WriteOptions::default()).is_ok() {
                return true;
            }
        }
    }
    false
}

#[tauri::command]
pub async fn execute_mp3_to_m4a_upgrade(
    app: AppHandle,
    candidates: Vec<Mp3UpgradeCandidate>,
    delete_mp3_on_success: bool,
) -> Result<Mp3UpgradeExecutionReport, String> {
    let cancel_flag = get_upgrade_cancel_flag();
    cancel_flag.store(false, Ordering::SeqCst);

    let total = candidates.len();
    let mut success_count = 0usize;
    let mut failed_count = 0usize;
    let skipped_count = 0usize;
    let mut freed_bytes = 0i64;
    let mut results = Vec::new();

    for (idx, candidate) in candidates.into_iter().enumerate() {
        if cancel_flag.load(Ordering::SeqCst) {
            let _ = app.emit(
                "mp3-upgrade-progress",
                Mp3UpgradeProgressPayload {
                    current: idx,
                    total,
                    current_file: "Cancelled by user".to_string(),
                    status: "cancelled".to_string(),
                    success_count,
                    failed_count,
                    saved_bytes: freed_bytes,
                },
            );
            break;
        }

        let orig_path = PathBuf::from(&candidate.path);
        let m4a_path = PathBuf::from(&candidate.m4a_path);
        let parent_dir = orig_path.parent().unwrap_or_else(|| Path::new("."));
        let stem = orig_path.file_stem().and_then(|s| s.to_str()).unwrap_or("track");
        let is_same_file = orig_path == m4a_path;

        let _ = app.emit(
            "mp3-upgrade-progress",
            Mp3UpgradeProgressPayload {
                current: idx + 1,
                total,
                current_file: candidate.filename.clone(),
                status: "downloading".to_string(),
                success_count,
                failed_count,
                saved_bytes: freed_bytes,
            },
        );

        // Case 1: M4A already exists, is healthy, and has no missing tags/art (only for MP3->M4A where M4A already converted)
        if !is_same_file
            && candidate.is_mp3
            && !candidate.missing_tags
            && !candidate.missing_artwork
            && m4a_path.is_file()
            && std::fs::metadata(&m4a_path).map(|m| m.len()).unwrap_or(0) > 10240
        {
            let m4a_size = std::fs::metadata(&m4a_path).map(|m| m.len()).unwrap_or(0);
            if delete_mp3_on_success && orig_path.exists() {
                let _ = std::fs::remove_file(&orig_path);
                freed_bytes += (candidate.file_size_bytes as i64) - (m4a_size as i64);
            }
            success_count += 1;
            results.push(Mp3UpgradeResultItem {
                path: candidate.path.clone(),
                filename: candidate.filename.clone(),
                youtube_id: candidate.youtube_id.clone(),
                success: true,
                m4a_path: Some(candidate.m4a_path.clone()),
                error: None,
                original_size_bytes: candidate.file_size_bytes,
                new_size_bytes: m4a_size,
                dead_tag_cleaned: false,
            });
            continue;
        }

        // Case 2: Download M4A via unified yt-dlp to temporary file
        // Handles both new M4A downloads and in-place repairs with the same filename!
        let safe_stem = stem.replace("%", "%%");
        let temp_stem = format!("{}.__upgrade_tmp__", safe_stem);
        let expected_temp_path = parent_dir.join(format!("{}.__upgrade_tmp__.m4a", stem));

        // Clean up any stale temp file from a previous aborted attempt
        if expected_temp_path.exists() {
            let _ = std::fs::remove_file(&expected_temp_path);
        }

        let mut upgrade_args = get_standard_ytdlp_audio_args("m4a");
        upgrade_args.push("--no-playlist".to_string());
        upgrade_args.push("--force-overwrites".to_string());
        upgrade_args.push("-o".to_string());
        upgrade_args.push(format!("{}.%(ext)s", temp_stem));
        upgrade_args.push(candidate.youtube_url.clone());

        let output = Command::new("yt-dlp")
            .args(&upgrade_args)
            .current_dir(parent_dir)
            .output()
            .await;

        match output {
            Ok(out) => {
                // Find the downloaded temp file
                let found_temp_path = if expected_temp_path.is_file() && std::fs::metadata(&expected_temp_path).map(|m| m.len()).unwrap_or(0) > 10240 {
                    Some(expected_temp_path)
                } else if let Ok(entries) = std::fs::read_dir(parent_dir) {
                    entries.filter_map(|e| e.ok()).find_map(|e| {
                        let p = e.path();
                        if p.extension().and_then(|ext| ext.to_str()).map(|ext| ext.eq_ignore_ascii_case("m4a")).unwrap_or(false) {
                            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                            if name.contains("__upgrade_tmp__") {
                                if let Ok(meta) = std::fs::metadata(&p) {
                                    if meta.len() > 10240 {
                                        if let Ok(modified) = meta.modified() {
                                            if let Ok(elapsed) = modified.elapsed() {
                                                if elapsed.as_secs() < 60 {
                                                    return Some(p);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        None
                    })
                } else {
                    None
                };

                if out.status.success() && found_temp_path.is_some() {
                    let temp_file = found_temp_path.unwrap();
                    let m4a_size = std::fs::metadata(&temp_file).map(|m| m.len()).unwrap_or(0);

                    // Safely replace target in-place (works even if m4a_path == orig_path)
                    let rename_res = std::fs::rename(&temp_file, &m4a_path);
                    if let Err(_) = rename_res {
                        // If rename across filesystems fails, attempt copy + remove
                        let _ = std::fs::copy(&temp_file, &m4a_path);
                        let _ = std::fs::remove_file(&temp_file);
                    }

                    // If original was an MP3 and we converted to M4A, clean up MP3
                    if !is_same_file && delete_mp3_on_success && orig_path.exists() {
                        let _ = std::fs::remove_file(&orig_path);
                        freed_bytes += (candidate.file_size_bytes as i64) - (m4a_size as i64);
                    } else if is_same_file {
                        freed_bytes += (candidate.file_size_bytes as i64) - (m4a_size as i64);
                    }

                    // If an archive.txt exists in this folder or parent, record the video ID
                    let local_archive = parent_dir.join("archive.txt");
                    if local_archive.is_file() {
                        if let Ok(archive_content) = std::fs::read_to_string(&local_archive) {
                            if !archive_content.contains(&candidate.youtube_id) {
                                use std::io::Write;
                                if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(&local_archive) {
                                    let _ = writeln!(f, "youtube {}", candidate.youtube_id);
                                }
                            }
                        }
                    }

                    success_count += 1;
                    results.push(Mp3UpgradeResultItem {
                        path: candidate.path.clone(),
                        filename: candidate.filename.clone(),
                        youtube_id: candidate.youtube_id.clone(),
                        success: true,
                        m4a_path: Some(candidate.m4a_path.clone()),
                        error: None,
                        original_size_bytes: candidate.file_size_bytes,
                        new_size_bytes: m4a_size,
                        dead_tag_cleaned: false,
                    });
                } else {
                    // Clean up temp file on failure if any
                    if let Some(tf) = found_temp_path {
                        let _ = std::fs::remove_file(tf);
                    }

                    let err_msg = String::from_utf8_lossy(&out.stderr).to_string();
                    let is_permanent = is_permanently_unavailable_youtube_error(&err_msg);
                    let mut dead_tag_cleaned = false;

                    if is_permanent {
                        // 1. Clean dead tag from audio file metadata
                        dead_tag_cleaned = clean_youtube_id_from_file_tags(&orig_path, &candidate.youtube_id);

                        // 2. Also strip bracketed/parenthesized dead ID from filename if present
                        let cur_name = orig_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                        let cleaned_filename = cur_name
                            .replace(&format!(" [{}]", candidate.youtube_id), "")
                            .replace(&format!("[{}]", candidate.youtube_id), "")
                            .replace(&format!(" ({})", candidate.youtube_id), "")
                            .replace(&format!("({})", candidate.youtube_id), "")
                            .replace(&format!(" - {}", candidate.youtube_id), "")
                            .replace(&format!("_{}", candidate.youtube_id), "")
                            .replace(&format!("-{}", candidate.youtube_id), "");
                        if cleaned_filename != cur_name && !cleaned_filename.trim().is_empty() {
                            let clean_path = parent_dir.join(&cleaned_filename);
                            if !clean_path.exists() {
                                if std::fs::rename(&orig_path, &clean_path).is_ok() {
                                    dead_tag_cleaned = true;
                                }
                            }
                        }
                    }

                    let clean_err = {
                        let mut error_lines: Vec<&str> = err_msg
                            .lines()
                            .map(|l| l.trim())
                            .filter(|l| {
                                let low = l.to_lowercase();
                                low.contains("error:") || low.contains("unavailable") || low.contains("removed") || low.contains("terminated") || low.contains("failed")
                            })
                            .collect();

                        if error_lines.is_empty() {
                            error_lines = err_msg
                                .lines()
                                .map(|l| l.trim())
                                .filter(|l| !l.is_empty() && !l.starts_with("[download]") && !l.starts_with("[youtube] Extracting") && !l.starts_with("[youtube] Downloading"))
                                .collect();
                        }

                        if !error_lines.is_empty() {
                            error_lines.join(" | ")
                        } else if !err_msg.trim().is_empty() {
                            err_msg.trim().to_string()
                        } else {
                            "Download failed or output m4a file invalid (<10KB)".to_string()
                        }
                    };

                    let error_label = if is_permanent {
                        if dead_tag_cleaned {
                            format!("Video permanently unavailable on YouTube (dead tag cleaned): {}", clean_err)
                        } else {
                            format!("Video permanently unavailable on YouTube: {}", clean_err)
                        }
                    } else {
                        clean_err
                    };

                    failed_count += 1;
                    results.push(Mp3UpgradeResultItem {
                        path: candidate.path.clone(),
                        filename: candidate.filename.clone(),
                        youtube_id: candidate.youtube_id.clone(),
                        success: false,
                        m4a_path: None,
                        error: Some(error_label),
                        original_size_bytes: candidate.file_size_bytes,
                        new_size_bytes: 0,
                        dead_tag_cleaned,
                    });
                }
            }
            Err(e) => {
                failed_count += 1;
                results.push(Mp3UpgradeResultItem {
                    path: candidate.path.clone(),
                    filename: candidate.filename.clone(),
                    youtube_id: candidate.youtube_id.clone(),
                    success: false,
                    m4a_path: None,
                    error: Some(format!("Failed to execute yt-dlp: {}", e)),
                    original_size_bytes: candidate.file_size_bytes,
                    new_size_bytes: 0,
                    dead_tag_cleaned: false,
                });
            }
        }
    }

    let _ = app.emit(
        "mp3-upgrade-progress",
        Mp3UpgradeProgressPayload {
            current: total,
            total,
            current_file: "Completed".to_string(),
            status: "done".to_string(),
            success_count,
            failed_count,
            saved_bytes: freed_bytes,
        },
    );

    Ok(Mp3UpgradeExecutionReport {
        total,
        success_count,
        failed_count,
        skipped_count,
        freed_bytes,
        results,
    })
}

#[tauri::command]
pub async fn scan_files_for_repair(
    folder_path: String,
    check_mp3_to_m4a: Option<bool>,
    check_tags_params: Option<bool>,
    check_cover_art: Option<bool>,
) -> Result<Mp3UpgradeScanReport, String> {
    scan_mp3s_for_m4a_upgrade(folder_path, check_mp3_to_m4a, check_tags_params, check_cover_art).await
}

#[tauri::command]
pub async fn execute_file_repair(
    app: AppHandle,
    candidates: Vec<Mp3UpgradeCandidate>,
    delete_mp3_on_success: bool,
) -> Result<Mp3UpgradeExecutionReport, String> {
    execute_mp3_to_m4a_upgrade(app, candidates, delete_mp3_on_success).await
}

#[tauri::command]
pub async fn cancel_file_repair() -> Result<(), String> {
    cancel_mp3_to_m4a_upgrade().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_permanently_unavailable_youtube_error() {
        // Transient network failures must NOT be treated as permanently unavailable
        assert!(!is_permanently_unavailable_youtube_error(
            "ERROR: [youtube] 12345: HTTP Error 429: Too Many Requests"
        ));
        assert!(!is_permanently_unavailable_youtube_error(
            "ERROR: [youtube] 12345: Connection timed out"
        ));
        assert!(!is_permanently_unavailable_youtube_error(
            "ERROR: [youtube] 12345: <urlopen error [Errno 8] nodename nor servname provided, or not known>"
        ));
        assert!(!is_permanently_unavailable_youtube_error(
            "ERROR: [youtube] 12345: HTTP Error 503: Service Unavailable"
        ));
        assert!(!is_permanently_unavailable_youtube_error(
            "ERROR: [youtube] 12345: Connection reset by peer"
        ));

        // Permanent absence must be recognized
        assert!(is_permanently_unavailable_youtube_error(
            "ERROR: [youtube] 12345: Video unavailable. This video has been removed by the uploader"
        ));
        assert!(is_permanently_unavailable_youtube_error(
            "ERROR: [youtube] 12345: Private video. Sign in if you've been granted access to this video"
        ));
        assert!(is_permanently_unavailable_youtube_error(
            "ERROR: [youtube] 12345: Video unavailable"
        ));
        assert!(is_permanently_unavailable_youtube_error(
            "ERROR: [youtube] 12345: This video does not exist"
        ));
        assert!(is_permanently_unavailable_youtube_error(
            "ERROR: [youtube] 12345: The account associated with this video has been terminated"
        ));
    }

    #[test]
    fn test_is_valid_standalone_youtube_id() {
        // Real YouTube IDs (with digits or symbols or mixed case) must be accepted
        assert!(is_valid_standalone_youtube_id("dQw4w9WgXcQ"));
        assert!(is_valid_standalone_youtube_id("9bZkp7q19f0"));
        assert!(is_valid_standalone_youtube_id("jNQXAC9IVRw"));
        assert!(is_valid_standalone_youtube_id("k-Xy_ZaBc12"));
        assert!(is_valid_standalone_youtube_id("aBcDeFgHiJk"));

        // Names and common words must be REJECTED
        assert!(!is_valid_standalone_youtube_id("Chakraborty"));
        assert!(!is_valid_standalone_youtube_id("Alternative"));
        assert!(!is_valid_standalone_youtube_id("Performance"));
        assert!(!is_valid_standalone_youtube_id("Composition"));
        assert!(!is_valid_standalone_youtube_id("Traditional"));
        assert!(!is_valid_standalone_youtube_id("performance"));
        assert!(!is_valid_standalone_youtube_id("ALTERNATIVE"));

        // Wrong length
        assert!(!is_valid_standalone_youtube_id("short"));
        assert!(!is_valid_standalone_youtube_id("waytoolongvideoid"));
    }
}

