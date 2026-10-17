use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use lofty::probe::Probe;
use lofty::tag::TagType;
use lofty::prelude::*;
use regex::Regex;
use any_ascii::any_ascii;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FontIssueItem {
    pub file_path: String,
    pub relative_path: String,
    pub detected_issue: String,
    pub option1_preview: String,
    pub option2_preview: String,
}

pub fn clean_transliterate(input: &str) -> String {
    // 1. Strip Private Use Area characters (\u{E000}-\u{F8FF}, \u{F000}-\u{FFFF}, etc.)
    let no_pua: String = input.chars().filter(|&c| {
        let u = c as u32;
        !( (0xE000..=0xF8FF).contains(&u) || (0xF000..=0xFFFF).contains(&u) || (0xF0000..=0x10FFFF).contains(&u) )
    }).collect();

    // 2. Transliterate Unicode scripts (Bangla, Hindi, Arabic, Russian, etc.) to Latin/ASCII phonetics
    let ascii_str = any_ascii(&no_pua);

    // 3. Remove/replace illegal filesystem and car player characters
    let mut cleaned = ascii_str
        .replace('/', " - ")
        .replace('\\', " - ")
        .replace('⧸', " - ")
        .replace('／', " - ")
        .replace('|', " - ")
        .replace(':', " - ")
        .replace('*', "")
        .replace('?', "")
        .replace('"', "")
        .replace('<', "")
        .replace('>', "")
        .replace('`', "")
        .replace('~', "");

    // 4. Normalize multiple dashes and spaces
    while cleaned.contains("  ") {
        cleaned = cleaned.replace("  ", " ");
    }
    while cleaned.contains("- -") {
        cleaned = cleaned.replace("- -", "-");
    }
    while cleaned.contains(" - - ") {
        cleaned = cleaned.replace(" - - ", " - ");
    }
    while cleaned.contains(" - -") {
        cleaned = cleaned.replace(" - -", " - ");
    }
    while cleaned.contains("--") {
        cleaned = cleaned.replace("--", "-");
    }

    cleaned.trim().trim_matches('-').trim().to_string()
}

#[tauri::command]
pub async fn scan_font_issues(
    app: AppHandle,
    task_id: String,
    folder: String,
    formats: Vec<String>,
) -> Result<Vec<FontIssueItem>, String> {
    tokio::task::spawn_blocking(move || {
        crate::sanitizer::clear_task_cancel(&task_id);
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
        let app_ref = &app;
        let task_id_ref = &task_id;

        std::thread::scope(|s| {
            for chunk in files.chunks(chunk_size) {
                s.spawn(move || {
                    let regex_bangla = Regex::new(r"[\u0980-\u09FF]").unwrap();
                    let regex_pua = Regex::new(r"[\uF000-\uFFFF]").unwrap();
                    let mut local_items = Vec::new();
                    for path in chunk {
                        if crate::sanitizer::is_task_cancelled(task_id_ref) {
                            break;
                        }
                        let abs_path_str = path.to_string_lossy().to_string();
                        let file_name_str = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                        let rel_path_str = match path.strip_prefix(root_path) {
                            Ok(p) => p.to_string_lossy().to_string(),
                            Err(_) => file_name_str.clone(),
                        };

                        let file_stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                        let ext_str = path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();

                        let mut issues = Vec::new();
                        let mut has_issue = false;

                        // 1. Filename checks (check file_name_str directly to avoid parent folder false-positives)
                        if regex_bangla.is_match(&file_name_str) {
                            issues.push("Bangla Script in Filename".to_string());
                            has_issue = true;
                        }

                        if regex_pua.is_match(&file_name_str) {
                            issues.push("Private Use Area Symbol (e.g. )".to_string());
                            has_issue = true;
                        }

                        if !has_issue && file_name_str.chars().any(|c| c as u32 > 127) {
                            issues.push("Non-ASCII Characters in Filename".to_string());
                            has_issue = true;
                        }

                        // 2. Tag checks
                        if let Ok(tagged_file) = Probe::open(path).and_then(|f| f.read()) {
                            if let Some(tag) = tagged_file.primary_tag() {
                                if let Some(t) = tag.title() {
                                    if regex_bangla.is_match(&t) {
                                        issues.push("Bangla Title Tag".to_string());
                                        has_issue = true;
                                    } else if regex_pua.is_match(&t) {
                                        issues.push("PUA Symbol in Title Tag".to_string());
                                        has_issue = true;
                                    }
                                }
                                if let Some(a) = tag.artist() {
                                    if regex_bangla.is_match(&a) {
                                        issues.push("Bangla Artist Tag".to_string());
                                        has_issue = true;
                                    } else if regex_pua.is_match(&a) {
                                        issues.push("PUA Symbol in Artist Tag".to_string());
                                        has_issue = true;
                                    }
                                }
                                if let Some(alb) = tag.album() {
                                    if regex_bangla.is_match(&alb) {
                                        issues.push("Bangla Album Tag".to_string());
                                        has_issue = true;
                                    }
                                }
                            }
                        }

                        if has_issue {
                            let clean_stem = clean_transliterate(&file_stem);
                            let option1_text = "Rewrite ID3v2.3 UTF-16 Tags".to_string();
                            let option2_text = if ext_str.is_empty() {
                                clean_stem
                            } else {
                                format!("{}.{}", clean_stem, ext_str)
                            };

                            local_items.push(FontIssueItem {
                                file_path: abs_path_str,
                                relative_path: rel_path_str,
                                detected_issue: issues.join(", "),
                                option1_preview: option1_text,
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
                            let _ = app_ref.emit(
                                "task-progress",
                                crate::sanitizer::TaskProgress {
                                    task_id: task_id_ref.clone(),
                                    task_name: "Scan Font Issues".to_string(),
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
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
pub async fn apply_font_issue_option1(file_paths: Vec<String>) -> Result<crate::sanitizer::ExecutionReport, String> {
    tokio::task::spawn_blocking(move || {
        let mut success_count = 0;
        let mut failure_count = 0;
        let mut errors = Vec::new();

        for file_path_str in file_paths {
            let path = Path::new(&file_path_str);
            if !path.exists() {
                failure_count += 1;
                errors.push(format!("File does not exist: {}", file_path_str));
                continue;
            }

            let file_path_str_clone = file_path_str.clone();
            let save_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = TagType::Id3v1.remove_from_path(path);

                match Probe::open(path).and_then(|f| f.read()) {
                    Ok(mut tagged_file) => {
                        let _ = tagged_file.remove(TagType::Id3v1);

                        if let Some(tag) = tagged_file.primary_tag_mut() {
                            // Strip PUA characters even when preserving Bangla
                            if let Some(t) = tag.title().map(|s| s.to_string()) {
                                let no_pua: String = t.chars().filter(|&c| {
                                    let u = c as u32;
                                    !( (0xE000..=0xF8FF).contains(&u) || (0xF000..=0xFFFF).contains(&u) || (0xF0000..=0x10FFFF).contains(&u) )
                                }).collect();
                                tag.set_title(no_pua);
                            }
                            if let Some(a) = tag.artist().map(|s| s.to_string()) {
                                let no_pua: String = a.chars().filter(|&c| {
                                    let u = c as u32;
                                    !( (0xE000..=0xF8FF).contains(&u) || (0xF000..=0xFFFF).contains(&u) || (0xF0000..=0x10FFFF).contains(&u) )
                                }).collect();
                                tag.set_artist(no_pua);
                            }
                            if let Some(alb) = tag.album().map(|s| s.to_string()) {
                                let no_pua: String = alb.chars().filter(|&c| {
                                    let u = c as u32;
                                    !( (0xE000..=0xF8FF).contains(&u) || (0xF000..=0xFFFF).contains(&u) )
                                }).collect();
                                tag.set_album(no_pua);
                            }
                            tagged_file.save_to_path(path, lofty::config::WriteOptions::default())
                                .map_err(|e| format!("Failed to save tags: {}", e))
                        } else {
                            Ok(())
                        }
                    }
                    Err(e) => Err(format!("Failed to open tags: {}", e)),
                }
            }));

            match save_res {
                Ok(Ok(_)) => success_count += 1,
                Ok(Err(e)) => {
                    failure_count += 1;
                    errors.push(format!("Error on '{}': {}", file_path_str_clone, e));
                }
                Err(_) => {
                    failure_count += 1;
                    errors.push(format!("Internal codec error on '{}'", file_path_str_clone));
                }
            }
        }

        Ok(crate::sanitizer::ExecutionReport {
            success_count,
            failure_count,
            errors,
        })
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
pub async fn apply_font_issue_option2(
    file_paths: Vec<String>,
    target_type: String,
) -> Result<crate::sanitizer::ExecutionReport, String> {
    tokio::task::spawn_blocking(move || {
        let mut success_count = 0;
        let mut failure_count = 0;
        let mut errors = Vec::new();

        for file_path_str in &file_paths {
            let path = Path::new(file_path_str);
            if !path.exists() {
                failure_count += 1;
                errors.push(format!("File does not exist: {}", file_path_str));
                continue;
            }

            let file_path_str_clone = file_path_str.clone();
            let mut tag_success = true;
            let mut rename_success = true;

            // 1. Tags transliteration
            if target_type == "tags" || target_type == "both" {
                let tag_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let _ = TagType::Id3v1.remove_from_path(path);

                    match Probe::open(path).and_then(|f| f.read()) {
                        Ok(mut tagged_file) => {
                            let _ = tagged_file.remove(TagType::Id3v1);

                            let mut modified = false;
                            if let Some(tag) = tagged_file.primary_tag_mut() {
                                if let Some(t) = tag.title().map(|s| s.to_string()) {
                                    let clean = clean_transliterate(&t);
                                    if clean != t && !clean.is_empty() {
                                        tag.set_title(clean);
                                        modified = true;
                                    }
                                }
                                if let Some(a) = tag.artist().map(|s| s.to_string()) {
                                    let clean = clean_transliterate(&a);
                                    if clean != a && !clean.is_empty() {
                                        tag.set_artist(clean);
                                        modified = true;
                                    }
                                }
                                if let Some(alb) = tag.album().map(|s| s.to_string()) {
                                    let clean = clean_transliterate(&alb);
                                    if clean != alb && !clean.is_empty() {
                                        tag.set_album(clean);
                                        modified = true;
                                    }
                                }
                                if let Some(c) = tag.comment().map(|s| s.to_string()) {
                                    let trimmed = c.trim();
                                    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                                        // Strip PUA characters only, preserving URLs completely intact
                                        let no_pua: String = trimmed.chars().filter(|&ch| {
                                            let u = ch as u32;
                                            !( (0xE000..=0xF8FF).contains(&u) || (0xF000..=0xFFFF).contains(&u) || (0xF0000..=0x10FFFF).contains(&u) )
                                        }).collect();
                                        if no_pua != c && !no_pua.is_empty() {
                                            tag.set_comment(no_pua);
                                            modified = true;
                                        }
                                    } else {
                                        // Protect embedded URLs before transliterating comment text
                                        let re_http = Regex::new(r#"https?://[^\s)\]}'"<]+"#).unwrap();
                                        let mut urls = Vec::new();
                                        let protected = re_http.replace_all(&c, |caps: &regex::Captures| {
                                            let idx = urls.len();
                                            urls.push(caps[0].to_string());
                                            format!("__URL_PROTECTED_{}__", idx)
                                        }).to_string();

                                        let mut clean = clean_transliterate(&protected);
                                        for (idx, orig_url) in urls.iter().enumerate() {
                                            clean = clean.replace(&format!("__URL_PROTECTED_{}__", idx), orig_url);
                                        }
                                        if clean != c && !clean.is_empty() {
                                            tag.set_comment(clean);
                                            modified = true;
                                        }
                                    }
                                }
                            }

                            if modified {
                                tagged_file.save_to_path(path, lofty::config::WriteOptions::default())
                                    .map_err(|e| format!("Failed to save tags: {}", e))
                            } else {
                                Ok(())
                            }
                        }
                        Err(e) => Err(format!("Failed to open tags: {}", e)),
                    }
                }));

                match tag_res {
                    Ok(Ok(_)) => {},
                    Ok(Err(e)) => {
                        tag_success = false;
                        errors.push(format!("Tag update warning on '{}': {}", file_path_str_clone, e));
                    }
                    Err(_) => {
                        tag_success = false;
                        errors.push(format!("Tag processing crash on '{}'", file_path_str_clone));
                    }
                }
            }

            // 2. Filename transliteration
            if target_type == "filenames" || target_type == "both" {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    let clean_stem = clean_transliterate(stem);
                    let ext_str = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                    let new_name = if ext_str.is_empty() {
                        clean_stem
                    } else {
                        format!("{}.{}", clean_stem, ext_str)
                    };

                    if let Some(parent) = path.parent() {
                        let new_path = parent.join(&new_name);
                        if new_path != path {
                            if let Err(e) = fs::rename(path, &new_path) {
                                rename_success = false;
                                errors.push(format!("Failed to rename '{}' to '{}': {}", file_path_str, new_name, e));
                            }
                        }
                    }
                }
            }

            let op_ok = match target_type.as_str() {
                "tags" => tag_success,
                "filenames" => rename_success,
                "both" => tag_success && rename_success,
                _ => tag_success || rename_success,
            };

            if op_ok {
                success_count += 1;
            } else {
                failure_count += 1;
            }
        }

        Ok(crate::sanitizer::ExecutionReport {
            success_count,
            failure_count,
            errors,
        })
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_transliterate_solidus_and_symbols() {
        let clean = clean_transliterate("Bob Sinclar feat. Raffaella Carra' ⧸ Far l'Amore (preview 2011)");
        assert_eq!(clean, "Bob Sinclar feat. Raffaella Carra' - Far l'Amore (preview 2011)");

        let clean2 = clean_transliterate("Artist / Title \\ Part");
        assert_eq!(clean2, "Artist - Title - Part");
    }
}
