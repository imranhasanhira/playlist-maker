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
    configOverride: Option<playlist::MainConfig>,
    sourceDirOverride: Option<String>,
    playlistIndex: usize,
    formats: String,
    bucketKey: Option<String>,
    probeUncached: Option<bool>,
) -> Result<Vec<playlist::TrackPreview>, String> {
    tokio::task::spawn_blocking(move || {
        let config = match configOverride {
            Some(cfg) => cfg,
            None => playlist::read_config_file(Path::new(&configPath))?,
        };
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
        let is_all_bucket = bucketKey
            .as_deref()
            .map(|b| b == "all" || b.is_empty())
            .unwrap_or(true);

        let files = if let Some(ref target_bucket) = bucketKey {
            if is_all_bucket {
                let (all_files, _) = playlist::resolve_playlist_files(playlist_config, &resolved_source_dir, &formats_set);
                all_files
            } else {
                let (sub_playlists, _) = playlist::expand_playlist_buckets(playlist_config, &resolved_source_dir, &formats_set, config.min_tracks_per_year_playlist);
                if let Some(sub) = sub_playlists.into_iter().find(|s| &s.bucket_key == target_bucket) {
                    sub.files
                } else if target_bucket.starts_with("unknown") {
                    // Handle unknown or unknown_XX bucket when include_unknown was false
                    let (all_files, _) = playlist::resolve_playlist_files(playlist_config, &resolved_source_dir, &formats_set);
                    let file_metas = playlist::get_or_probe_track_metadata_batch(&all_files);
                    let unknown_files: Vec<std::path::PathBuf> = all_files.into_iter().zip(file_metas).filter_map(|(f, m)| {
                        if m.year.is_none() { Some(f) } else { None }
                    }).collect();

                    let year_cfg = playlist_config.year_split.as_ref();
                    let split_parts = year_cfg.and_then(|y| y.split_unknown_parts).unwrap_or(0);
                    if split_parts >= 2 && target_bucket.starts_with("unknown_") {
                        let suffix = &target_bucket["unknown_".len()..];
                        let num_str = suffix.trim_start_matches('p');
                        if let Ok(idx_1based) = num_str.parse::<usize>() {
                            if idx_1based >= 1 && idx_1based <= split_parts {
                                let total_u = unknown_files.len();
                                let base = total_u / split_parts;
                                let rem = total_u % split_parts;
                                let mut start = 0;
                                for i in 0..idx_1based - 1 {
                                    start += base + if i < rem { 1 } else { 0 };
                                }
                                let count = base + if (idx_1based - 1) < rem { 1 } else { 0 };
                                unknown_files[start..start + count].to_vec()
                            } else {
                                Vec::new()
                            }
                        } else {
                            Vec::new()
                        }
                    } else {
                        unknown_files
                    }
                } else {
                    Vec::new()
                }
            }
        } else {
            let (all_files, _) = playlist::resolve_playlist_files(playlist_config, &resolved_source_dir, &formats_set);
            all_files
        };

        let should_probe = probeUncached.unwrap_or(!is_all_bucket);
        let previews = playlist::get_tracks_previews_with_options(&files, &resolved_source_dir, should_probe);

        Ok(previews)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
async fn get_playlists_summary(
    app: tauri::AppHandle,
    taskId: Option<String>,
    configPath: String,
    configOverride: Option<playlist::MainConfig>,
    sourceDirOverride: Option<String>,
    formats: String,
) -> Result<Vec<playlist::PlaylistSummaryItem>, String> {
    tokio::task::spawn_blocking(move || {
        let config = match configOverride {
            Some(cfg) => cfg,
            None => playlist::read_config_file(Path::new(&configPath))?,
        };
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
        let summaries = playlist::calculate_playlist_summaries(Some(&app), taskId.as_deref(), &config, &resolved_source_dir, &formats_set);
        Ok(summaries)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
async fn get_single_playlist_summary(
    app: tauri::AppHandle,
    taskId: Option<String>,
    configPath: String,
    configOverride: Option<playlist::MainConfig>,
    sourceDirOverride: Option<String>,
    formats: String,
    playlistIndex: usize,
) -> Result<playlist::PlaylistSummaryItem, String> {
    tokio::task::spawn_blocking(move || {
        let config = match configOverride {
            Some(cfg) => cfg,
            None => playlist::read_config_file(Path::new(&configPath))?,
        };
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
        playlist::calculate_single_playlist_summary(Some(&app), taskId.as_deref(), &config, &resolved_source_dir, &formats_set, playlistIndex, true)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
async fn generate_all_playlists(
    app: tauri::AppHandle,
    configPath: String,
    sourceDirOverride: Option<String>,
    targetDirOverride: Option<String>,
    relativeToConfig: bool,
    formats: String,
    appendTrackCount: Option<bool>,
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
        let emit_log = |msg: String, logs: &mut Vec<String>| {
            let _ = app.emit("playlist-generation-log", msg.clone());
            logs.push(msg);
        };

        let should_append_count = appendTrackCount.unwrap_or(true);

        emit_log(format!(
            "$ generate-playlists --config \"{}\" --formats \"{}\"{}{}",
            configPath,
            formats,
            if relativeToConfig { " --relative-to-config" } else { "" },
            if should_append_count { " --append-track-count" } else { "" }
        ), &mut logs);
        emit_log(format!("Writing all playlist files to {}", resolved_target_dir.display()), &mut logs);

        let total_playlists = config.playlists.len();
        let mut total_generated = 0usize;

        for (idx, playlist_config) in config.playlists.iter().enumerate() {
            emit_log(format!("[{}/{}] Processing \"{}\"...", idx + 1, total_playlists, playlist_config.name), &mut logs);

            let (sub_playlists, errors) = playlist::expand_playlist_buckets(
                playlist_config,
                &resolved_source_dir,
                &formats_set,
                config.min_tracks_per_year_playlist,
            );
            for err in errors {
                emit_log(format!("  ⚠️ {}", err), &mut logs);
            }

            for sub in sub_playlists {
                if !sub.files.is_empty() {
                    let count = sub.files.len();
                    let file_name = if should_append_count {
                        format!("{} ({})", sub.name, count)
                    } else {
                        sub.name
                    };
                    let sanitized = file_name.replace('/', "_").replace('\\', "_");
                    let playlist_file_path = resolved_target_dir.join(format!("{}.m3u", sanitized));
                    match playlist::write_playlist_file(&playlist_file_path, &sub.files) {
                        Ok(_) => {
                            total_generated += 1;
                            emit_log(format!("  ✅ Created: {}.m3u ({} tracks)", sanitized, count), &mut logs);
                        }
                        Err(e) => emit_log(format!("  ❌ ERROR: Failed to write {}.m3u: {}", sanitized, e), &mut logs),
                    }
                } else {
                    emit_log(format!("  ⚠️ Skipped \"{}\" (no matching tracks)", sub.name), &mut logs);
                }
            }
        }

        emit_log(format!("🎉 Finished compiling {} playlist file(s) successfully!", total_generated), &mut logs);

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
async fn execute_sanitizer(app: tauri::AppHandle, taskId: String, items: Vec<sanitizer::SanitizeItem>) -> Result<sanitizer::ExecutionReport, String> {
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
async fn execute_metadata_sanitizer(app: tauri::AppHandle, taskId: String, items: Vec<sanitizer::MetadataSanitizeItem>) -> Result<sanitizer::ExecutionReport, String> {
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
async fn delete_hidden(app: tauri::AppHandle, taskId: String, filePaths: Vec<String>) -> Result<sanitizer::ExecutionReport, String> {
    tokio::task::spawn_blocking(move || {
        sanitizer::execute_delete_files(&app, &taskId, filePaths)
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
async fn scan_all_unified(app: tauri::AppHandle, taskId: String, folder: String, formats: Vec<String>, stripPhrases: Vec<String>) -> Result<sanitizer::UnifiedScanResult, String> {
    tokio::task::spawn_blocking(move || {
        sanitizer::scan_all_unified(&app, &taskId, Path::new(&folder), &formats, &stripPhrases)
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
async fn cancel_any_task(taskId: String) -> Result<(), String> {
    sanitizer::cancel_task(Some(&taskId));
    if taskId == "flac_transcode" || taskId.starts_with("transcode") {
        sanitizer::cancel_task(Some("flac_transcode"));
    }
    if taskId.starts_with("dl_") {
        let _ = downloader::cancel_download_job(taskId.clone()).await;
    }
    if taskId.starts_with("export_") || taskId == "export" {
        let _ = export::cancel_export().await;
    }
    if taskId == "mp3_to_m4a" || taskId.starts_with("mp3_to_m4a") {
        let _ = downloader::cancel_mp3_to_m4a_upgrade().await;
    }
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
        sanitizer::clear_task_cancel(&taskId);
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
            if sanitizer::is_task_cancelled(&taskId) {
                break;
            }
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
        sanitizer::clear_task_cancel(&taskId);
        let path = Path::new(&folder);
        if !path.exists() {
            return Err("Folder does not exist".to_string());
        }

        let total = walkdir::WalkDir::new(path).into_iter().count();
        let formats_set: HashSet<String> = formats.iter().map(|f| f.to_lowercase()).collect();
        let mut counter = 0;
        let mut root = library::read_tree_recursive(&app, &taskId, path, &formats_set, 0, &mut counter, total)?;
        if !sanitizer::is_task_cancelled(&taskId) {
            library::annotate_tree_years(&mut root);
        }
        Ok(root)
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

        let previews = playlist::get_tracks_previews(&files, base_path);

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

            #[cfg(desktop)]
            {
                if let Some(tray) = app.tray_by_id("main") {
                    let quit_item = tauri::menu::MenuItem::with_id(app, "quit", "Quit Diamond Music Manager", true, None::<&str>)?;
                    let show_item = tauri::menu::MenuItem::with_id(app, "show", "Show Diamond Music Manager", true, None::<&str>)?;
                    let menu = tauri::menu::Menu::with_items(app, &[&show_item, &quit_item])?;
                    let _ = tray.set_menu(Some(menu));
                    let _ = tray.on_menu_event(|app, event| match event.id.as_ref() {
                        "quit" => {
                            app.exit(0);
                        }
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    });
                    let _ = tray.on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::Click { button, button_state, .. } = event {
                            if button == tauri::tray::MouseButton::Left && button_state == tauri::tray::MouseButtonState::Up {
                                let app = tray.app_handle();
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.unminimize();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                    });
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
            scan_all_unified,
            cancel_sanitizer_scan,
            cancel_any_task,
            export::analyze_export_diff,
            export::execute_export,
            export::reveal_in_finder,
            export::delete_export_files,
            export::cancel_export,
            export::clean_export_hidden_files,
            watcher::start_fs_watcher,
            watcher::stop_fs_watcher,
            downloader::start_download_job,
            downloader::cancel_download_job,
            downloader::reset_archive_file,
            downloader::reset_playlist_archive_ids,
            downloader::dl_fetch_playlist_metadata,
            downloader::dl_count_songs_on_disk,
            downloader::dl_rename_entry_folder,
            downloader::dl_get_delete_files_report,
            downloader::dl_execute_delete_files,
            downloader::dl_reconcile_playlist_archive,
            downloader::scan_mp3s_for_m4a_upgrade,
            downloader::execute_mp3_to_m4a_upgrade,
            downloader::cancel_mp3_to_m4a_upgrade,
            downloader::scan_files_for_repair,
            downloader::execute_file_repair,
            downloader::cancel_file_repair,
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
            dedup::prune_fingerprint_cache,
            dedup::delete_duplicate_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

