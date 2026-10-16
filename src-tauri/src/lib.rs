#![allow(non_snake_case)]

mod playlist;
mod sanitizer;
mod transcoder;
mod library;
mod export;
mod watcher;
pub mod utils;
mod downloader;
mod font_issues;
mod download_store;
mod dedup;

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;
use tauri::{Emitter, Manager};


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
    bucketKey: Option<String>,
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

        let files = if let Some(ref target_bucket) = bucketKey {
            if target_bucket == "all" || target_bucket.is_empty() {
                let (all_files, _) = playlist::resolve_playlist_files(playlist_config, &resolved_source_dir, &formats_set);
                all_files
            } else {
                let (sub_playlists, _) = playlist::expand_playlist_buckets(playlist_config, &resolved_source_dir, &formats_set, config.min_tracks_per_year_playlist);
                // Also handle "unknown" bucket if it was excluded by include_unknown
                if target_bucket == "unknown" && !sub_playlists.iter().any(|s| s.bucket_key == "unknown") {
                    let (all_files, _) = playlist::resolve_playlist_files(playlist_config, &resolved_source_dir, &formats_set);
                    all_files.into_iter().filter(|f| {
                        let yr = if let Ok(tagged_file) = lofty::probe::Probe::open(f).and_then(|p| p.read()) {
                            playlist::extract_track_year(f, Some(&tagged_file))
                        } else {
                            playlist::extract_track_year(f, None)
                        };
                        yr.is_none()
                    }).collect()
                } else {
                    sub_playlists
                        .into_iter()
                        .find(|sub| &sub.bucket_key == target_bucket)
                        .map(|sub| sub.files)
                        .unwrap_or_default()
                }
            }
        } else {
            let (all_files, _) = playlist::resolve_playlist_files(playlist_config, &resolved_source_dir, &formats_set);
            all_files
        };

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
async fn get_playlists_summary(
    configPath: String,
    sourceDirOverride: Option<String>,
    formats: String,
) -> Result<Vec<playlist::PlaylistSummaryItem>, String> {
    tokio::task::spawn_blocking(move || {
        let config = playlist::read_config_file(Path::new(&configPath))?;
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
        let summaries = playlist::calculate_playlist_summaries(&config, &resolved_source_dir, &formats_set);
        Ok(summaries)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
async fn get_single_playlist_summary(
    configPath: String,
    sourceDirOverride: Option<String>,
    formats: String,
    playlistIndex: usize,
) -> Result<playlist::PlaylistSummaryItem, String> {
    tokio::task::spawn_blocking(move || {
        let config = playlist::read_config_file(Path::new(&configPath))?;
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
        playlist::calculate_single_playlist_summary(&config, &resolved_source_dir, &formats_set, playlistIndex)
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
        logs.push(format!(
            "$ generate-playlists --config \"{}\" --formats \"{}\"{}",
            configPath,
            formats,
            if relativeToConfig { " --relative-to-config" } else { "" }
        ));
        logs.push(format!("Writing all playlist files to {}", resolved_target_dir.display()));

        let replacement_map =
            dedup::build_export_superior_replacement_map(&config, &resolved_source_dir, &formats_set);

        for playlist_config in &config.playlists {
            let (sub_playlists, errors) = playlist::expand_playlist_buckets(playlist_config, &resolved_source_dir, &formats_set, config.min_tracks_per_year_playlist);
            for err in errors {
                logs.push(format!("  {}", err));
            }

            for sub in sub_playlists {
                logs.push(format!("Making playlist: {}", sub.name));
                let mut resolved_files = Vec::new();
                let mut seen = HashSet::new();
                for f in sub.files {
                    let c_str = utils::canonical_path_str(&f);
                    let eff = replacement_map.get(&c_str).cloned().unwrap_or(f);
                    let eff_c = utils::canonical_path_str(&eff);
                    if seen.insert(eff_c) {
                        resolved_files.push(eff);
                    }
                }
                if !resolved_files.is_empty() {
                    let sanitized = sub.name.replace('/', "_").replace('\\', "_");
                    let playlist_file_path = resolved_target_dir.join(format!("{}.m3u", sanitized));
                    match playlist::write_playlist_file(&playlist_file_path, &resolved_files) {
                        Ok(_) => logs.push(format!("  Done with {} files", resolved_files.len())),
                        Err(e) => logs.push(format!("  ERROR: {}", e)),
                    }
                } else {
                    logs.push(format!("  SKIPPED due to no available music"));
                }
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
async fn cancel_sanitizer_scan(taskId: Option<String>) -> Result<(), String> {
    sanitizer::cancel_task(taskId.as_deref());
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
async fn select_directories(title: String) -> Result<Vec<String>, String> {
    let paths = rfd::FileDialog::new()
        .set_title(&title)
        .pick_folders();
    Ok(paths.map_or(Vec::new(), |list| {
        list.into_iter().map(|p| p.to_string_lossy().to_string()).collect()
    }))
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

#[tauri::command]
async fn fit_window_to_screen(window: tauri::WebviewWindow) -> Result<(), String> {
    let mon = window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten());
    if let Some(monitor) = mon {
        let work_area = monitor.work_area();
        let _ = window.set_position(work_area.position);
        let _ = window.set_size(work_area.size);
    } else {
        let _ = window.maximize();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let conn = download_store::init_db(app.handle())?;
            app.manage(download_store::DbState(Mutex::new(conn)));
            if let Some(window) = app.get_webview_window("main") {
                let mon = window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten());
                if let Some(monitor) = mon {
                    let work_area = monitor.work_area();
                    let _ = window.set_position(work_area.position);
                    let _ = window.set_size(work_area.size);
                }
            }
            Ok(())
        })
        .manage(watcher::WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            fit_window_to_screen,
            load_workspace,
            save_workspace,
            preview_playlist_tracks,
            preview_directory_tracks,
            get_playlists_summary,
            get_single_playlist_summary,
            generate_all_playlists,
            scan_sanitizer,
            execute_sanitizer,
            scan_hidden,
            delete_hidden,
            start_transcoding_queue,
            select_file,
            select_directory,
            select_directories,
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
            export::cancel_export,
            watcher::start_fs_watcher,
            watcher::stop_fs_watcher,
            downloader::start_download_job,
            downloader::cancel_download_job,
            downloader::reset_archive_file,
            downloader::reset_playlist_archive_ids,
            downloader::dl_fetch_playlist_metadata,
            downloader::dl_count_songs_on_disk,
            downloader::dl_get_delete_files_report,
            downloader::dl_execute_delete_files,
            downloader::dl_reconcile_playlist_archive,
            download_store::dl_store_get_all_entries,
            download_store::dl_store_save_entry,
            download_store::dl_store_delete_entry,
            download_store::dl_store_get_global_settings,
            download_store::dl_store_save_global_settings,
            font_issues::scan_font_issues,
            font_issues::apply_font_issue_option1,
            font_issues::apply_font_issue_option2,
            utils::check_system_binaries,
            dedup::analyze_playlist_duplicates,
            dedup::prune_fingerprint_cache
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

