use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use lofty::probe::Probe;
use lofty::tag::Tag;
use lofty::prelude::*;
use regex::Regex;
use tauri::AppHandle;
use any_ascii::any_ascii;
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FontIssueItem {
    pub file_path: String,
    pub relative_path: String,
    pub detected_issue: String,
    pub option1_preview: String,
    pub option2_preview: String,
}

#[tauri::command]
pub async fn scan_font_issues(
    _app: AppHandle,
    _task_id: String,
    folder: String,
    formats: Vec<String>,
) -> Result<Vec<FontIssueItem>, String> {
    let root_path = Path::new(&folder);
    if !root_path.exists() {
        return Err(format!("Folder path does not exist: {}", folder));
    }

    let formats_set: HashSet<String> = formats
        .iter()
        .map(|s| s.trim().to_lowercase())
        .collect();

    let mut files = Vec::new();
    for entry in WalkDir::new(root_path).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let path = entry.path();
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if formats_set.contains(&ext.to_lowercase()) {
                    files.push(path.to_path_buf());
                }
            }
        }
    }

    let regex_bangla = Regex::new(r"[\u0980-\u09FF]").unwrap();
    let regex_pua = Regex::new(r"[\uF000-\uFFFF]").unwrap();

    let mut items = Vec::new();

    for path in files {
        let abs_path_str = path.to_string_lossy().to_string();
        let rel_path_str = match path.strip_prefix(root_path) {
            Ok(p) => p.to_string_lossy().to_string(),
            Err(_) => path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        };

        let file_stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext_str = path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();

        let mut issues = Vec::new();
        let mut has_non_ascii = false;

        if regex_bangla.is_match(&rel_path_str) {
            issues.push("Bangla Unicode Script in Filename".to_string());
            has_non_ascii = true;
        }

        if regex_pua.is_match(&rel_path_str) {
            issues.push("Private Use Area Symbol (e.g. )".to_string());
            has_non_ascii = true;
        }

        if let Ok(tagged_file) = Probe::open(&path).and_then(|f| f.read()) {
            if let Some(tag) = tagged_file.primary_tag() {
                if let Some(t) = tag.title() {
                    if regex_bangla.is_match(&t) {
                        issues.push("Bangla Title Tag".to_string());
                        has_non_ascii = true;
                    }
                }
                if let Some(a) = tag.artist() {
                    if regex_bangla.is_match(&a) {
                        issues.push("Bangla Artist Tag".to_string());
                        has_non_ascii = true;
                    }
                }
            }
        }

        if !has_non_ascii && rel_path_str.chars().any(|c| c as u32 > 127) {
            issues.push("Non-ASCII Characters".to_string());
            has_non_ascii = true;
        }

        if has_non_ascii {
            let option1_text = "Keep Bangla + Write ID3v2.3 UTF-16".to_string();
            
            let latin_stem = any_ascii(&file_stem);
            let option2_text = if ext_str.is_empty() {
                latin_stem
            } else {
                format!("{}.{}", latin_stem, ext_str)
            };

            items.push(FontIssueItem {
                file_path: abs_path_str,
                relative_path: rel_path_str,
                detected_issue: issues.join(", "),
                option1_preview: option1_text,
                option2_preview: option2_text,
            });
        }
    }

    Ok(items)
}

#[tauri::command]
pub async fn apply_font_issue_option1(file_paths: Vec<String>) -> Result<usize, String> {
    let mut updated_count = 0;
    for file_path_str in file_paths {
        let path = Path::new(&file_path_str);
        if path.exists() {
            if let Ok(mut tagged_file) = Probe::open(path).and_then(|f| f.read()) {
                let tag_type = tagged_file.primary_tag_type();
                let _tag = if tagged_file.primary_tag().is_some() {
                    tagged_file.primary_tag_mut().unwrap()
                } else {
                    tagged_file.insert_tag(Tag::new(tag_type));
                    tagged_file.primary_tag_mut().unwrap()
                };

                // Saving tag with lofty automatically formats ID3v2 text frames to UTF-16 when non-ASCII text is present
                if tagged_file.save_to_path(path, lofty::config::WriteOptions::default()).is_ok() {
                    updated_count += 1;
                }
            }
        }
    }
    Ok(updated_count)
}

#[tauri::command]
pub async fn apply_font_issue_option2(
    file_paths: Vec<String>,
    target_type: String,
) -> Result<usize, String> {
    let mut updated_count = 0;

    for file_path_str in &file_paths {
        let path = Path::new(file_path_str);
        if !path.exists() {
            continue;
        }

        if target_type == "tags" {
            // Transliterate metadata tags only
            if let Ok(mut tagged_file) = Probe::open(path).and_then(|f| f.read()) {
                let tag_type = tagged_file.primary_tag_type();
                let tag = if tagged_file.primary_tag().is_some() {
                    tagged_file.primary_tag_mut().unwrap()
                } else {
                    tagged_file.insert_tag(Tag::new(tag_type));
                    tagged_file.primary_tag_mut().unwrap()
                };

                if let Some(t) = tag.title() {
                    tag.set_title(any_ascii(&t));
                }
                if let Some(a) = tag.artist() {
                    tag.set_artist(any_ascii(&a));
                }
                if let Some(alb) = tag.album() {
                    tag.set_album(any_ascii(&alb));
                }
                if tagged_file.save_to_path(path, lofty::config::WriteOptions::default()).is_ok() {
                    updated_count += 1;
                }
            }
        } else if target_type == "filenames" {
            // Transliterate filenames on disk only
            if let Some(parent) = path.parent() {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    let latin_stem = any_ascii(stem);
                    let ext_str = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                    let new_name = if ext_str.is_empty() {
                        latin_stem
                    } else {
                        format!("{}.{}", latin_stem, ext_str)
                    };

                    let new_path = parent.join(&new_name);
                    if new_path != path {
                        if fs::rename(path, new_path).is_ok() {
                            updated_count += 1;
                        }
                    } else {
                        updated_count += 1;
                    }
                }
            }
        }
    }

    Ok(updated_count)
}
