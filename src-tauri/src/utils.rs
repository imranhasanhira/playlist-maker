use std::fs;
use std::path::Path;

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
