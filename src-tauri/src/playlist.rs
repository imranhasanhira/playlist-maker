use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Write, BufWriter};
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;
use lofty::probe::Probe;
use lofty::file::{TaggedFileExt, AudioFile};
use lofty::tag::Accessor;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlaylistConfig {
    pub name: String,
    pub sources: Vec<String>,
    pub exclusions: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MainConfig {
    #[serde(rename = "sourceDir")]
    pub source_dir: Option<String>,
    #[serde(rename = "targetDir")]
    pub target_dir: Option<String>,
    #[serde(rename = "relativeToConfig")]
    pub relative_to_config: Option<bool>,
    pub playlists: Vec<PlaylistConfig>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrackPreview {
    pub file_path: String,
    pub relative_path: String,
    pub title: String,
    pub artist: String,
    pub duration: u32,
    pub size_bytes: u64,
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
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    }
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

pub fn get_track_preview(path: &Path, base_playlist_dir: &Path) -> TrackPreview {
    let file_path = path.to_string_lossy().to_string();
    let relative_path = pathdiff::diff_paths(path, base_playlist_dir)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| file_path.clone());

    let size_bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    
    let mut title = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let mut artist = String::new();
    let mut duration = 0;

    if let Ok(tagged_file) = Probe::open(path).and_then(|p| p.read()) {
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
    }

    TrackPreview {
        file_path,
        relative_path,
        title,
        artist,
        duration,
        size_bytes,
    }
}

pub fn resolve_playlist_files(
    playlist_config: &PlaylistConfig,
    source_dir: &Path,
    formats: &HashSet<String>,
) -> (Vec<PathBuf>, Vec<String>) {
    let mut errors = Vec::new();
    let mut files = HashSet::new();

    // 1. Gather all sources
    for source in &playlist_config.sources {
        let source_path = if Path::new(source).is_absolute() {
            PathBuf::from(source)
        } else {
            source_dir.join(source)
        };

        if !source_path.exists() {
            errors.push(format!("Folder not found: {}", source_path.display()));
            continue;
        }

        for file in list_music_files(&source_path, formats) {
            files.insert(file);
        }
    }

    // 2. Remove exclusions
    if let Some(exclusions) = &playlist_config.exclusions {
        for exclusion in exclusions {
            let exclusion_path = if Path::new(exclusion).is_absolute() {
                PathBuf::from(exclusion)
            } else {
                source_dir.join(exclusion)
            };

            for file in list_music_files(&exclusion_path, formats) {
                files.remove(&file);
            }
        }
    }

    let mut files_vec: Vec<PathBuf> = files.into_iter().collect();
    // Sort files to keep stable ordering (unlike python's set random order)
    files_vec.sort();

    (files_vec, errors)
}

pub fn write_playlist_file(playlist_file_path: &Path, music_files: &[PathBuf]) -> Result<(), String> {
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
}
