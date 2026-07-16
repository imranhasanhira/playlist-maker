use std::fs;
use std::path::Path;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;
use regex::{Regex, RegexBuilder};

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

// Replicate Python's sanitizeText
pub fn sanitize_text(original_text: &str) -> String {
    let mut new_text = original_text.to_string();

    let parts = vec![
        "music.com.bd", "SVF", "Tseries",
        "Full Video", "Full audio", "Full HD", "Full Song",
        "New Video", "New Song", "New audio",
        "High Quality", "best song", "best Quality", "Best Audio", "best video", "best movie",
        "With Lyrics", "Lyrical",
        "The Movie",
        "Hindi Film", "Super Hindi Album", "Hindi Album",
        "ENGlish subtitle", "bangla subtitle", "Eng subtitle", "Eng Sub",
        "Bengali Film", "Bengla Film" , "Bangla Movie", "Eskay Movies",
        "Bangla New Song", "new Bangla song", "new song", "bangla song",
        "Film","Movie", "Songs", "Song", "Music", "Audio",
        "SUBTITLE", "sub title", "Title", "Lyrics", "Lyric", "Video",
        "Quality", "Original", "Official",
        "DVD", "Blue Ray",
        "＂"
    ];

    // Remove keywords case-insensitively
    for part in parts {
        if let Ok(re) = RegexBuilder::new(&regex::escape(part))
            .case_insensitive(true)
            .build()
        {
            new_text = re.replace_all(&new_text, "").to_string();
        }
    }

    // Run regex replacements
    // re.sub(r"I+", r'I', new_text)
    if let Ok(re) = Regex::new(r"I+") {
        new_text = re.replace_all(&new_text, "I").to_string();
    }

    // re.sub(r"[(|｜\[\{]+(HQ|HD)[)|｜\]\}]+", r'', new_text, flags=re.IGNORECASE)
    if let Ok(re) = RegexBuilder::new(r"[(|｜\[\{]+(HQ|HD)[)|｜\]\}]+")
        .case_insensitive(true)
        .build()
    {
        new_text = re.replace_all(&new_text, "").to_string();
    }

    // re.sub(r"\s+\d+p\s+", r'', new_text, flags=re.IGNORECASE)
    if let Ok(re) = RegexBuilder::new(r"\s+\d+p\s+")
        .case_insensitive(true)
        .build()
    {
        new_text = re.replace_all(&new_text, "").to_string();
    }

    // Python: re.sub(r"\s*[|(｜\|\-\[\{]+(\s*[)|｜\|\-\]\}])+\s*", " | ", new_text)
    if let Ok(re) = Regex::new(r"\s*[|(｜\|\-\[\{]+(\s*[)|｜\|\-\]\}])+\s*") {
        new_text = re.replace_all(&new_text, " | ").to_string();
    }

    // Python: re.sub(r"\s?[\":：＂]+\s?", " | ", new_text)
    if let Ok(re) = Regex::new(r#"\s?[":：＂]+\s?"#) {
        new_text = re.replace_all(&new_text, " | ").to_string();
    }

    // Python: re.sub(r"^\.*\s*\d+\.*\s*", "", new_text)
    if let Ok(re) = Regex::new(r"^\.*\s*\d+\.*\s*") {
        new_text = re.replace_all(&new_text, "").to_string();
    }

    // Python: re.sub(r"\.+", ".", new_text)
    if let Ok(re) = Regex::new(r"\.+") {
        new_text = re.replace_all(&new_text, ".").to_string();
    }

    // Python: re.sub(r"\s+", " ", new_text)
    if let Ok(re) = Regex::new(r"\s+") {
        new_text = re.replace_all(&new_text, " ").to_string();
    }

    // Python: re.sub(r"^[()|｜:：＂'\"\-\[\]\{\}\s]+", "", new_text)
    if let Ok(re) = Regex::new(r#"^[()|｜:：＂'"\-\[\]\{\}\s]+"#) {
        new_text = re.replace_all(&new_text, "").to_string();
    }

    // Python: re.sub(r"[(|｜:：＂'\"\-\[\]\{\}\s]+(\.[^\.]+)$", r"\1", new_text)
    if let Ok(re) = Regex::new(r#"[(|｜:：＂'"\-\[\]\{\}\s]+(\.[^\.]+)$"#) {
        new_text = re.replace_all(&new_text, "$1").to_string();
    }

    new_text.trim().to_string()
}

pub fn scan_sanitize_files(
    folder: &Path,
    formats: &[String],
) -> Result<Vec<SanitizeItem>, String> {
    if !folder.exists() {
        return Err(format!("Folder does not exist: {}", folder.display()));
    }

    let formats_set: std::collections::HashSet<String> = formats
        .iter()
        .map(|f| f.to_lowercase())
        .collect();

    let mut items = Vec::new();

    for entry in WalkDir::new(folder).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let path = entry.path();
            if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                // Check extension
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if formats_set.contains(&ext.to_lowercase()) {
                        let sanitized = sanitize_text(file_name);
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
                }
            }
        }
    }

    Ok(items)
}

pub fn execute_rename_files(items: Vec<SanitizeItem>) -> Result<(), String> {
    for item in items {
        let old_path = Path::new(&item.original_path);
        if old_path.exists() {
            let new_path = old_path.parent().unwrap().join(&item.sanitized_name);
            fs::rename(old_path, new_path)
                .map_err(|e| format!("Failed to rename {}: {}", item.original_name, e))?;
        }
    }
    Ok(())
}

pub fn scan_hidden_files(folder: &Path) -> Result<Vec<HiddenFileItem>, String> {
    if !folder.exists() {
        return Err(format!("Folder does not exist: {}", folder.display()));
    }

    let mut items = Vec::new();

    for entry in WalkDir::new(folder).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with('.') {
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
        }
    }

    Ok(items)
}

pub fn execute_delete_files(file_paths: Vec<String>) -> Result<(), String> {
    for path_str in file_paths {
        let path = Path::new(&path_str);
        if path.exists() && path.is_file() {
            fs::remove_file(path)
                .map_err(|e| format!("Failed to delete {}: {}", path_str, e))?;
        }
    }
    Ok(())
}
