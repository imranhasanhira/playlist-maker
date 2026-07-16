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
pub struct TranscodeProgress {
    pub file_path: String,
    pub index: usize,
    pub total: usize,
    pub success: bool,
    pub error_msg: Option<String>,
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

// Background queue runner
pub fn run_transcode_queue(app: AppHandle, jobs: Vec<TranscodeJob>) {
    tokio::spawn(async move {
        let total = jobs.len();
        for (index, job) in jobs.into_iter().enumerate() {
            let input_path = Path::new(&job.file_path);
            let output_dir = Path::new(&job.output_dir);
            
            // Create target filename
            let file_stem = input_path.file_stem().unwrap_or_else(|| std::ffi::OsStr::new("output"));
            let output_filename = format!("{}.mp3", file_stem.to_string_lossy());
            let output_path = output_dir.join(output_filename);

            // Make sure target dir exists
            if !output_dir.exists() {
                let _ = std::fs::create_dir_all(output_dir);
            }

            let result = transcode_flac_to_mp3(input_path, &output_path, job.bitrate);

            let (success, error_msg) = match result {
                Ok(_) => (true, None),
                Err(e) => (false, Some(e)),
            };

            let _ = app.emit(
                "transcode-progress",
                TranscodeProgress {
                    file_path: job.file_path,
                    index: index + 1,
                    total,
                    success,
                    error_msg,
                },
            );
        }
    });
}
