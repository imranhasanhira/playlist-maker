use crate::download_store::get_global_db_path;
use crate::playlist::{self, MainConfig, PlaylistConfig};
use crate::utils::{canonical_path_str, get_file_mtime_and_size};
use any_ascii::any_ascii;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::Accessor;
use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone)]
pub struct TrackFingerprintRecord {
    pub file_path: String,
    pub mtime_secs: u64,
    pub size_bytes: u64,
    pub quick_hash: String,
    pub audio_hash: String,
    pub youtube_id: Option<String>,
    pub raw_title: String,
    pub raw_artist: String,
    pub norm_title: String,
    pub norm_artist: String,
    pub norm_stem: String,
    pub duration_secs: u32,
    pub format_ext: String,
    pub bitrate_kbps: u32,
    pub chromaprint: Option<Vec<u32>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DuplicateTrackEntry {
    pub file_path: String,
    pub relative_path: String,
    pub source_folder: String,
    pub source_index: usize,
    pub playlist_names: Vec<String>,
    pub title: String,
    pub artist: String,
    pub duration: u32,
    pub size_bytes: u64,
    pub format_ext: String,
    pub bitrate_kbps: u32,
    pub youtube_id: Option<String>,
    pub is_winner: bool,
    pub offset_secs: Option<f32>,
    pub winner_reason: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DuplicateGroup {
    pub group_id: String,
    pub canonical_title: String,
    pub canonical_artist: String,
    pub match_tier: String,  // "exact_hash" | "youtube_id" | "acoustic" | "metadata"
    pub match_label: String, // Human-readable match badge
    pub confidence: u8,
    pub tracks: Vec<DuplicateTrackEntry>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DuplicateAnalysisReport {
    pub scope_name: String,
    pub total_scanned_files: usize,
    pub duplicate_groups: Vec<DuplicateGroup>,
    pub redundant_files_count: usize,
    pub redundant_bytes: u64,
    pub cache_total_entries: usize,
    pub cache_stale_pruned: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PruneCacheReport {
    pub pruned_count: usize,
    pub remaining_count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DeleteDuplicatesResult {
    pub deleted_count: usize,
    pub failed_count: usize,
    pub freed_bytes: u64,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DuplicateProgressPayload {
    pub phase: String,
    pub phase_label: String,
    pub stage: u8,
    pub stage_name: String,
    pub stage_label: String,
    pub current: usize,
    pub total: usize,
    pub progress: f64,
    pub current_file: Option<String>,
    pub eta_secs: Option<f64>,
    pub speed: f64,
}

#[derive(Debug, Clone)]
pub struct CandidateTrack {
    pub path: PathBuf,
    pub canonical_path: String,
    pub playlist_index: usize,
    pub playlist_name: String,
    pub source_index: usize,
    pub source_folder: String,
}

// Fast 64-bit FNV-1a hash helper
fn fnv1a_64(bytes: &[u8], seed: u64) -> u64 {
    let mut hash = seed;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Compute quick_hash (first 16KB + middle 16KB + last 16KB) and audio_hash (audio stream payload)
fn compute_file_hashes(path: &Path, size_bytes: u64) -> (String, String) {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return (format!("sz_{}", size_bytes), format!("sz_{}", size_bytes)),
    };

    let mut buf = vec![0u8; 16384];
    let mut q_hash: u64 = 0xcbf29ce484222325 ^ size_bytes;

    // Head 16KB
    let mut head_bytes = vec![0u8; 16384.min(size_bytes as usize)];
    let _ = file.read_exact(&mut head_bytes);
    q_hash = fnv1a_64(&head_bytes, q_hash);

    // Middle 16KB
    if size_bytes > 32768 {
        if file.seek(SeekFrom::Start(size_bytes / 2)).is_ok() {
            if let Ok(n) = file.read(&mut buf) {
                q_hash = fnv1a_64(&buf[..n], q_hash);
            }
        }
    }

    // Tail 16KB
    if size_bytes > 16384 {
        let tail_start = size_bytes.saturating_sub(16384);
        if file.seek(SeekFrom::Start(tail_start)).is_ok() {
            if let Ok(n) = file.read(&mut buf) {
                q_hash = fnv1a_64(&buf[..n], q_hash);
            }
        }
    }

    let quick_hash = format!("{:016x}", q_hash);

    // Determine audio stream boundaries (skip ID3v2 tag at start and ID3v1 tag at end)
    let mut audio_start: u64 = 0;
    if head_bytes.len() >= 10 && &head_bytes[0..3] == b"ID3" {
        // Synchsafe 28-bit integer size in bytes 6..10
        let s0 = (head_bytes[6] as u64) & 0x7F;
        let s1 = (head_bytes[7] as u64) & 0x7F;
        let s2 = (head_bytes[8] as u64) & 0x7F;
        let s3 = (head_bytes[9] as u64) & 0x7F;
        let id3v2_size = (s0 << 21) | (s1 << 14) | (s2 << 7) | s3;
        audio_start = (10 + id3v2_size).min(size_bytes);
    }

    let mut audio_end = size_bytes;
    if size_bytes > audio_start + 128 {
        let mut tag_buf = [0u8; 3];
        if file.seek(SeekFrom::Start(size_bytes - 128)).is_ok()
            && file.read_exact(&mut tag_buf).is_ok()
            && &tag_buf == b"TAG"
        {
            audio_end = size_bytes - 128;
        }
    }

    let audio_len = audio_end.saturating_sub(audio_start);
    let mut a_hash1: u64 = 0xcbf29ce484222325 ^ audio_len;
    let mut a_hash2: u64 = 0x84222325cbf29ce4 ^ audio_len;

    if audio_len > 0 {
        let sample_points = [
            audio_start + (audio_len / 5),
            audio_start + (audio_len / 2),
            audio_start + ((audio_len * 4) / 5),
        ];
        let mut chunk = vec![0u8; 32768];
        for &pt in &sample_points {
            let max_read = (audio_end.saturating_sub(pt)).min(32768) as usize;
            if max_read > 0 && file.seek(SeekFrom::Start(pt)).is_ok() {
                if let Ok(n) = file.read(&mut chunk[..max_read]) {
                    a_hash1 = fnv1a_64(&chunk[..n], a_hash1);
                    // Secondary hash in reverse order for collision resistance
                    for &b in chunk[..n].iter().rev() {
                        a_hash2 ^= b as u64;
                        a_hash2 = a_hash2.wrapping_mul(0x100000001b3);
                    }
                }
            }
        }
    }

    let audio_hash = format!("{:x}_{:016x}{:016x}", audio_len, a_hash1, a_hash2);
    (quick_hash, audio_hash)
}

fn get_yt_regexes() -> &'static (Regex, Regex, Regex, Regex) {
    static RE: OnceLock<(Regex, Regex, Regex, Regex)> = OnceLock::new();
    RE.get_or_init(|| {
        (
            Regex::new(r"\[([a-zA-Z0-9_-]{11})\]").unwrap(),
            Regex::new(r"\(([a-zA-Z0-9_-]{11})\)").unwrap(),
            Regex::new(
                r"(?:^|[-_ ])([a-zA-Z0-9_-]{11})\.(?:mp3|m4a|flac|wav|ogg|opus|aac|alac|wma)$",
            )
            .unwrap(),
            Regex::new(r"(?:v=|youtu\.be/|/embed/|/v/|/watch\?v=)([a-zA-Z0-9_-]{11})").unwrap(),
        )
    })
}

fn get_noise_regex() -> &'static (Regex, Regex, Regex) {
    static NOISE_RE: OnceLock<(Regex, Regex, Regex)> = OnceLock::new();
    NOISE_RE.get_or_init(|| {
        // 1. Bracketed / parenthesized sections containing promo/video/lyric noise (strictly excluding musical modifiers like live, version, acoustic)
        let bracket_noise = Regex::new(
            r"(?i)[\(\[\{][^\)\]\}]*\b(official\s*(music\s*video|video|audio|track)?|lyric|lyrics|lyrical|full\s*(video|audio|song|hd)|hd|4k|hq|remaster|remastered|music\.com\.bd|svf|tseries|coke\s*studio|128kbps|192kbps|256kbps|320kbps|kbps|eng\s*sub|subtitle|subtitles)\b[^\)\]\}]*[\)\]\}]"
        ).unwrap();

        // 2. Standalone noise phrases outside brackets
        let phrase_noise = Regex::new(
            r"(?i)\b(official music video|official video|official audio|official lyric video|official track|lyrical video|lyric video|with lyrics|lyrical|full video|full audio|full song|full hd|music video|audio song|video song|audio track|music\.com\.bd|128kbps|192kbps|256kbps|320kbps)\b"
        ).unwrap();

        // 3. Leading track numbers e.g. "01 - ", "01. ", "Track 01"
        let leading_track_num = Regex::new(r"^\s*(?:track\s*)?\d{1,3}\s*[-._)]\s*").unwrap();

        (bracket_noise, phrase_noise, leading_track_num)
    })
}

pub fn normalize_song_text(raw: &str) -> String {
    if raw.trim().is_empty() {
        return String::new();
    }
    let (id_b, id_p, _, _) = get_yt_regexes();
    let (bracket_noise, phrase_noise, leading_track_num) = get_noise_regex();

    // Transliterate Unicode (Bangla, Hindi, accents, etc.) to ASCII
    let ascii = any_ascii(raw);
    let no_yt1 = id_b.replace_all(&ascii, " ");
    let no_yt2 = id_p.replace_all(&no_yt1, " ");
    let no_lead = leading_track_num.replace(&no_yt2, "");
    let no_brackets = bracket_noise.replace_all(&no_lead, " ");
    let no_phrases = phrase_noise.replace_all(&no_brackets, " ");

    // Collapse to alphanumeric lowercase tokens
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    for ch in no_phrases.chars() {
        if ch.is_ascii_alphanumeric() {
            current.push(ch.to_ascii_lowercase());
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }

    // Remove trailing isolated year token (e.g. 1998, 2021) if there are enough title tokens
    if tokens.len() > 2 {
        if let Some(last) = tokens.last() {
            if last.len() == 4 {
                if let Ok(yr) = last.parse::<u32>() {
                    if (1950..=2035).contains(&yr) {
                        tokens.pop();
                    }
                }
            }
        }
    }

    tokens.join(" ")
}

/// Format quality ranking for tie-breaking when two tracks have equal source priority
pub fn format_quality_rank(ext: &str) -> u32 {
    match ext.to_lowercase().as_str() {
        "flac" => 100,
        "wav" | "alac" => 90,
        "m4a" | "aac" | "opus" => 80,
        "mp3" => 70,
        "ogg" => 60,
        "wma" => 50,
        _ => 10,
    }
}

/// Encode Vec<u32> into little-endian bytes for SQLite BLOB storage
fn encode_u32_blob(vals: &[u32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vals.len() * 4);
    for &v in vals {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    bytes
}

/// Decode SQLite BLOB into Vec<u32>
fn decode_u32_blob(bytes: &[u8]) -> Vec<u32> {
    bytes
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Compute compact 32-bit spectral sub-fingerprints (8 frames/sec, up to 120 seconds) via ffmpeg PCM pipe.
/// Robust to MP3 vs M4A vs FLAC transcoding and 10-15s intro/outro advertisements.
fn compute_acoustic_subfingerprints(path: &Path) -> Option<Vec<u32>> {
    let output = Command::new("ffmpeg")
        .args([
            "-v",
            "quiet",
            "-nostdin",
            "-ss",
            "10",
            "-t",
            "40",
            "-i",
            &path.to_string_lossy(),
            "-ac",
            "1",
            "-ar",
            "8000",
            "-f",
            "s16le",
            "-",
        ])
        .output()
        .ok()?;

    let stdout = if output.status.success() && output.stdout.len() >= 8000 * 2 * 15 {
        output.stdout
    } else {
        // Fallback for tracks shorter than 15s: decode from beginning
        let fallback = Command::new("ffmpeg")
            .args([
                "-v",
                "quiet",
                "-nostdin",
                "-t",
                "40",
                "-i",
                &path.to_string_lossy(),
                "-ac",
                "1",
                "-ar",
                "8000",
                "-f",
                "s16le",
                "-",
            ])
            .output()
            .ok()?;
        if !fallback.status.success() || fallback.stdout.len() < 8000 * 2 * 10 {
            return None;
        }
        fallback.stdout
    };

    // Convert bytes to i16 samples at 8000 Hz
    let samples: Vec<f32> = stdout
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32)
        .collect();

    // Frame step = 1000 samples (0.125s = 8 frames/sec), window = 2000 samples (0.25s)
    let step = 1000usize;
    let window = 2000usize;
    if samples.len() < window + step * 16 {
        return None;
    }

    let num_frames = (samples.len() - window) / step;
    let mut frame_bands: Vec<[f32; 17]> = Vec::with_capacity(num_frames);

    // Divide each 2000-sample window into 17 log-spaced frequency/modulation sub-bands
    // using fast time-domain decimated Haar/Walsh filter bank
    for f_idx in 0..num_frames {
        let start = f_idx * step;
        let slice = &samples[start..start + window];
        let mut bands = [0.0f32; 17];

        // Compute multi-scale zero-crossing / energy bands across 17 stride scales (periods 1..17)
        for b in 0..17 {
            let stride = b + 1;
            let mut energy = 0.0f32;
            let mut idx = 0;
            while idx + stride < slice.len() {
                let diff = slice[idx + stride] - slice[idx];
                energy += diff * diff;
                idx += 2;
            }
            bands[b] = (energy + 1.0).ln();
        }
        frame_bands.push(bands);
    }

    // Haitsma-Kalker / Chromaprint style 2D differential bit encoding:
    // Bit (b) is 1 if (Band[t][b] - Band[t][b+1]) - (Band[t-1][b] - Band[t-1][b+1]) > 0
    // Plus 16 bits for delta across t-2 (0.25s temporal derivative)
    let mut subfingerprints = Vec::with_capacity(num_frames.saturating_sub(2));
    for t in 2..frame_bands.len() {
        let mut fp: u32 = 0;
        for b in 0..16 {
            let d_curr = frame_bands[t][b] - frame_bands[t][b + 1];
            let d_prev1 = frame_bands[t - 1][b] - frame_bands[t - 1][b + 1];
            let d_prev2 = frame_bands[t - 2][b] - frame_bands[t - 2][b + 1];

            if d_curr > d_prev1 {
                fp |= 1u32 << b;
            }
            if d_curr > d_prev2 {
                fp |= 1u32 << (b + 16);
            }
        }
        subfingerprints.push(fp);
    }

    if subfingerprints.len() >= 64 {
        Some(subfingerprints)
    } else {
        None
    }
}

/// Compare two acoustic fingerprint streams with sliding offset (-25s to +25s)
/// and progressive multi-stage verification up to `max_duration_secs`.
/// Stage 1: Fast alignment scan across initial 20-second window.
/// Stage 2: Progressive verification in 10-second steps deeper into the song.
/// If audio diverges after a similar intro, early-aborts to eliminate false positives.
/// Returns Some((similarity_percent, offset_seconds, verified_seconds)) if they match.
pub fn compare_acoustic_fingerprints(
    fp_a: &[u32],
    fp_b: &[u32],
    max_duration_secs: u32,
) -> Option<(u8, f32, f32)> {
    // Require at least 20 seconds (160 frames at 8 fps) of audio in both
    let min_window = 160usize;
    if fp_a.len() < min_window || fp_b.len() < min_window {
        return None;
    }

    // Slide offset from -200 to +200 frames (-25.0s to +25.0s at 8 frames/sec)
    let max_shift: isize = 200;
    let mut best_bit_errors: u32 = u32::MAX;
    let mut best_offset: isize = 0;
    let mut best_inner_skip = 0usize;

    // Stage 1: Coarse pass across initial 20-second window to find best alignment offset
    for shift in -max_shift..=max_shift {
        let (start_a, start_b) = if shift >= 0 {
            (0usize, shift as usize)
        } else {
            ((-shift) as usize, 0usize)
        };

        if start_a >= fp_a.len() || start_b >= fp_b.len() {
            continue;
        }

        let overlap = (fp_a.len() - start_a).min(fp_b.len() - start_b);
        if overlap < min_window {
            continue;
        }

        // Check a 20-second (160-frame) core window starting 4 seconds into the overlap
        // (skipping the very first few seconds in case of fade-in/jingle)
        let inner_skip = if overlap > min_window + 32 { 32 } else { 0 };
        let a_slice = &fp_a[start_a + inner_skip..start_a + inner_skip + min_window];
        let b_slice = &fp_b[start_b + inner_skip..start_b + inner_skip + min_window];
        let mut bit_errors = 0u32;
        let mut exceeded = false;
        // Require at least 82% bit agreement (< 921 errors out of 5120 bits)
        let threshold = best_bit_errors.min(921);
        for i in 0..min_window {
            bit_errors += (a_slice[i] ^ b_slice[i]).count_ones();
            if bit_errors >= threshold {
                exceeded = true;
                break;
            }
        }

        if !exceeded && bit_errors < best_bit_errors {
            best_bit_errors = bit_errors;
            best_offset = shift;
            best_inner_skip = inner_skip;
        }
    }

    if best_bit_errors == u32::MAX {
        return None;
    }

    let initial_bits = (min_window * 32) as f32;
    let initial_agreement = 1.0 - (best_bit_errors as f32 / initial_bits);

    if initial_agreement < 0.805 {
        return None;
    }

    // Stage 2: Progressive verification deeper into tracks at locked `best_offset`
    let (start_a, start_b) = if best_offset >= 0 {
        (0usize, best_offset as usize)
    } else {
        ((-best_offset) as usize, 0usize)
    };

    let available_overlap = (fp_a.len().saturating_sub(start_a))
        .min(fp_b.len().saturating_sub(start_b));

    let max_target_frames = ((max_duration_secs.max(20) as usize) * 8).min(available_overlap);

    let mut current_frame = best_inner_skip + min_window;
    let mut total_tested_frames = min_window;
    let mut total_bit_errors = best_bit_errors;
    let chunk_size = 80usize; // 10-second verification chunks (80 frames)

    while current_frame + chunk_size <= max_target_frames {
        let a_chunk = &fp_a[start_a + current_frame..start_a + current_frame + chunk_size];
        let b_chunk = &fp_b[start_b + current_frame..start_b + current_frame + chunk_size];
        let mut chunk_errors = 0u32;
        for i in 0..chunk_size {
            chunk_errors += (a_chunk[i] ^ b_chunk[i]).count_ones();
        }
        let chunk_bits = (chunk_size * 32) as f32;
        let chunk_agreement = 1.0 - (chunk_errors as f32 / chunk_bits);

        // If music diverged after intro, chunk agreement drops to ~50%.
        // Genuine duplicate audio maintains > 77% bit agreement.
        if chunk_agreement < 0.77 {
            return None; // Early-abort! False-positive intro match rejected.
        }

        total_tested_frames += chunk_size;
        total_bit_errors += chunk_errors;
        current_frame += chunk_size;
    }

    // Test any remaining tail frames (>= 24 frames = 3 seconds)
    if max_target_frames > current_frame + 24 {
        let rem_size = max_target_frames - current_frame;
        let a_rem = &fp_a[start_a + current_frame..start_a + current_frame + rem_size];
        let b_rem = &fp_b[start_b + current_frame..start_b + current_frame + rem_size];
        let mut rem_errors = 0u32;
        for i in 0..rem_size {
            rem_errors += (a_rem[i] ^ b_rem[i]).count_ones();
        }
        let rem_bits = (rem_size * 32) as f32;
        let rem_agreement = 1.0 - (rem_errors as f32 / rem_bits);
        if rem_agreement < 0.77 {
            return None;
        }
        total_tested_frames += rem_size;
        total_bit_errors += rem_errors;
    }

    let verified_secs = (total_tested_frames as f32) * 0.125;
    let total_bits = (total_tested_frames * 32) as f32;
    let overall_agreement = 1.0 - (total_bit_errors as f32 / total_bits);

    if overall_agreement < 0.80 {
        return None;
    }

    let confidence = ((overall_agreement - 0.5) * 170.0 + (verified_secs / 120.0) * 15.0).clamp(86.0, 99.0) as u8;
    let offset_secs = (best_offset as f32) * 0.125;
    Some((confidence, offset_secs, verified_secs))
}

/// Jaro-Winkler string similarity (0.0 to 1.0) for normalized song titles
fn jaro_winkler(s1: &str, s2: &str) -> f64 {
    if s1 == s2 {
        return 1.0;
    }
    let v1: Vec<char> = s1.chars().collect();
    let v2: Vec<char> = s2.chars().collect();
    let len1 = v1.len();
    let len2 = v2.len();
    if len1 == 0 || len2 == 0 {
        return 0.0;
    }

    let match_distance = (len1.max(len2) / 2).saturating_sub(1);
    let mut s1_matches = vec![false; len1];
    let mut s2_matches = vec![false; len2];

    let mut matches = 0usize;
    for i in 0..len1 {
        let start = i.saturating_sub(match_distance);
        let end = (i + match_distance + 1).min(len2);
        for j in start..end {
            if !s2_matches[j] && v1[i] == v2[j] {
                s1_matches[i] = true;
                s2_matches[j] = true;
                matches += 1;
                break;
            }
        }
    }

    if matches == 0 {
        return 0.0;
    }

    let mut transpositions = 0usize;
    let mut k = 0usize;
    for i in 0..len1 {
        if s1_matches[i] {
            while !s2_matches[k] {
                k += 1;
            }
            if v1[i] != v2[k] {
                transpositions += 1;
            }
            k += 1;
        }
    }

    let m = matches as f64;
    let jaro =
        ((m / len1 as f64) + (m / len2 as f64) + ((m - (transpositions as f64 / 2.0)) / m)) / 3.0;

    let prefix_len = v1
        .iter()
        .zip(v2.iter())
        .take(4)
        .take_while(|(a, b)| a == b)
        .count();

    jaro + (prefix_len as f64 * 0.1 * (1.0 - jaro))
}

fn open_cache_db() -> Option<Connection> {
    let db_path = get_global_db_path()?;
    Connection::open(db_path).ok()
}

/// Extract metadata, hashes, and (optionally) acoustic fingerprint for a single file,
/// utilizing SQLite cache with (file_path, mtime, size) and rename recovery via (size, quick_hash).
/// Purely compute hashes, metadata tags, YouTube ID, and (optionally) acoustic subfingerprints for a track.
/// Thread-safe and independent of SQLite.
pub fn compute_raw_fingerprint(
    path: &Path,
    mtime_secs: u64,
    size_bytes: u64,
    compute_acoustic: bool,
) -> TrackFingerprintRecord {
    let canonical_path = canonical_path_str(path);
    let (quick_hash, audio_hash) = compute_file_hashes(path, size_bytes);

    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let format_ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let (id_b, id_p, id_t, yt_url_re) = get_yt_regexes();
    let mut youtube_id = id_b
        .captures(&filename)
        .or_else(|| id_p.captures(&filename))
        .or_else(|| id_t.captures(&filename))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());

    let mut raw_title = stem.clone();
    let mut raw_artist = String::new();
    let mut duration_secs = 0u32;
    let mut bitrate_kbps = 0u32;

    if let Ok(tagged_file) = Probe::open(path).and_then(|p| p.read()) {
        let props = tagged_file.properties();
        duration_secs = props.duration().as_secs() as u32;
        bitrate_kbps = props.audio_bitrate().unwrap_or(0);

        if let Some(tag) = tagged_file.primary_tag() {
            if let Some(t) = tag.title() {
                if !t.trim().is_empty() {
                    raw_title = t.trim().to_string();
                }
            }
            if let Some(a) = tag.artist() {
                if !a.trim().is_empty() {
                    raw_artist = a.trim().to_string();
                }
            }
            if youtube_id.is_none() {
                if let Some(comment) = tag.comment() {
                    if let Some(caps) = yt_url_re.captures(&comment) {
                        youtube_id = caps.get(1).map(|m| m.as_str().to_string());
                    }
                }
            }
            if youtube_id.is_none() {
                for item in tag.items() {
                    if let Some(val) = item.value().text() {
                        if let Some(caps) = yt_url_re.captures(val) {
                            youtube_id = caps.get(1).map(|m| m.as_str().to_string());
                            break;
                        }
                    }
                }
            }
        }
    }

    if bitrate_kbps == 0 && duration_secs > 0 {
        bitrate_kbps = ((size_bytes * 8) / (duration_secs as u64 * 1000)) as u32;
    }

    let norm_title = normalize_song_text(&raw_title);
    let norm_artist = normalize_song_text(&raw_artist);
    let norm_stem = normalize_song_text(&stem);

    let chromaprint = if compute_acoustic {
        compute_acoustic_subfingerprints(path)
    } else {
        None
    };

    TrackFingerprintRecord {
        file_path: canonical_path,
        mtime_secs,
        size_bytes,
        quick_hash,
        audio_hash,
        youtube_id,
        raw_title,
        raw_artist,
        norm_title,
        norm_artist,
        norm_stem,
        duration_secs,
        format_ext,
        bitrate_kbps,
        chromaprint,
    }
}


/// Remove stale fingerprint entries whose files no longer exist on disk (or clear all if requested)
pub fn prune_stale_fingerprints_impl(conn: &Connection, clear_all: bool) -> (usize, usize) {
    if clear_all {
        let deleted = conn
            .execute("DELETE FROM track_fingerprints", [])
            .unwrap_or(0);
        return (deleted, 0);
    }

    let mut paths: Vec<String> = Vec::new();
    if let Ok(mut stmt) = conn.prepare("SELECT file_path FROM track_fingerprints") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for p in rows.flatten() {
                paths.push(p);
            }
        }
    }

    let total_before = paths.len();
    let mut pruned = 0usize;
    for p in paths {
        if !Path::new(&p).exists() {
            if conn
                .execute(
                    "DELETE FROM track_fingerprints WHERE file_path = ?1",
                    params![p],
                )
                .is_ok()
            {
                pruned += 1;
            }
        }
    }

    (pruned, total_before.saturating_sub(pruned))
}

#[derive(Debug, Clone)]
struct MatchEdge {
    tier: &'static str, // "exact_hash" | "youtube_id" | "acoustic" | "metadata"
    label: String,
    confidence: u8,
    offset_secs: Option<f32>,
}

fn get_track_modifier(raw_title: &str, raw_stem: &str) -> Option<&'static str> {
    let lower = format!("{} {}", raw_title, raw_stem).to_lowercase();
    let modifiers = [
        "remix", "acoustic", "live", "instrumental", "karaoke",
        "reprise", "cover", "club mix", "unplugged", "orchestral",
        "part 1", "part 2", "part 3", "part 4", "pt 1", "pt 2", "pt 3",
        "part i", "part ii", "part iii",
    ];
    for &m in &modifiers {
        if lower.contains(m) {
            return Some(m);
        }
    }
    None
}

/// Determine whether two distinct files represent the same underlying song across the 3 tiers
fn check_pair_duplicate(
    a: &TrackFingerprintRecord,
    b: &TrackFingerprintRecord,
    max_acoustic_secs: u32,
) -> Option<MatchEdge> {
    if a.file_path == b.file_path {
        return None;
    }

    // Tier 1A: Exact Audio Payload Hash (same audio bytes even if renamed or re-tagged)
    if a.size_bytes > 1024 && a.audio_hash == b.audio_hash {
        return Some(MatchEdge {
            tier: "exact_hash",
            label: "Exact Audio Stream Match".to_string(),
            confidence: 100,
            offset_secs: Some(0.0),
        });
    }

    // Tier 1B: Same YouTube Video ID
    if let (Some(id_a), Some(id_b)) = (&a.youtube_id, &b.youtube_id) {
        if !id_a.is_empty() && id_a == id_b {
            let diff = (a.duration_secs as f32) - (b.duration_secs as f32);
            return Some(MatchEdge {
                tier: "youtube_id",
                label: format!("Same YouTube ID ({})", id_a),
                confidence: 99,
                offset_secs: if diff.abs() >= 1.0 { Some(-diff) } else { None },
            });
        }
    }

    // Protect distinct musical modifiers (e.g. Live vs Studio, Remix vs Original, Part 1 vs Part 2)
    let mod_a = get_track_modifier(&a.raw_title, &a.norm_stem);
    let mod_b = get_track_modifier(&b.raw_title, &b.norm_stem);
    if mod_a != mod_b {
        return None;
    }

    // Protect generic titles from merging across different or empty artists
    let is_generic_a = matches!(
        a.norm_title.as_str(),
        "intro" | "outro" | "interlude" | "track 1" | "track 01" | "untitled" | "prelude"
    );
    let is_generic_b = matches!(
        b.norm_title.as_str(),
        "intro" | "outro" | "interlude" | "track 1" | "track 01" | "untitled" | "prelude"
    );
    if (is_generic_a || is_generic_b) && (a.norm_artist.is_empty() || b.norm_artist.is_empty() || a.norm_artist != b.norm_artist) {
        return None;
    }

    let dur_diff = (a.duration_secs as i64 - b.duration_secs as i64).unsigned_abs() as u32;

    // Tier 3: Sliding-Window Progressive Acoustic Match (catches 10-15s extra intro/outro ads + different URLs/formats)
    if dur_diff <= 26 {
        if let (Some(fp_a), Some(fp_b)) = (&a.chromaprint, &b.chromaprint) {
            if let Some((conf, offset, verified_secs)) =
                compare_acoustic_fingerprints(fp_a, fp_b, max_acoustic_secs)
            {
                let offset_str = if offset.abs() >= 1.5 {
                    format!(" ({:+.1}s offset)", offset)
                } else {
                    String::new()
                };
                let label = format!("Acoustic Match (verified {:.0}s{})", verified_secs, offset_str);
                return Some(MatchEdge {
                    tier: "acoustic",
                    label,
                    confidence: conf,
                    offset_secs: Some(offset),
                });
            }
        }
    }

    // Tier 2: Normalized Title + Artist / Filename Stem + Duration Window (within 20s for ads)
    if dur_diff <= 20 && a.duration_secs > 15 && b.duration_secs > 15 {
        let t_a = if a.norm_title.len() >= 3 {
            &a.norm_title
        } else {
            &a.norm_stem
        };
        let t_b = if b.norm_title.len() >= 3 {
            &b.norm_title
        } else {
            &b.norm_stem
        };

        if t_a.len() >= 4 && t_b.len() >= 4 {
            let artists_compatible = a.norm_artist.is_empty()
                || b.norm_artist.is_empty()
                || a.norm_artist == b.norm_artist
                || a.norm_artist.contains(&b.norm_artist)
                || b.norm_artist.contains(&a.norm_artist);

            // Exact normalized title match or exact normalized stem match
            if (t_a == t_b || (a.norm_stem.len() >= 5 && a.norm_stem == b.norm_stem))
                && artists_compatible
            {
                let diff = (b.duration_secs as f32) - (a.duration_secs as f32);
                let label = if dur_diff >= 4 {
                    format!("Title & Artist Match ({:+.0}s duration diff)", diff)
                } else {
                    "Canonical Title & Artist Match".to_string()
                };
                return Some(MatchEdge {
                    tier: "metadata",
                    label,
                    confidence: 94,
                    offset_secs: if diff.abs() >= 2.0 { Some(diff) } else { None },
                });
            }

            // High fuzzy similarity (Jaro-Winkler >= 0.93) when both have matching non-empty artist
            if !a.norm_artist.is_empty()
                && a.norm_artist == b.norm_artist
                && dur_diff <= 16
                && jaro_winkler(t_a, t_b) >= 0.93
            {
                let diff = (b.duration_secs as f32) - (a.duration_secs as f32);
                return Some(MatchEdge {
                    tier: "metadata",
                    label: "Fuzzy Title + Same Artist Match".to_string(),
                    confidence: 90,
                    offset_secs: if diff.abs() >= 2.0 { Some(diff) } else { None },
                });
            }
        }
    }

    None
}

/// Rank two tracks within a duplicate cluster to determine which one is the Superior Winner.
/// Order of precedence:
/// 1. Lower `playlist_index` (Rule 1 for cross-playlist resolution; equal within a single playlist)
/// 2. Lower `source_index` (First in `sources` list is highest priority)
/// 3. Clean duration (if one track has 5-25s extra ad compared to the cleanest track in the cluster)
/// 4. Format quality (`flac` > `wav`/`alac` > `m4a`/`aac`/`opus` > `mp3` > `ogg` > `wma`)
/// 5. Higher bitrate (`bitrate_kbps`)
fn compare_candidates_priority(
    cand_a: &CandidateTrack,
    rec_a: &TrackFingerprintRecord,
    cand_b: &CandidateTrack,
    rec_b: &TrackFingerprintRecord,
    min_cluster_duration: u32,
) -> std::cmp::Ordering {
    // 1. Playlist priority (Rule 1)
    match cand_a.playlist_index.cmp(&cand_b.playlist_index) {
        std::cmp::Ordering::Equal => {}
        ord => return ord,
    }

    // 2. Source priority (0 = first in SOURCES)
    match cand_a.source_index.cmp(&cand_b.source_index) {
        std::cmp::Ordering::Equal => {}
        ord => return ord,
    }

    // 3. Same source tie-breaker: Clean duration (penalize track if it has >= 5s extra intro/outro ad)
    let a_has_extra_ad =
        min_cluster_duration > 30 && rec_a.duration_secs >= min_cluster_duration + 5;
    let b_has_extra_ad =
        min_cluster_duration > 30 && rec_b.duration_secs >= min_cluster_duration + 5;
    match a_has_extra_ad.cmp(&b_has_extra_ad) {
        std::cmp::Ordering::Equal => {}
        ord => return ord,
    }

    // 4. Format quality rank (higher is better, so reverse cmp)
    let rank_a = format_quality_rank(&rec_a.format_ext);
    let rank_b = format_quality_rank(&rec_b.format_ext);
    match rank_b.cmp(&rank_a) {
        std::cmp::Ordering::Equal => {}
        ord => return ord,
    }

    // 5. Higher bitrate (higher is better)
    match rec_b.bitrate_kbps.cmp(&rec_a.bitrate_kbps) {
        std::cmp::Ordering::Equal => {}
        ord => return ord,
    }

    // 6. Deterministic path tie-breaker
    cand_a.canonical_path.cmp(&cand_b.canonical_path)
}

/// Core clustering engine: takes candidate tracks, loads/computes fingerprints, groups duplicates,
/// and picks the winner per group.
pub fn analyze_candidates(
    candidates: &[CandidateTrack],
    base_dir: &Path,
    compute_acoustic: bool,
    max_acoustic_secs: u32,
    auto_prune: bool,
    app: Option<&AppHandle>,
    task_id: Option<&str>,
) -> (
    Vec<PathBuf>,              // Winning deduplicated files
    HashMap<String, PathBuf>,  // Map: canonical_path of any track -> winning PathBuf (for superior replacement!)
    DuplicateAnalysisReport,
) {
    let mut conn_opt = open_cache_db();
    let (pruned_count, remaining_cache) = if let Some(ref conn) = conn_opt {
        if auto_prune {
            prune_stale_fingerprints_impl(conn, false)
        } else {
            let count: usize = conn
                .query_row("SELECT COUNT(*) FROM track_fingerprints", [], |r| r.get(0))
                .unwrap_or(0);
            (0, count)
        }
    } else {
        (0, 0)
    };

    // Deduplicate identical file paths while keeping highest priority (lowest playlist_index, lowest source_index)
    // and collecting all playlist names that reference each file
    let mut unique_candidates: Vec<CandidateTrack> = Vec::new();
    let mut path_to_idx: HashMap<String, usize> = HashMap::new();
    let mut path_playlists: HashMap<String, Vec<String>> = HashMap::new();

    for c in candidates {
        let pls = path_playlists.entry(c.canonical_path.clone()).or_default();
        if !c.playlist_name.is_empty() && !pls.contains(&c.playlist_name) {
            pls.push(c.playlist_name.clone());
        }

        if let Some(&existing_idx) = path_to_idx.get(&c.canonical_path) {
            let existing = &mut unique_candidates[existing_idx];
            if (c.playlist_index, c.source_index) < (existing.playlist_index, existing.source_index)
            {
                existing.playlist_index = c.playlist_index;
                existing.playlist_name = c.playlist_name.clone();
                existing.source_index = c.source_index;
                existing.source_folder = c.source_folder.clone();
            }
        } else {
            let idx = unique_candidates.len();
            path_to_idx.insert(c.canonical_path.clone(), idx);
            unique_candidates.push(c.clone());
        }
    }

    let n = unique_candidates.len();
    if n == 0 {
        if let Some(app) = app {
            let _ = app.emit(
                "duplicate-analysis-progress",
                DuplicateProgressPayload {
                    phase: "done".to_string(),
                    phase_label: "No tracks to analyze".to_string(),
                    stage: 3,
                    stage_name: "done".to_string(),
                    stage_label: "No tracks to analyze".to_string(),
                    current: 0,
                    total: 0,
                    progress: 100.0,
                    current_file: None,
                    eta_secs: Some(0.0),
                    speed: 0.0,
                },
            );
        }
    }

    let start_time = std::time::Instant::now();
    let mut last_emit = std::time::Instant::now();

    let mut records: Vec<Option<TrackFingerprintRecord>> = vec![None; n];
    let mut to_compute: Vec<(usize, CandidateTrack, u64, u64)> = Vec::new();

    // 1. Fast SQLite cache check on main thread
    for (idx, c) in unique_candidates.iter().enumerate() {
        let (mtime_secs, size_bytes) = get_file_mtime_and_size(&c.path).unwrap_or((0, 0));
        let mut hit = false;
        if let Some(ref conn) = conn_opt {
            if let Ok(mut stmt) = conn.prepare_cached(
                "SELECT mtime_secs, size_bytes, quick_hash, audio_hash, youtube_id,
                        raw_title, raw_artist, norm_title, norm_artist, norm_stem,
                        duration_secs, format_ext, bitrate_kbps, chromaprint
                 FROM track_fingerprints WHERE file_path = ?1",
            ) {
                if let Ok(rec) = stmt.query_row(params![&c.canonical_path], |row| {
                    let db_mtime: i64 = row.get(0)?;
                    let db_size: i64 = row.get(1)?;
                    let blob_opt: Option<Vec<u8>> = row.get(13)?;
                    Ok((
                        db_mtime as u64,
                        db_size as u64,
                        TrackFingerprintRecord {
                            file_path: c.canonical_path.clone(),
                            mtime_secs: db_mtime as u64,
                            size_bytes: db_size as u64,
                            quick_hash: row.get(2)?,
                            audio_hash: row.get(3)?,
                            youtube_id: row.get(4)?,
                            raw_title: row.get(5)?,
                            raw_artist: row.get(6)?,
                            norm_title: row.get(7)?,
                            norm_artist: row.get(8)?,
                            norm_stem: row.get(9)?,
                            duration_secs: row.get::<_, i64>(10)? as u32,
                            format_ext: row.get(11)?,
                            bitrate_kbps: row.get::<_, i64>(12)? as u32,
                            chromaprint: blob_opt.map(|b| decode_u32_blob(&b)),
                        },
                    ))
                }) {
                    let (db_mtime, db_size, cached) = rec;
                    if db_mtime == mtime_secs && db_size == size_bytes {
                        records[idx] = Some(cached);
                        hit = true;
                    }
                }
            }
        }
        if !hit {
            to_compute.push((idx, c.clone(), mtime_secs, size_bytes));
        }
    }

    let initial_cached = n - to_compute.len();

    // Stage 1: Parallel extraction of metadata & stream hashes (100x faster, zero ffmpeg calls)
    if !to_compute.is_empty() {
        let num_workers = std::thread::available_parallelism()
            .map(|p| p.get())
            .unwrap_or(4)
            .clamp(2, 8)
            .min(to_compute.len());

        let work_idx = std::sync::atomic::AtomicUsize::new(0);
        let (tx, rx) = std::sync::mpsc::channel();

        if let Some(app) = app {
            let first_fname = to_compute[0].1.path
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_else(|| to_compute[0].1.canonical_path.clone());
            let pct = if n > 0 {
                ((initial_cached as f64) / (n as f64) * 33.0).clamp(0.0, 33.0)
            } else {
                33.0
            };
            let _ = app.emit(
                "duplicate-analysis-progress",
                DuplicateProgressPayload {
                    phase: "fingerprinting".to_string(),
                    phase_label: format!("Stage 1/3: Reading tags & audio stream hashes ({} parallel workers)...", num_workers),
                    stage: 1,
                    stage_name: "metadata".to_string(),
                    stage_label: "Stage 1/3: Reading tags & audio stream hashes".to_string(),
                    current: initial_cached,
                    total: n,
                    progress: pct,
                    current_file: Some(first_fname),
                    eta_secs: None,
                    speed: 0.0,
                },
            );
        }

        let mut computed_items: Vec<(usize, TrackFingerprintRecord)> =
            Vec::with_capacity(to_compute.len());

        std::thread::scope(|s| {
            for _ in 0..num_workers {
                let tx = tx.clone();
                let work_idx = &work_idx;
                let to_compute_ref = &to_compute;
                s.spawn(move || {
                    loop {
                        if let Some(tid) = task_id {
                            if crate::sanitizer::is_task_cancelled(tid) {
                                break;
                            }
                        }
                        let i = work_idx.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        if i >= to_compute_ref.len() {
                            break;
                        }
                        let (orig_idx, ref cand, mtime, size) = to_compute_ref[i];
                        // Fast pass: compute_acoustic = false (extracts tags and stream hash only)
                        let rec = compute_raw_fingerprint(&cand.path, mtime, size, false);
                        let _ = tx.send((orig_idx, rec));
                    }
                });
            }
            drop(tx);

            let total_to_compute = to_compute.len();
            let mut completed_computed = 0usize;

            while completed_computed < total_to_compute {
                if let Some(tid) = task_id {
                    if crate::sanitizer::is_task_cancelled(tid) {
                        break;
                    }
                }
                match rx.recv_timeout(std::time::Duration::from_millis(200)) {
                    Ok((orig_idx, rec)) => {
                        let fname = Path::new(&rec.file_path)
                            .file_name()
                            .map(|f| f.to_string_lossy().to_string());
                        computed_items.push((orig_idx, rec));
                        completed_computed += 1;

                        if let Some(app) = app {
                            let total_done = initial_cached + completed_computed;
                            let elapsed = start_time.elapsed().as_secs_f64();
                            let should_emit = completed_computed == total_to_compute
                                || last_emit.elapsed() >= std::time::Duration::from_secs(1);
                            if should_emit {
                                let speed = if elapsed > 0.05 && completed_computed > 0 {
                                    (completed_computed as f64) / elapsed
                                } else {
                                    0.0
                                };
                                let remaining = (total_to_compute - completed_computed) as f64;
                                let eta_secs = if speed > 0.1 {
                                    Some(remaining / speed)
                                } else {
                                    None
                                };
                                let pct = if n > 0 {
                                    ((total_done as f64) / (n as f64) * 33.0).clamp(0.0, 33.0)
                                } else {
                                    33.0
                                };

                                let _ = app.emit(
                                    "duplicate-analysis-progress",
                                    DuplicateProgressPayload {
                                        phase: "fingerprinting".to_string(),
                                        phase_label: format!(
                                            "Stage 1/3: Reading tags & audio stream hashes ({} parallel workers)...",
                                            num_workers
                                        ),
                                        stage: 1,
                                        stage_name: "metadata".to_string(),
                                        stage_label: "Stage 1/3: Reading tags & audio stream hashes".to_string(),
                                        current: total_done,
                                        total: n,
                                        progress: pct,
                                        current_file: fname,
                                        eta_secs,
                                        speed,
                                    },
                                );
                                last_emit = std::time::Instant::now();
                            }
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        if let Some(app) = app {
                            if last_emit.elapsed() >= std::time::Duration::from_secs(1) {
                                let total_done = initial_cached + completed_computed;
                                let elapsed = start_time.elapsed().as_secs_f64();
                                let speed = if elapsed > 0.05 && completed_computed > 0 {
                                    (completed_computed as f64) / elapsed
                                } else {
                                    0.0
                                };
                                let remaining = (total_to_compute - completed_computed) as f64;
                                let eta_secs = if speed > 0.1 {
                                    Some(remaining / speed)
                                } else {
                                    None
                                };
                                let pct = if n > 0 {
                                    ((total_done as f64) / (n as f64) * 33.0).clamp(0.0, 33.0)
                                } else {
                                    33.0
                                };
                                let _ = app.emit(
                                    "duplicate-analysis-progress",
                                    DuplicateProgressPayload {
                                        phase: "fingerprinting".to_string(),
                                        phase_label: format!(
                                            "Stage 1/3: Reading tags & audio stream hashes ({} parallel workers)...",
                                            num_workers
                                        ),
                                        stage: 1,
                                        stage_name: "metadata".to_string(),
                                        stage_label: "Stage 1/3: Reading tags & audio stream hashes".to_string(),
                                        current: total_done,
                                        total: n,
                                        progress: pct,
                                        current_file: None,
                                        eta_secs,
                                        speed,
                                    },
                                );
                                last_emit = std::time::Instant::now();
                            }
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        for (orig_idx, rec) in computed_items {
            records[orig_idx] = Some(rec);
        }

        // Batch persist newly computed fingerprints into SQLite in a single transaction
        if let Some(ref mut conn) = conn_opt {
            if let Ok(tx) = conn.transaction() {
                {
                    if let Ok(mut stmt) = tx.prepare_cached(
                        "INSERT OR REPLACE INTO track_fingerprints (
                            file_path, mtime_secs, size_bytes, quick_hash, audio_hash, youtube_id,
                            raw_title, raw_artist, norm_title, norm_artist, norm_stem,
                            duration_secs, format_ext, bitrate_kbps, chromaprint, updated_at
                        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                    ) {
                        let now_ts = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .map(|d| d.as_secs() as i64)
                            .unwrap_or(0);
                        for (orig_idx, ..) in &to_compute {
                            if let Some(rec) = records.get(*orig_idx).and_then(|r| r.as_ref()) {
                                let blob_opt = rec.chromaprint.as_ref().map(|fp| encode_u32_blob(fp));
                                let _ = stmt.execute(params![
                                    &rec.file_path,
                                    rec.mtime_secs as i64,
                                    rec.size_bytes as i64,
                                    &rec.quick_hash,
                                    &rec.audio_hash,
                                    &rec.youtube_id,
                                    &rec.raw_title,
                                    &rec.raw_artist,
                                    &rec.norm_title,
                                    &rec.norm_artist,
                                    &rec.norm_stem,
                                    rec.duration_secs as i64,
                                    &rec.format_ext,
                                    rec.bitrate_kbps as i64,
                                    blob_opt,
                                    now_ts,
                                ]);
                            }
                        }
                    }
                }
                let _ = tx.commit();
            }
        }
    }

    let mut records: Vec<TrackFingerprintRecord> = records.into_iter().flatten().collect();

    // Union-Find for duplicate clustering
    let mut parent: Vec<usize> = (0..n).collect();
    let mut edge_info: HashMap<(usize, usize), MatchEdge> = HashMap::new();

    fn find(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }

    // Step 1: Instant O(N) indexing for Tier 1A (exact audio stream hash) and Tier 1B (YouTube ID)
    let mut hash_groups: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut yt_groups: HashMap<&str, Vec<usize>> = HashMap::new();

    for (idx, rec) in records.iter().enumerate() {
        if rec.size_bytes > 1024 && !rec.audio_hash.is_empty() {
            hash_groups.entry(&rec.audio_hash).or_default().push(idx);
        }
        if let Some(ref ytid) = rec.youtube_id {
            if !ytid.is_empty() {
                yt_groups.entry(ytid.as_str()).or_default().push(idx);
            }
        }
    }

    for group in hash_groups.values() {
        for a_idx in 0..group.len() {
            for b_idx in (a_idx + 1)..group.len() {
                let i = group[a_idx];
                let j = group[b_idx];
                let root_i = find(&mut parent, i);
                let root_j = find(&mut parent, j);
                if root_i != root_j {
                    parent[root_j] = root_i;
                }
                let pair = if i < j { (i, j) } else { (j, i) };
                edge_info.entry(pair).or_insert_with(|| MatchEdge {
                    tier: "exact_hash",
                    label: "Exact Audio Stream Match".to_string(),
                    confidence: 100,
                    offset_secs: Some(0.0),
                });
            }
        }
    }

    for (ytid, group) in yt_groups {
        for a_idx in 0..group.len() {
            for b_idx in (a_idx + 1)..group.len() {
                let i = group[a_idx];
                let j = group[b_idx];
                let root_i = find(&mut parent, i);
                let root_j = find(&mut parent, j);
                if root_i != root_j {
                    parent[root_j] = root_i;
                }
                let pair = if i < j { (i, j) } else { (j, i) };
                let diff = (records[i].duration_secs as f32) - (records[j].duration_secs as f32);
                edge_info.entry(pair).or_insert_with(|| MatchEdge {
                    tier: "youtube_id",
                    label: format!("Same YouTube ID ({})", ytid),
                    confidence: 99,
                    offset_secs: if diff.abs() >= 1.0 { Some(-diff) } else { None },
                });
            }
        }
    }

    // Stage 2: Targeted Acoustic Analysis (ONLY computed on unresolved candidate pairs)
    if compute_acoustic {
        let mut already_matched: HashSet<usize> = HashSet::new();
        for i in 0..n {
            let root = find(&mut parent, i);
            if root != i {
                already_matched.insert(i);
                already_matched.insert(root);
            }
        }

        let mut needed_flags = vec![false; n];
        let mut sorted_by_dur: Vec<usize> = (0..n).collect();
        sorted_by_dur.sort_by_key(|&idx| records[idx].duration_secs);

        for (pos, &i) in sorted_by_dur.iter().enumerate() {
            if already_matched.contains(&i) {
                continue;
            }
            let dur_i = records[i].duration_secs;
            for &j in &sorted_by_dur[(pos + 1)..] {
                if already_matched.contains(&j) {
                    continue;
                }
                let dur_j = records[j].duration_secs;
                if dur_j > dur_i + 22 {
                    break;
                }
                let mod_a = get_track_modifier(&records[i].raw_title, &records[i].norm_stem);
                let mod_b = get_track_modifier(&records[j].raw_title, &records[j].norm_stem);
                if mod_a != mod_b {
                    continue;
                }

                let artist_same = !records[i].norm_artist.is_empty()
                    && records[i].norm_artist == records[j].norm_artist;
                let artists_compat = artist_same
                    || records[i].norm_artist.is_empty()
                    || records[j].norm_artist.is_empty()
                    || records[i].norm_artist.contains(&records[j].norm_artist)
                    || records[j].norm_artist.contains(&records[i].norm_artist);

                let stem_exact = !records[i].norm_stem.is_empty() && records[i].norm_stem == records[j].norm_stem;
                let title_exact = !records[i].norm_title.is_empty() && records[i].norm_title == records[j].norm_title;

                let should_check_acoustic = if stem_exact || title_exact {
                    artists_compat
                } else if artist_same {
                    let t_i = &records[i].norm_title;
                    let t_j = &records[j].norm_title;
                    (t_i.len() >= 4 && t_j.len() >= 4 && (t_i.contains(t_j) || t_j.contains(t_i)))
                        || jaro_winkler(t_i, t_j) >= 0.80
                } else if artists_compat {
                    let t_i = &records[i].norm_title;
                    let t_j = &records[j].norm_title;
                    jaro_winkler(t_i, t_j) >= 0.88
                } else {
                    false
                };

                if should_check_acoustic {
                    needed_flags[i] = true;
                    needed_flags[j] = true;
                }
            }
        }

        let needed_indices: Vec<usize> = (0..n)
            .filter(|&i| needed_flags[i] && records[i].chromaprint.is_none())
            .collect();
        let total_acoustic = needed_indices.len();

        if total_acoustic > 0 {
            let acoustic_start = std::time::Instant::now();
            let mut last_acoustic_emit = std::time::Instant::now();

            let num_workers = std::thread::available_parallelism()
                .map(|p| p.get())
                .unwrap_or(4)
                .clamp(2, 8)
                .min(total_acoustic);
            let work_idx = std::sync::atomic::AtomicUsize::new(0);
            let (tx, rx) = std::sync::mpsc::channel();

            // Emit immediate start notice
            if let Some(app) = app {
                let _ = app.emit(
                    "duplicate-analysis-progress",
                    DuplicateProgressPayload {
                        phase: "acoustic".to_string(),
                        phase_label: format!("Stage 2/3: Verifying {} candidate tracks with parallel acoustic waveforms...", total_acoustic),
                        stage: 2,
                        stage_name: "acoustic".to_string(),
                        stage_label: "Stage 2/3: Acoustic waveform verification".to_string(),
                        current: 0,
                        total: total_acoustic,
                        progress: 33.0,
                        current_file: None,
                        eta_secs: None,
                        speed: 0.0,
                    },
                );
            }

            let mut computed_fps = Vec::with_capacity(total_acoustic);

            std::thread::scope(|s| {
                for _ in 0..num_workers {
                    let tx = tx.clone();
                    let work_idx = &work_idx;
                    let needed_ref = &needed_indices;
                    let unique_cand_ref = &unique_candidates;
                    s.spawn(move || {
                        loop {
                            if let Some(tid) = task_id {
                                if crate::sanitizer::is_task_cancelled(tid) {
                                    break;
                                }
                            }
                            let i = work_idx.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            if i >= needed_ref.len() {
                                break;
                            }
                            let orig_idx = needed_ref[i];
                            let fp = compute_acoustic_subfingerprints(&unique_cand_ref[orig_idx].path);
                            let _ = tx.send((orig_idx, fp));
                        }
                    });
                }
                drop(tx);

                let mut completed = 0usize;

                while completed < total_acoustic {
                    if let Some(tid) = task_id {
                        if crate::sanitizer::is_task_cancelled(tid) {
                            break;
                        }
                    }
                    match rx.recv_timeout(std::time::Duration::from_millis(200)) {
                        Ok((orig_idx, fp_opt)) => {
                            computed_fps.push((orig_idx, fp_opt));
                            completed += 1;

                            if let Some(app) = app {
                                let elapsed = acoustic_start.elapsed().as_secs_f64();
                                let should_emit = completed == total_acoustic
                                    || last_acoustic_emit.elapsed() >= std::time::Duration::from_millis(400);
                                if should_emit {
                                    let speed = if elapsed > 0.05 && completed > 0 {
                                        (completed as f64) / elapsed
                                    } else {
                                        0.0
                                    };
                                    let remaining = (total_acoustic - completed) as f64;
                                    let eta = if speed > 0.1 { Some(remaining / speed) } else { None };
                                    let pct = 33.0 + ((completed as f64) / (total_acoustic as f64) * 33.0);
                                    let fname = Path::new(&unique_candidates[orig_idx].canonical_path)
                                        .file_name()
                                        .map(|f| f.to_string_lossy().to_string());
                                    let _ = app.emit(
                                        "duplicate-analysis-progress",
                                        DuplicateProgressPayload {
                                            phase: "acoustic".to_string(),
                                            phase_label: format!("Stage 2/3: Acoustic decoding ({}/{})...", completed, total_acoustic),
                                            stage: 2,
                                            stage_name: "acoustic".to_string(),
                                            stage_label: "Stage 2/3: Acoustic waveform verification".to_string(),
                                            current: completed,
                                            total: total_acoustic,
                                            progress: pct.clamp(33.0, 66.0),
                                            current_file: fname,
                                            eta_secs: eta,
                                            speed,
                                        },
                                    );
                                    last_acoustic_emit = std::time::Instant::now();
                                }
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            });

            // Persist newly computed fingerprints to SQLite in batch
            if let Some(ref mut conn) = conn_opt {
                if let Ok(tx) = conn.transaction() {
                    {
                        if let Ok(mut stmt) = tx.prepare_cached(
                            "UPDATE track_fingerprints SET chromaprint = ?1 WHERE file_path = ?2",
                        ) {
                            for &(orig_idx, ref fp_opt) in &computed_fps {
                                if let Some(ref fp) = fp_opt {
                                    let blob = encode_u32_blob(fp);
                                    let _ = stmt.execute(params![blob, &records[orig_idx].file_path]);
                                }
                            }
                        }
                    }
                    let _ = tx.commit();
                }
            }

            for (orig_idx, fp_opt) in computed_fps {
                if let Some(fp) = fp_opt {
                    records[orig_idx].chromaprint = Some(fp);
                }
            }
        } else if let Some(app) = app {
            let _ = app.emit(
                "duplicate-analysis-progress",
                DuplicateProgressPayload {
                    phase: "acoustic".to_string(),
                    phase_label: "Stage 2/3: All candidates verified via stream hashes & metadata (acoustic decode skipped)".to_string(),
                    stage: 2,
                    stage_name: "acoustic".to_string(),
                    stage_label: "Stage 2/3: Acoustic decode skipped (all resolved via metadata)".to_string(),
                    current: 0,
                    total: 0,
                    progress: 66.0,
                    current_file: None,
                    eta_secs: Some(0.0),
                    speed: 0.0,
                },
            );
        }
    } else if let Some(app) = app {
        let _ = app.emit(
            "duplicate-analysis-progress",
            DuplicateProgressPayload {
                phase: "acoustic".to_string(),
                phase_label: "Stage 2/3: Acoustic decoding disabled".to_string(),
                stage: 2,
                stage_name: "acoustic".to_string(),
                stage_label: "Stage 2/3: Acoustic decoding disabled".to_string(),
                current: 0,
                total: 0,
                progress: 66.0,
                current_file: None,
                eta_secs: Some(0.0),
                speed: 0.0,
            },
        );
    }

    // Stage 3: Duration-windowed candidate comparison for Tier 2 (Metadata) & Tier 3 (Acoustic)
    let mut sorted_indices: Vec<usize> = (0..n).collect();
    sorted_indices.sort_by_key(|&idx| records[idx].duration_secs);

    let cluster_start = std::time::Instant::now();
    for (step, &i) in sorted_indices.iter().enumerate() {
        if let Some(tid) = task_id {
            if crate::sanitizer::is_task_cancelled(tid) {
                break;
            }
        }

        let dur_i = records[i].duration_secs;
        for &j in &sorted_indices[(step + 1)..] {
            let dur_j = records[j].duration_secs;
            if dur_j > dur_i + 26 {
                break;
            }

            let root_i = find(&mut parent, i);
            let root_j = find(&mut parent, j);
            if root_i == root_j {
                continue;
            }

            // Anti-transitive chaining check: ensure j is compatible with the cluster representative
            let rep_i = root_i;
            if rep_i != i {
                if check_pair_duplicate(&records[rep_i], &records[j], max_acoustic_secs).is_none() {
                    continue;
                }
            }

            if let Some(edge) = check_pair_duplicate(&records[i], &records[j], max_acoustic_secs) {
                let root_i = find(&mut parent, i);
                let root_j = find(&mut parent, j);
                if root_i != root_j {
                    parent[root_j] = root_i;
                }
                let pair = if i < j { (i, j) } else { (j, i) };
                edge_info.insert(pair, edge);
            }
        }

        if let Some(app) = app {
            if (step % 25 == 0 || step + 1 == n)
                && last_emit.elapsed() >= std::time::Duration::from_millis(500)
            {
                let elapsed = cluster_start.elapsed().as_secs_f64();
                let speed = if elapsed > 0.05 && step > 0 {
                    (step + 1) as f64 / elapsed
                } else {
                    0.0
                };
                let remaining = (n.saturating_sub(step + 1)) as f64;
                let eta_secs = if speed > 0.1 {
                    Some(remaining / speed)
                } else {
                    None
                };
                let pct = 66.0 + ((step as f64) / (n as f64) * 33.0);
                let _ = app.emit(
                    "duplicate-analysis-progress",
                    DuplicateProgressPayload {
                        phase: "clustering".to_string(),
                        phase_label: "Stage 3/3: Comparing candidates & clustering duplicate groups...".to_string(),
                        stage: 3,
                        stage_name: "clustering".to_string(),
                        stage_label: "Stage 3/3: Comparing candidates & clustering duplicate groups".to_string(),
                        current: step + 1,
                        total: n,
                        progress: pct.clamp(66.0, 99.0),
                        current_file: None,
                        eta_secs,
                        speed,
                    },
                );
                last_emit = std::time::Instant::now();
            }
        }
    }

    let mut clusters: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        let root = find(&mut parent, i);
        clusters.entry(root).or_default().push(i);
    }

    let canonical_base =
        std::fs::canonicalize(base_dir).unwrap_or_else(|_| base_dir.to_path_buf());

    let mut winning_files: Vec<PathBuf> = Vec::new();
    let mut replacement_map: HashMap<String, PathBuf> = HashMap::new();
    let mut duplicate_groups: Vec<DuplicateGroup> = Vec::new();
    let mut redundant_files_count = 0usize;
    let mut redundant_bytes = 0u64;

    // Sort clusters deterministically
    let mut cluster_list: Vec<Vec<usize>> = clusters.into_values().collect();
    cluster_list.sort_by_key(|c| c[0]);

    for mut members in cluster_list {
        if members.len() == 1 {
            let idx = members[0];
            let win_path = unique_candidates[idx].path.clone();
            winning_files.push(win_path.clone());
            replacement_map.insert(unique_candidates[idx].canonical_path.clone(), win_path);
            continue;
        }

        let min_dur = members
            .iter()
            .map(|&idx| records[idx].duration_secs)
            .filter(|&d| d > 0)
            .min()
            .unwrap_or(0);

        // Sort members so index 0 is the Superior Winner
        members.sort_by(|&a, &b| {
            compare_candidates_priority(
                &unique_candidates[a],
                &records[a],
                &unique_candidates[b],
                &records[b],
                min_dur,
            )
        });

        let winner_idx = members[0];
        let winner_cand = &unique_candidates[winner_idx];
        let winner_rec = &records[winner_idx];
        let winner_path = winner_cand.path.clone();

        winning_files.push(winner_path.clone());
        for &m_idx in &members {
            replacement_map.insert(
                unique_candidates[m_idx].canonical_path.clone(),
                winner_path.clone(),
            );
        }

        // Determine group match badge from best edge connected to winner
        let mut group_tier = "metadata";
        let mut group_label = "Canonical Title & Artist Match".to_string();
        let mut group_conf = 90u8;

        for &other_idx in &members[1..] {
            let pair = if winner_idx < other_idx {
                (winner_idx, other_idx)
            } else {
                (other_idx, winner_idx)
            };
            if let Some(edge) = edge_info.get(&pair) {
                if edge.confidence >= group_conf || group_tier == "metadata" {
                    group_tier = edge.tier;
                    group_label = edge.label.clone();
                    group_conf = edge.confidence;
                }
            }
        }

        let mut group_tracks: Vec<DuplicateTrackEntry> = Vec::with_capacity(members.len());
        for (pos, &m_idx) in members.iter().enumerate() {
            let cand = &unique_candidates[m_idx];
            let rec = &records[m_idx];
            let is_winner = pos == 0;

            if !is_winner {
                redundant_files_count += 1;
                redundant_bytes += rec.size_bytes;
            }

            let rel_path = pathdiff::diff_paths(&cand.path, &canonical_base)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|| cand.canonical_path.clone());

            let offset_secs = if is_winner {
                None
            } else {
                let pair = if winner_idx < m_idx {
                    (winner_idx, m_idx)
                } else {
                    (m_idx, winner_idx)
                };
                let edge_offset = edge_info.get(&pair).and_then(|e| e.offset_secs);
                let diff = (rec.duration_secs as f32) - (winner_rec.duration_secs as f32);
                if diff.abs() >= 1.0 {
                    Some(diff)
                } else {
                    edge_offset.filter(|o| o.abs() >= 1.0)
                }
            };

            let winner_reason = if is_winner {
                let second_cand = &unique_candidates[members[1]];
                let second_rec = &records[members[1]];
                if cand.playlist_index < second_cand.playlist_index {
                    format!(
                        "Higher Playlist Priority ({})",
                        cand.playlist_name
                    )
                } else if cand.source_index < second_cand.source_index {
                    format!("Source #{} Priority", cand.source_index + 1)
                } else if min_dur > 30
                    && rec.duration_secs < second_rec.duration_secs.saturating_sub(4)
                {
                    "Clean Duration (No Ad/Intro)".to_string()
                } else if format_quality_rank(&rec.format_ext)
                    > format_quality_rank(&second_rec.format_ext)
                {
                    format!(
                        "Superior Format ({} > {})",
                        rec.format_ext.to_uppercase(),
                        second_rec.format_ext.to_uppercase()
                    )
                } else if rec.bitrate_kbps > second_rec.bitrate_kbps {
                    format!("Higher Bitrate ({} kbps)", rec.bitrate_kbps)
                } else {
                    format!("Source #{} Priority", cand.source_index + 1)
                }
            } else {
                format!("Source #{}", cand.source_index + 1)
            };

            group_tracks.push(DuplicateTrackEntry {
                file_path: cand.canonical_path.clone(),
                relative_path: rel_path,
                source_folder: cand.source_folder.clone(),
                source_index: cand.source_index,
                playlist_names: path_playlists
                    .get(&cand.canonical_path)
                    .cloned()
                    .unwrap_or_default(),
                title: rec.raw_title.clone(),
                artist: rec.raw_artist.clone(),
                duration: rec.duration_secs,
                size_bytes: rec.size_bytes,
                format_ext: rec.format_ext.to_uppercase(),
                bitrate_kbps: rec.bitrate_kbps,
                youtube_id: rec.youtube_id.clone(),
                is_winner,
                offset_secs,
                winner_reason,
            });
        }

        duplicate_groups.push(DuplicateGroup {
            group_id: format!("dup_{}", duplicate_groups.len() + 1),
            canonical_title: winner_rec.raw_title.clone(),
            canonical_artist: winner_rec.raw_artist.clone(),
            match_tier: group_tier.to_string(),
            match_label: group_label,
            confidence: group_conf,
            tracks: group_tracks,
        });
    }

    winning_files.sort();

    let total_cache = if let Some(ref conn) = conn_opt {
        conn.query_row("SELECT COUNT(*) FROM track_fingerprints", [], |r| r.get(0))
            .unwrap_or(remaining_cache)
    } else {
        remaining_cache
    };

    let report = DuplicateAnalysisReport {
        scope_name: String::new(),
        total_scanned_files: n,
        duplicate_groups,
        redundant_files_count,
        redundant_bytes,
        cache_total_entries: total_cache,
        cache_stale_pruned: pruned_count,
    };

    if let Some(app) = app {
        let _ = app.emit(
            "duplicate-analysis-progress",
            DuplicateProgressPayload {
                phase: "done".to_string(),
                phase_label: "Analysis complete".to_string(),
                stage: 3,
                stage_name: "done".to_string(),
                stage_label: "Analysis complete".to_string(),
                current: n,
                total: n,
                progress: 100.0,
                current_file: None,
                eta_secs: Some(0.0),
                speed: 0.0,
            },
        );
    }

    (winning_files, replacement_map, report)
}

/// Gather ordered candidate tracks for a single playlist (preserving `sources` priority order and applying exclusions)
pub fn gather_playlist_candidates(
    playlist_config: &PlaylistConfig,
    playlist_index: usize,
    source_dir: &Path,
    formats: &HashSet<String>,
) -> (Vec<CandidateTrack>, Vec<String>) {
    let mut errors = Vec::new();

    // 1. Gather exclusions first (normalized canonical paths)
    let mut excluded_canonical: HashSet<String> = HashSet::new();
    if let Some(exclusions) = &playlist_config.exclusions {
        for exclusion in exclusions {
            let exclusion_path = if Path::new(exclusion).is_absolute() {
                PathBuf::from(exclusion)
            } else {
                source_dir.join(exclusion)
            };

            for file in playlist::list_music_files(&exclusion_path, formats) {
                excluded_canonical.insert(canonical_path_str(&file));
            }
        }
    }

    // 2. Gather sources in priority order (0, 1, 2...)
    let mut candidates = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();

    for (source_idx, source) in playlist_config.sources.iter().enumerate() {
        let source_path = if Path::new(source).is_absolute() {
            PathBuf::from(source)
        } else {
            source_dir.join(source)
        };

        if !source_path.exists() {
            errors.push(format!("Folder not found: {}", source_path.display()));
            continue;
        }

        let source_display = pathdiff::diff_paths(&source_path, source_dir)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| source.clone());

        let mut source_files = playlist::list_music_files(&source_path, formats);
        source_files.sort();

        for file in source_files {
            let c_path = canonical_path_str(&file);
            if excluded_canonical.contains(&c_path) || seen_paths.contains(&c_path) {
                continue;
            }
            seen_paths.insert(c_path.clone());
            candidates.push(CandidateTrack {
                path: file,
                canonical_path: c_path,
                playlist_index,
                playlist_name: playlist_config.name.clone(),
                source_index: source_idx,
                source_folder: if source_display.is_empty() {
                    ".".to_string()
                } else {
                    source_display.clone()
                },
            });
        }
    }

    (candidates, errors)
}

#[tauri::command]
pub async fn analyze_playlist_duplicates(
    app: AppHandle,
    taskId: Option<String>,
    configPath: String,
    sourceDirOverride: Option<String>,
    playlistIndex: Option<usize>,
    formats: String,
    computeAcoustic: Option<bool>,
    maxAcousticSeconds: Option<u32>,
) -> Result<DuplicateAnalysisReport, String> {
    tokio::task::spawn_blocking(move || {
        let effective_task_id = taskId.as_deref().unwrap_or("duplicate_analysis");
        crate::sanitizer::clear_task_cancel(effective_task_id);

        let config_file = Path::new(&configPath);
        let config = playlist::read_config_file(config_file)?;
        let resolved_source_dir = playlist::find_right_dir(
            sourceDirOverride,
            config.source_dir.clone(),
            config.relative_to_config.unwrap_or(true),
            config_file,
        );

        let formats_set: HashSet<String> = formats
            .split(',')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect();

        let run_acoustic = computeAcoustic.unwrap_or(true);
        let max_acoustic_secs = maxAcousticSeconds.unwrap_or(60);

        if let Some(pl_idx) = playlistIndex {
            if pl_idx >= config.playlists.len() {
                return Err("Playlist index out of bounds".to_string());
            }
            let pl = &config.playlists[pl_idx];
            let (candidates, _) =
                gather_playlist_candidates(pl, pl_idx, &resolved_source_dir, &formats_set);
            let (_, _, mut report) =
                analyze_candidates(&candidates, &resolved_source_dir, run_acoustic, max_acoustic_secs, false, Some(&app), Some(effective_task_id));
            report.scope_name = format!("Playlist: {}", pl.name);
            Ok(report)
        } else {
            // Global analysis across all playlists in config order (plus any remaining files in sourceDir)
            let mut all_candidates = Vec::new();
            for (pl_idx, pl) in config.playlists.iter().enumerate() {
                let (cands, _) =
                    gather_playlist_candidates(pl, pl_idx, &resolved_source_dir, &formats_set);
                all_candidates.extend(cands);
            }

            // Also include any workspace files not yet in a playlist with lowest priority
            let mut root_files = playlist::list_music_files(&resolved_source_dir, &formats_set);
            root_files.sort();
            for file in root_files {
                let c_path = canonical_path_str(&file);
                all_candidates.push(CandidateTrack {
                    path: file,
                    canonical_path: c_path,
                    playlist_index: config.playlists.len(),
                    playlist_name: "Workspace Library".to_string(),
                    source_index: 999,
                    source_folder: "Workspace Root".to_string(),
                });
            }

            let (_, _, mut report) =
                analyze_candidates(&all_candidates, &resolved_source_dir, run_acoustic, max_acoustic_secs, true, Some(&app), Some(effective_task_id));
            report.scope_name = "All Playlists & Workspace".to_string();
            Ok(report)
        }
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
pub async fn prune_fingerprint_cache(clearAll: Option<bool>) -> Result<PruneCacheReport, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_cache_db().ok_or_else(|| "Fingerprint database not initialized".to_string())?;
        let (pruned_count, remaining_count) =
            prune_stale_fingerprints_impl(&conn, clearAll.unwrap_or(false));
        Ok(PruneCacheReport {
            pruned_count,
            remaining_count,
        })
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

#[tauri::command]
pub async fn delete_duplicate_files(
    filePaths: Vec<String>,
) -> Result<DeleteDuplicatesResult, String> {
    tokio::task::spawn_blocking(move || {
        let mut deleted_count = 0;
        let mut failed_count = 0;
        let mut freed_bytes = 0u64;
        let mut errors = Vec::new();

        let mut conn_opt = open_cache_db();

        for path_str in &filePaths {
            let path = Path::new(path_str);
            if path.exists() {
                if let Ok(meta) = path.metadata() {
                    freed_bytes += meta.len();
                }
                match std::fs::remove_file(path) {
                    Ok(_) => {
                        deleted_count += 1;
                        if let Some(ref mut conn) = conn_opt {
                            let _ = conn.execute(
                                "DELETE FROM track_fingerprints WHERE file_path = ?1",
                                rusqlite::params![path_str],
                            );
                        }
                    }
                    Err(e) => {
                        failed_count += 1;
                        errors.push(format!("Failed to delete '{}': {}", path_str, e));
                    }
                }
            } else {
                // File does not exist anymore (already deleted)
                deleted_count += 1;
                if let Some(ref mut conn) = conn_opt {
                    let _ = conn.execute(
                        "DELETE FROM track_fingerprints WHERE file_path = ?1",
                        rusqlite::params![path_str],
                    );
                }
            }
        }

        Ok(DeleteDuplicatesResult {
            deleted_count,
            failed_count,
            freed_bytes,
            errors,
        })
    })
    .await
    .map_err(|e| format!("Thread execution error: {}", e))?
}

/// Build a cross-playlist canonical replacement map for Smart Sync Export (Rule 1 + Superior Substitution):
/// When Playlist A and Playlist B reference different duplicate files of the same song,
/// maps every inferior file path to the Superior Winner's `PathBuf` so all playlists keep the song
/// and reference the single superior exported file!
pub fn build_export_superior_replacement_map(
    config: &MainConfig,
    source_dir: &Path,
    formats: &HashSet<String>,
) -> HashMap<String, PathBuf> {
    let mut all_candidates = Vec::new();
    for (pl_idx, pl) in config.playlists.iter().enumerate() {
        let (cands, _) = gather_playlist_candidates(pl, pl_idx, source_dir, formats);
        all_candidates.extend(cands);
    }

    let (_, replacement_map, _) = analyze_candidates(&all_candidates, source_dir, false, 60, true, None, None);
    replacement_map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_souls_duplicate_analysis() {
        let souls_dir = Path::new("/Users/naurinjahan/Documents/BMW-Drive/Music/Bangla/artist/Souls");
        if !souls_dir.exists() {
            println!("Souls directory not present on this machine, skipping");
            return;
        }

        let mut formats = HashSet::new();
        formats.insert("mp3".to_string());
        let files = playlist::list_music_files(souls_dir, &formats);
        assert!(
            files.len() >= 40,
            "Expected at least 40 tracks in Souls folder, found {}",
            files.len()
        );

        let candidates: Vec<CandidateTrack> = files
            .iter()
            .map(|f| CandidateTrack {
                path: f.clone(),
                canonical_path: canonical_path_str(f),
                playlist_index: 0,
                playlist_name: "Souls Test".to_string(),
                source_index: 0,
                source_folder: "Souls".to_string(),
            })
            .collect();

        // Test with acoustic fingerprinting enabled (the mode that previously failed)
        let (_, _, report_with) = analyze_candidates(&candidates, souls_dir, true, 60, false, None, None);

        // Crucial requirement: only ONE song is duplicated ("Ami Are Bhabbona"),
        // and all other 39 songs must remain unique!
        assert_eq!(
            report_with.duplicate_groups.len(),
            1,
            "Expected exactly 1 duplicate group with acoustic enabled, found {}",
            report_with.duplicate_groups.len()
        );

        let group = &report_with.duplicate_groups[0];
        assert_eq!(
            group.tracks.len(),
            2,
            "Expected duplicate group to contain exactly 2 tracks, found {}",
            group.tracks.len()
        );
        assert!(
            group.canonical_title.to_lowercase().contains("ami are bhabbona"),
            "Expected duplicate to be 'Ami Are Bhabbona', got '{}'",
            group.canonical_title
        );
        assert_eq!(report_with.redundant_files_count, 1);

        // Also test with acoustic fingerprinting disabled
        let (_, _, report_without) = analyze_candidates(&candidates, souls_dir, false, 60, false, None, None);
        assert_eq!(
            report_without.duplicate_groups.len(),
            1,
            "Expected exactly 1 duplicate group without acoustic, found {}",
            report_without.duplicate_groups.len()
        );
    }

    #[test]
    fn test_progressive_acoustic_verification_rejects_diverging_audio() {
        // Construct two synthetic 60-second acoustic fingerprints (480 frames at 8 fps)
        let total_frames = 480usize; // 60 seconds
        let intro_frames = 192usize; // 24 seconds (4s skip + 20s initial window)

        let mut fp_a = Vec::with_capacity(total_frames);
        let mut fp_b = Vec::with_capacity(total_frames);
        let mut fp_identical = Vec::with_capacity(total_frames);

        for i in 0..total_frames {
            let pattern = (i as u32).wrapping_mul(0x9e3779b9);
            fp_a.push(pattern);
            fp_identical.push(pattern);

            if i < intro_frames {
                // Same intro: exact match in the first 24 seconds
                fp_b.push(pattern);
            } else {
                // Diverging audio after the intro: completely inverted bits
                fp_b.push(!pattern);
            }
        }

        // 1. When verifying only the first 20 seconds, fp_a and fp_b match because intro is identical
        let match_20s = compare_acoustic_fingerprints(&fp_a, &fp_b, 20);
        assert!(match_20s.is_some(), "Expected 20s scan to match on intro");

        // 2. When progressive verification is set to 60s, it detects that audio diverged after intro and rejects it!
        let match_60s = compare_acoustic_fingerprints(&fp_a, &fp_b, 60);
        assert!(
            match_60s.is_none(),
            "Expected progressive 60s scan to reject diverging tracks as false positive"
        );

        // 3. Truly identical tracks pass the progressive 60s verification and return verified seconds
        let match_true_dup = compare_acoustic_fingerprints(&fp_a, &fp_identical, 60);
        assert!(match_true_dup.is_some(), "Expected true duplicate to match");
        let (conf, offset, verified_secs) = match_true_dup.unwrap();
        assert!(conf >= 90);
        assert_eq!(offset, 0.0);
        assert!(verified_secs >= 55.0, "Expected at least 55s verified, got {}", verified_secs);
    }
}

