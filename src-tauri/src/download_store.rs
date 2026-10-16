use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;
use tauri::Manager;

static GLOBAL_DB_PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn get_global_db_path() -> Option<PathBuf> {
    GLOBAL_DB_PATH.get().cloned()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DownloadEntry {
    pub id: String,
    pub url: String,
    pub name: String,
    pub labels: String,
    pub output_dir: String,
    pub audio_format: Option<String>,
    pub use_archive: Option<bool>,
    pub ignore_errors: Option<bool>,
    pub total_songs: u32,
    pub songs_on_disk: u32,
    pub playlist_title: String,
    pub artist: String,
    pub album: String,
    pub status: String,
    pub last_download_at: Option<i64>,
    pub last_error: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DownloadGlobalSettings {
    pub default_output_dir: String,
    pub default_audio_format: String,
    pub default_use_archive: bool,
    pub archive_path: String,
    pub default_ignore_errors: bool,
    pub max_parallel_jobs: u32,
}

pub struct DbState(pub Mutex<Connection>);

fn get_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app_data_dir: {}", e))?;
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    }
    Ok(dir.join("downloads.db"))
}

pub fn init_db(app: &AppHandle) -> Result<Connection, String> {
    let db_path = get_db_path(app)?;
    let _ = GLOBAL_DB_PATH.set(db_path.clone());
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open SQLite database at {:?}: {}", db_path, e))?;

    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;

        CREATE TABLE IF NOT EXISTS download_entries (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            labels TEXT NOT NULL DEFAULT '',
            output_dir TEXT NOT NULL DEFAULT '',
            audio_format TEXT,
            use_archive INTEGER,
            ignore_errors INTEGER,
            total_songs INTEGER DEFAULT 0,
            songs_on_disk INTEGER DEFAULT 0,
            playlist_title TEXT DEFAULT '',
            artist TEXT DEFAULT '',
            album TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'new',
            last_download_at INTEGER,
            last_error TEXT DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS download_global_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS track_fingerprints (
            file_path TEXT PRIMARY KEY,
            mtime_secs INTEGER NOT NULL,
            size_bytes INTEGER NOT NULL,
            quick_hash TEXT NOT NULL,
            audio_hash TEXT NOT NULL,
            youtube_id TEXT,
            raw_title TEXT NOT NULL DEFAULT '',
            raw_artist TEXT NOT NULL DEFAULT '',
            norm_title TEXT NOT NULL,
            norm_artist TEXT NOT NULL,
            norm_stem TEXT NOT NULL DEFAULT '',
            duration_secs INTEGER NOT NULL,
            format_ext TEXT NOT NULL,
            bitrate_kbps INTEGER NOT NULL DEFAULT 0,
            chromaprint BLOB,
            updated_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_fp_quick_hash ON track_fingerprints(size_bytes, quick_hash);
        ",
    )
    .map_err(|e| format!("Failed to initialize database tables: {}", e))?;

    Ok(conn)
}

#[tauri::command]
pub async fn dl_store_get_all_entries(app: AppHandle) -> Result<Vec<DownloadEntry>, String> {
    let state = app.state::<DbState>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, url, name, labels, output_dir, audio_format, use_archive, ignore_errors,
                    total_songs, songs_on_disk, playlist_title, artist, album, status,
                    last_download_at, last_error, created_at, updated_at
             FROM download_entries ORDER BY updated_at DESC",
        )
        .map_err(|e| format!("Query prepare error: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            let use_archive_int: Option<i32> = row.get(6)?;
            let ignore_errors_int: Option<i32> = row.get(7)?;

            Ok(DownloadEntry {
                id: row.get(0)?,
                url: row.get(1)?,
                name: row.get(2)?,
                labels: row.get(3)?,
                output_dir: row.get(4)?,
                audio_format: row.get(5)?,
                use_archive: use_archive_int.map(|v| v != 0),
                ignore_errors: ignore_errors_int.map(|v| v != 0),
                total_songs: row.get(8)?,
                songs_on_disk: row.get(9)?,
                playlist_title: row.get(10)?,
                artist: row.get(11)?,
                album: row.get(12)?,
                status: row.get(13)?,
                last_download_at: row.get(14)?,
                last_error: row.get(15)?,
                created_at: row.get(16)?,
                updated_at: row.get(17)?,
            })
        })
        .map_err(|e| format!("Query map error: {}", e))?;

    let mut entries = Vec::new();
    for r in rows {
        if let Ok(entry) = r {
            entries.push(entry);
        }
    }

    Ok(entries)
}

#[tauri::command]
pub async fn dl_store_save_entry(app: AppHandle, entry: DownloadEntry) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    let use_archive_int = entry.use_archive.map(|v| if v { 1 } else { 0 });
    let ignore_errors_int = entry.ignore_errors.map(|v| if v { 1 } else { 0 });

    conn.execute(
        "INSERT OR REPLACE INTO download_entries (
            id, url, name, labels, output_dir, audio_format, use_archive, ignore_errors,
            total_songs, songs_on_disk, playlist_title, artist, album, status,
            last_download_at, last_error, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        params![
            entry.id,
            entry.url,
            entry.name,
            entry.labels,
            entry.output_dir,
            entry.audio_format,
            use_archive_int,
            ignore_errors_int,
            entry.total_songs,
            entry.songs_on_disk,
            entry.playlist_title,
            entry.artist,
            entry.album,
            entry.status,
            entry.last_download_at,
            entry.last_error,
            entry.created_at,
            entry.updated_at,
        ],
    )
    .map_err(|e| format!("Save entry failed: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn dl_store_delete_entry(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    conn.execute("DELETE FROM download_entries WHERE id = ?1", params![id])
        .map_err(|e| format!("Delete entry failed: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn dl_store_get_global_settings(app: AppHandle) -> Result<DownloadGlobalSettings, String> {
    let state = app.state::<DbState>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    let get_val = |key: &str, default: &str| -> String {
        let res: SqlResult<String> = conn.query_row(
            "SELECT value FROM download_global_settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        );
        res.unwrap_or_else(|_| default.to_string())
    };

    let default_output_dir = get_val("default_output_dir", "");
    let default_audio_format = get_val("default_audio_format", "m4a/mp3");
    let default_use_archive = get_val("default_use_archive", "true") == "true";
    let archive_path = get_val("archive_path", "");
    let default_ignore_errors = get_val("default_ignore_errors", "true") == "true";
    let max_parallel_jobs = get_val("max_parallel_jobs", "2").parse::<u32>().unwrap_or(2);

    Ok(DownloadGlobalSettings {
        default_output_dir,
        default_audio_format,
        default_use_archive,
        archive_path,
        default_ignore_errors,
        max_parallel_jobs,
    })
}

#[tauri::command]
pub async fn dl_store_save_global_settings(
    app: AppHandle,
    settings: DownloadGlobalSettings,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    let pairs = [
        ("default_output_dir", settings.default_output_dir),
        ("default_audio_format", settings.default_audio_format),
        ("default_use_archive", if settings.default_use_archive { "true" } else { "false" }.to_string()),
        ("archive_path", settings.archive_path),
        ("default_ignore_errors", if settings.default_ignore_errors { "true" } else { "false" }.to_string()),
        ("max_parallel_jobs", settings.max_parallel_jobs.to_string()),
    ];

    for (k, v) in pairs {
        conn.execute(
            "INSERT OR REPLACE INTO download_global_settings (key, value) VALUES (?1, ?2)",
            params![k, v],
        )
        .map_err(|e| format!("Save setting {} failed: {}", k, e))?;
    }

    Ok(())
}
