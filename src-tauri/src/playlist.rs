use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::collections::HashSet;
use std::io::{BufWriter, Write};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;
use lofty::probe::Probe;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::Accessor;

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
        if let Some(primary_tag) = tagged_file.primary_tag() {
            if let Some(y) = primary_tag.year() {
                if (1900..=2099).contains(&y) {
                    return Some(y);
                }
            }
            // Check OriginalReleaseDate tag frame if present
            use lofty::tag::ItemKey;
            if let Some(val) = primary_tag.get_string(&ItemKey::OriginalReleaseDate) {
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

fn lazy_static_or_local_year_regex(text: &str) -> Option<u32> {
    let re = regex::Regex::new(r"(?:\b|_)(19\d\d|20\d\d)(?:\b|_)").ok()?;
    for cap in re.captures_iter(text) {
        if let Some(m) = cap.get(1) {
            if let Ok(y) = m.as_str().parse::<u32>() {
                if (1900..=2099).contains(&y) {
                    return Some(y);
                }
            }
        }
    }
    None
}

pub fn get_track_preview(path: &Path, base_playlist_dir: &Path) -> TrackPreview {
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let file_path = canonical.to_string_lossy().to_string();
    
    let canonical_base = fs::canonicalize(base_playlist_dir).unwrap_or_else(|_| base_playlist_dir.to_path_buf());
    let relative_path = pathdiff::diff_paths(&canonical, &canonical_base)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| file_path.clone());

    let size_bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    
    let mut title = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let mut artist = String::new();
    let mut duration = 0;

    let year = if let Ok(tagged_file) = Probe::open(path).and_then(|p| p.read()) {
        let properties = tagged_file.properties();
        duration = properties.duration().as_secs() as u32;

        if let Some(primary_tag) = tagged_file.primary_tag() {
            if let Some(t) = primary_tag.title() {
                title = t.to_string();
            }
            if let Some(a) = primary_tag.artist() {
                artist = a.to_string();
            }
        }

        extract_track_year(path, Some(&tagged_file))
    } else {
        extract_track_year(path, None)
    };

    TrackPreview {
        file_path,
        relative_path,
        title,
        artist,
        duration,
        size_bytes,
        year,
    }
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

    // 1. Gather all file years
    let mut file_years: Vec<(PathBuf, Option<u32>)> = Vec::with_capacity(files.len());
    let mut single_year_counts: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();

    for f in &files {
        let yr = if let Ok(tagged_file) = Probe::open(f).and_then(|p| p.read()) {
            extract_track_year(f, Some(&tagged_file))
        } else {
            extract_track_year(f, None)
        };

        if let Some(y) = yr {
            *single_year_counts.entry(y).or_insert(0) += 1;
        }
        file_years.push((f.clone(), yr));
    }

    // 2. Group into buckets
    let mut bucket_files: std::collections::BTreeMap<String, Vec<PathBuf>> = std::collections::BTreeMap::new();

    for (path, yr) in file_years {
        if yr.is_none() && !year_cfg.include_unknown {
            // Default ignored!
            continue;
        }

        let (key, _) = determine_year_bucket_key(yr, &year_cfg, &single_year_counts, global_min_tracks);
        bucket_files.entry(key).or_default().push(path);
    }

    let mut result = Vec::new();
    for (key, b_files) in bucket_files {
        if b_files.is_empty() {
            continue;
        }
        let sub_name = if key == "unknown" {
            format!("{} - Unknown", playlist_config.name)
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
            if year_cfg.include_unknown {
                let info = determine_year_bucket_info(None, year_cfg, single_year_counts, global_min_tracks);
                let entry = bucket_counts.entry("unknown".to_string()).or_insert((info, 0));
                entry.1 += 1;
            }
            continue;
        }

        let info = determine_year_bucket_info(yr, year_cfg, single_year_counts, global_min_tracks);
        let entry = bucket_counts.entry(info.key.clone()).or_insert((info, 0));
        entry.1 += 1;
    }

    let mut buckets = Vec::new();
    let mut warning_exceeds_max = false;

    let effective_min_tracks = year_cfg.min_tracks.or(global_min_tracks).unwrap_or(10);

    if unknown_count > 0 && !year_cfg.include_unknown {
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

    (buckets, warning_exceeds_max)
}

// Generate summary of all playlists and their year buckets for the sidebar refresh
pub fn calculate_playlist_summaries(
    config: &MainConfig,
    source_dir: &Path,
    formats: &HashSet<String>,
) -> Vec<PlaylistSummaryItem> {
    let max_tracks = config.max_tracks_per_playlist.unwrap_or(400);
    let mut summaries = Vec::new();

    for (index, pl) in config.playlists.iter().enumerate() {
        let (files, _) = resolve_playlist_files(pl, source_dir, formats);
        let total_tracks = files.len();
        let year_split_enabled = pl.year_split.as_ref().map(|y| y.enabled).unwrap_or(false);

        let mut buckets = Vec::new();
        let mut warning_exceeds_max = total_tracks > max_tracks;

        if year_split_enabled {
            let year_cfg = pl.year_split.as_ref().unwrap();
            let mut file_years: Vec<Option<u32>> = Vec::with_capacity(files.len());
            let mut single_year_counts: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();

            for f in &files {
                let yr = if let Ok(tagged_file) = Probe::open(f).and_then(|p| p.read()) {
                    extract_track_year(f, Some(&tagged_file))
                } else {
                    extract_track_year(f, None)
                };
                if let Some(y) = yr {
                    *single_year_counts.entry(y).or_insert(0) += 1;
                }
                file_years.push(yr);
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

        summaries.push(PlaylistSummaryItem {
            index,
            name: pl.name.clone(),
            total_tracks,
            year_split_enabled,
            buckets,
            warning_exceeds_max,
        });
    }

    summaries
}

// Calculate summary for a single playlist
pub fn calculate_single_playlist_summary(
    config: &MainConfig,
    source_dir: &Path,
    formats: &HashSet<String>,
    playlist_index: usize,
) -> Result<PlaylistSummaryItem, String> {
    if playlist_index >= config.playlists.len() {
        return Err("Playlist index out of bounds".to_string());
    }
    let max_tracks = config.max_tracks_per_playlist.unwrap_or(400);
    let pl = &config.playlists[playlist_index];
    let (files, _) = resolve_playlist_files(pl, source_dir, formats);
    let total_tracks = files.len();
    let year_split_enabled = pl.year_split.as_ref().map(|y| y.enabled).unwrap_or(false);

    let mut buckets = Vec::new();
    let mut warning_exceeds_max = total_tracks > max_tracks;

    if year_split_enabled {
        let year_cfg = pl.year_split.as_ref().unwrap();
        let mut file_years: Vec<Option<u32>> = Vec::with_capacity(files.len());
        let mut single_year_counts: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();

        for f in &files {
            let yr = if let Ok(tagged_file) = Probe::open(f).and_then(|p| p.read()) {
                extract_track_year(f, Some(&tagged_file))
            } else {
                extract_track_year(f, None)
            };
            if let Some(y) = yr {
                *single_year_counts.entry(y).or_insert(0) += 1;
            }
            file_years.push(yr);
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
    let (winning_files, _, _) =
        crate::dedup::analyze_candidates(&candidates, source_dir, false, 60, false, None);
    (winning_files, errors)
}

pub fn write_playlist_file(
    playlist_file_path: &Path,
    music_files: &[PathBuf],
) -> Result<(), String> {
    let file = File::create(playlist_file_path)
        .map_err(|e| format!("Failed to create playlist file: {}", e))?;
    let mut writer = BufWriter::new(file);

    writeln!(writer, "#EXTM3U").map_err(|e| e.to_string())?;

    for file_path in music_files {
        let mut duration = 0;
        if let Ok(tagged_file) = Probe::open(file_path).and_then(|p| p.read()) {
            duration = tagged_file.properties().duration().as_secs() as u32;
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
}
