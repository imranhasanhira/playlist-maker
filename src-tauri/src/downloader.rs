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
                                last_progress = p;
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
