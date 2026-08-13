use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
) -> Result<(), String> {
    let mut args = vec![
        "-f".to_string(),
        "ba[ext=m4a]/ba".to_string(),
        "-x".to_string(),
        "--audio-format".to_string(),
        audio_format.clone(),
        "--audio-quality".to_string(),
        "0".to_string(),
        "--embed-thumbnail".to_string(),
        "--embed-metadata".to_string(),
        "--convert-thumbnails".to_string(),
        "jpg".to_string(),
    ];

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

    // Output template
    let out_template = format!("{}/%(playlist_title)s/%(title)s.%(ext)s", output_dir);
    args.push("-o".to_string());
    args.push(out_template);

    args.push(url.clone());

    let mut command = Command::new("yt-dlp");
    command
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

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

                // Parse "Downloading item 33 of 34"
                if line.contains("Downloading item ") && line.contains(" of ") {
                    if let Some(idx) = line.find("Downloading item ") {
                        let rest = &line[idx + "Downloading item ".len()..];
                        let parts: Vec<&str> = rest.split_whitespace().collect();
                        if parts.len() >= 3 && parts[1] == "of" {
                            if let (Ok(curr), Ok(tot)) = (parts[0].parse::<u32>(), parts[2].parse::<u32>()) {
                                current_item = Some(curr);
                                total_items = Some(tot);
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
                            }
                        }
                    }
                }

                // Emit raw log line
                let _ = app_clone.emit(
                    "download-log",
                    DownloadLogPayload {
                        job_id: job_id_clone.clone(),
                        line: line.clone(),
                    },
                );

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
pub async fn dl_count_songs_on_disk(
    output_dir: String,
    playlist_title: String,
    formats: Vec<String>,
) -> Result<u32, String> {
    tokio::task::spawn_blocking(move || {
        let base_path = std::path::Path::new(&output_dir);
        let target_dir = if !playlist_title.trim().is_empty() {
            base_path.join(playlist_title.trim())
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
        let target_dir = if !playlist_title.trim().is_empty() {
            base_path.join(playlist_title.trim())
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
        let target_dir = if !playlist_title.trim().is_empty() {
            base_path.join(playlist_title.trim())
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

