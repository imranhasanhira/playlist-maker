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

// Precompiled regex engine for high-performance scanning across thousands of files
pub struct CompiledSanitizer {
    strip_regexes: Vec<Regex>,
    re_pua: Regex,
    re_url: Regex,
    re_hashtag: Regex,
    re_bracket_junk: Regex,
    re_bracket_promo: Regex,
    re_resolution: Regex,
    re_delim_brackets: Regex,
    re_empty_brackets: Regex,
    re_composite_sep: Regex,
    re_leading_track_num: Regex,
    re_multi_dots: Regex,
    re_multi_dashes: Regex,
    re_multi_spaces: Regex,
    re_leading_sep: Regex,
    re_trailing_sep_no_ext: Regex,
}

impl CompiledSanitizer {
    pub fn new(strip_phrases: &[String]) -> Self {
        let mut strip_regexes = Vec::new();
        for part in strip_phrases {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                continue;
            }

            let re = if part.contains(r"\d") || part.contains(r"\s") || part.contains(r"\w") {
                let safe_pattern = part.replace(" | ", r"\s*\|\s*").replace("|", r"\|");
                RegexBuilder::new(&safe_pattern).case_insensitive(true).build().ok()
            } else {
                let escaped = regex::escape(part);
                let pattern = format!(r"(?i)(?:https?://)?(?:www\.)?{}(?:/)?", escaped);
                RegexBuilder::new(&pattern).case_insensitive(true).build().ok()
            };

            if let Some(r) = re {
                strip_regexes.push(r);
            }
        }

        Self {
            strip_regexes,
            re_pua: Regex::new(r"[\uF000-\uFFFF]+").unwrap(),
            re_url: RegexBuilder::new(
                r#"(?i)(?:https?://[^\s)\]}'"<>]+|www\.[a-zA-Z0-9\-\._~%]+(?:/[^\s)\]}'"<>]*)?|\b[a-zA-Z0-9\-]{2,}\.(?:com|net|org|info|biz|xyz|top|site|online|club|vip|mobi|pk|fm)(?:/[^\s)\]}'"<>]*)?)"#
            ).case_insensitive(true).build().unwrap(),
            re_hashtag: RegexBuilder::new(r"#\w+").case_insensitive(true).build().unwrap(),
            re_bracket_junk: RegexBuilder::new(r"[(|｜\[\{]+\s*(HQ|HD|Official\s*(Audio|Video|Music\s*Video|Track)?|Audio|Video|Lyrics?|Lyrical|Sound\s*Track|Soundtrack)\s*[)|｜\]\}]+").case_insensitive(true).build().unwrap(),
            re_bracket_promo: RegexBuilder::new(
                r#"[\(\[\{]\s*(?:source|download(?:ed)?\s*(?:from)?|visit|website|from|ripped\s*by|courtesy\s*of)\s*[\)\]\}]"#
            ).case_insensitive(true).build().unwrap(),
            re_resolution: RegexBuilder::new(r"\s+\d+p\s+").case_insensitive(true).build().unwrap(),
            re_delim_brackets: Regex::new(r"[\(\[\{]\s*[-–—|｜│┃║:：_~•*\\/><#]+[-–—|｜│┃║:：_~•*\\/><#\s]*[\)\]\}]").unwrap(),
            re_empty_brackets: Regex::new(r"[\(\[\{]\s*[\)\]\}]").unwrap(),
            re_composite_sep: Regex::new(r"(\s*[-–—|｜│┃║:：_~•\\/><#]\s*){2,}|\s*[-–—|｜│┃║:：_~•\\/><#]\s+|\s+[-–—|｜│┃║:：_~•\\/><#]\s*|[|｜│┃║:：\\/]+").unwrap(),
            re_leading_track_num: Regex::new(r#"^\s*\d{1,3}\s*[-–—._]\s*"#).unwrap(),
            re_multi_dots: Regex::new(r"\.+").unwrap(),
            re_multi_dashes: Regex::new(r"\s*-\s*(-\s*)+").unwrap(),
            re_multi_spaces: Regex::new(r"\s+").unwrap(),
            // Leading/trailing separators: NEVER include brackets '()[]{}' so balanced features like '(feat. ...)' and '(Acoustic)' remain intact
            re_leading_sep: Regex::new(r#"^[-–—_~•|｜│┃║:：＂'"\\/><#\s]+"#).unwrap(),
            re_trailing_sep_no_ext: Regex::new(r#"[-–—_~•|｜│┃║:：＂'"\\/><#\s]+$"#).unwrap(),
        }
    }

    fn sanitize_common(&self, original_text: &str) -> String {
        // 1. Normalize full-width pipes ｜ (U+FF5C) and unicode bars to standard ASCII pipe |
        let mut new_text = original_text
            .replace('｜', "|")
            .replace('│', "|")
            .replace('┃', "|")
            .replace('║', "|");

        // 2. Remove private use area / invalid control characters (e.g. \u{F027} )
        new_text = self.re_pua.replace_all(&new_text, "").to_string();

        // 3. Remove URLs and promo web domains from filenames and tag names
        new_text = self.re_url.replace_all(&new_text, "").to_string();

        // 4. Remove keywords case-insensitively using precompiled regexes
        for re in &self.strip_regexes {
            new_text = re.replace_all(&new_text, "").to_string();
        }

        // 5. Strip hashtags (e.g. #bangla, #song, #shorts, #trending)
        new_text = self.re_hashtag.replace_all(&new_text, "").to_string();

        // 6. Strip bracketed descriptors like (Official Video), [HD], and promo brackets like [Downloaded from ]
        new_text = self.re_bracket_junk.replace_all(&new_text, "").to_string();
        new_text = self.re_bracket_promo.replace_all(&new_text, "").to_string();
        new_text = self.re_resolution.replace_all(&new_text, "").to_string();

        // 7. Handle delimiter-enclosing brackets (e.g. "( - )", "[ | ]") by replacing them with " - ", and strip empty brackets ("()", "[]")
        new_text = self.re_delim_brackets.replace_all(&new_text, " - ").to_string();
        new_text = self.re_empty_brackets.replace_all(&new_text, "").to_string();

        // 8. Strip forbidden quotes and wildcards
        new_text = new_text
            .replace('"', "")
            .replace('＂', "")
            .replace('?', "")
            .replace('？', "")
            .replace('*', "")
            .replace('＊', "");

        // 9. Collapse any composite separator cluster in a SINGLE pass:
        new_text = self.re_composite_sep.replace_all(&new_text, " - ").to_string();

        // 10. Collapse multiple dots, dashes, and spaces
        new_text = self.re_multi_dots.replace_all(&new_text, ".").to_string();
        new_text = self.re_multi_dashes.replace_all(&new_text, " - ").to_string();
        new_text = self.re_multi_spaces.replace_all(&new_text, " ").to_string();

        // 11. Trim leading punctuation & separators (preserving valid opening brackets like "(I Can't Get No)")
        new_text = self.re_leading_sep.replace_all(&new_text, "").to_string();

        new_text
    }

    pub fn sanitize_filename(&self, original_text: &str) -> String {
        // If the filename has an audio/media extension, sanitize stem and preserve extension
        let (stem, ext_opt) = match original_text.rfind('.') {
            Some(dot_idx) if dot_idx > 0 && dot_idx + 1 < original_text.len() => {
                let candidate_ext = &original_text[dot_idx + 1..];
                // Check if candidate_ext looks like a file extension (1 to 5 alphanumeric characters)
                // and NOT a known web domain TLD (e.g. com, net, org, info, biz, pk, fm)
                let ext_lower = candidate_ext.to_lowercase();
                let is_web_tld = matches!(
                    ext_lower.as_str(),
                    "com" | "net" | "org" | "info" | "biz" | "xyz" | "top" | "site" | "online" | "club" | "vip" | "mobi" | "pk" | "fm" | "html" | "php" | "asp"
                );
                if !is_web_tld && candidate_ext.chars().all(|c| c.is_alphanumeric()) && candidate_ext.len() <= 5 {
                    (&original_text[..dot_idx], Some(candidate_ext))
                } else {
                    (original_text, None)
                }
            }
            _ => (original_text, None),
        };

        let mut clean_stem = self.sanitize_common(stem);

        // Strip leading track numbering only if followed by explicit delimiter (e.g. "01. ", "01 - ")
        clean_stem = self.re_leading_track_num.replace_all(&clean_stem, "").to_string();

        // Clean any leading separators exposed after removing track numbering
        clean_stem = self.re_leading_sep.replace_all(&clean_stem, "").to_string();

        // Strip trailing separators from the stem
        clean_stem = self.re_trailing_sep_no_ext.replace_all(&clean_stem, "").to_string();

        let clean_stem = clean_stem.trim();
        if clean_stem.is_empty() {
            return original_text.trim().to_string();
        }

        match ext_opt {
            Some(ext) => format!("{}.{}", clean_stem, ext),
            None => clean_stem.to_string(),
        }
    }

    pub fn sanitize_metadata(&self, original_text: &str) -> String {
        let mut new_text = self.sanitize_common(original_text);

        // For metadata (Title, Artist, Album), NEVER strip leading numbers (e.g. "1984", "21 Guns")
        new_text = self.re_trailing_sep_no_ext.replace_all(&new_text, "").to_string();

        new_text.trim().to_string()
    }

    pub fn sanitize_comment(&self, original_text: &str) -> String {
        let trimmed = original_text.trim();
        // If the comment is primarily a URL, preserve it untouched (only strip corrupt PUA glyphs)
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            let no_pua: String = trimmed.chars().filter(|&c| {
                let u = c as u32;
                !( (0xE000..=0xF8FF).contains(&u) || (0xF000..=0xFFFF).contains(&u) || (0xF0000..=0x10FFFF).contains(&u) )
            }).collect();
            return no_pua.trim().to_string();
        }

        // For description/comment text, protect all embedded URLs with tokens to prevent URL corruption
        let mut url_placeholders: Vec<String> = Vec::new();
        let re_http = Regex::new(r#"https?://[^\s)\]}'"<]+"#).unwrap();
        let protected_text = re_http.replace_all(original_text, |caps: &regex::Captures| {
            let idx = url_placeholders.len();
            url_placeholders.push(caps[0].to_string());
            format!("__URL_PROTECTED_{}__", idx)
        }).to_string();

        let mut cleaned = protected_text;

        // 1. Remove PUA characters
        cleaned = self.re_pua.replace_all(&cleaned, "").to_string();

        // 2. Strip user-defined phrases from surrounding text
        for re in &self.strip_regexes {
            cleaned = re.replace_all(&cleaned, "").to_string();
        }

        // 3. Strip bracket junk like (Official Video), [HD]
        cleaned = self.re_bracket_junk.replace_all(&cleaned, "").to_string();

        // 4. Strip empty brackets
        cleaned = self.re_empty_brackets.replace_all(&cleaned, "").to_string();

        // 5. Strip lingering 'www.' or promotional domain leftovers while URLs are protected
        static RE_DANGLING_WWW: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
            RegexBuilder::new(r"(?i)\b(?:https?://)?www\.[\w\-\._~%]*").case_insensitive(true).build().unwrap()
        });
        cleaned = RE_DANGLING_WWW.replace_all(&cleaned, "").to_string();

        // 6. Restore protected URLs untouched
        for (idx, original_url) in url_placeholders.iter().enumerate() {
            let holder = format!("__URL_PROTECTED_{}__", idx);
            cleaned = cleaned.replace(&holder, original_url);
        }

        // 7. Clean multiple consecutive spaces and trim
        cleaned = self.re_multi_spaces.replace_all(&cleaned, " ").to_string();
        let trimmed_result = cleaned.trim().trim_matches(|c: char| c == '-' || c == '.' || c == '|' || c == ':' || c == '_' || c.is_whitespace()).trim();

        // If the comment has no alphanumeric characters left (purely stripped junk or punctuation), clean to empty string
        if !trimmed_result.chars().any(|c| c.is_alphanumeric()) {
            String::new()
        } else {
            trimmed_result.to_string()
        }
    }

    pub fn sanitize(&self, original_text: &str) -> String {
        self.sanitize_filename(original_text)
    }
}

// Clean and sanitize text for file names and tags, used in unit tests
#[cfg(test)]
pub fn sanitize_text(original_text: &str, strip_phrases: &[String]) -> String {
    CompiledSanitizer::new(strip_phrases).sanitize(original_text)
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

    let sanitizer = CompiledSanitizer::new(strip_phrases);
    let sanitizer_ref = &sanitizer;

    std::thread::scope(|s| {
        for chunk in files.chunks(chunk_size) {
            s.spawn(move || {
                let mut local_items = Vec::new();
                for path in chunk {
                    if is_task_cancelled(task_id) {
                        break;
                    }
                    if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                        let sanitized = sanitizer_ref.sanitize(file_name);
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

    let sanitizer = CompiledSanitizer::new(strip_phrases);
    let sanitizer_ref = &sanitizer;

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
                                let sanitized = sanitizer_ref.sanitize_metadata(&title);
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
                                let sanitized = sanitizer_ref.sanitize_metadata(&artist);
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
                                let sanitized = sanitizer_ref.sanitize_metadata(&album);
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
                                let sanitized = sanitizer_ref.sanitize_comment(&comment);
                                if sanitized != comment.as_ref() {
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

    let sanitizer = CompiledSanitizer::new(strip_phrases);
    let sanitizer_ref = &sanitizer;

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
                        let sanitized = sanitizer_ref.sanitize(file_name);
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
                    let mut has_issue = false;

                    let file_name_for_font = file_name_opt.unwrap_or("");

                    if regex_bangla.is_match(file_name_for_font) {
                        font_issues_list.push("Bangla Script in Filename".to_string());
                        has_issue = true;
                    }
                    if regex_pua.is_match(file_name_for_font) {
                        font_issues_list.push("Private Use Area Symbol (e.g. )".to_string());
                        has_issue = true;
                    }
                    if !has_issue && file_name_for_font.chars().any(|c| c as u32 > 127) {
                        font_issues_list.push("Non-ASCII Characters in Filename".to_string());
                        has_issue = true;
                    }

                    if let Ok(tagged_file) = Probe::open(path).and_then(|f| f.read()) {
                        if let Some(tag) = tagged_file.primary_tag() {
                            // Check title
                            if let Some(title) = tag.title() {
                                let sanitized = sanitizer_ref.sanitize_metadata(&title);
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
                                    has_issue = true;
                                } else if regex_pua.is_match(&title) {
                                    font_issues_list.push("PUA Symbol in Title Tag".to_string());
                                    has_issue = true;
                                }
                            }

                            // Check artist
                            if let Some(artist) = tag.artist() {
                                let sanitized = sanitizer_ref.sanitize_metadata(&artist);
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
                                    has_issue = true;
                                } else if regex_pua.is_match(&artist) {
                                    font_issues_list.push("PUA Symbol in Artist Tag".to_string());
                                    has_issue = true;
                                }
                            }

                            // Check album
                            if let Some(album) = tag.album() {
                                let sanitized = sanitizer_ref.sanitize_metadata(&album);
                                if sanitized != album.as_ref() && !sanitized.is_empty() {
                                    local_metadata.push(MetadataSanitizeItem {
                                        file_path: abs_path_str.clone(),
                                        field_name: "Album".to_string(),
                                        original_value: album.to_string(),
                                        sanitized_value: sanitized,
                                    });
                                }
                                if regex_bangla.is_match(&album) {
                                    font_issues_list.push("Bangla Album Tag".to_string());
                                    has_issue = true;
                                }
                            }

                            // Check comment
                            if let Some(comment) = tag.comment() {
                                let sanitized = sanitizer_ref.sanitize_comment(&comment);
                                if sanitized != comment.as_ref() {
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

                    if has_issue {
                        let file_stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                        let ext_str = path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
                        let clean_stem = crate::font_issues::clean_transliterate(&file_stem);
                        let option2_text = if ext_str.is_empty() {
                            clean_stem
                        } else {
                            format!("{}.{}", clean_stem, ext_str)
                        };

                        local_font_issues.push(crate::font_issues::FontIssueItem {
                            file_path: abs_path_str.clone(),
                            relative_path: rel_path_str.clone(),
                            detected_issue: font_issues_list.join(", "),
                            option1_preview: "Rewrite ID3v2.3 UTF-16 Tags".to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_composite_delimiters_single_pass() {
        let phrases = vec!["Official Video".to_string(), "HD".to_string()];

        // User's exact case: "xxxx | > | xxxx" -> "xxxx - xxxx"
        assert_eq!(sanitize_text("xxxx | > | xxxx", &phrases), "xxxx - xxxx");

        // "Song | > | Artist.mp3" -> "Song - Artist.mp3"
        assert_eq!(sanitize_text("Song | > | Artist.mp3", &phrases), "Song - Artist.mp3");

        // "Song - | - Artist.m4a" -> "Song - Artist.m4a"
        assert_eq!(sanitize_text("Song - | - Artist.m4a", &phrases), "Song - Artist.m4a");

        // "Song | [Official Video] | Artist.m4a" -> "Song - Artist.m4a"
        assert_eq!(sanitize_text("Song | [Official Video] | Artist.m4a", &phrases), "Song - Artist.m4a");

        // "Song | > | [Official Video] | > | Artist.m4a" -> "Song - Artist.m4a"
        assert_eq!(sanitize_text("Song | > | [Official Video] | > | Artist.m4a", &phrases), "Song - Artist.m4a");

        // "01. Song ( - ) Artist.mp3" -> "Song - Artist.mp3"
        assert_eq!(sanitize_text("01. Song ( - ) Artist.mp3", &phrases), "Song - Artist.mp3");

        // Preserve hyphen in compound words like "Non-stop"
        assert_eq!(sanitize_text("Non-stop Party | Remix", &phrases), "Non-stop Party - Remix");

        // Combinations with | and #:
        // "xxxx | # | xxxx" -> "xxxx - xxxx"
        assert_eq!(sanitize_text("xxxx | # | xxxx", &phrases), "xxxx - xxxx");

        // "Song | #shorts | Artist.mp3" -> "Song - Artist.mp3"
        assert_eq!(sanitize_text("Song | #shorts | Artist.mp3", &phrases), "Song - Artist.mp3");

        // "Song | # | > | Artist.mp3" -> "Song - Artist.mp3"
        assert_eq!(sanitize_text("Song | # | > | Artist.mp3", &phrases), "Song - Artist.mp3");

        // Trailing and leading # with pipes: "# Song | #shorts #trending | .mp3" -> "Song.mp3"
        assert_eq!(sanitize_text("# Song | #shorts #trending | .mp3", &phrases), "Song.mp3");

        // User's exact bug: "Loca (feat. El Cata).mp3" MUST NOT lose its closing parenthesis!
        assert_eq!(sanitize_text("Loca (feat. El Cata).mp3", &phrases), "Loca (feat. El Cata).mp3");
        assert_eq!(sanitize_text("Shape of You (Acoustic).mp3", &phrases), "Shape of You (Acoustic).mp3");
        assert_eq!(sanitize_text("Hotel California [Live].mp3", &phrases), "Hotel California [Live].mp3");
        assert_eq!(sanitize_text("(I Can't Get No) Satisfaction.mp3", &phrases), "(I Can't Get No) Satisfaction.mp3");

        // Leading track numbers vs song titles that start with numbers:
        assert_eq!(sanitize_text("01. Loca (feat. El Cata).mp3", &phrases), "Loca (feat. El Cata).mp3");
        assert_eq!(sanitize_text("01 - Loca (feat. El Cata).mp3", &phrases), "Loca (feat. El Cata).mp3");
        assert_eq!(sanitize_text("21 Guns.mp3", &phrases), "21 Guns.mp3");

        // Metadata sanitization tests:
        let sanitizer = CompiledSanitizer::new(&phrases);
        assert_eq!(sanitizer.sanitize_metadata("Loca (feat. El Cata)"), "Loca (feat. El Cata)");
        assert_eq!(sanitizer.sanitize_metadata("21 Guns"), "21 Guns");
        assert_eq!(sanitizer.sanitize_metadata("1984"), "1984");
        assert_eq!(sanitizer.sanitize_metadata("Ek Nodi Rokta Paria "), "Ek Nodi Rokta Paria");
        assert_eq!(sanitizer.sanitize_metadata("Ek Nodi  Rokta Paria"), "Ek Nodi Rokta Paria");

        // URL removal from filenames:
        assert_eq!(sanitizer.sanitize_filename("01. www.SongsPK.com - Loca (feat. El Cata).mp3"), "Loca (feat. El Cata).mp3");
        assert_eq!(sanitizer.sanitize_filename("Title [PagalWorld.com].mp3"), "Title.mp3");
        assert_eq!(sanitizer.sanitize_filename("Track Name - https://youtube.com/watch?v=12345.mp3"), "Track Name.mp3");
        assert_eq!(sanitizer.sanitize_filename("Song (www.youtube.com).mp3"), "Song.mp3");
        assert_eq!(sanitizer.sanitize_filename("Artist - Song (downloaded from pagalworld.com).mp3"), "Artist - Song.mp3");

        // URL removal from tag names (Title, Artist, Album):
        assert_eq!(sanitizer.sanitize_metadata("Loca (feat. El Cata) [www.SongsPK.com]"), "Loca (feat. El Cata)");
        assert_eq!(sanitizer.sanitize_metadata("Title - PagalWorld.com"), "Title");
        assert_eq!(sanitizer.sanitize_metadata("Artist (Visit www.doridro.com)"), "Artist");

        // URL preservation in Description (Comment):
        // 1. Pure YouTube URL must remain 100% byte-for-byte identical (no punctuation mangling):
        assert_eq!(
            sanitizer.sanitize_comment("https://www.youtube.com/watch?v=iZb9_8MCGew"),
            "https://www.youtube.com/watch?v=iZb9_8MCGew"
        );
        // 2. URL embedded in comment text must preserve URL and sentence punctuation:
        assert_eq!(
            sanitizer.sanitize_comment("Source: https://www.youtube.com/watch?v=iZb9_8MCGew"),
            "Source: https://www.youtube.com/watch?v=iZb9_8MCGew"
        );
        // 3. PUA characters stripped but URL preserved:
        assert_eq!(
            sanitizer.sanitize_comment("https://www.youtube.com/watch?v=iZb9_8MCGew \u{F027}"),
            "https://www.youtube.com/watch?v=iZb9_8MCGew"
        );

        // 4. Promotional website in comment completely removed (including 'www.'):
        let bd_phrases = vec!["music.com.bd".to_string()];
        let bd_sanitizer = CompiledSanitizer::new(&bd_phrases);
        assert_eq!(bd_sanitizer.sanitize_comment("www.music.com.bd"), "");
        assert_eq!(bd_sanitizer.sanitize_comment("www."), "");
        assert_eq!(bd_sanitizer.sanitize_comment("Visit www.music.com.bd"), "Visit");
        assert_eq!(bd_sanitizer.sanitize_metadata("Porshi - Tomari Porosh [www.music.com.bd]"), "Porshi - Tomari Porosh");
    }
}
