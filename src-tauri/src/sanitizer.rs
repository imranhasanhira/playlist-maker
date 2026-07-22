use std::fs;
use std::path::Path;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;
use regex::{Regex, RegexBuilder};
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::Tag;
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
    let mut new_text = original_text.to_string();

    // Remove keywords case-insensitively
    for part in strip_phrases {
        if let Ok(re) = RegexBuilder::new(&regex::escape(part))
            .case_insensitive(true)
            .build()
        {
            new_text = re.replace_all(&new_text, "").to_string();
        }
    }

    // Run regex replacements
    if let Ok(re) = Regex::new(r"I+") {
        new_text = re.replace_all(&new_text, "I").to_string();
    }

    if let Ok(re) = RegexBuilder::new(r"[(|｜\[\{]+(HQ|HD)[)|｜\]\}]+")
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
    let mut items = Vec::new();

    // 2. Loop and process with progress
    for (index, path) in files.iter().enumerate() {
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

                items.push(SanitizeItem {
                    original_path,
                    original_name: file_name.to_string(),
                    sanitized_name: sanitized,
                    relative_path,
                });
            }
        }

        let _ = app.emit(
            "task-progress",
            TaskProgress {
                task_id: task_id.to_string(),
                task_name: "Filename Sanitizer Scan".to_string(),
                index,
                total,
                status: if index + 1 == total { "completed".to_string() } else { "running".to_string() },
                message: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                file_path: None,
            },
        );
    }

    Ok(items)
}

pub fn execute_rename_files(app: &AppHandle, task_id: &str, items: Vec<SanitizeItem>) -> Result<(), String> {
    let total = items.len();
    for (index, item) in items.into_iter().enumerate() {
        let old_path = Path::new(&item.original_path);
        if old_path.exists() {
            if let Some(parent) = old_path.parent() {
                let new_path = parent.join(&item.sanitized_name);
                if let Err(e) = fs::rename(old_path, &new_path) {
                    eprintln!("Failed to rename {}: {}", item.original_name, e);
                }
            }
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
    Ok(())
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
    let mut items = Vec::new();

    // 2. Loop and process
    for (index, path) in files.iter().enumerate() {
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

                items.push(HiddenFileItem {
                    file_path,
                    file_name: name.to_string(),
                    relative_path,
                    size_bytes,
                });
            }
        }

        let _ = app.emit(
            "task-progress",
            TaskProgress {
                task_id: task_id.to_string(),
                task_name: "Hidden Files Scan".to_string(),
                index,
                total,
                status: if index + 1 == total { "completed".to_string() } else { "running".to_string() },
                message: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                file_path: None,
            },
        );
    }

    Ok(items)
}

pub fn execute_delete_files(app: &AppHandle, task_id: &str, file_paths: Vec<String>) -> Result<(), String> {
    let total = file_paths.len();
    for (index, path_str) in file_paths.into_iter().enumerate() {
        let path = Path::new(&path_str);
        if path.exists() {
            if path.is_dir() {
                let _ = fs::remove_dir_all(path);
            } else {
                let _ = fs::remove_file(path);
            }
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
    Ok(())
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
    let mut items = Vec::new();

    // 2. Loop and process with progress
    for (index, path) in files.iter().enumerate() {
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
                        items.push(MetadataSanitizeItem {
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
                        items.push(MetadataSanitizeItem {
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
                        items.push(MetadataSanitizeItem {
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
                        items.push(MetadataSanitizeItem {
                            file_path: file_path_str.clone(),
                            field_name: "Description (Comment)".to_string(),
                            original_value: comment.to_string(),
                            sanitized_value: sanitized,
                        });
                    }
                }
            }
        }

        let _ = app.emit(
            "task-progress",
            TaskProgress {
                task_id: task_id.to_string(),
                task_name: "Metadata Sanitizer Scan".to_string(),
                index,
                total,
                status: if index + 1 == total { "completed".to_string() } else { "running".to_string() },
                message: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                file_path: None,
            },
        );
    }

    Ok(items)
}

pub fn execute_sanitize_metadata(app: &AppHandle, task_id: &str, items: Vec<MetadataSanitizeItem>) -> Result<(), String> {
    let total = items.len();
    for (index, item) in items.into_iter().enumerate() {
        let path = Path::new(&item.file_path);
        if path.exists() {
            if let Ok(mut tagged_file) = Probe::open(path).and_then(|f| f.read()) {
                let tag_type = tagged_file.primary_tag_type();
                let tag = if tagged_file.primary_tag().is_some() {
                    tagged_file.primary_tag_mut().unwrap()
                } else {
                    tagged_file.insert_tag(Tag::new(tag_type));
                    tagged_file.primary_tag_mut().unwrap()
                };

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

                let _ = tagged_file.save_to_path(path, lofty::config::WriteOptions::default());
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
                message: item.field_name,
                file_path: None,
            },
        );
    }
    Ok(())
}
