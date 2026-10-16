use std::path::Path;
use serde::{Deserialize, Serialize};
use claxon::FlacReader;
use shine_rs::{Mp3Encoder, Mp3EncoderConfig, StereoMode};
use lofty::probe::Probe;
use lofty::file::TaggedFileExt;
use lofty::tag::{Accessor, Tag, TagType, TagExt};
use lofty::config::WriteOptions;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranscodeJob {
    pub file_path: String,
    pub output_dir: String,
    pub bitrate: i32, // kbps, e.g. 192, 256, 320
}

#[derive(Debug, Serialize, Clone)]
pub struct TaskProgress {
    pub task_id: String,
    pub task_name: String,
    pub index: usize,
    pub total: usize,
    pub status: String,
    pub message: String,
    #[serde(rename = "filePath")]
    pub file_path: Option<String>,
}

// Convert a single FLAC file to MP3
pub fn transcode_flac_to_mp3(
    input_path: &Path,
    output_path: &Path,
    bitrate_kbps: i32,
) -> Result<(), String> {
    // 1. Open FLAC reader
    let mut reader = FlacReader::open(input_path)
        .map_err(|e| format!("Failed to open FLAC file: {}", e))?;
    
    let streaminfo = reader.streaminfo();
    let sample_rate = streaminfo.sample_rate;
    let channels = streaminfo.channels;
    let bits_per_sample = streaminfo.bits_per_sample;

    if channels != 1 && channels != 2 {
        return Err(format!("Unsupported channel count: {}. Only mono (1) and stereo (2) are supported.", channels));
    }

    // 2. Read samples and convert/scale to i16 PCM
    let mut samples_i16 = Vec::new();
    if bits_per_sample == 16 {
        for sample in reader.samples() {
            let val = sample.map_err(|e| format!("Error decoding FLAC samples: {}", e))?;
            samples_i16.push(val as i16);
        }
    } else if bits_per_sample == 24 {
        for sample in reader.samples() {
            let val = sample.map_err(|e| format!("Error decoding FLAC samples: {}", e))?;
            // Shift 24-bit samples to 16-bit
            samples_i16.push((val >> 8) as i16);
        }
    } else {
        // General scaling for other bit depths
        let max_val = (1 << (bits_per_sample - 1)) as f32;
        for sample in reader.samples() {
            let val = sample.map_err(|e| format!("Error decoding FLAC samples: {}", e))?;
            let normalized = (val as f32) / max_val;
            let scaled = (normalized * 32767.0).clamp(-32768.0, 32767.0) as i16;
            samples_i16.push(scaled);
        }
    }

    // 3. Configure MP3 encoder
    let stereo_mode = if channels == 1 {
        StereoMode::Mono
    } else {
        StereoMode::Stereo
    };

    let config = Mp3EncoderConfig::new()
        .sample_rate(sample_rate)
        .bitrate(bitrate_kbps as u32)
        .channels(channels as u8)
        .stereo_mode(stereo_mode);

    let mut encoder = Mp3Encoder::new(config)
        .map_err(|e| format!("Failed to initialize MP3 encoder: {:?}", e))?;

    // 4. Encode samples in frame chunks
    let mut mp3_bytes: Vec<u8> = Vec::new();
    let frame_size = encoder.samples_per_frame();
    
    for chunk in samples_i16.chunks(frame_size) {
        if chunk.len() == frame_size {
            let encoded = encoder.encode_interleaved(chunk)
                .map_err(|e| format!("MP3 encoding error: {:?}", e))?;
            for frame in encoded {
                mp3_bytes.extend_from_slice(&frame);
            }
        } else {
            let mut padded = chunk.to_vec();
            padded.resize(frame_size, 0);
            let encoded = encoder.encode_interleaved(&padded)
                .map_err(|e| format!("MP3 encoding error: {:?}", e))?;
            for frame in encoded {
                mp3_bytes.extend_from_slice(&frame);
            }
        }
    }

    let final_bytes = encoder.finish()
        .map_err(|e| format!("MP3 finalizing error: {:?}", e))?;
    mp3_bytes.extend_from_slice(&final_bytes);

    // 5. Write MP3 file
    std::fs::write(output_path, mp3_bytes)
        .map_err(|e| format!("Failed to write MP3 file to disk: {}", e))?;

    // 6. Copy metadata tags if they exist
    let _ = copy_metadata(input_path, output_path);

    Ok(())
}

fn copy_metadata(flac_path: &Path, mp3_path: &Path) -> Result<(), String> {
    let flac_file = Probe::open(flac_path)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;

    if let Some(flac_tag) = flac_file.primary_tag() {
        let mut mp3_file = Probe::open(mp3_path)
            .map_err(|e| e.to_string())?
            .read()
            .map_err(|e| e.to_string())?;

        // Insert or access ID3v2 tag
        let tag = if mp3_file.tag(TagType::Id3v2).is_some() {
            mp3_file.tag_mut(TagType::Id3v2)
        } else {
            mp3_file.insert_tag(Tag::new(TagType::Id3v2));
            mp3_file.tag_mut(TagType::Id3v2)
        };

        if let Some(mp3_tag) = tag {
            if let Some(title) = flac_tag.title() {
                mp3_tag.set_title(title.to_string());
            }
            if let Some(artist) = flac_tag.artist() {
                mp3_tag.set_artist(artist.to_string());
            }
            if let Some(album) = flac_tag.album() {
                mp3_tag.set_album(album.to_string());
            }
            if let Some(genre) = flac_tag.genre() {
                mp3_tag.set_genre(genre.to_string());
            }
            if let Some(year) = flac_tag.year() {
                mp3_tag.set_year(year);
            }
            if let Some(track) = flac_tag.track() {
                mp3_tag.set_track(track);
            }

            mp3_tag.save_to_path(mp3_path, WriteOptions::default())
                .map_err(|e| format!("Failed to save MP3 tags: {}", e))?;
        }
    }
    Ok(())
}

// Background queue runner with parallel workers
pub fn run_transcode_queue(app: AppHandle, jobs: Vec<TranscodeJob>) {
    tokio::spawn(async move {
        crate::sanitizer::clear_task_cancel("flac_transcode");
        let total = jobs.len();
        if total == 0 {
            return;
        }

        let num_workers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(8);

        let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(num_workers));
        let processed_counter = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut task_handles = Vec::new();

        for job in jobs {
            let sem = semaphore.clone();
            let app_clone = app.clone();
            let counter = processed_counter.clone();

            let handle = tokio::spawn(async move {
                let _permit = match sem.acquire_owned().await {
                    Ok(p) => p,
                    Err(_) => return,
                };
                if crate::sanitizer::is_task_cancelled("flac_transcode") {
                    return;
                }

                let input_path = std::path::PathBuf::from(&job.file_path);
                let output_dir = std::path::PathBuf::from(&job.output_dir);
                let file_stem = input_path
                    .file_stem()
                    .unwrap_or_else(|| std::ffi::OsStr::new("output"))
                    .to_string_lossy()
                    .to_string();
                let output_filename = format!("{}.mp3", file_stem);
                let output_path = output_dir.join(output_filename);

                if !output_dir.exists() {
                    let _ = std::fs::create_dir_all(&output_dir);
                }

                let in_path = input_path.clone();
                let out_path = output_path.clone();
                let bitrate = job.bitrate;

                let result = tokio::task::spawn_blocking(move || {
                    transcode_flac_to_mp3(&in_path, &out_path, bitrate)
                })
                .await
                .unwrap_or_else(|e| Err(format!("Task error: {}", e)));

                let (success, error_msg) = match result {
                    Ok(_) => (true, None),
                    Err(e) => (false, Some(e)),
                };

                let cur = counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                let message = if success {
                    format!("Converted: {}", file_stem)
                } else {
                    format!("Failed: {}", error_msg.as_deref().unwrap_or(""))
                };

                let _ = app_clone.emit(
                    "task-progress",
                    TaskProgress {
                        task_id: "flac_transcode".to_string(),
                        task_name: "FLAC Transcoding".to_string(),
                        index: cur.saturating_sub(1),
                        total,
                        status: if cur == total { "completed".to_string() } else { "running".to_string() },
                        message,
                        file_path: Some(job.file_path),
                    },
                );
            });

            task_handles.push(handle);
        }

        for handle in task_handles {
            let _ = handle.await;
        }
    });
}
