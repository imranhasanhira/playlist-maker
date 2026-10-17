use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::collections::HashSet;
use std::io::{BufWriter, Write};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;
use lofty::probe::Probe;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::Accessor;
use tauri::Emitter;

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
pub struct YearSplitConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_tracks: Option<usize>, // Optional playlist-level override; falls back to global minTracksPerYearPlaylist
    #[serde(default)]
    pub include_unknown: bool,
    #[serde(default)]
    pub split_5y: Vec<u32>, // Decades (e.g. 1960, 1990) split into 5y half-decades
    #[serde(default)]
    pub split_1y: Vec<u32>, // 5y half-decades (e.g. 1965, 1995) split into individual years
    #[serde(default)]
    pub custom_merges: Vec<[u32; 2]>, // [start_year, end_year] spans (e.g. [[1950, 1989], [2011, 2012]])
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split_unknown_parts: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlaylistConfig {
    pub name: String,
    pub sources: Vec<String>,
    pub exclusions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year_split: Option<YearSplitConfig>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MainConfig {
    #[serde(rename = "sourceDir")]
    pub source_dir: Option<String>,
    #[serde(rename = "targetDir")]
    pub target_dir: Option<String>,
    #[serde(rename = "relativeToConfig")]
    pub relative_to_config: Option<bool>,
    #[serde(rename = "maxTracksPerPlaylist", default, skip_serializing_if = "Option::is_none")]
    pub max_tracks_per_playlist: Option<usize>,
    #[serde(rename = "minTracksPerYearPlaylist", default, skip_serializing_if = "Option::is_none")]
    pub min_tracks_per_year_playlist: Option<usize>,
    pub playlists: Vec<PlaylistConfig>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TrackPreview {
    pub file_path: String,
    pub relative_path: String,
    pub title: String,
    pub artist: String,
    pub duration: u32,
    pub size_bytes: u64,
    pub year: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CachedTrackMeta {
    pub file_path: String,
    pub mtime_secs: u64,
    pub size_bytes: u64,
    pub year: Option<u32>,
    pub title: String,
    pub artist: String,
    pub duration_secs: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct YearBucketSummary {
    pub key: String,         // e.g. "2000-2009", "2000-2004", "2011", "1950-1989", "unknown"
    pub label: String,       // Display label e.g. "2000-2009", "2000-2004", "2011", "1950-1989", "Unknown Year"
    pub bucket_type: String, // "10y" | "5y" | "1y" | "custom" | "unknown"
    pub parent_key: Option<String>, // Parent decade or half-decade for merge-back
    pub track_count: usize,
    pub is_split: bool,
    pub start_year: Option<u32>,
    pub end_year: Option<u32>,
    #[serde(default)]
    pub below_min_tracks: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlaylistSummaryItem {
    pub index: usize,
    pub name: String,
    pub total_tracks: usize,
    pub year_split_enabled: bool,
    pub buckets: Vec<YearBucketSummary>,
    pub warning_exceeds_max: bool,
}

// Find right directory resolving logic similar to Python's findRightDir
pub fn find_right_dir(
    cli_dir: Option<String>,
    yaml_dir: Option<String>,
    relative_to_config: bool,
    config_path: &Path,
) -> PathBuf {
    if let Some(d) = cli_dir {
        PathBuf::from(d)
    } else if let Some(d) = yaml_dir {
        let p = Path::new(&d);
        if p.is_absolute() || !relative_to_config {
            p.to_path_buf()
        } else {
            // Join with parent of config_path
            if let Some(parent) = config_path.parent() {
                parent.join(p)
            } else {
                p.to_path_buf()
            }
        }
    } else {
        if relative_to_config {
            config_path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."))
        } else {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        }
    }
}

// Helper to clean paths (resolving ParentDir and CurDir components) without filesystem checks
pub fn clean_path(path: &Path) -> String {
    use std::path::Component;
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                clean.pop();
            }
            Component::CurDir => {}
            Component::Normal(c) => {
                clean.push(c);
            }
            Component::RootDir => {
                clean.push("/");
            }
            Component::Prefix(p) => {
                clean.push(p.as_os_str());
            }
        }
    }
    clean.to_string_lossy().to_string()
}


// Helper to resolve a path string to be relative to parent
fn resolve_to_relative(path_str: &str, parent: &Path) -> String {
    let p = Path::new(path_str);
    if !p.is_absolute() {
        return path_str.to_string();
    }
    if let Some(rel) = pathdiff::diff_paths(p, parent) {
        let rel_str = rel.to_string_lossy().to_string();
        if rel_str.is_empty() {
            ".".to_string()
        } else if !rel_str.starts_with('.') && !rel_str.starts_with('/') {
            format!("./{}", rel_str)
        } else {
            rel_str
        }
    } else {
        path_str.to_string()
    }
}

// Converts relative paths in MainConfig to absolute resolved paths for frontend robustness
pub fn make_paths_absolute(mut config: MainConfig, config_path: &Path) -> MainConfig {
    let relative_to_config = config.relative_to_config.unwrap_or(true);
    
    // Resolve sourceDir & targetDir
    let resolved_src = find_right_dir(None, config.source_dir.clone(), relative_to_config, config_path);
    config.source_dir = Some(clean_path(&resolved_src));
    
    let resolved_tgt = find_right_dir(None, config.target_dir.clone(), relative_to_config, config_path);
    config.target_dir = Some(clean_path(&resolved_tgt));

    // Resolve playlists relative to the resolved absolute sourceDir
    if let Some(base_src_str) = &config.source_dir.clone() {
        let base_src_dir = Path::new(base_src_str);
        for playlist in &mut config.playlists {
            playlist.sources = playlist.sources.iter().map(|s| {
                let p = Path::new(s);
                if p.is_absolute() {
                    s.clone()
                } else {
                    clean_path(&base_src_dir.join(p))
                }
            }).collect();
            
            if let Some(exclusions) = &mut playlist.exclusions {
                *exclusions = exclusions.iter().map(|e| {
                    let p = Path::new(e);
                    if p.is_absolute() {
                        e.clone()
                    } else {
                        clean_path(&base_src_dir.join(p))
                    }
                }).collect();
            }
        }
    }
    
    config
}

// Converts absolute paths in MainConfig to relative paths before writing to disk
pub fn make_paths_relative(mut config: MainConfig, config_path: &Path) -> MainConfig {
    let relative_to_config = config.relative_to_config.unwrap_or(true);
    if !relative_to_config {
        return config;
    }
    
    let parent = match config_path.parent() {
        Some(p) => p,
        None => return config,
    };
    
    // Resolve playlists relative to absolute sourceDir before sourceDir itself is made relative
    if let Some(abs_src_str) = &config.source_dir {
        let abs_src_path = Path::new(abs_src_str);
        
        for playlist in &mut config.playlists {
            playlist.sources = playlist.sources.iter().map(|s| resolve_to_relative(s, abs_src_path)).collect();
            if let Some(exclusions) = &mut playlist.exclusions {
                *exclusions = exclusions.iter().map(|e| resolve_to_relative(e, abs_src_path)).collect();
            }
        }
    }
    
    // Make source_dir and target_dir relative to config parent dir
    if let Some(src) = config.source_dir {
        config.source_dir = Some(resolve_to_relative(&src, parent));
    }
    if let Some(tgt) = config.target_dir {
        config.target_dir = Some(resolve_to_relative(&tgt, parent));
    }
    
    config
}

// Read and parse config YAML
pub fn read_config_file(path: &Path) -> Result<MainConfig, String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read config file: {}", e))?;
    let config: MainConfig = serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse YAML: {}", e))?;
    Ok(config)
}

// Write config YAML
pub fn write_config_file(path: &Path, config: &MainConfig) -> Result<(), String> {
    let content = serde_yaml::to_string(config)
        .map_err(|e| format!("Failed to serialize YAML: {}", e))?;
    fs::write(path, content)
        .map_err(|e| format!("Failed to write config file: {}", e))?;
    Ok(())
}

// Collect files in folder matching formats
pub fn list_music_files(folder: &Path, formats: &HashSet<String>) -> Vec<PathBuf> {
    if !folder.exists() {
        return Vec::new();
    }

    let mut files = Vec::new();
    for entry in WalkDir::new(folder).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let path = entry.path();
            if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                if formats.contains(&ext.to_lowercase()) {
                    files.push(path.to_path_buf());
                }
            }
        }
    }
    files
}

// Extract year from metadata tags with fallback to filename regex (explicitly skipping directory paths)
pub fn extract_track_year(path: &Path, tagged_file_opt: Option<&lofty::file::TaggedFile>) -> Option<u32> {
    // 1. Primary: Audio metadata tags (ID3v2, Vorbis, MP4, etc.)
    if let Some(tagged_file) = tagged_file_opt {
        let tag_opt = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());
        if let Some(tag) = tag_opt {
            if let Some(y) = tag.year() {
                if (1900..=2099).contains(&y) {
                    return Some(y);
                }
            }
            // Check OriginalReleaseDate and RecordingDate tag frames if present
            use lofty::tag::ItemKey;
            if let Some(val) = tag.get_string(&ItemKey::OriginalReleaseDate) {
                if let Some(parsed) = parse_year_from_str(val) {
                    return Some(parsed);
                }
            }
            if let Some(val) = tag.get_string(&ItemKey::RecordingDate) {
                if let Some(parsed) = parse_year_from_str(val) {
                    return Some(parsed);
                }
            }
        }
    }

    // 2. Secondary: Filename stem regex (e.g. "Song (1968).mp3" or "1999 - Track.mp3")
    // NOTE: Explicitly skipping parent directory names as per user requirement!
    if let Some(file_name) = path.file_stem().and_then(|s| s.to_str()) {
        if let Some(parsed) = parse_year_from_str(file_name) {
            return Some(parsed);
        }
    }

    None
}

fn parse_year_from_str(text: &str) -> Option<u32> {
    lazy_static_or_local_year_regex(text)
}

static YEAR_REGEX: std::sync::LazyLock<Option<regex::Regex>> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"(?:\b|_)(19\d\d|20\d\d)(?:\b|_)").ok()
});

fn lazy_static_or_local_year_regex(text: &str) -> Option<u32> {
    if let Some(re) = YEAR_REGEX.as_ref() {
        for cap in re.captures_iter(text) {
            if let Some(m) = cap.get(1) {
                if let Ok(y) = m.as_str().parse::<u32>() {
                    if (1900..=2099).contains(&y) {
                        return Some(y);
                    }
                }
            }
        }
    }
    None
}

static TRACK_METADATA_CACHE: std::sync::LazyLock<std::sync::RwLock<std::collections::HashMap<String, CachedTrackMeta>>> =
    std::sync::LazyLock::new(|| std::sync::RwLock::new(std::collections::HashMap::new()));


pub fn probe_track_metadata(path: &Path, mtime_secs: u64, size_bytes: u64) -> CachedTrackMeta {
    let file_path = crate::utils::canonical_path_str(path);

    let mut title = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let mut artist = String::new();
    let mut duration_secs = 0;
    let year;

    if let Ok(probe) = Probe::open(path) {
        if let Ok(tagged_file) = probe.read() {
            let properties = tagged_file.properties();
            duration_secs = properties.duration().as_secs() as u32;

            if let Some(primary_tag) = tagged_file.primary_tag().or_else(|| tagged_file.first_tag()) {
                if let Some(t) = primary_tag.title() {
                    title = t.to_string();
                }
                if let Some(a) = primary_tag.artist() {
                    artist = a.to_string();
                }
            }
            year = extract_track_year(path, Some(&tagged_file));
        } else {
            year = extract_track_year(path, None);
        }
    } else {
        year = extract_track_year(path, None);
    }

    CachedTrackMeta {
        file_path,
        mtime_secs,
        size_bytes,
        year,
        title,
        artist,
        duration_secs,
    }
}

pub fn save_cached_metadata_batch(records: &[CachedTrackMeta]) {
    if records.is_empty() {
        return;
    }
    if let Ok(mut cache_guard) = TRACK_METADATA_CACHE.write() {
        for r in records {
            cache_guard.insert(r.file_path.clone(), r.clone());
        }
    }
}

pub fn get_cached_metadata_batch(
    files: &[PathBuf],
) -> (std::collections::HashMap<PathBuf, CachedTrackMeta>, Vec<(usize, PathBuf, u64, u64)>) {
    let mut hits = std::collections::HashMap::new();
    let mut misses = Vec::new();

    let cache_guard = TRACK_METADATA_CACHE.read().unwrap();

    for (idx, path) in files.iter().enumerate() {
        let path_str = crate::utils::canonical_path_str(path);
        let (mtime, size) = crate::utils::get_file_mtime_and_size(path).unwrap_or((0, 0));

        if let Some(cached) = cache_guard.get(&path_str) {
            if cached.mtime_secs == mtime && cached.size_bytes == size && mtime > 0 {
                hits.insert(path.clone(), cached.clone());
                continue;
            }
        }
        misses.push((idx, path.clone(), mtime, size));
    }

    (hits, misses)
}

pub fn get_or_probe_track_metadata_batch(files: &[PathBuf]) -> Vec<CachedTrackMeta> {
    if files.is_empty() {
        return Vec::new();
    }

    let (mut hits, misses) = get_cached_metadata_batch(files);

    if !misses.is_empty() {
        let num_workers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(16);
        let chunk_size = (misses.len() + num_workers - 1) / num_workers;
        let new_records_mutex = std::sync::Mutex::new(Vec::with_capacity(misses.len()));

        std::thread::scope(|s| {
            for chunk in misses.chunks(chunk_size.max(1)) {
                let records_ref = &new_records_mutex;
                s.spawn(move || {
                    let mut local = Vec::with_capacity(chunk.len());
                    for (_idx, path, mtime, size) in chunk {
                        let probed = probe_track_metadata(path, *mtime, *size);
                        local.push((path.clone(), probed));
                    }
                    if let Ok(mut guard) = records_ref.lock() {
                        guard.extend(local);
                    }
                });
            }
        });

        let new_records = new_records_mutex.into_inner().unwrap_or_default();
        let records_to_save: Vec<CachedTrackMeta> = new_records.iter().map(|(_, r)| r.clone()).collect();
        save_cached_metadata_batch(&records_to_save);

        for (path, meta) in new_records {
            hits.insert(path, meta);
        }
    }

    files
        .iter()
        .map(|f| {
            hits.remove(f)
                .unwrap_or_else(|| probe_track_metadata(f, 0, 0))
        })
        .collect()
}

pub fn get_tracks_previews_with_options(
    files: &[PathBuf],
    base_playlist_dir: &Path,
    probe_uncached: bool,
) -> Vec<TrackPreview> {
    if files.is_empty() {
        return Vec::new();
    }

    let metas = if probe_uncached {
        get_or_probe_track_metadata_batch(files)
    } else {
        let (mut hits, _misses) = get_cached_metadata_batch(files);
        files
            .iter()
            .map(|f| {
                if let Some(cached) = hits.remove(f) {
                    cached
                } else {
                    let file_path = crate::utils::canonical_path_str(f);
                    let (mtime_secs, size_bytes) =
                        crate::utils::get_file_mtime_and_size(f).unwrap_or((0, 0));
                    let title = f
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let year = extract_track_year(f, None);
                    CachedTrackMeta {
                        file_path,
                        mtime_secs,
                        size_bytes,
                        year,
                        title,
                        artist: String::new(),
                        duration_secs: 0,
                    }
                }
            })
            .collect()
    };

    let canonical_base =
        fs::canonicalize(base_playlist_dir).unwrap_or_else(|_| base_playlist_dir.to_path_buf());

    files
        .iter()
        .zip(metas)
        .map(|(path, meta)| {
            let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
            let relative_path = pathdiff::diff_paths(&canonical, &canonical_base)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| meta.file_path.clone());

            TrackPreview {
                file_path: meta.file_path,
                relative_path,
                title: meta.title,
                artist: meta.artist,
                duration: meta.duration_secs,
                size_bytes: meta.size_bytes,
                year: meta.year,
            }
        })
        .collect()
}

pub fn get_tracks_previews(files: &[PathBuf], base_playlist_dir: &Path) -> Vec<TrackPreview> {
    get_tracks_previews_with_options(files, base_playlist_dir, true)
}

pub fn get_track_preview(path: &Path, base_playlist_dir: &Path) -> TrackPreview {
    get_tracks_previews(&[path.to_path_buf()], base_playlist_dir)
        .into_iter()
        .next()
        .unwrap_or_else(|| {
            let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
            let file_path = canonical.to_string_lossy().to_string();
            TrackPreview {
                file_path: file_path.clone(),
                relative_path: file_path,
                title: String::new(),
                artist: String::new(),
                duration: 0,
                size_bytes: 0,
                year: None,
            }
        })
}

#[derive(Debug, Clone)]
pub struct ResolvedSubPlaylist {
    pub name: String,
    pub bucket_key: String,
    pub files: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct YearBucketInfo {
    pub key: String,
    pub label: String,
    pub bucket_type: String,
    pub parent_key: Option<String>,
    pub start_year: Option<u32>,
    pub end_year: Option<u32>,
}

// Compute bucket info for a year given the year_split config
// Returns YearBucketInfo with key, label, bucket_type, parent_key, and start/end years
pub fn determine_year_bucket_info(
    year_opt: Option<u32>,
    cfg: &YearSplitConfig,
    _single_year_counts: &std::collections::HashMap<u32, usize>,
    _global_min_tracks: Option<usize>,
) -> YearBucketInfo {
    let y = match year_opt {
        Some(val) => val,
        None => return YearBucketInfo {
            key: "unknown".to_string(),
            label: "Unknown Year".to_string(),
            bucket_type: "unknown".to_string(),
            parent_key: None,
            start_year: None,
            end_year: None,
        },
    };

    // 1. Check custom_merges first
    for span in &cfg.custom_merges {
        let start = span[0].min(span[1]);
        let end = span[0].max(span[1]);
        if y >= start && y <= end {
            let key = if start == end {
                format!("{}", start)
            } else {
                format!("{}-{}", start, end)
            };
            return YearBucketInfo {
                key: key.clone(),
                label: key,
                bucket_type: "custom".to_string(),
                parent_key: None,
                start_year: Some(start),
                end_year: Some(end),
            };
        }
    }

    let decade = (y / 10) * 10;
    let half_decade = if (y % 10) < 5 { decade } else { decade + 5 };

    let is_decade_split_5y = cfg.split_5y.contains(&decade);
    let is_half_decade_split_1y = cfg.split_1y.contains(&half_decade);

    if is_half_decade_split_1y {
        let key = format!("{}", y);
        return YearBucketInfo {
            key: key.clone(),
            label: key,
            bucket_type: "1y".to_string(),
            parent_key: Some(format!("{}-{}", half_decade, half_decade + 4)),
            start_year: Some(y),
            end_year: Some(y),
        };
    }

    if is_decade_split_5y {
        let key = format!("{}-{}", half_decade, half_decade + 4);
        return YearBucketInfo {
            key: key.clone(),
            label: key,
            bucket_type: "5y".to_string(),
            parent_key: Some(format!("{}-{}", decade, decade + 9)),
            start_year: Some(half_decade),
            end_year: Some(half_decade + 4),
        };
    }

    // Default 10y decade
    let key = format!("{}-{}", decade, decade + 9);
    YearBucketInfo {
        key: key.clone(),
        label: key,
        bucket_type: "10y".to_string(),
        parent_key: None,
        start_year: Some(decade),
        end_year: Some(decade + 9),
    }
}

pub fn determine_year_bucket_key(
    year_opt: Option<u32>,
    cfg: &YearSplitConfig,
    single_year_counts: &std::collections::HashMap<u32, usize>,
    global_min_tracks: Option<usize>,
) -> (String, String) {
    let info = determine_year_bucket_info(year_opt, cfg, single_year_counts, global_min_tracks);
    (info.key, info.bucket_type)
}

// Expand a playlist into its sub-playlists (or 1 playlist if year_split is disabled)
pub fn expand_playlist_buckets(
    playlist_config: &PlaylistConfig,
    source_dir: &Path,
    formats: &HashSet<String>,
    global_min_tracks: Option<usize>,
) -> (Vec<ResolvedSubPlaylist>, Vec<String>) {
    let (files, errors) = resolve_playlist_files(playlist_config, source_dir, formats);

    let year_cfg = match &playlist_config.year_split {
        Some(cfg) if cfg.enabled => cfg.clone(),
        _ => {
            return (
                vec![ResolvedSubPlaylist {
                    name: playlist_config.name.clone(),
                    bucket_key: "all".to_string(),
                    files,
                }],
                errors,
            );
        }
    };

    // 1. Gather all file years from cache (and probe misses in parallel if any)
    let file_metas = get_or_probe_track_metadata_batch(&files);
    let mut file_years: Vec<(PathBuf, Option<u32>)> = Vec::with_capacity(files.len());
    let mut single_year_counts: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();

    for (f, meta) in files.iter().zip(file_metas) {
        let yr = meta.year;
        if let Some(y) = yr {
            *single_year_counts.entry(y).or_insert(0) += 1;
        }
        file_years.push((f.clone(), yr));
    }

    // 2. Group into buckets
    let mut bucket_files: std::collections::BTreeMap<String, Vec<PathBuf>> = std::collections::BTreeMap::new();
    let mut unknown_files: Vec<PathBuf> = Vec::new();

    for (path, yr) in file_years {
        if yr.is_none() {
            if year_cfg.include_unknown {
                unknown_files.push(path);
            }
            continue;
        }

        let (key, _) = determine_year_bucket_key(yr, &year_cfg, &single_year_counts, global_min_tracks);
        bucket_files.entry(key).or_default().push(path);
    }

    if !unknown_files.is_empty() {
        let split_parts = year_cfg.split_unknown_parts.unwrap_or(0);
        if split_parts >= 2 {
            let total_u = unknown_files.len();
            let base = total_u / split_parts;
            let rem = total_u % split_parts;
            let mut offset = 0;
            for i in 0..split_parts {
                let count = base + if i < rem { 1 } else { 0 };
                let chunk = unknown_files[offset..offset + count].to_vec();
                offset += count;
                let key = format!("unknown_{:02}", i + 1);
                bucket_files.insert(key, chunk);
            }
        } else {
            bucket_files.insert("unknown".to_string(), unknown_files);
        }
    }

    let mut result = Vec::new();
    for (key, b_files) in bucket_files {
        if b_files.is_empty() {
            continue;
        }
        let sub_name = if key == "unknown" {
            format!("{} - Unknown", playlist_config.name)
        } else if let Some(suffix) = key.strip_prefix("unknown_") {
            format!("{} - Unknown {}", playlist_config.name, suffix)
        } else {
            format!("{} - {}", playlist_config.name, key)
        };
        result.push(ResolvedSubPlaylist {
            name: sub_name,
            bucket_key: key,
            files: b_files,
        });
    }

    (result, errors)
}

// Compute bucket summaries for a set of file years
pub fn compute_buckets_summary(
    file_years: &[Option<u32>],
    year_cfg: &YearSplitConfig,
    single_year_counts: &std::collections::HashMap<u32, usize>,
    global_min_tracks: Option<usize>,
    max_tracks: usize,
) -> (Vec<YearBucketSummary>, bool) {
    let mut bucket_counts: std::collections::BTreeMap<String, (YearBucketInfo, usize)> = std::collections::BTreeMap::new();
    let mut unknown_count = 0;

    for &yr in file_years {
        if yr.is_none() {
            unknown_count += 1;
            continue;
        }

        let info = determine_year_bucket_info(yr, year_cfg, single_year_counts, global_min_tracks);
        let entry = bucket_counts.entry(info.key.clone()).or_insert((info, 0));
        entry.1 += 1;
    }

    let mut buckets = Vec::new();
    let mut warning_exceeds_max = false;

    let effective_min_tracks = year_cfg.min_tracks.or(global_min_tracks).unwrap_or(10);

    for (key, (info, count)) in bucket_counts {
        if count > max_tracks {
            warning_exceeds_max = true;
        }

        let is_split = match info.bucket_type.as_str() {
            "10y" => {
                if let Some(s) = info.start_year {
                    year_cfg.split_5y.contains(&s)
                } else {
                    false
                }
            }
            "5y" => {
                if let Some(s) = info.start_year {
                    year_cfg.split_1y.contains(&s)
                } else {
                    false
                }
            }
            _ => false,
        };

        let below_min_tracks = info.bucket_type != "unknown" && count < effective_min_tracks;

        buckets.push(YearBucketSummary {
            key,
            label: info.label,
            bucket_type: info.bucket_type,
            parent_key: info.parent_key,
            track_count: count,
            is_split,
            start_year: info.start_year,
            end_year: info.end_year,
            below_min_tracks,
        });
    }

    // Sort buckets chronologically: known years first by (start_year, end_year), unknown at the end
    buckets.sort_by_key(|b| {
        (
            b.start_year.unwrap_or(u32::MAX),
            b.end_year.unwrap_or(u32::MAX),
        )
    });

    if unknown_count > 0 {
        let split_parts = year_cfg.split_unknown_parts.unwrap_or(0);
        if split_parts >= 2 {
            let base = unknown_count / split_parts;
            let rem = unknown_count % split_parts;
            for i in 0..split_parts {
                let count = base + if i < rem { 1 } else { 0 };
                let key = format!("unknown_{:02}", i + 1);
                let label = format!("Unknown {:02}", i + 1);
                if count > max_tracks && year_cfg.include_unknown {
                    warning_exceeds_max = true;
                }
                buckets.push(YearBucketSummary {
                    key: key.clone(),
                    label,
                    bucket_type: "unknown_split".to_string(),
                    parent_key: Some("unknown".to_string()),
                    track_count: count,
                    is_split: true,
                    start_year: None,
                    end_year: None,
                    below_min_tracks: false,
                });
            }
        } else {
            if unknown_count > max_tracks && year_cfg.include_unknown {
                warning_exceeds_max = true;
            }
            buckets.push(YearBucketSummary {
                key: "unknown".to_string(),
                label: "Unknown Year".to_string(),
                bucket_type: "unknown".to_string(),
                parent_key: None,
                track_count: unknown_count,
                is_split: false,
                start_year: None,
                end_year: None,
                below_min_tracks: false,
            });
        }
    }

    (buckets, warning_exceeds_max)
}

// Generate summary of all playlists and their year buckets for the sidebar refresh
pub fn calculate_playlist_summaries(
    app: Option<&tauri::AppHandle>,
    task_id: Option<&str>,
    config: &MainConfig,
    source_dir: &Path,
    formats: &HashSet<String>,
) -> Vec<PlaylistSummaryItem> {
    if let Some(tid) = task_id {
        crate::sanitizer::clear_task_cancel(tid);
    }
    let mut summaries = Vec::new();
    let total_playlists = config.playlists.len();

    for (index, pl) in config.playlists.iter().enumerate() {
        if let Some(tid) = task_id {
            if crate::sanitizer::is_task_cancelled(tid) {
                return summaries;
            }
        }
        if let (Some(app), Some(tid)) = (app, task_id) {
            let _ = app.emit(
                "task-progress",
                crate::sanitizer::TaskProgress {
                    task_id: tid.to_string(),
                    task_name: "Scanning Playlist Summaries".to_string(),
                    index,
                    total: total_playlists,
                    status: "running".to_string(),
                    message: pl.name.clone(),
                    file_path: None,
                },
            );
        }

        if let Ok(item) = calculate_single_playlist_summary(None, None, config, source_dir, formats, index, false) {
            summaries.push(item);
        }
    }

    if let (Some(app), Some(tid)) = (app, task_id) {
        if !crate::sanitizer::is_task_cancelled(tid) {
            let _ = app.emit(
                "task-progress",
                crate::sanitizer::TaskProgress {
                    task_id: tid.to_string(),
                    task_name: "Scanning Playlist Summaries".to_string(),
                    index: total_playlists.saturating_sub(1),
                    total: total_playlists,
                    status: "completed".to_string(),
                    message: "All playlists analyzed".to_string(),
                    file_path: None,
                },
            );
        }
    }

    summaries
}

// Calculate summary for a single playlist with in-memory caching, multi-threaded probing, and smooth progress
pub fn calculate_single_playlist_summary(
    app: Option<&tauri::AppHandle>,
    task_id: Option<&str>,
    config: &MainConfig,
    source_dir: &Path,
    formats: &HashSet<String>,
    playlist_index: usize,
    probe_uncached: bool,
) -> Result<PlaylistSummaryItem, String> {
    if playlist_index >= config.playlists.len() {
        return Err("Playlist index out of bounds".to_string());
    }
    if let Some(tid) = task_id {
        crate::sanitizer::clear_task_cancel(tid);
    }

    let max_tracks = config.max_tracks_per_playlist.unwrap_or(400);
    let pl = &config.playlists[playlist_index];
    let year_split_enabled = pl.year_split.as_ref().map(|y| y.enabled).unwrap_or(false);
    let effective_task_id = task_id;
    let task_name = format!("Analyzing Year Distribution: {}", pl.name);

    if year_split_enabled && probe_uncached {
        if let (Some(app), Some(tid)) = (app, effective_task_id) {
            let _ = app.emit(
                "task-progress",
                crate::sanitizer::TaskProgress {
                    task_id: tid.to_string(),
                    task_name: task_name.clone(),
                    index: 0,
                    total: 100,
                    status: "running".to_string(),
                    message: "Resolving playlist files...".to_string(),
                    file_path: None,
                },
            );
        }
    }

    let (files, _) = resolve_playlist_files(pl, source_dir, formats);
    let total_tracks = files.len();

    let mut buckets = Vec::new();
    let mut warning_exceeds_max = total_tracks > max_tracks;

    if year_split_enabled {
        let year_cfg = pl.year_split.as_ref().unwrap();
        let total = files.len();

        if total == 0 {
            if let (Some(app), Some(tid)) = (app, effective_task_id) {
                let _ = app.emit(
                    "task-progress",
                    crate::sanitizer::TaskProgress {
                        task_id: tid.to_string(),
                        task_name: task_name.clone(),
                        index: 1,
                        total: 1,
                        status: "completed".to_string(),
                        message: "No candidate tracks found".to_string(),
                        file_path: None,
                    },
                );
            }
            return Ok(PlaylistSummaryItem {
                index: playlist_index,
                name: pl.name.clone(),
                total_tracks: 0,
                year_split_enabled,
                buckets: Vec::new(),
                warning_exceeds_max: false,
            });
        }

        // 1. Check cache first
        let (cached_hits, misses) = get_cached_metadata_batch(&files);
        let cached_count = cached_hits.len();
        let misses_count = misses.len();

        let mut file_years: Vec<Option<u32>> = vec![None; total];
        for (i, f) in files.iter().enumerate() {
            if let Some(m) = cached_hits.get(f) {
                file_years[i] = m.year;
            }
        }

        if !probe_uncached {
            // When probe_uncached is false (e.g. background/app startup summary):
            // Only use cached data; do not trigger disk tag scanning
            if cached_count > 0 {
                let mut single_year_counts: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
                for yr in &file_years {
                    if let Some(y) = yr {
                        *single_year_counts.entry(*y).or_insert(0) += 1;
                    }
                }

                let (computed_buckets, exceeds) = compute_buckets_summary(
                    &file_years,
                    year_cfg,
                    &single_year_counts,
                    config.min_tracks_per_year_playlist,
                    max_tracks,
                );
                buckets = computed_buckets;
                if exceeds {
                    warning_exceeds_max = true;
                }
            }

            return Ok(PlaylistSummaryItem {
                index: playlist_index,
                name: pl.name.clone(),
                total_tracks,
                year_split_enabled,
                buckets,
                warning_exceeds_max,
            });
        }

        // When probe_uncached is true:
        if misses_count > 0 {
            if let (Some(app), Some(tid)) = (app, effective_task_id) {
                let _ = app.emit(
                    "task-progress",
                    crate::sanitizer::TaskProgress {
                        task_id: tid.to_string(),
                        task_name: task_name.clone(),
                        index: cached_count,
                        total,
                        status: "running".to_string(),
                        message: format!("Analyzing {} tracks...", misses_count),
                        file_path: None,
                    },
                );
            }

            let num_workers = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4)
                .min(16);
            let chunk_size = (misses_count + num_workers - 1) / num_workers;
            let processed_counter = std::sync::atomic::AtomicUsize::new(cached_count);
            let start_instant = std::time::Instant::now();
            let last_emit_ms = std::sync::atomic::AtomicU64::new(0);

            let processed_ref = &processed_counter;
            let last_emit_ms_ref = &last_emit_ms;
            let task_name_ref = &task_name;

            let probe_results_mutex = std::sync::Mutex::new(Vec::with_capacity(misses_count));
            let probe_results_ref = &probe_results_mutex;

            std::thread::scope(|s| {
                for chunk in misses.chunks(chunk_size.max(1)) {
                    s.spawn(move || {
                        let mut local_results = Vec::with_capacity(chunk.len());
                        for (orig_idx, path, mtime, size) in chunk {
                            if let Some(tid) = effective_task_id {
                                if crate::sanitizer::is_task_cancelled(tid) {
                                    break;
                                }
                            }

                            let probed = probe_track_metadata(path, *mtime, *size);
                            local_results.push((*orig_idx, probed.year, probed));

                            let cur = processed_ref.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                            if let (Some(app), Some(tid)) = (app, effective_task_id) {
                                let elapsed_ms = start_instant.elapsed().as_millis() as u64;
                                let prev_ms = last_emit_ms_ref.load(std::sync::atomic::Ordering::Relaxed);
                                let mut should_emit = cur == cached_count + 1 || cur == total;
                                if !should_emit && elapsed_ms >= prev_ms + 80 {
                                    if last_emit_ms_ref
                                        .compare_exchange_weak(
                                            prev_ms,
                                            elapsed_ms,
                                            std::sync::atomic::Ordering::Relaxed,
                                            std::sync::atomic::Ordering::Relaxed,
                                        )
                                        .is_ok()
                                    {
                                        should_emit = true;
                                    }
                                }
                                if should_emit {
                                    let _ = app.emit(
                                        "task-progress",
                                        crate::sanitizer::TaskProgress {
                                            task_id: tid.to_string(),
                                            task_name: task_name_ref.clone(),
                                            index: cur.saturating_sub(1),
                                            total,
                                            status: "running".to_string(),
                                            message: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                                            file_path: None,
                                        },
                                    );
                                }
                            }
                        }

                        if let Ok(mut guard) = probe_results_ref.lock() {
                            guard.extend(local_results);
                        }
                    });
                }
            });

            let mut newly_probed = Vec::with_capacity(misses_count);
            if let Ok(probed_list) = probe_results_mutex.into_inner() {
                for (orig_idx, yr, meta) in probed_list {
                    file_years[orig_idx] = yr;
                    newly_probed.push(meta);
                }
            }

            // Save newly probed metadata to in-memory cache (even partial results if cancelled)
            save_cached_metadata_batch(&newly_probed);

            if let Some(tid) = effective_task_id {
                if crate::sanitizer::is_task_cancelled(tid) {
                    return Err("Task cancelled".to_string());
                }
            }
        }

        let mut single_year_counts: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
        for yr in &file_years {
            if let Some(y) = yr {
                *single_year_counts.entry(*y).or_insert(0) += 1;
            }
        }

        let (computed_buckets, exceeds) = compute_buckets_summary(
            &file_years,
            year_cfg,
            &single_year_counts,
            config.min_tracks_per_year_playlist,
            max_tracks,
        );
        buckets = computed_buckets;
        if exceeds {
            warning_exceeds_max = true;
        }

        if let (Some(app), Some(tid)) = (app, effective_task_id) {
            let _ = app.emit(
                "task-progress",
                crate::sanitizer::TaskProgress {
                    task_id: tid.to_string(),
                    task_name: task_name.clone(),
                    index: total.saturating_sub(1),
                    total,
                    status: "completed".to_string(),
                    message: "Year distribution analysis complete".to_string(),
                    file_path: None,
                },
            );
        }
    }

    Ok(PlaylistSummaryItem {
        index: playlist_index,
        name: pl.name.clone(),
        total_tracks,
        year_split_enabled,
        buckets,
        warning_exceeds_max,
    })
}

pub fn resolve_playlist_files(
    playlist_config: &PlaylistConfig,
    source_dir: &Path,
    formats: &HashSet<String>,
) -> (Vec<PathBuf>, Vec<String>) {
    let (candidates, errors) =
        crate::dedup::gather_playlist_candidates(playlist_config, 0, source_dir, formats);
    let mut files: Vec<PathBuf> = candidates.into_iter().map(|c| c.path).collect();
    files.sort();
    (files, errors)
}

pub fn write_playlist_file(
    playlist_file_path: &Path,
    music_files: &[PathBuf],
) -> Result<(), String> {
    let file = File::create(playlist_file_path)
        .map_err(|e| format!("Failed to create playlist file: {}", e))?;
    let mut writer = BufWriter::new(file);

    writeln!(writer, "#EXTM3U").map_err(|e| e.to_string())?;

    let cache_opt = TRACK_METADATA_CACHE.read().ok();

    for file_path in music_files {
        let mut duration = 0;
        let c_str = crate::utils::canonical_path_str(file_path);
        if let Some(ref guard) = cache_opt {
            if let Some(cached) = guard.get(&c_str) {
                duration = cached.duration_secs;
            }
        }
        if duration == 0 {
            if let Ok(tagged_file) = Probe::open(file_path).and_then(|p| p.read()) {
                duration = tagged_file.properties().duration().as_secs() as u32;
            }
        }

        let rel_path = pathdiff::diff_paths(file_path, playlist_file_path.parent().unwrap())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| file_path.to_string_lossy().to_string());

        writeln!(writer, "#EXTINF:{}\n{}", duration, rel_path).map_err(|e| e.to_string())?;
    }

    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_parse() {
        let content = std::fs::read_to_string("../sample_config.yaml").unwrap();
        let config: MainConfig = serde_yaml::from_str(&content).unwrap();
        println!("Loaded config successfully: {:?}", config);
    }

    #[test]
    fn test_year_bucket_patterns_and_custom_merges() {
        let mut cfg = YearSplitConfig {
            enabled: true,
            min_tracks: Some(10),
            include_unknown: false,
            split_5y: vec![2000],
            split_1y: vec![2010],
            custom_merges: vec![[1950, 1989], [2011, 2012]],
            split_unknown_parts: None,
        };

        let mut single_year_counts = std::collections::HashMap::new();
        single_year_counts.insert(2010, 15);
        single_year_counts.insert(2011, 12);
        single_year_counts.insert(2012, 10);
        single_year_counts.insert(1965, 8);

        // 1. Custom merge span [1950, 1989] covers 1965 -> "1950-1989"
        let b1 = determine_year_bucket_info(Some(1965), &cfg, &single_year_counts, None);
        assert_eq!(b1.key, "1950-1989");
        assert_eq!(b1.label, "1950-1989");
        assert_eq!(b1.bucket_type, "custom");
        assert_eq!(b1.start_year, Some(1950));
        assert_eq!(b1.end_year, Some(1989));

        // 2. Custom merge span [2011, 2012] covers 2011 -> "2011-2012"
        let b2 = determine_year_bucket_info(Some(2011), &cfg, &single_year_counts, None);
        assert_eq!(b2.key, "2011-2012");
        assert_eq!(b2.label, "2011-2012");
        assert_eq!(b2.bucket_type, "custom");

        // 3. Default 10y decade pattern (e.g. 1995 without split) -> "1990-1999"
        let b3 = determine_year_bucket_info(Some(1995), &cfg, &single_year_counts, None);
        assert_eq!(b3.key, "1990-1999");
        assert_eq!(b3.label, "1990-1999");
        assert_eq!(b3.bucket_type, "10y");

        // 4. 5y split pattern (2000 decade is split) -> 2002 is "2000-2004", 2007 is "2005-2009"
        let b4 = determine_year_bucket_info(Some(2002), &cfg, &single_year_counts, None);
        assert_eq!(b4.key, "2000-2004");
        assert_eq!(b4.label, "2000-2004");
        assert_eq!(b4.bucket_type, "5y");

        let b5 = determine_year_bucket_info(Some(2007), &cfg, &single_year_counts, None);
        assert_eq!(b5.key, "2005-2009");
        assert_eq!(b5.label, "2005-2009");
        assert_eq!(b5.bucket_type, "5y");

        // 5. 1y split pattern (2010 half-decade is split, 2010 has 15 tracks) -> "2010"
        cfg.custom_merges.clear();
        let b6 = determine_year_bucket_info(Some(2010), &cfg, &single_year_counts, None);
        assert_eq!(b6.key, "2010");
        assert_eq!(b6.label, "2010");
        assert_eq!(b6.bucket_type, "1y");

        // 6. Unconditional 1y split even when tracks < min_tracks (e.g. 2013 has only 2 tracks)
        let b7 = determine_year_bucket_info(Some(2013), &cfg, &single_year_counts, None);
        assert_eq!(b7.key, "2013");
        assert_eq!(b7.label, "2013");
        assert_eq!(b7.bucket_type, "1y");
        assert_eq!(b7.start_year, Some(2013));
        assert_eq!(b7.end_year, Some(2013));

        // 7. Verify below_min_tracks marker in compute_buckets_summary
        let (buckets, _) = compute_buckets_summary(&[Some(2010), Some(2013), Some(2013)], &cfg, &single_year_counts, None, 400);
        let b2010 = buckets.iter().find(|b| b.key == "2010").unwrap();
        assert_eq!(b2010.below_min_tracks, true); // 1 track in this run < 10 min_tracks
    }

    #[test]
    fn test_split_unknown_parts() {
        let single_year_counts = std::collections::HashMap::new();

        // Single unknown
        let mut cfg = YearSplitConfig {
            enabled: true,
            min_tracks: Some(10),
            include_unknown: true,
            split_5y: vec![],
            split_1y: vec![],
            custom_merges: vec![],
            split_unknown_parts: None,
        };

        let file_years: Vec<Option<u32>> = vec![None; 10];
        let (buckets1, _) = compute_buckets_summary(&file_years, &cfg, &single_year_counts, None, 400);
        assert_eq!(buckets1.len(), 1);
        assert_eq!(buckets1[0].key, "unknown");
        assert_eq!(buckets1[0].label, "Unknown Year");
        assert_eq!(buckets1[0].track_count, 10);

        // Split unknown into 3 parts (10 tracks -> 4, 3, 3)
        cfg.split_unknown_parts = Some(3);
        let (buckets2, _) = compute_buckets_summary(&file_years, &cfg, &single_year_counts, None, 400);
        assert_eq!(buckets2.len(), 3);
        assert_eq!(buckets2[0].key, "unknown_01");
        assert_eq!(buckets2[0].label, "Unknown 01");
        assert_eq!(buckets2[0].track_count, 4);

        assert_eq!(buckets2[1].key, "unknown_02");
        assert_eq!(buckets2[1].label, "Unknown 02");
        assert_eq!(buckets2[1].track_count, 3);

        assert_eq!(buckets2[2].key, "unknown_03");
        assert_eq!(buckets2[2].label, "Unknown 03");
        assert_eq!(buckets2[2].track_count, 3);
    }
}
