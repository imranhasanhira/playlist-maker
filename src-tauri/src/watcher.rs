use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub struct WatcherState {
    pub watcher: Mutex<Option<RecommendedWatcher>>,
    pub active_path: Mutex<Option<String>>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            watcher: Mutex::new(None),
            active_path: Mutex::new(None),
        }
    }
}

#[derive(Clone, Serialize)]
pub struct FsChangeEvent {
    pub path: String,
    pub timestamp_ms: u64,
}

#[tauri::command]
pub async fn start_fs_watcher(
    app: AppHandle,
    state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let watch_path = Path::new(&path);
    if !watch_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    // Stop existing watcher
    {
        let mut watcher_guard = state.watcher.lock().map_err(|e| e.to_string())?;
        *watcher_guard = None;
        let mut path_guard = state.active_path.lock().map_err(|e| e.to_string())?;
        *path_guard = Some(path.clone());
    }

    let app_handle = app.clone();
    let path_clone = path.clone();

    let last_event_time = Arc::new(Mutex::new(None::<Instant>));
    let pending_trigger = Arc::new(Mutex::new(false));

    let last_time_tx = last_event_time.clone();
    let pending_tx = pending_trigger.clone();

    // Spawn 3-second debouncer task
    let debouncer_app = app_handle.clone();
    let debouncer_path = path_clone.clone();

    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;

            let should_trigger = {
                let mut pending = pending_tx.lock().unwrap();
                let last_time = last_time_tx.lock().unwrap();

                if *pending {
                    if let Some(t) = *last_time {
                        if t.elapsed() >= Duration::from_secs(3) {
                            *pending = false;
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    false
                }
            };

            if should_trigger {
                println!("[FS Watcher] 3s Debounce triggered for path: {}", debouncer_path);
                let _ = debouncer_app.emit(
                    "fs-library-changed",
                    FsChangeEvent {
                        path: debouncer_path.clone(),
                        timestamp_ms: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64,
                    },
                );
            }
        }
    });

    let event_handler = move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            // Ignore access/read-only events
            match event.kind {
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                    let mut pending = pending_trigger.lock().unwrap();
                    let mut last_time = last_event_time.lock().unwrap();
                    *pending = true;
                    *last_time = Some(Instant::now());
                }
                _ => {}
            }
        }
    };

    let mut watcher = RecommendedWatcher::new(event_handler, Config::default())
        .map_err(|e| format!("Failed to initialize watcher: {}", e))?;

    watcher
        .watch(watch_path, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch directory: {}", e))?;

    {
        let mut watcher_guard = state.watcher.lock().map_err(|e| e.to_string())?;
        *watcher_guard = Some(watcher);
    }

    println!("[FS Watcher] Started watching '{}' with 3s debounce.", path);
    Ok(())
}

#[tauri::command]
pub async fn stop_fs_watcher(
    state: tauri::State<'_, WatcherState>,
) -> Result<(), String> {
    let mut watcher_guard = state.watcher.lock().map_err(|e| e.to_string())?;
    *watcher_guard = None;
    let mut path_guard = state.active_path.lock().map_err(|e| e.to_string())?;
    *path_guard = None;
    println!("[FS Watcher] Watcher stopped.");
    Ok(())
}
