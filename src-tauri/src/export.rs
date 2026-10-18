use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use walkdir::WalkDir;

use lofty::prelude::*;
use lofty::probe::Probe;

use crate::playlist::{self, TrackPreview};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub enum ExportStatus {
    New,
    Modified,
    UpToDate,
    Renamed,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TrackDiffField {
    pub field: String,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TrackDiffDetails {
    pub has_tag_changes: bool,
    pub has_artwork_changes: bool,
    pub has_audio_changes: bool,
    pub diffs: Vec<TrackDiffField>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExportTrackItem {
    pub file_path: String,
    pub relative_path: String,
    pub dest_relative_path: String,
    pub old_dest_relative_path: Option<String>,
    pub size_bytes: u64,
    pub mtime_secs: u64,
    pub status: ExportStatus,
    pub diff_details: Option<TrackDiffDetails>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExportOrphanItem {
    pub file_path: String,
    pub relative_path: String,
    pub size_bytes: u64,
    pub is_playlist: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExportPlaylistItem {
    pub name: String,
    pub filename: String,
    pub track_count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExportWarningItem {
    pub scope: String,
    pub target_path: String,
    pub warning_type: String,
    pub message: String,
    pub affected_count: usize,
    pub sample_files: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExportDiffReport {
    pub destination: String,
    pub new_files: Vec<ExportTrackItem>,
    pub updated_files: Vec<ExportTrackItem>,
    pub up_to_date_files: Vec<ExportTrackItem>,
    pub renamed_files: Vec<ExportTrackItem>,
    pub orphan_files: Vec<ExportOrphanItem>,
    pub playlists: Vec<ExportPlaylistItem>,
    pub warnings: Vec<ExportWarningItem>,
    pub total_bytes_to_copy: u64,
    pub total_bytes_updated: u64,
    pub total_bytes_up_to_date: u64,
    pub total_bytes_renamed: u64,
    pub total_bytes_orphans: u64,
}

use crate::utils::{canonical_path_str, get_file_mtime_and_size};

fn sanitize_playlist_filename(name: &str) -> String {
    let invalid_chars = ['/', '\\', '?', '%', '*', ':', '|', '"', '<', '>'];
    let clean: String = name
        .chars()
        .map(|ch| if invalid_chars.contains(&ch) { '_' } else { ch })
        .collect();
    let trimmed = clean.trim();
    if trimmed.is_empty() {
        "playlist".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn compute_track_diff(src_path: &Path, dest_path: &Path, src_size: u64, dest_size: u64) -> TrackDiffDetails {
    let mut diffs: Vec<TrackDiffField> = Vec::new();
    let mut has_tag_changes = false;
    let mut has_artwork_changes = false;

    let src_tagged = Probe::open(src_path).ok().and_then(|p| p.read().ok());
    let dest_tagged = Probe::open(dest_path).ok().and_then(|p| p.read().ok());

    let src_tag = src_tagged.as_ref().and_then(|tf| tf.primary_tag().or_else(|| tf.first_tag()));
    let dest_tag = dest_tagged.as_ref().and_then(|tf| tf.primary_tag().or_else(|| tf.first_tag()));

    let mut check_tag_field = |field_name: &str, old_val: Option<&str>, new_val: Option<&str>| {
        let old_clean = old_val.map(|s| s.trim()).filter(|s| !s.is_empty());
        let new_clean = new_val.map(|s| s.trim()).filter(|s| !s.is_empty());
        if old_clean != new_clean {
            has_tag_changes = true;
            diffs.push(TrackDiffField {
                field: field_name.to_string(),
                old_value: old_clean.map(|s| s.to_string()),
                new_value: new_clean.map(|s| s.to_string()),
            });
        }
    };

    let dest_title = dest_tag.and_then(|t| t.title());
    let src_title = src_tag.and_then(|t| t.title());
    check_tag_field("Title", dest_title.as_deref(), src_title.as_deref());

    let dest_artist = dest_tag.and_then(|t| t.artist());
    let src_artist = src_tag.and_then(|t| t.artist());
    check_tag_field("Artist", dest_artist.as_deref(), src_artist.as_deref());

    let dest_album = dest_tag.and_then(|t| t.album());
    let src_album = src_tag.and_then(|t| t.album());
    check_tag_field("Album", dest_album.as_deref(), src_album.as_deref());

    let dest_year = dest_tag.and_then(|t| t.year()).map(|y| y.to_string());
    let src_year = src_tag.and_then(|t| t.year()).map(|y| y.to_string());
    check_tag_field("Year", dest_year.as_deref(), src_year.as_deref());

    let dest_track = dest_tag.and_then(|t| t.track()).map(|tr| tr.to_string());
    let src_track = src_tag.and_then(|t| t.track()).map(|tr| tr.to_string());
    check_tag_field("Track #", dest_track.as_deref(), src_track.as_deref());

    let dest_genre = dest_tag.and_then(|t| t.genre());
    let src_genre = src_tag.and_then(|t| t.genre());
    check_tag_field("Genre", dest_genre.as_deref(), src_genre.as_deref());

    let dest_comment = dest_tag.and_then(|t| t.comment());
    let src_comment = src_tag.and_then(|t| t.comment());
    check_tag_field("Comment", dest_comment.as_deref(), src_comment.as_deref());

    // Cover Art comparison
    let dest_pics = dest_tag.map(|t| t.pictures()).unwrap_or(&[]);
    let src_pics = src_tag.map(|t| t.pictures()).unwrap_or(&[]);
    let dest_pic_info = dest_pics.first().map(|p| {
        format!(
            "{} ({} KB)",
            p.mime_type().map(|m| m.to_string()).unwrap_or_else(|| "image".to_string()),
            p.data().len() / 1024
        )
    });
    let src_pic_info = src_pics.first().map(|p| {
        format!(
            "{} ({} KB)",
            p.mime_type().map(|m| m.to_string()).unwrap_or_else(|| "image".to_string()),
            p.data().len() / 1024
        )
    });

    if dest_pic_info != src_pic_info {
        has_artwork_changes = true;
        diffs.push(TrackDiffField {
            field: "Cover Art".to_string(),
            old_value: dest_pic_info,
            new_value: src_pic_info,
        });
    }

    // Audio stream comparison
    let (_dest_q, dest_audio_hash) = crate::dedup::compute_file_hashes(dest_path, dest_size);
    let (_src_q, src_audio_hash) = crate::dedup::compute_file_hashes(src_path, src_size);
    let has_audio_changes = dest_audio_hash != src_audio_hash;

    diffs.push(TrackDiffField {
        field: "Audio Stream".to_string(),
        old_value: Some(if has_audio_changes { "Previous audio stream" } else { "Unchanged" }.to_string()),
        new_value: Some(if has_audio_changes { "Modified / Re-encoded" } else { "Unchanged (Metadata-only update)" }.to_string()),
    });

    if src_size != dest_size {
        diffs.push(TrackDiffField {
            field: "File Size".to_string(),
            old_value: Some(format!("{:.2} MB", dest_size as f64 / 1_048_576.0)),
            new_value: Some(format!("{:.2} MB", src_size as f64 / 1_048_576.0)),
        });
    }

    TrackDiffDetails {
        has_tag_changes,
        has_artwork_changes,
        has_audio_changes,
        diffs,
    }
}

#[tauri::command]
pub async fn analyze_export_diff(
    config_path: String,
    destination: String,
    formats: Vec<String>,
    relative_to_config: bool,
    skip_duplicates: Option<bool>,
) -> Result<ExportDiffReport, String> {
    let config_file_path = Path::new(&config_path);
    if !config_file_path.exists() {
        return Err(format!("Configuration file not found: {}", config_path));
    }

    let config = playlist::read_config_file(config_file_path)?;

    let resolved_source_dir = playlist::find_right_dir(
        None,
        config.source_dir.clone(),
        relative_to_config,
        config_file_path,
    );

    let formats_set: HashSet<String> = formats
        .iter()
        .map(|s| s.trim().to_lowercase())
        .collect();

    let dest_path = Path::new(&destination);
    let dest_music_dir = dest_path.join("music");
    let dest_playlists_dir = dest_path.join("playlists");

    let replacement_map = if skip_duplicates.unwrap_or(false) {
        crate::dedup::build_export_superior_replacement_map(&config, &resolved_source_dir, &formats_set)
    } else {
        HashMap::new()
    };

    // Map of unique source tracks across all playlists: relative_path -> (absolute_source_path, TrackPreview)
    let mut required_tracks: HashMap<String, (String, TrackPreview)> = HashMap::new();
    let mut playlist_items: Vec<ExportPlaylistItem> = Vec::new();

    for pl in &config.playlists {
        let (sub_playlists, _) = playlist::expand_playlist_buckets(pl, &resolved_source_dir, &formats_set, config.min_tracks_per_year_playlist);
        for sub in sub_playlists {
            let sanitized_name = sanitize_playlist_filename(&sub.name);
            let filename = format!("{}.m3u8", sanitized_name);

            // Substitute inferior duplicate files with the superior file and deduplicate within the sub-playlist
            let mut resolved_sub_files = Vec::new();
            let mut seen_in_sub = HashSet::new();
            for file_path_buf in sub.files {
                let c_str = canonical_path_str(&file_path_buf);
                let effective_path = replacement_map.get(&c_str).cloned().unwrap_or(file_path_buf);
                let eff_c_str = canonical_path_str(&effective_path);
                if seen_in_sub.insert(eff_c_str) {
                    resolved_sub_files.push(effective_path);
                }
            }

            playlist_items.push(ExportPlaylistItem {
                name: sub.name.clone(),
                filename,
                track_count: resolved_sub_files.len(),
            });

            for file_path_buf in resolved_sub_files {
                let track_src_path = file_path_buf.as_path();
                let canonical_src = fs::canonicalize(track_src_path).unwrap_or_else(|_| track_src_path.to_path_buf());
                let track = playlist::get_track_preview(&canonical_src, &resolved_source_dir);

                // Compute relative path from resolved_source_dir
                let rel_path = match canonical_src.strip_prefix(&resolved_source_dir) {
                    Ok(p) => p.to_string_lossy().to_string(),
                    Err(_) => track_src_path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| track.title.clone()),
                };

                let rel_clean = rel_path.replace('\\', "/");
                required_tracks.entry(rel_clean).or_insert((canonical_path_str(&canonical_src), track));
            }
        }
    }

    let mut new_files: Vec<ExportTrackItem> = Vec::new();
    let mut updated_files: Vec<ExportTrackItem> = Vec::new();
    let mut up_to_date_files: Vec<ExportTrackItem> = Vec::new();
    let mut renamed_files: Vec<ExportTrackItem> = Vec::new();
    let mut total_bytes_to_copy: u64 = 0;
    let mut total_bytes_updated: u64 = 0;
    let mut total_bytes_up_to_date: u64 = 0;
    let mut total_bytes_renamed: u64 = 0;

    let mut expected_dest_rel_paths: HashSet<String> = HashSet::new();
    let mut candidate_new_tracks: Vec<(String, String, u64, u64)> = Vec::new();

    for (rel_path, (src_abs_path, _track)) in &required_tracks {
        expected_dest_rel_paths.insert(rel_path.clone());

        let src_path = Path::new(src_abs_path);
        let dest_file_path = dest_music_dir.join(rel_path);

        let (src_mtime, src_size) = get_file_mtime_and_size(src_path).unwrap_or((0, 0));

        if dest_file_path.exists() {
            if let Some((dest_mtime, dest_size)) = get_file_mtime_and_size(&dest_file_path) {
                if src_size == dest_size && src_mtime <= dest_mtime {
                    total_bytes_up_to_date += src_size;
                    up_to_date_files.push(ExportTrackItem {
                        file_path: src_abs_path.clone(),
                        relative_path: rel_path.clone(),
                        dest_relative_path: format!("music/{}", rel_path),
                        old_dest_relative_path: None,
                        size_bytes: src_size,
                        mtime_secs: src_mtime,
                        status: ExportStatus::UpToDate,
                        diff_details: None,
                    });
                } else {
                    let diff_details = compute_track_diff(src_path, &dest_file_path, src_size, dest_size);
                    total_bytes_updated += src_size;
                    updated_files.push(ExportTrackItem {
                        file_path: src_abs_path.clone(),
                        relative_path: rel_path.clone(),
                        dest_relative_path: format!("music/{}", rel_path),
                        old_dest_relative_path: None,
                        size_bytes: src_size,
                        mtime_secs: src_mtime,
                        status: ExportStatus::Modified,
                        diff_details: Some(diff_details),
                    });
                }
            } else {
                candidate_new_tracks.push((rel_path.clone(), src_abs_path.clone(), src_size, src_mtime));
            }
        } else {
            candidate_new_tracks.push((rel_path.clone(), src_abs_path.clone(), src_size, src_mtime));
        }
    }

fn is_os_system_junk(filename: &str) -> bool {
    filename.starts_with('.')
        || filename.starts_with("._")
        || filename.eq_ignore_ascii_case("thumbs.db")
        || filename.eq_ignore_ascii_case("desktop.ini")
}

    // Expected playlist filenames
    let expected_playlists: HashSet<String> = playlist_items.iter().map(|p| p.filename.clone()).collect();

    // Scan destination for orphans and candidate renamed files
    let mut candidate_dest_orphans: Vec<(std::path::PathBuf, String, u64)> = Vec::new();
    let mut orphan_files: Vec<ExportOrphanItem> = Vec::new();
    let mut total_bytes_orphans: u64 = 0;

    if dest_music_dir.exists() {
        for entry in WalkDir::new(&dest_music_dir).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                if let Some(file_name) = entry.path().file_name().and_then(|n| n.to_str()) {
                    if is_os_system_junk(file_name) {
                        continue;
                    }
                }
                if let Ok(rel) = entry.path().strip_prefix(&dest_music_dir) {
                    let rel_clean = rel.to_string_lossy().replace('\\', "/");
                    if !expected_dest_rel_paths.contains(&rel_clean) {
                        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        candidate_dest_orphans.push((entry.path().to_path_buf(), rel_clean, size));
                    }
                }
            }
        }
    }

    // Pass 2: Audio Stream Hash Matching between candidate_new_tracks and candidate_dest_orphans
    let mut matched_orphan_indices: HashSet<usize> = HashSet::new();

    if !candidate_new_tracks.is_empty() && !candidate_dest_orphans.is_empty() {
        // Build hash index of candidate destination orphans: audio_hash -> Vec<orphan_idx>
        let mut dest_hash_index: HashMap<String, Vec<usize>> = HashMap::new();
        for (idx, (dest_path, _rel, size)) in candidate_dest_orphans.iter().enumerate() {
            let (_q_hash, audio_hash) = crate::dedup::compute_file_hashes(dest_path, *size);
            dest_hash_index.entry(audio_hash).or_default().push(idx);
        }

        for (rel_path, src_abs_path, src_size, src_mtime) in candidate_new_tracks {
            let src_path = Path::new(&src_abs_path);
            let (_src_q_hash, src_audio_hash) = crate::dedup::compute_file_hashes(src_path, src_size);

            if let Some(matching_indices) = dest_hash_index.get_mut(&src_audio_hash) {
                if let Some(orphan_idx) = matching_indices.pop() {
                    matched_orphan_indices.insert(orphan_idx);
                    let (old_path, old_rel, old_size) = &candidate_dest_orphans[orphan_idx];
                    let diff_details = compute_track_diff(src_path, old_path, src_size, *old_size);
                    total_bytes_renamed += src_size;
                    renamed_files.push(ExportTrackItem {
                        file_path: src_abs_path,
                        relative_path: rel_path.clone(),
                        dest_relative_path: format!("music/{}", rel_path),
                        old_dest_relative_path: Some(format!("music/{}", old_rel)),
                        size_bytes: src_size,
                        mtime_secs: src_mtime,
                        status: ExportStatus::Renamed,
                        diff_details: Some(diff_details),
                    });
                    continue;
                }
            }

            // Truly New file (no matching audio hash in destination)
            total_bytes_to_copy += src_size;
            new_files.push(ExportTrackItem {
                file_path: src_abs_path,
                relative_path: rel_path.clone(),
                dest_relative_path: format!("music/{}", rel_path),
                old_dest_relative_path: None,
                size_bytes: src_size,
                mtime_secs: src_mtime,
                status: ExportStatus::New,
                diff_details: None,
            });
        }
    } else {
        // If no candidate orphans, all candidate new tracks are truly new
        for (rel_path, src_abs_path, src_size, src_mtime) in candidate_new_tracks {
            total_bytes_to_copy += src_size;
            new_files.push(ExportTrackItem {
                file_path: src_abs_path,
                relative_path: rel_path.clone(),
                dest_relative_path: format!("music/{}", rel_path),
                old_dest_relative_path: None,
                size_bytes: src_size,
                mtime_secs: src_mtime,
                status: ExportStatus::New,
                diff_details: None,
            });
        }
    }

    // Truly Orphaned audio tracks (not matched to any renamed track)
    for (idx, (dest_path, rel_clean, size)) in candidate_dest_orphans.into_iter().enumerate() {
        if !matched_orphan_indices.contains(&idx) {
            total_bytes_orphans += size;
            orphan_files.push(ExportOrphanItem {
                file_path: dest_path.to_string_lossy().to_string(),
                relative_path: format!("music/{}", rel_clean),
                size_bytes: size,
                is_playlist: false,
            });
        }
    }

    if dest_playlists_dir.exists() {
        for entry in WalkDir::new(&dest_playlists_dir).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                if let Some(file_name) = entry.path().file_name().and_then(|n| n.to_str()) {
                    if is_os_system_junk(file_name) {
                        continue;
                    }
                }
                if let Ok(rel) = entry.path().strip_prefix(&dest_playlists_dir) {
                    let filename = rel.to_string_lossy().to_string();
                    if !expected_playlists.contains(&filename) {
                        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        total_bytes_orphans += size;
                        orphan_files.push(ExportOrphanItem {
                            file_path: entry.path().to_string_lossy().to_string(),
                            relative_path: format!("playlists/{}", filename),
                            size_bytes: size,
                            is_playlist: true,
                        });
                    }
                }
            }
        }
    }

    let regex_pua = regex::Regex::new(r"[\uF000-\uFFFF]").unwrap_or_else(|_| regex::Regex::new(r"$^").unwrap());
    let regex_bangla = regex::Regex::new(r"[\u0980-\u09FF]").unwrap_or_else(|_| regex::Regex::new(r"$^").unwrap());
    let regex_illegal_fat = regex::Regex::new(r#"[:*?"<>|]"#).unwrap_or_else(|_| regex::Regex::new(r"$^").unwrap());

    let mut dir_invalid_symbols: HashMap<String, (usize, Vec<String>)> = HashMap::new();
    let mut group_warnings: HashMap<(String, String), Vec<String>> = HashMap::new();

    for (rel_path, (_src_abs_path, _track)) in &required_tracks {
        let dest_full_path = dest_music_dir.join(rel_path);
        let dest_str = dest_full_path.to_string_lossy().to_string();

        let parent_dir = Path::new(rel_path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "Root".to_string());

        if regex_pua.is_match(&parent_dir) {
            let entry = dir_invalid_symbols.entry(parent_dir.clone()).or_insert((0, Vec::new()));
            entry.0 += 1;
            if entry.1.len() < 5 {
                entry.1.push(rel_path.clone());
            }
        }

        if regex_illegal_fat.is_match(rel_path) {
            let key = (parent_dir.clone(), "illegal_char".to_string());
            group_warnings.entry(key).or_default().push(rel_path.clone());
        }

        if dest_str.len() > 255 {
            let key = (parent_dir.clone(), "path_too_long".to_string());
            group_warnings.entry(key).or_default().push(rel_path.clone());
        }

        if regex_bangla.is_match(rel_path) {
            let key = (parent_dir.clone(), "non_ascii".to_string());
            group_warnings.entry(key).or_default().push(rel_path.clone());
        }
    }

    let mut warnings: Vec<ExportWarningItem> = Vec::new();

    for (dir_path, (count, samples)) in dir_invalid_symbols {
        warnings.push(ExportWarningItem {
            scope: "directory".to_string(),
            target_path: dir_path,
            warning_type: "invalid_symbol".to_string(),
            message: "Folder path contains Private Use Area symbol ('') which causes FAT32 directory errors on car media players".to_string(),
            affected_count: count,
            sample_files: samples,
        });
    }

    for ((dir_path, w_type), tracks) in group_warnings {
        let msg = if w_type == "path_too_long" {
            "Path lengths in this folder exceed 255 characters (FAT32 limit for car players)".to_string()
        } else if w_type == "illegal_char" {
            "Filenames or paths contain forbidden FAT32/exFAT characters (such as '|', ':', '\"', '?', '*') which car infotainment systems cannot read or index".to_string()
        } else {
            "Filenames in this folder contain Bangla script. Ensure ID3v2.3 UTF-16 tags are written so BMW iDrive can render text".to_string()
        };

        warnings.push(ExportWarningItem {
            scope: "track_group".to_string(),
            target_path: dir_path,
            warning_type: w_type,
            message: msg,
            affected_count: tracks.len(),
            sample_files: tracks.into_iter().take(10).collect(),
        });
    }

    if dest_path.exists() {
        let mut apple_double_count = 0;
        let mut apple_double_samples = Vec::new();
        for entry in WalkDir::new(dest_path).into_iter().filter_map(|e| e.ok()) {
            let filename = entry.file_name().to_string_lossy();
            if filename.starts_with("._") {
                apple_double_count += 1;
                if apple_double_samples.len() < 5 {
                    apple_double_samples.push(filename.to_string());
                }
            }
        }

        if apple_double_count > 0 {
            warnings.push(ExportWarningItem {
                scope: "system".to_string(),
                target_path: destination.to_string(),
                warning_type: "apple_double".to_string(),
                message: "Found hidden macOS resource fork files ('._*') in destination which crash car media indexers".to_string(),
                affected_count: apple_double_count,
                sample_files: apple_double_samples,
            });
        }
    }

    new_files.sort_by(|a, b| a.relative_path.to_lowercase().cmp(&b.relative_path.to_lowercase()));
    updated_files.sort_by(|a, b| a.relative_path.to_lowercase().cmp(&b.relative_path.to_lowercase()));
    up_to_date_files.sort_by(|a, b| a.relative_path.to_lowercase().cmp(&b.relative_path.to_lowercase()));
    renamed_files.sort_by(|a, b| a.relative_path.to_lowercase().cmp(&b.relative_path.to_lowercase()));
    orphan_files.sort_by(|a, b| a.relative_path.to_lowercase().cmp(&b.relative_path.to_lowercase()));
    playlist_items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(ExportDiffReport {
        destination: destination.to_string(),
        new_files,
        updated_files,
        up_to_date_files,
        renamed_files,
        orphan_files,
        playlists: playlist_items,
        warnings,
        total_bytes_to_copy,
        total_bytes_updated,
        total_bytes_up_to_date,
        total_bytes_renamed,
        total_bytes_orphans,
    })
}

#[tauri::command]
pub async fn reveal_in_finder(filePath: String) -> Result<(), String> {
    let path = Path::new(&filePath);
    if !path.exists() {
        return Err(format!("File does not exist: {}", filePath));
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&filePath)
            .spawn()
            .map_err(|e| format!("Failed to reveal file in Finder: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&filePath)
            .spawn()
            .map_err(|e| format!("Failed to reveal file in Explorer: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        let dir = path.parent().unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to open directory: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_export_files(filePaths: Vec<String>) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let mut count = 0;
        for path_str in filePaths {
            let path = Path::new(&path_str);
            if path.exists() || path.symlink_metadata().is_ok() {
                if let Ok(metadata) = path.symlink_metadata() {
                    let mut permissions = metadata.permissions();
                    if permissions.readonly() {
                        permissions.set_readonly(false);
                        let _ = fs::set_permissions(path, permissions);
                    }
                }
                if path.is_dir() {
                    if fs::remove_dir_all(path).is_ok() {
                        count += 1;
                    }
                } else {
                    if fs::remove_file(path).is_ok() {
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
pub async fn apply_export_renames(
    destination: String,
    items: Vec<ExportTrackItem>,
) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let dest_path = Path::new(&destination);
        let dest_music_dir = dest_path.join("music");
        let mut count = 0;

        for item in items {
            if let Some(ref old_dest_rel) = item.old_dest_relative_path {
                let old_full_path = dest_path.join(old_dest_rel);
                let new_full_path = dest_music_dir.join(&item.relative_path);

                if old_full_path.exists() {
                    if let Some(parent) = new_full_path.parent() {
                        if !parent.exists() {
                            let _ = fs::create_dir_all(parent);
                        }
                    }
                    if fs::rename(&old_full_path, &new_full_path).is_ok() {
                        count += 1;
                    } else {
                        let src_path = Path::new(&item.file_path);
                        if fs::copy(src_path, &new_full_path).is_ok() {
                            let _ = fs::remove_file(&old_full_path);
                            count += 1;
                        }
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
pub async fn apply_export_copies(
    app: tauri::AppHandle,
    destination: String,
    items: Vec<ExportTrackItem>,
) -> Result<usize, String> {
    use tauri::Emitter;

    tokio::task::spawn_blocking(move || {
        let dest_path = Path::new(&destination);
        let dest_music_dir = dest_path.join("music");
        let mut count = 0;
        let total = items.len();

        for (idx, item) in items.iter().enumerate() {
            let src_path = Path::new(&item.file_path);
            let dest_file_path = dest_music_dir.join(&item.relative_path);

            if let Some(parent) = dest_file_path.parent() {
                if !parent.exists() {
                    let _ = fs::create_dir_all(parent);
                }
            }

            if fs::copy(src_path, &dest_file_path).is_ok() {
                count += 1;
            }

            let _ = app.emit(
                "export-quick-progress",
                serde_json::json!({
                    "current": idx + 1,
                    "total": total,
                    "file": item.relative_path,
                }),
            );
        }

        Ok(count)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

pub static EXPORT_CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
pub struct ExportProgressPayload {
    pub current_file_index: usize,
    pub total_files: usize,
    pub copied_bytes: u64,
    pub total_bytes: u64,
    pub current_file: String,
}

#[tauri::command]
pub async fn cancel_export() -> Result<(), String> {
    EXPORT_CANCELLED.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn execute_export(
    app: tauri::AppHandle,
    taskId: String,
    config_path: String,
    destination: String,
    delete_orphans: bool,
    skip_duplicates: Option<bool>,
    excluded_paths: Vec<String>,
    formats: Vec<String>,
    relative_to_config: bool,
) -> Result<Vec<String>, String> {
    use tauri::Emitter;

    EXPORT_CANCELLED.store(false, Ordering::SeqCst);

    let mut logs: Vec<String> = Vec::new();
    let push_log = |msg: String, logs: &mut Vec<String>| {
        let _ = app.emit("export-log", msg.clone());
        logs.push(msg);
    };

    let skip_dups = skip_duplicates.unwrap_or(false);
    let formats_str = formats.join(",");
    let exact_cmd = format!(
        "$ sync-export --config \"{}\" --destination \"{}\" --formats \"{}\"{}{}",
        config_path,
        destination,
        formats_str,
        if skip_dups { " --skip-duplicates" } else { "" },
        if delete_orphans { " --delete-orphans" } else { "" }
    );
    push_log(exact_cmd, &mut logs);
    push_log("Starting smart sync export process...".to_string(), &mut logs);

    let report = analyze_export_diff(
        config_path.clone(),
        destination.clone(),
        formats.clone(),
        relative_to_config,
        Some(skip_dups),
    )
    .await?;

    let excluded_set: HashSet<String> = excluded_paths.into_iter().collect();

    let dest_path = Path::new(&destination);
    let dest_music_dir = dest_path.join("music");
    let dest_playlists_dir = dest_path.join("playlists");

    fs::create_dir_all(&dest_music_dir)
        .map_err(|e| format!("Failed to create destination music directory: {}", e))?;
    fs::create_dir_all(&dest_playlists_dir)
        .map_err(|e| format!("Failed to create destination playlists directory: {}", e))?;

    // 0. Process Renamed files via instant destination filesystem rename
    if !report.renamed_files.is_empty() {
        push_log(format!("Found {} renamed/moved tracks to update instantly at destination.", report.renamed_files.len()), &mut logs);
        for item in &report.renamed_files {
            if let Some(ref old_dest_rel) = item.old_dest_relative_path {
                let old_full_path = dest_path.join(old_dest_rel);
                let new_full_path = dest_music_dir.join(&item.relative_path);
                if old_full_path.exists() {
                    if let Some(parent) = new_full_path.parent() {
                        if !parent.exists() {
                            let _ = fs::create_dir_all(parent);
                        }
                    }
                    match fs::rename(&old_full_path, &new_full_path) {
                        Ok(_) => {
                            push_log(format!("  🔄 Renamed: {} -> {}", old_dest_rel, item.dest_relative_path), &mut logs);
                        }
                        Err(e) => {
                            push_log(format!("  ⚠️ Rename error for {}: {}. Copying instead...", old_dest_rel, e), &mut logs);
                            let src_path = Path::new(&item.file_path);
                            if let Err(err) = fs::copy(src_path, &new_full_path) {
                                push_log(format!("  ❌ Failed to copy {}: {}", item.relative_path, err), &mut logs);
                            } else {
                                let _ = fs::remove_file(&old_full_path);
                            }
                        }
                    }
                }
            }
        }
    }

    // 1. Copy New & Updated files
    let mut files_to_copy: Vec<&ExportTrackItem> = Vec::new();
    files_to_copy.extend(report.new_files.iter());
    files_to_copy.extend(report.updated_files.iter());

    push_log(format!("Found {} new and {} updated audio files to copy.", report.new_files.len(), report.updated_files.len()), &mut logs);
    push_log(format!("Skipping {} up-to-date audio files.", report.up_to_date_files.len()), &mut logs);

    let total_files = files_to_copy.len();
    let total_bytes = report.total_bytes_to_copy + report.total_bytes_updated;
    let mut copied_bytes: u64 = 0;

    for (idx, item) in files_to_copy.into_iter().enumerate() {
        if EXPORT_CANCELLED.load(Ordering::SeqCst) {
            push_log("Export stopped by user!".to_string(), &mut logs);
            return Err("Export stopped by user.".to_string());
        }

        if excluded_set.contains(&item.relative_path) {
            push_log(format!("Skipping user-excluded file: {}", item.relative_path), &mut logs);
            continue;
        }

        let _ = app.emit(
            "export-progress",
            ExportProgressPayload {
                current_file_index: idx + 1,
                total_files,
                copied_bytes,
                total_bytes,
                current_file: item.relative_path.clone(),
            },
        );

        let src_path = Path::new(&item.file_path);
        let dest_file_path = dest_music_dir.join(&item.relative_path);

        if let Some(parent) = dest_file_path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent).ok();
            }
        }

        push_log(format!("[{}/{}] Copying: {}", idx + 1, total_files, item.relative_path), &mut logs);

        if let Err(e) = fs::copy(src_path, &dest_file_path) {
            push_log(format!("WARNING: Failed to copy file '{}': {}", item.file_path, e), &mut logs);
            continue;
        }

        copied_bytes += item.size_bytes;

        // Preserve modification time if possible
        if let Ok(metadata) = fs::metadata(src_path) {
            if let Ok(mtime) = metadata.modified() {
                if let Ok(file) = fs::OpenOptions::new().write(true).open(&dest_file_path) {
                    file.set_modified(mtime).ok();
                }
            }
        }

        let _ = app.emit(
            "task-progress",
            crate::sanitizer::TaskProgress {
                task_id: taskId.clone(),
                task_name: "Smart Sync Export".to_string(),
                index: idx,
                total: total_files,
                status: if idx + 1 == total_files { "completed".to_string() } else { "running".to_string() },
                message: item.relative_path.clone(),
                file_path: None,
            },
        );
    }

    // 2. Generate M3U files in <destination>/playlists/
    push_log(format!("Generating {} M3U8 playlist files...", report.playlists.len()), &mut logs);

    let config_file_path = Path::new(&config_path);
    let config = playlist::read_config_file(config_file_path)?;

    let resolved_source_dir = playlist::find_right_dir(
        None,
        config.source_dir.clone(),
        relative_to_config,
        config_file_path,
    );

    let formats_set: HashSet<String> = formats
        .iter()
        .map(|s| s.trim().to_lowercase())
        .collect();

    let replacement_map = if skip_dups {
        crate::dedup::build_export_superior_replacement_map(&config, &resolved_source_dir, &formats_set)
    } else {
        HashMap::new()
    };

    for pl in &config.playlists {
        let (sub_playlists, _) = playlist::expand_playlist_buckets(pl, &resolved_source_dir, &formats_set, config.min_tracks_per_year_playlist);
        for sub in sub_playlists {
            let sanitized_name = sanitize_playlist_filename(&sub.name);
            let filename = format!("{}.m3u8", sanitized_name);
            let m3u_path = dest_playlists_dir.join(&filename);

            if let Ok(mut file) = fs::File::create(&m3u_path) {
                writeln!(file, "#EXTM3U").ok();

                let mut seen_in_sub = HashSet::new();
                for file_path_buf in sub.files {
                    let c_str = canonical_path_str(&file_path_buf);
                    let effective_path = replacement_map.get(&c_str).cloned().unwrap_or(file_path_buf);
                    let eff_c_str = canonical_path_str(&effective_path);
                    if !seen_in_sub.insert(eff_c_str) {
                        continue;
                    }

                    let track_src_path = effective_path.as_path();
                    let canonical_src = fs::canonicalize(track_src_path).unwrap_or_else(|_| track_src_path.to_path_buf());
                    let track = playlist::get_track_preview(&canonical_src, &resolved_source_dir);

                    let rel_path = match canonical_src.strip_prefix(&resolved_source_dir) {
                        Ok(p) => p.to_string_lossy().to_string(),
                        Err(_) => track_src_path
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_else(|| track.title.clone()),
                    };

                    let rel_clean = rel_path.replace('\\', "/");
                    let m3u_track_ref = format!("../music/{}", rel_clean);

                    writeln!(file, "#EXTINF:{},{} - {}", track.duration, track.artist, track.title).ok();
                    writeln!(file, "{}", m3u_track_ref).ok();
                }
                push_log(format!("Created playlist: {}", filename), &mut logs);
            }
        }
    }

    // 3. Delete Orphans if requested
    if delete_orphans && !report.orphan_files.is_empty() {
        push_log(format!("Cleaning up {} orphan files from destination...", report.orphan_files.len()), &mut logs);
        for orphan in &report.orphan_files {
            let orphan_path = Path::new(&orphan.file_path);
            if orphan_path.exists() {
                if orphan_path.is_dir() {
                    if fs::remove_dir_all(orphan_path).is_ok() {
                        push_log(format!("Removed orphan folder: {}", orphan.relative_path), &mut logs);
                    }
                } else {
                    if fs::remove_file(orphan_path).is_ok() {
                        push_log(format!("Removed orphan file: {}", orphan.relative_path), &mut logs);
                    }
                }
            }
        }
    }

    push_log("Export completed successfully!".to_string(), &mut logs);
    Ok(logs)
}

#[tauri::command]
pub async fn clean_export_hidden_files(destination: String) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let dest_path = Path::new(&destination);
        if !dest_path.exists() {
            return Err(format!("Destination path does not exist: {}", destination));
        }

        let mut deleted_count = 0;
        for entry in WalkDir::new(dest_path).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                if let Some(name) = entry.file_name().to_str() {
                    if name.starts_with("._") || crate::utils::is_os_system_junk(name) {
                        if fs::remove_file(entry.path()).is_ok() {
                            deleted_count += 1;
                        }
                    }
                }
            }
        }
        Ok(deleted_count)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_renamed_content_hash_matching() {
        // Create 2 temporary files simulating source renamed file and destination orphan file
        let temp_dir = std::env::temp_dir().join("playlist_maker_test_export_renamed");
        let _ = fs::create_dir_all(&temp_dir);

        let src_file = temp_dir.join("New Artist - Song Title.mp3");
        let dest_file = temp_dir.join("01. Old Artist - Song Title.mp3");

        // Identical audio stream content
        let audio_payload = vec![0x42u8; 65536];
        fs::write(&src_file, &audio_payload).unwrap();
        fs::write(&dest_file, &audio_payload).unwrap();

        let (src_q, src_a) = crate::dedup::compute_file_hashes(&src_file, 65536);
        let (dest_q, dest_a) = crate::dedup::compute_file_hashes(&dest_file, 65536);

        assert_eq!(src_q, dest_q);
        assert_eq!(src_a, dest_a);

        // Clean up
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
