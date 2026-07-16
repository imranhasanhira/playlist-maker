use std::collections::HashSet;
use std::path::Path;
use serde::{Deserialize, Serialize};
use lofty::probe::Probe;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::{Accessor, Tag};
use lofty::picture::{Picture, PictureType, MimeType};
use base64::prelude::*;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DirTreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<DirTreeNode>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TrackTags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub year: Option<u32>,
    pub track: Option<u32>,
    pub cover_b64: Option<String>,
    pub cover_mime: Option<String>,
}

pub fn read_tree_recursive(path: &Path, formats: &HashSet<String>) -> Result<DirTreeNode, String> {
    let name = path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "/".to_string());
    let path_str = path.to_string_lossy().to_string();
    
    if path.is_dir() {
        let mut children = Vec::new();
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    if let Ok(child) = read_tree_recursive(&p, formats) {
                        children.push(child);
                    }
                } else if p.is_file() {
                    if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                        if formats.contains(&ext.to_lowercase()) {
                            children.push(DirTreeNode {
                                name: p.file_name().unwrap().to_string_lossy().to_string(),
                                path: p.to_string_lossy().to_string(),
                                is_dir: false,
                                children: Vec::new(),
                            });
                        }
                    }
                }
            }
        }

        // Sort children: directories first, then files, both alphabetically
        children.sort_by(|a, b| {
            if a.is_dir != b.is_dir {
                b.is_dir.cmp(&a.is_dir)
            } else {
                a.name.to_lowercase().cmp(&b.name.to_lowercase())
            }
        });

        Ok(DirTreeNode {
            name,
            path: path_str,
            is_dir: true,
            children,
        })
    } else {
        Ok(DirTreeNode {
            name,
            path: path_str,
            is_dir: false,
            children: Vec::new(),
        })
    }
}

pub fn read_track_tags_impl(file_path: &Path) -> Result<TrackTags, String> {
    let tagged_file = Probe::open(file_path)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;

    let mut title = None;
    let mut artist = None;
    let mut album = None;
    let mut genre = None;
    let mut year = None;
    let mut track = None;
    let mut cover_b64 = None;
    let mut cover_mime = None;

    if let Some(tag) = tagged_file.primary_tag() {
        title = tag.title().map(|s| s.to_string());
        artist = tag.artist().map(|s| s.to_string());
        album = tag.album().map(|s| s.to_string());
        genre = tag.genre().map(|s| s.to_string());
        year = tag.year();
        track = tag.track();

        if let Some(pic) = tag.pictures().first() {
            cover_mime = pic.mime_type().map(|m| m.to_string());
            cover_b64 = Some(BASE64_STANDARD.encode(pic.data()));
        }
    }

    Ok(TrackTags {
        title,
        artist,
        album,
        genre,
        year,
        track,
        cover_b64,
        cover_mime,
    })
}

pub fn write_track_tags_impl(file_path: &Path, tags: TrackTags) -> Result<(), String> {
    let mut tagged_file = Probe::open(file_path)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;

    let tag_type = tagged_file.primary_tag_type();
    let tag = if tagged_file.primary_tag().is_some() {
        tagged_file.primary_tag_mut().unwrap()
    } else {
        tagged_file.insert_tag(Tag::new(tag_type));
        tagged_file.primary_tag_mut().unwrap()
    };

    if let Some(t) = tags.title {
        tag.set_title(t);
    } else {
        tag.remove_title();
    }

    if let Some(a) = tags.artist {
        tag.set_artist(a);
    } else {
        tag.remove_artist();
    }

    if let Some(al) = tags.album {
        tag.set_album(al);
    } else {
        tag.remove_album();
    }

    if let Some(g) = tags.genre {
        tag.set_genre(g);
    } else {
        tag.remove_genre();
    }

    if let Some(y) = tags.year {
        tag.set_year(y);
    } else {
        tag.remove_year();
    }

    if let Some(tr) = tags.track {
        tag.set_track(tr);
    } else {
        tag.remove_track();
    }

    // Set cover picture
    while !tag.pictures().is_empty() {
        tag.remove_picture(0);
    }

    if let Some(b64) = tags.cover_b64 {
        if let Ok(data) = BASE64_STANDARD.decode(&b64) {
            let mime = tags.cover_mime.unwrap_or_else(|| "image/jpeg".to_string());
            let lofty_mime = match mime.as_str() {
                "image/png" => Some(MimeType::Png),
                "image/jpeg" | "image/jpg" => Some(MimeType::Jpeg),
                _ => None,
            };
            let picture = Picture::new_unchecked(
                PictureType::CoverFront,
                lofty_mime,
                None,
                data,
            );
            tag.push_picture(picture);
        }
    }

    tagged_file.save_to_path(file_path, lofty::config::WriteOptions::default())
        .map_err(|e| format!("Failed to save audio tags: {}", e))?;

    Ok(())
}

pub fn batch_update_folder_tags_impl(
    folder_path: &Path,
    formats: &HashSet<String>,
    artist: Option<String>,
    album: Option<String>,
    genre: Option<String>,
    year: Option<u32>,
) -> Result<(), String> {
    for entry in walkdir::WalkDir::new(folder_path).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            let p = entry.path();
            if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                if formats.contains(&ext.to_lowercase()) {
                    let mut tagged_file = match Probe::open(p).and_then(|f| f.read()) {
                        Ok(tf) => tf,
                        Err(_) => continue,
                    };

                    let tag_type = tagged_file.primary_tag_type();
                    let tag = if tagged_file.primary_tag().is_some() {
                        tagged_file.primary_tag_mut().unwrap()
                    } else {
                        tagged_file.insert_tag(Tag::new(tag_type));
                        tagged_file.primary_tag_mut().unwrap()
                    };

                    let mut changed = false;
                    if let Some(ref a) = artist {
                        if !a.trim().is_empty() {
                            tag.set_artist(a.clone());
                            changed = true;
                        }
                    }
                    if let Some(ref al) = album {
                        if !al.trim().is_empty() {
                            tag.set_album(al.clone());
                            changed = true;
                        }
                    }
                    if let Some(ref g) = genre {
                        if !g.trim().is_empty() {
                            tag.set_genre(g.clone());
                            changed = true;
                        }
                    }
                    if let Some(y) = year {
                        if y > 0 {
                            tag.set_year(y);
                            changed = true;
                        }
                    }

                    if changed {
                        let _ = tagged_file.save_to_path(p, lofty::config::WriteOptions::default());
                    }
                }
            }
        }
    }
    Ok(())
}
