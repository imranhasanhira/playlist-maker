use std::fs;
use std::path::Path;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;
use regex::{Regex, RegexBuilder};
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{Tag, TagType};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SanitizeItem {
    pub original_path: String,
    pub original_name: String,
    pub sanitized_name: String,
    pub relative_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HiddenFileItem {
    pub file_path: String,
    pub file_name: String,
    pub relative_path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MetadataSanitizeItem {
    pub file_path: String,
    pub field_name: String,
    pub original_value: String,
    pub sanitized_value: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExecutionReport {
    pub success_count: usize,
    pub failure_count: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UnifiedScanResult {
    pub filename_items: Vec<SanitizeItem>,
    pub metadata_items: Vec<MetadataSanitizeItem>,
    pub font_issue_items: Vec<crate::font_issues::FontIssueItem>,
    pub hidden_items: Vec<HiddenFileItem>,
    pub total_scanned_files: usize,
}

#[derive(Clone, serde::Serialize)]
pub struct TaskProgress {
    pub task_id: String,
    pub task_name: String,
    pub index: usize,
    pub total: usize,
    pub status: String,
    pub message: String,
    #[serde(rename = "filePath")]
    pub file_path: Option<String>,
}

// Replicate Python's sanitizeText with customizable strip_phrases
pub fn sanitize_text(original_text: &str, strip_phrases: &[String]) -> String {
    // 1. Normalize full-width pipes ｜ (U+FF5C) and unicode bars to standard ASCII pipe |
    let mut new_text = original_text
        .replace('｜', "|")
        .replace('│', "|")
        .replace('┃', "|")
        .replace('║', "|");

    // 2. Remove private use area / invalid control characters (e.g. \u{F027} )
    if let Ok(re) = Regex::new(r"[\uF000-\uFFFF]+") {
        new_text = re.replace_all(&new_text, "").to_string();
    }

    // Remove keywords case-insensitively (supporting both literal strings and regexes like \d+)
    for part in strip_phrases {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }

        let re = if part.contains(r"\d") || part.contains(r"\s") || part.contains(r"\w") {
            let safe_pattern = part.replace(" | ", r"\s*\|\s*").replace("|", r"\|");
            RegexBuilder::new(&safe_pattern).case_insensitive(true).build().ok()
        } else {
            None
        };

        let re = re.or_else(|| {
            RegexBuilder::new(&regex::escape(part)).case_insensitive(true).build().ok()
        });

        if let Some(re) = re {
            new_text = re.replace_all(&new_text, "").to_string();
        }
    }

    // Strip hashtags (e.g. #bangla, #song, #shorts, #trending)
    if let Ok(re) = RegexBuilder::new(r"#\w+")
        .case_insensitive(true)
        .build()
    {
        new_text = re.replace_all(&new_text, "").to_string();
    }

    if let Ok(re) = RegexBuilder::new(r"[(|｜\[\{]+\s*(HQ|HD|Official\s*(Audio|Video|Music\s*Video|Track)?|Audio|Video|Lyrics?|Lyrical|Sound\s*Track|Soundtrack)\s*[)|｜\]\}]+")
        .case_insensitive(true)
        .build()
    {
        new_text = re.replace_all(&new_text, "").to_string();
    }

    if let Ok(re) = RegexBuilder::new(r"\s+\d+p\s+")
        .case_insensitive(true)
        .build()
    {
        new_text = re.replace_all(&new_text, "").to_string();
    }

    if let Ok(re) = Regex::new(r"\s*[|(｜\|\-\[\{]+(\s*[)|｜\|\-\]\}])+\s*") {
        new_text = re.replace_all(&new_text, " | ").to_string();
    }

    if let Ok(re) = Regex::new(r#"\s?[":：＂]+\s?"#) {
        new_text = re.replace_all(&new_text, " | ").to_string();
    }

    if let Ok(re) = Regex::new(r"^\.*\s*\d+\.*\s*") {
        new_text = re.replace_all(&new_text, "").to_string();
    }

    if let Ok(re) = Regex::new(r"\.+") {
        new_text = re.replace_all(&new_text, ".").to_string();
    }

    if let Ok(re) = Regex::new(r"\s+") {
        new_text = re.replace_all(&new_text, " ").to_string();
    }

    if let Ok(re) = Regex::new(r#"^[()|｜:：＂'"\-\[\]\{\}\s]+"#) {
        new_text = re.replace_all(&new_text, "").to_string();
    }

    if let Ok(re) = Regex::new(r#"[(|｜:：＂'"\-\[\]\{\}\s]+(\.[^\.]+)$"#) {
        new_text = re.replace_all(&new_text, "$1").to_string();
    }

    new_text.trim().to_string()
}

use std::sync::{Mutex, OnceLock};
use std::collections::HashSet;

static CANCELLED_TASKS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn get_cancelled_tasks() -> &'static Mutex<HashSet<String>> {
    CANCELLED_TASKS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn is_task_cancelled(task_id: &str) -> bool {
    if let Ok(guard) = get_cancelled_tasks().lock() {
        guard.contains(task_id)
    } else {
        false
    }
}

pub fn cancel_task(task_id: Option<&str>) {
    if let Ok(mut guard) = get_cancelled_tasks().lock() {
        if let Some(id) = task_id {
            guard.insert(id.to_string());
        } else {
            guard.insert("filename_scan".to_string());
            guard.insert("hidden_scan".to_string());
            guard.insert("metadata_scan".to_string());
        }
    }
}

pub fn clear_task_cancel(task_id: &str) {
    if let Ok(mut guard) = get_cancelled_tasks().lock() {
        guard.remove(task_id);
    }
}

pub fn scan_sanitize_files(
    app: &AppHandle,
    task_id: &str,
    folder: &Path,
    formats: &[String],
    strip_phrases: &[String],
) -> Result<Vec<SanitizeItem>, String> {
    clear_task_cancel(task_id);
    if !folder.exists() {
        return Err(format!("Folder does not exist: {}", folder.display()));
    }

    let formats_set: std::collections::HashSet<String> = formats
        .iter()
        .map(|f| f.to_lowercase())
        .collect();

    // 1. Quick pass: collect files
    let mut files = Vec::new();
    for entry in WalkDir::new(folder).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let path = entry.path();
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if formats_set.contains(&ext.to_lowercase()) {
                    files.push(path.to_path_buf());
                }
            }
        }
    }

    let total = files.len();
    if total == 0 {
        return Ok(Vec::new());
    }

    let num_workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(16);

    let chunk_size = (total + num_workers - 1) / num_workers;
    let processed_counter = std::sync::atomic::AtomicUsize::new(0);
    let items_mutex = std::sync::Mutex::new(Vec::new());
    let last_emit_mutex = std::sync::Mutex::new(std::time::Instant::now());

    let processed_ref = &processed_counter;
    let items_ref = &items_mutex;
    let last_emit_ref = &last_emit_mutex;

    std::thread::scope(|s| {
        for chunk in files.chunks(chunk_size) {
            s.spawn(move || {
                let mut local_items = Vec::new();
                for path in chunk {
                    if is_task_cancelled(task_id) {
                        break;
                    }
                    if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                        let sanitized = sanitize_text(file_name, strip_phrases);
                        if sanitized != file_name && !sanitized.is_empty() {
                            let original_path = path.to_string_lossy().to_string();
                            let relative_path = pathdiff::diff_paths(path, folder)
                                .map(|p| p.to_string_lossy().to_string())
                                .unwrap_or_else(|| original_path.clone());

                            local_items.push(SanitizeItem {
                                original_path,
                                original_name: file_name.to_string(),
                                sanitized_name: sanitized,
                                relative_path,
                            });
                        }
                    }

                    let cur = processed_ref.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                    let mut should_emit = cur == total;
                    if !should_emit {
                        if let Ok(mut last) = last_emit_ref.try_lock() {
                            if last.elapsed() >= std::time::Duration::from_secs(1) {
                                *last = std::time::Instant::now();
                                should_emit = true;
                            }
                        }
                    }
                    if should_emit {
                        let _ = app.emit(
                            "task-progress",
                            TaskProgress {
                                task_id: task_id.to_string(),
                                task_name: "Filename Sanitizer Scan".to_string(),
                                index: cur.saturating_sub(1),
                                total,
                                status: if cur == total { "completed".to_string() } else { "running".to_string() },
                                message: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                                file_path: None,
                            },
                        );
                    }
                }

                if let Ok(mut guard) = items_ref.lock() {
                    guard.extend(local_items);
                }
            });
        }
    });

    let items = items_mutex.into_inner().unwrap_or_default();
    Ok(items)
}

pub fn execute_rename_files(app: &AppHandle, task_id: &str, items: Vec<SanitizeItem>) -> Result<ExecutionReport, String> {
    clear_task_cancel(task_id);
    let total = items.len();
    let mut success_count = 0;
    let mut failure_count = 0;
    let mut errors = Vec::new();

    for (index, item) in items.into_iter().enumerate() {
        if is_task_cancelled(task_id) {
            break;
        }
        let old_path = Path::new(&item.original_path);
        if !old_path.exists() {
            failure_count += 1;
            errors.push(format!("File not found on disk: {}", item.original_path));
        } else if let Some(parent) = old_path.parent() {
            let new_path = parent.join(&item.sanitized_name);
            if new_path == old_path {
                success_count += 1;
            } else {
                match fs::rename(old_path, &new_path) {
                    Ok(_) => success_count += 1,
                    Err(e) => {
                        failure_count += 1;
                        errors.push(format!("Failed to rename '{}' -> '{}': {}", item.original_name, item.sanitized_name, e));
                    }
                }
            }
        } else {
            failure_count += 1;
            errors.push(format!("Could not determine parent directory for: {}", item.original_path));
        }

        let _ = app.emit(
            "task-progress",
            TaskProgress {
                task_id: task_id.to_string(),
                task_name: "Filename Sanitizer Execution".to_string(),
                index,
                total,
                status: if index + 1 == total { "completed".to_string() } else { "running".to_string() },
                message: item.sanitized_name,
                file_path: None,
            },
        );
    }

    Ok(ExecutionReport {
        success_count,
        failure_count,
        errors,
    })
}

pub fn scan_hidden_files(
    app: &AppHandle,
    task_id: &str,
    folder: &Path,
) -> Result<Vec<HiddenFileItem>, String> {
    clear_task_cancel(task_id);
    if !folder.exists() {
        return Err(format!("Folder does not exist: {}", folder.display()));
    }

    // 1. Quick pass: count files
    let mut files = Vec::new();
    for entry in WalkDir::new(folder).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            files.push(entry.path().to_path_buf());
        }
    }

    let total = files.len();
    if total == 0 {
        return Ok(Vec::new());
    }

    let num_workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(16);

    let chunk_size = (total + num_workers - 1) / num_workers;
    let processed_counter = std::sync::atomic::AtomicUsize::new(0);
    let items_mutex = std::sync::Mutex::new(Vec::new());
    let last_emit_mutex = std::sync::Mutex::new(std::time::Instant::now());

    let processed_ref = &processed_counter;
    let items_ref = &items_mutex;
    let last_emit_ref = &last_emit_mutex;

    std::thread::scope(|s| {
        for chunk in files.chunks(chunk_size) {
            s.spawn(move || {
                let mut local_items = Vec::new();
                for path in chunk {
                    if is_task_cancelled(task_id) {
                        break;
                    }
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        if crate::utils::is_os_system_junk(name) {
                            let file_path = path.to_string_lossy().to_string();
                            let relative_path = pathdiff::diff_paths(path, folder)
                                .map(|p| p.to_string_lossy().to_string())
                                .unwrap_or_else(|| file_path.clone());
                            let size_bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);

                            local_items.push(HiddenFileItem {
                                file_path,
                                file_name: name.to_string(),
                                relative_path,
                                size_bytes,
                            });
                        }
                    }

                    let cur = processed_ref.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                    let mut should_emit = cur == total;
                    if !should_emit {
                        if let Ok(mut last) = last_emit_ref.try_lock() {
                            if last.elapsed() >= std::time::Duration::from_secs(1) {
                                *last = std::time::Instant::now();
                                should_emit = true;
                            }
                        }
                    }
                    if should_emit {
                        let _ = app.emit(
                            "task-progress",
                            TaskProgress {
                                task_id: task_id.to_string(),
                                task_name: "Hidden Files Scan".to_string(),
                                index: cur.saturating_sub(1),
                                total,
                                status: if cur == total { "completed".to_string() } else { "running".to_string() },
                                message: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                                file_path: None,
                            },
                        );
                    }
                }

                if let Ok(mut guard) = items_ref.lock() {
                    guard.extend(local_items);
                }
            });
        }
    });

    let items = items_mutex.into_inner().unwrap_or_default();
    Ok(items)
}

pub fn execute_delete_files(app: &AppHandle, task_id: &str, file_paths: Vec<String>) -> Result<ExecutionReport, String> {
    clear_task_cancel(task_id);
    let total = file_paths.len();
    let mut success_count = 0;
    let mut failure_count = 0;
    let mut errors = Vec::new();

    for (index, path_str) in file_paths.into_iter().enumerate() {
        if is_task_cancelled(task_id) {
            break;
        }
        let path = Path::new(&path_str);
        if path.exists() {
            let res = if path.is_dir() {
                fs::remove_dir_all(path)
            } else {
                fs::remove_file(path)
            };
            match res {
                Ok(_) => success_count += 1,
                Err(e) => {
                    failure_count += 1;
                    errors.push(format!("Failed to delete '{}': {}", path_str, e));
                }
            }
        } else {
            // File is already deleted/gone
            success_count += 1;
        }

        let _ = app.emit(
            "task-progress",
            TaskProgress {
                task_id: task_id.to_string(),
                task_name: "Hidden Files Delete Execution".to_string(),
                index,
                total,
                status: if index + 1 == total { "completed".to_string() } else { "running".to_string() },
                message: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                file_path: None,
            },
        );
    }

    Ok(ExecutionReport {
        success_count,
        failure_count,
        errors,
    })
}

pub fn scan_sanitize_metadata(
    app: &AppHandle,
    task_id: &str,
    folder: &Path,
    formats: &[String],
    strip_phrases: &[String],
) -> Result<Vec<MetadataSanitizeItem>, String> {
    clear_task_cancel(task_id);
    if !folder.exists() {
        return Err(format!("Folder does not exist: {}", folder.display()));
    }

    let formats_set: std::collections::HashSet<String> = formats
        .iter()
        .map(|f| f.to_lowercase())
        .collect();

    // 1. Quick pass: count files
    let mut files = Vec::new();
    for entry in WalkDir::new(folder).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let path = entry.path();
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if formats_set.contains(&ext.to_lowercase()) {
                    files.push(path.to_path_buf());
                }
            }
        }
    }

    let total = files.len();
    if total == 0 {
        return Ok(Vec::new());
    }

    let num_workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(16);

    let chunk_size = (total + num_workers - 1) / num_workers;
    let processed_counter = std::sync::atomic::AtomicUsize::new(0);
    let items_mutex = std::sync::Mutex::new(Vec::new());
    let last_emit_mutex = std::sync::Mutex::new(std::time::Instant::now());

    let processed_ref = &processed_counter;
    let items_ref = &items_mutex;
    let last_emit_ref = &last_emit_mutex;

    std::thread::scope(|s| {
        for chunk in files.chunks(chunk_size) {
            s.spawn(move || {
                let mut local_items = Vec::new();
                for path in chunk {
                    if is_task_cancelled(task_id) {
                        break;
                    }

                    if let Ok(tagged_file) = Probe::open(path).and_then(|f| f.read()) {
                        if let Some(tag) = tagged_file.primary_tag() {
                            let file_path_str = path.to_string_lossy().to_string();

                            // 1. Title
                            if let Some(title) = tag.title() {
                                let sanitized = sanitize_text(&title, strip_phrases);
                                if sanitized != title.as_ref() && !sanitized.is_empty() {
                                    local_items.push(MetadataSanitizeItem {
                                        file_path: file_path_str.clone(),
                                        field_name: "Title".to_string(),
                                        original_value: title.to_string(),
                                        sanitized_value: sanitized,
                                    });
                                }
                            }

                            // 2. Artist
                            if let Some(artist) = tag.artist() {
                                let sanitized = sanitize_text(&artist, strip_phrases);
                                if sanitized != artist.as_ref() && !sanitized.is_empty() {
                                    local_items.push(MetadataSanitizeItem {
                                        file_path: file_path_str.clone(),
                                        field_name: "Artist".to_string(),
                                        original_value: artist.to_string(),
                                        sanitized_value: sanitized,
                                    });
                                }
                            }

                            // 3. Album
                            if let Some(album) = tag.album() {
                                let sanitized = sanitize_text(&album, strip_phrases);
                                if sanitized != album.as_ref() && !sanitized.is_empty() {
                                    local_items.push(MetadataSanitizeItem {
                                        file_path: file_path_str.clone(),
                                        field_name: "Album".to_string(),
                                        original_value: album.to_string(),
                                        sanitized_value: sanitized,
                                    });
                                }
                            }

                            // 4. Description (Comment)
                            if let Some(comment) = tag.comment() {
                                let sanitized = sanitize_text(&comment, strip_phrases);
                                if sanitized != comment.as_ref() && !sanitized.is_empty() {
                                    local_items.push(MetadataSanitizeItem {
                                        file_path: file_path_str.clone(),
                                        field_name: "Description (Comment)".to_string(),
                                        original_value: comment.to_string(),
                                        sanitized_value: sanitized,
                                    });
                                }
                            }
                        }
                    }

                    let cur = processed_ref.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                    let mut should_emit = cur == total;
                    if !should_emit {
                        if let Ok(mut last) = last_emit_ref.try_lock() {
                            if last.elapsed() >= std::time::Duration::from_secs(1) {
                                *last = std::time::Instant::now();
                                should_emit = true;
                            }
                        }
                    }
                    if should_emit {
                        let _ = app.emit(
                            "task-progress",
                            TaskProgress {
                                task_id: task_id.to_string(),
                                task_name: "Metadata Sanitizer Scan".to_string(),
                                index: cur.saturating_sub(1),
                                total,
                                status: if cur == total { "completed".to_string() } else { "running".to_string() },
                                message: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                                file_path: None,
                            },
                        );
                    }
                }

                if let Ok(mut guard) = items_ref.lock() {
                    guard.extend(local_items);
                }
            });
        }
    });

    let items = items_mutex.into_inner().unwrap_or_default();
    Ok(items)
}

pub fn execute_sanitize_metadata(app: &AppHandle, task_id: &str, items: Vec<MetadataSanitizeItem>) -> Result<ExecutionReport, String> {
    clear_task_cancel(task_id);
    let mut items_by_file: std::collections::HashMap<String, Vec<MetadataSanitizeItem>> = std::collections::HashMap::new();
    for item in items {
        items_by_file.entry(item.file_path.clone()).or_default().push(item);
    }

    let total = items_by_file.len();
    let mut success_count = 0;
    let mut failure_count = 0;
    let mut errors = Vec::new();

    for (index, (file_path_str, file_items)) in items_by_file.into_iter().enumerate() {
        if is_task_cancelled(task_id) {
            break;
        }
        let path = Path::new(&file_path_str);
        if !path.exists() {
            failure_count += file_items.len();
            errors.push(format!("File does not exist: {}", file_path_str));
            continue;
        }

        let file_path_str_clone = file_path_str.clone();
        let save_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = TagType::Id3v1.remove_from_path(path);

            match Probe::open(path).and_then(|f| f.read()) {
                Ok(mut tagged_file) => {
                    tagged_file.remove(TagType::Id3v1);

                    let tag_type = match tagged_file.primary_tag_type() {
                        TagType::Id3v1 => TagType::Id3v2,
                        other => other,
                    };
                    let tag = if tagged_file.primary_tag().is_some() {
                        tagged_file.primary_tag_mut().unwrap()
                    } else {
                        tagged_file.insert_tag(Tag::new(tag_type));
                        tagged_file.primary_tag_mut().unwrap()
                    };

                    for item in &file_items {
                        let sanitized = item.sanitized_value.trim().to_string();
                        let has_value = !sanitized.is_empty();

                        match item.field_name.as_str() {
                            "Title" => {
                                if has_value { tag.set_title(sanitized); } else { tag.remove_title(); }
                            }
                            "Artist" => {
                                if has_value { tag.set_artist(sanitized); } else { tag.remove_artist(); }
                            }
                            "Album" => {
                                if has_value { tag.set_album(sanitized); } else { tag.remove_album(); }
                            }
                            "Description (Comment)" => {
                                if has_value { tag.set_comment(sanitized); } else { tag.remove_comment(); }
                            }
                            _ => {}
                        }
                    }

                    tagged_file.save_to_path(path, lofty::config::WriteOptions::default())
                        .map_err(|e| format!("Failed to save tags: {}", e))
                }
                Err(e) => Err(format!("Failed to read tags: {}", e)),
            }
        }));

        match save_res {
            Ok(Ok(_)) => success_count += file_items.len(),
            Ok(Err(e)) => {
                failure_count += file_items.len();
                errors.push(format!("Error on '{}': {}", file_path_str_clone, e));
            }
            Err(_) => {
                failure_count += file_items.len();
                errors.push(format!("Tag processing error on '{}'", file_path_str_clone));
            }
        }

        let _ = app.emit(
            "task-progress",
            TaskProgress {
                task_id: task_id.to_string(),
                task_name: "Metadata Tags Execution".to_string(),
                index,
                total,
                status: if index + 1 == total { "completed".to_string() } else { "running".to_string() },
                message: Path::new(&file_path_str).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                file_path: None,
            },
        );
    }

    Ok(ExecutionReport {
        success_count,
        failure_count,
        errors,
    })
}

pub fn scan_all_unified(
    app: &AppHandle,
    task_id: &str,
    folder: &Path,
    formats: &[String],
    strip_phrases: &[String],
) -> Result<UnifiedScanResult, String> {
    clear_task_cancel(task_id);
    if !folder.exists() {
        return Err(format!("Folder does not exist: {}", folder.display()));
    }

    let formats_set: std::collections::HashSet<String> = formats
        .iter()
        .map(|f| f.to_lowercase())
        .collect();

    // 1. Single WalkDir pass: classify files into hidden vs audio files
    let mut hidden_items = Vec::new();
    let mut audio_files = Vec::new();

    for entry in WalkDir::new(folder).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if crate::utils::is_os_system_junk(name) {
                    let file_path = path.to_string_lossy().to_string();
                    let relative_path = pathdiff::diff_paths(path, folder)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| file_path.clone());
                    let size_bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);

                    hidden_items.push(HiddenFileItem {
                        file_path,
                        file_name: name.to_string(),
                        relative_path,
                        size_bytes,
                    });
                    continue;
                }

                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if formats_set.contains(&ext.to_lowercase()) {
                        audio_files.push(path.to_path_buf());
                    }
                }
            }
        }
    }

    let total = audio_files.len();
    let total_scanned = total + hidden_items.len();
    if total == 0 {
        return Ok(UnifiedScanResult {
            filename_items: Vec::new(),
            metadata_items: Vec::new(),
            font_issue_items: Vec::new(),
            hidden_items,
            total_scanned_files: total_scanned,
        });
    }

    let num_workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(16);

    let chunk_size = (total + num_workers - 1) / num_workers;
    let processed_counter = std::sync::atomic::AtomicUsize::new(0);

    let filename_items_mutex = std::sync::Mutex::new(Vec::new());
    let metadata_items_mutex = std::sync::Mutex::new(Vec::new());
    let font_issue_items_mutex = std::sync::Mutex::new(Vec::new());
    let last_emit_mutex = std::sync::Mutex::new(std::time::Instant::now());

    let processed_ref = &processed_counter;
    let filenames_ref = &filename_items_mutex;
    let metadata_ref = &metadata_items_mutex;
    let font_issues_ref = &font_issue_items_mutex;
    let last_emit_ref = &last_emit_mutex;

    std::thread::scope(|s| {
        for chunk in audio_files.chunks(chunk_size) {
            s.spawn(move || {
                let regex_bangla = regex::Regex::new(r"[\u0980-\u09FF]").unwrap();
                let regex_pua = regex::Regex::new(r"[\uF000-\uFFFF]").unwrap();
                let mut local_filenames = Vec::new();
                let mut local_metadata = Vec::new();
                let mut local_font_issues = Vec::new();

                for path in chunk {
                    if is_task_cancelled(task_id) {
                        break;
                    }

                    let file_name_opt = path.file_name().and_then(|n| n.to_str());
                    let abs_path_str = path.to_string_lossy().to_string();
                    let rel_path_str = pathdiff::diff_paths(path, folder)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| abs_path_str.clone());

                    // Analyzer A: Filename sanitization
                    if let Some(file_name) = file_name_opt {
                        let sanitized = sanitize_text(file_name, strip_phrases);
                        if sanitized != file_name && !sanitized.is_empty() {
                            local_filenames.push(SanitizeItem {
                                original_path: abs_path_str.clone(),
                                original_name: file_name.to_string(),
                                sanitized_name: sanitized,
                                relative_path: rel_path_str.clone(),
                            });
                        }
                    }

                    // Analyzer B & C: Font issues & Metadata tags (Single Probe::open pass)
                    let mut font_issues_list = Vec::new();
                    let mut has_non_ascii = false;

                    if regex_bangla.is_match(&rel_path_str) {
                        font_issues_list.push("Bangla Unicode Script in Filename".to_string());
                        has_non_ascii = true;
                    }
                    if regex_pua.is_match(&rel_path_str) {
                        font_issues_list.push("Private Use Area Symbol (e.g. )".to_string());
                        has_non_ascii = true;
                    }

                    if let Ok(tagged_file) = Probe::open(path).and_then(|f| f.read()) {
                        if let Some(tag) = tagged_file.primary_tag() {
                            // Check title
                            if let Some(title) = tag.title() {
                                let sanitized = sanitize_text(&title, strip_phrases);
                                if sanitized != title.as_ref() && !sanitized.is_empty() {
                                    local_metadata.push(MetadataSanitizeItem {
                                        file_path: abs_path_str.clone(),
                                        field_name: "Title".to_string(),
                                        original_value: title.to_string(),
                                        sanitized_value: sanitized,
                                    });
                                }
                                if regex_bangla.is_match(&title) {
                                    font_issues_list.push("Bangla Title Tag".to_string());
                                    has_non_ascii = true;
                                }
                            }

                            // Check artist
                            if let Some(artist) = tag.artist() {
                                let sanitized = sanitize_text(&artist, strip_phrases);
                                if sanitized != artist.as_ref() && !sanitized.is_empty() {
                                    local_metadata.push(MetadataSanitizeItem {
                                        file_path: abs_path_str.clone(),
                                        field_name: "Artist".to_string(),
                                        original_value: artist.to_string(),
                                        sanitized_value: sanitized,
                                    });
                                }
                                if regex_bangla.is_match(&artist) {
                                    font_issues_list.push("Bangla Artist Tag".to_string());
                                    has_non_ascii = true;
                                }
                            }

                            // Check album
                            if let Some(album) = tag.album() {
                                let sanitized = sanitize_text(&album, strip_phrases);
                                if sanitized != album.as_ref() && !sanitized.is_empty() {
                                    local_metadata.push(MetadataSanitizeItem {
                                        file_path: abs_path_str.clone(),
                                        field_name: "Album".to_string(),
                                        original_value: album.to_string(),
                                        sanitized_value: sanitized,
                                    });
                                }
                            }

                            // Check comment
                            if let Some(comment) = tag.comment() {
                                let sanitized = sanitize_text(&comment, strip_phrases);
                                if sanitized != comment.as_ref() && !sanitized.is_empty() {
                                    local_metadata.push(MetadataSanitizeItem {
                                        file_path: abs_path_str.clone(),
                                        field_name: "Description (Comment)".to_string(),
                                        original_value: comment.to_string(),
                                        sanitized_value: sanitized,
                                    });
                                }
                            }
                        }
                    }

                    if !has_non_ascii && rel_path_str.chars().any(|c| c as u32 > 127) {
                        font_issues_list.push("Non-ASCII Characters".to_string());
                        has_non_ascii = true;
                    }

                    if has_non_ascii {
                        let file_stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                        let ext_str = path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
                        let latin_stem = any_ascii::any_ascii(&file_stem);
                        let option2_text = if ext_str.is_empty() {
                            latin_stem
                        } else {
                            format!("{}.{}", latin_stem, ext_str)
                        };

                        local_font_issues.push(crate::font_issues::FontIssueItem {
                            file_path: abs_path_str.clone(),
                            relative_path: rel_path_str.clone(),
                            detected_issue: font_issues_list.join(", "),
                            option1_preview: "Keep Bangla + Write ID3v2.3 UTF-16".to_string(),
                            option2_preview: option2_text,
                        });
                    }

                    let cur = processed_ref.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                    let mut should_emit = cur == total;
                    if !should_emit {
                        if let Ok(mut last) = last_emit_ref.try_lock() {
                            if last.elapsed() >= std::time::Duration::from_secs(1) {
                                *last = std::time::Instant::now();
                                should_emit = true;
                            }
                        }
                    }
                    if should_emit {
                        let _ = app.emit(
                            "task-progress",
                            TaskProgress {
                                task_id: task_id.to_string(),
                                task_name: "Unified Sanitizer Scan".to_string(),
                                index: cur.saturating_sub(1),
                                total,
                                status: if cur == total { "completed".to_string() } else { "running".to_string() },
                                message: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                                file_path: None,
                            },
                        );
                    }
                }

                if let Ok(mut g) = filenames_ref.lock() {
                    g.extend(local_filenames);
                }
                if let Ok(mut g) = metadata_ref.lock() {
                    g.extend(local_metadata);
                }
                if let Ok(mut g) = font_issues_ref.lock() {
                    g.extend(local_font_issues);
                }
            });
        }
    });

    Ok(UnifiedScanResult {
        filename_items: filename_items_mutex.into_inner().unwrap_or_default(),
        metadata_items: metadata_items_mutex.into_inner().unwrap_or_default(),
        font_issue_items: font_issue_items_mutex.into_inner().unwrap_or_default(),
        hidden_items,
        total_scanned_files: total_scanned,
    })
}
