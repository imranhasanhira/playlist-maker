#![allow(non_snake_case)]

mod playlist;
mod sanitizer;
mod transcoder;
mod library;
mod export;

use std::collections::HashSet;
use std::path::Path;
use tauri::Emitter;

#[tauri::command]
async fn load_workspace(configPath: String) -> Result<playlist::MainConfig, String> {
    let path = Path::new(&configPath);
    let config = playlist::read_config_file(path)?;
    Ok(playlist::make_paths_absolute(config, path))
}

#[tauri::command]
async fn save_workspace(configPath: String, config: playlist::MainConfig) -> Result<(), String> {
    let path = Path::new(&configPath);
    let relative_config = playlist::make_paths_relative(config, path);
    playlist::write_config_file(path, &relative_config)
}

#[tauri::command]
async fn preview_playlist_tracks(
    configPath: String,
    sourceDirOverride: Option<String>,
    playlistIndex: usize,
    formats: String,
) -> Result<Vec<playlist::TrackPreview>, String> {
    tokio::task::spawn_blocking(move || {
        let config = playlist::read_config_file(Path::new(&configPath))?;
        if playlistIndex >= config.playlists.len() {
            return Err("Playlist index out of bounds".to_string());
        }

        let resolved_source_dir = playlist::find_right_dir(
            sourceDirOverride,
            config.source_dir.clone(),
            true,
            Path::new(&configPath),
        );

        let formats_set: HashSet<String> = formats
            .split(',')
            .map(|s| s.trim().to_lowercase())
            .collect();

        let playlist_config = &config.playlists[playlistIndex];
        let (files, _) = playlist::resolve_playlist_files(playlist_config, &resolved_source_dir, &formats_set);


        let previews = files
            .iter()
            .map(|f| playlist::get_track_preview(f, &resolved_source_dir))
            .collect();

        Ok(previews)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
async fn generate_all_playlists(
    configPath: String,
    sourceDirOverride: Option<String>,
    targetDirOverride: Option<String>,
    relativeToConfig: bool,
    formats: String,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let config = playlist::read_config_file(Path::new(&configPath))?;
        
        let resolved_source_dir = playlist::find_right_dir(
            sourceDirOverride,
            config.source_dir.clone(),
            relativeToConfig,
            Path::new(&configPath),
        );

        let resolved_target_dir = playlist::find_right_dir(
            targetDirOverride,
            config.target_dir.clone(),
            relativeToConfig,
            Path::new(&configPath),
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
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
async fn scan_sanitizer(app: tauri::AppHandle, taskId: String, folder: String, formats: Vec<String>, stripPhrases: Vec<String>) -> Result<Vec<sanitizer::SanitizeItem>, String> {
    tokio::task::spawn_blocking(move || {
        sanitizer::scan_sanitize_files(&app, &taskId, Path::new(&folder), &formats, &stripPhrases)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
async fn execute_sanitizer(app: tauri::AppHandle, taskId: String, items: Vec<sanitizer::SanitizeItem>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        sanitizer::execute_rename_files(&app, &taskId, items)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
async fn scan_metadata_sanitizer(app: tauri::AppHandle, taskId: String, folder: String, formats: Vec<String>, stripPhrases: Vec<String>) -> Result<Vec<sanitizer::MetadataSanitizeItem>, String> {
    tokio::task::spawn_blocking(move || {
        sanitizer::scan_sanitize_metadata(&app, &taskId, Path::new(&folder), &formats, &stripPhrases)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
async fn execute_metadata_sanitizer(app: tauri::AppHandle, taskId: String, items: Vec<sanitizer::MetadataSanitizeItem>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        sanitizer::execute_sanitize_metadata(&app, &taskId, items)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
async fn scan_hidden(app: tauri::AppHandle, taskId: String, folder: String) -> Result<Vec<sanitizer::HiddenFileItem>, String> {
    tokio::task::spawn_blocking(move || {
        sanitizer::scan_hidden_files(&app, &taskId, Path::new(&folder))
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
async fn delete_hidden(app: tauri::AppHandle, taskId: String, filePaths: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        sanitizer::execute_delete_files(&app, &taskId, filePaths)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
async fn cancel_sanitizer_scan() -> Result<(), String> {
    sanitizer::SANITZER_CANCELLED.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
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
async fn scan_flac_files(app: tauri::AppHandle, taskId: String, folder: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&folder);
        if !path.exists() {
            return Err("Folder does not exist".to_string());
        }
        
        // 1. Quick Scan: count files
        let mut entries = Vec::new();
        for entry in walkdir::WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                entries.push(entry.path().to_path_buf());
            }
        }

        let total = entries.len();
        let mut flac_files = Vec::new();

        // 2. Loop and process
        for (index, p) in entries.iter().enumerate() {
            if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                if ext.to_lowercase() == "flac" {
                    flac_files.push(p.to_string_lossy().to_string());
                }
            }

            // Emit progress
            let _ = app.emit(
                "task-progress",
                transcoder::TaskProgress {
                    task_id: taskId.clone(),
                    task_name: "FLAC Files Scan".to_string(),
                    index,
                    total,
                    status: if index + 1 == total { "completed".to_string() } else { "running".to_string() },
                    message: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    file_path: None,
                }
            );
        }

        flac_files.sort();
        Ok(flac_files)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

// Library Management Commands
#[tauri::command]
async fn read_dir_tree(app: tauri::AppHandle, taskId: String, folder: String, formats: Vec<String>) -> Result<library::DirTreeNode, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&folder);
        if !path.exists() {
            return Err("Folder does not exist".to_string());
        }

        let total = walkdir::WalkDir::new(path).into_iter().count();
        let formats_set: HashSet<String> = formats.iter().map(|f| f.to_lowercase()).collect();
        let mut counter = 0;
        library::read_tree_recursive(&app, &taskId, path, &formats_set, 0, &mut counter, total)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
async fn read_track_tags(filePath: String) -> Result<library::TrackTags, String> {
    tokio::task::spawn_blocking(move || {
        library::read_track_tags_impl(Path::new(&filePath))
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
async fn write_track_tags(filePath: String, tags: library::TrackTags) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        library::write_track_tags_impl(Path::new(&filePath), tags)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
async fn batch_update_folder_tags(
    folderPath: String,
    formats: Vec<String>,
    artist: Option<String>,
    album: Option<String>,
    genre: Option<String>,
    year: Option<u32>,
    coverB64: Option<String>,
    coverMime: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let formats_set: HashSet<String> = formats.iter().map(|f| f.to_lowercase()).collect();
        library::batch_update_folder_tags_impl(
            Path::new(&folderPath),
            &formats_set,
            artist,
            album,
            genre,
            year,
            coverB64,
            coverMime,
        )
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
async fn read_image_base64(filePath: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let data = std::fs::read(Path::new(&filePath))
            .map_err(|e| format!("Failed to read file: {}", e))?;
        use base64::prelude::*;
        Ok(BASE64_STANDARD.encode(&data))
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
async fn preview_directory_tracks(
    folder: String,
    formats: Vec<String>,
) -> Result<Vec<playlist::TrackPreview>, String> {
    tokio::task::spawn_blocking(move || {
        let base_path = Path::new(&folder);
        if !base_path.exists() {
            return Err("Folder does not exist".to_string());
        }

        let formats_set: HashSet<String> = formats
            .iter()
            .map(|s| s.trim().to_lowercase())
            .collect();

        let mut files = Vec::new();
        for entry in walkdir::WalkDir::new(base_path).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                let path = entry.path();
                if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                    if formats_set.contains(&ext.to_lowercase()) {
                        files.push(path.to_path_buf());
                    }
                }
            }
        }
        files.sort();

        let previews = files
            .iter()
            .map(|f| playlist::get_track_preview(f, base_path))
            .collect();

        Ok(previews)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            save_workspace,
            preview_playlist_tracks,
            preview_directory_tracks,
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
            read_image_base64,
            scan_metadata_sanitizer,
            execute_metadata_sanitizer,
            cancel_sanitizer_scan,
            export::analyze_export_diff,
            export::execute_export,
            export::reveal_in_finder,
            export::delete_export_files,
            export::cancel_export
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
