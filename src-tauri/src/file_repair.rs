use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::Accessor;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, atomic::{AtomicBool, Ordering}};
use tauri::{AppHandle, Emitter};
use tokio::process::Command;

use crate::downloader::{get_standard_ytdlp_audio_args, is_valid_standalone_youtube_id};

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

