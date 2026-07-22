use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SystemBinariesStatus {
    pub ytdlp_installed: bool,
    pub ytdlp_version: Option<String>,
    pub ffmpeg_installed: bool,
    pub ffmpeg_version: Option<String>,
}

/// Check if a file or directory name is an OS-generated hidden file or metadata junk
/// (e.g. macOS AppleDouble `._*` files, `.DS_Store`, `.Trashes`, Windows `Thumbs.db`, `desktop.ini`)
pub fn is_os_system_junk(filename: &str) -> bool {
    filename.starts_with('.')
        || filename.starts_with("._")
        || filename.eq_ignore_ascii_case("thumbs.db")
        || filename.eq_ignore_ascii_case("desktop.ini")
}

/// Convert a path to a normalized String with forward slashes
pub fn canonical_path_str(path: &Path) -> String {
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    canonical.to_string_lossy().replace('\\', "/")
}

/// Get file mtime (in seconds) and file size (in bytes)
pub fn get_file_mtime_and_size(path: &Path) -> Option<(u64, u64)> {
    let metadata = fs::metadata(path).ok()?;
    let mtime = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    let size = metadata.len();
    Some((mtime, size))
}

#[tauri::command]
pub fn check_system_binaries() -> SystemBinariesStatus {
    // Check yt-dlp
    let (ytdlp_installed, ytdlp_version) = match Command::new("yt-dlp").arg("--version").output() {
        Ok(out) if out.status.success() => {
            let ver = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (true, Some(ver))
        }
        _ => (false, None),
    };

    // Check ffmpeg
    let (ffmpeg_installed, ffmpeg_version) = match Command::new("ffmpeg").arg("-version").output() {
        Ok(out) if out.status.success() => {
            let ver_line = String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .unwrap_or("ffmpeg installed")
                .to_string();
            (true, Some(ver_line))
        }
        _ => (false, None),
    };

    SystemBinariesStatus {
        ytdlp_installed,
        ytdlp_version,
        ffmpeg_installed,
        ffmpeg_version,
    }
}
