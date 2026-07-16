// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod playlist;
mod sanitizer;
mod transcoder;
mod library;

use std::collections::HashSet;
use std::path::Path;

#[tauri::command]
async fn load_workspace(config_path: String) -> Result<playlist::MainConfig, String> {
    playlist::read_config_file(Path::new(&config_path))
}

#[tauri::command]
async fn save_workspace(config_path: String, config: playlist::MainConfig) -> Result<(), String> {
    playlist::write_config_file(Path::new(&config_path), &config)
}

#[tauri::command]
async fn preview_playlist_tracks(
    config_path: String,
    source_dir_override: Option<String>,
    playlist_index: usize,
    formats: String,
) -> Result<Vec<playlist::TrackPreview>, String> {
    let config = playlist::read_config_file(Path::new(&config_path))?;
    if playlist_index >= config.playlists.len() {
        return Err("Playlist index out of bounds".to_string());
    }

    let resolved_source_dir = playlist::find_right_dir(
        source_dir_override,
        config.source_dir.clone(),
        true,
        Path::new(&config_path),
    );

    let formats_set: HashSet<String> = formats
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .collect();

    let playlist_config = &config.playlists[playlist_index];
    let (files, _) = playlist::resolve_playlist_files(playlist_config, &resolved_source_dir, &formats_set);

    let resolved_target_dir = playlist::find_right_dir(
        None,
        config.target_dir.clone(),
        true,
        Path::new(&config_path),
    );

    let previews = files
        .iter()
        .map(|f| playlist::get_track_preview(f, &resolved_target_dir))
        .collect();

    Ok(previews)
}

#[tauri::command]
async fn generate_all_playlists(
    config_path: String,
    source_dir_override: Option<String>,
    target_dir_override: Option<String>,
    relative_to_config: bool,
    formats: String,
) -> Result<Vec<String>, String> {
    let config = playlist::read_config_file(Path::new(&config_path))?;
    
    let resolved_source_dir = playlist::find_right_dir(
        source_dir_override,
        config.source_dir.clone(),
        relative_to_config,
        Path::new(&config_path),
    );

    let resolved_target_dir = playlist::find_right_dir(
        target_dir_override,
        config.target_dir.clone(),
        relative_to_config,
        Path::new(&config_path),
    );

    if !resolved_target_dir.exists() {
        std::fs::create_dir_all(&resolved_target_dir)
            .map_err(|e| format!("Failed to create target directory: {}", e))?;
    }

    let formats_set: HashSet<String> = formats
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .collect();

    let mut logs = Vec::new();
    logs.push(format!("Writing all playlist files to {}", resolved_target_dir.display()));

    for playlist_config in &config.playlists {
        logs.push(format!("Making playlist: {}", playlist_config.name));

        let (files, errors) = playlist::resolve_playlist_files(playlist_config, &resolved_source_dir, &formats_set);
        for err in errors {
            logs.push(format!("  {}", err));
        }

        if !files.is_empty() {
            let playlist_file_path = resolved_target_dir.join(format!("{}.m3u", playlist_config.name));
            match playlist::write_playlist_file(&playlist_file_path, &files) {
                Ok(_) => logs.push(format!("  Done with {} files", files.len())),
                Err(e) => logs.push(format!("  ERROR: {}", e)),
            }
        } else {
            logs.push(format!("  SKIPPED due to no available music"));
        }
    }

    Ok(logs)
}

#[tauri::command]
async fn scan_sanitizer(folder: String, formats: Vec<String>, strip_phrases: Vec<String>) -> Result<Vec<sanitizer::SanitizeItem>, String> {
    sanitizer::scan_sanitize_files(Path::new(&folder), &formats, &strip_phrases)
}

#[tauri::command]
async fn execute_sanitizer(items: Vec<sanitizer::SanitizeItem>) -> Result<(), String> {
    sanitizer::execute_rename_files(items)
}

#[tauri::command]
async fn scan_hidden(folder: String) -> Result<Vec<sanitizer::HiddenFileItem>, String> {
    sanitizer::scan_hidden_files(Path::new(&folder))
}

#[tauri::command]
async fn delete_hidden(file_paths: Vec<String>) -> Result<(), String> {
    sanitizer::execute_delete_files(file_paths)
}

#[tauri::command]
async fn start_transcoding_queue(app: tauri::AppHandle, jobs: Vec<transcoder::TranscodeJob>) -> Result<(), String> {
    transcoder::run_transcode_queue(app, jobs);
    Ok(())
}

#[tauri::command]
async fn select_file(title: String, filter_name: String, filter_ext: String) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new().set_title(&title);
    if !filter_ext.is_empty() {
        let extensions: Vec<&str> = filter_ext.split(',').map(|s| s.trim()).collect();
        dialog = dialog.add_filter(&filter_name, &extensions);
    }
    let path = dialog.pick_file();
    Ok(path.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
async fn save_file_dialog(title: String, filter_name: String, filter_ext: String) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new().set_title(&title);
    if !filter_ext.is_empty() {
        let extensions: Vec<&str> = filter_ext.split(',').map(|s| s.trim()).collect();
        dialog = dialog.add_filter(&filter_name, &extensions);
    }
    let path = dialog.save_file();
    Ok(path.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
async fn select_directory(title: String) -> Result<Option<String>, String> {
    let path = rfd::FileDialog::new()
        .set_title(&title)
        .pick_folder();
    Ok(path.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
async fn scan_flac_files(folder: String) -> Result<Vec<String>, String> {
    let path = Path::new(&folder);
    if !path.exists() {
        return Err("Folder does not exist".to_string());
    }
    let mut flac_files = Vec::new();
    for entry in walkdir::WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let p = entry.path();
            if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                if ext.to_lowercase() == "flac" {
                    flac_files.push(p.to_string_lossy().to_string());
                }
            }
        }
    }
    flac_files.sort();
    Ok(flac_files)
}

// Library Management Commands
#[tauri::command]
async fn read_dir_tree(folder: String, formats: Vec<String>) -> Result<library::DirTreeNode, String> {
    let formats_set: HashSet<String> = formats.iter().map(|f| f.to_lowercase()).collect();
    library::read_tree_recursive(Path::new(&folder), &formats_set)
}

#[tauri::command]
async fn read_track_tags(file_path: String) -> Result<library::TrackTags, String> {
    library::read_track_tags_impl(Path::new(&file_path))
}

#[tauri::command]
async fn write_track_tags(file_path: String, tags: library::TrackTags) -> Result<(), String> {
    library::write_track_tags_impl(Path::new(&file_path), tags)
}

#[tauri::command]
async fn batch_update_folder_tags(
    folder_path: String,
    formats: Vec<String>,
    artist: Option<String>,
    album: Option<String>,
    genre: Option<String>,
    year: Option<u32>,
) -> Result<(), String> {
    let formats_set: HashSet<String> = formats.iter().map(|f| f.to_lowercase()).collect();
    library::batch_update_folder_tags_impl(
        Path::new(&folder_path),
        &formats_set,
        artist,
        album,
        genre,
        year,
    )
}

#[tauri::command]
async fn read_image_base64(file_path: String) -> Result<String, String> {
    let data = std::fs::read(Path::new(&file_path))
        .map_err(|e| format!("Failed to read file: {}", e))?;
    use base64::prelude::*;
    Ok(BASE64_STANDARD.encode(&data))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            save_workspace,
            preview_playlist_tracks,
            generate_all_playlists,
            scan_sanitizer,
            execute_sanitizer,
            scan_hidden,
            delete_hidden,
            start_transcoding_queue,
            select_file,
            select_directory,
            scan_flac_files,
            save_file_dialog,
            read_dir_tree,
            read_track_tags,
            write_track_tags,
            batch_update_folder_tags,
            read_image_base64
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
