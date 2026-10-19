use lofty::probe::Probe;
use lofty::file::TaggedFileExt;
use lofty::tag::Accessor;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
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


pub use crate::file_repair::*;
