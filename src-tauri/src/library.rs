use std::collections::HashSet;
use std::path::Path;
use serde::{Deserialize, Serialize};
use lofty::probe::Probe;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::{Accessor, Tag, TagType};
use lofty::picture::{Picture, PictureType, MimeType};
use base64::prelude::*;
use tauri::Emitter;
use crate::sanitizer::TaskProgress;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DirTreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<DirTreeNode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<u32>,
    #[serde(default)]
    pub unknown_year_count: usize,
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

pub fn read_tree_recursive(
    app: &tauri::AppHandle,
    task_id: &str,
    path: &Path,
    formats: &HashSet<String>,
    current_depth: usize,
    counter: &mut usize,
    total: usize,
) -> Result<DirTreeNode, String> {
    if current_depth > 8 || crate::sanitizer::is_task_cancelled(task_id) {
        return Ok(DirTreeNode {
            name: path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "/".to_string()),
            path: path.to_string_lossy().to_string(),
            is_dir: true,
            children: Vec::new(),
            year: None,
            unknown_year_count: 0,
        });
    }

    *counter += 1;
    let _ = app.emit(
        "task-progress",
        TaskProgress {
            task_id: task_id.to_string(),
            task_name: "Library Tree Scan".to_string(),
            index: *counter,
            total,
            status: if *counter >= total { "completed".to_string() } else { "running".to_string() },
            message: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            file_path: None,
        },
    );

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
                    if let Ok(child) = read_tree_recursive(app, task_id, &p, formats, current_depth + 1, counter, total) {
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
                                year: None,
                                unknown_year_count: 0,
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
            year: None,
            unknown_year_count: 0,
        })
    } else {
        Ok(DirTreeNode {
            name,
            path: path_str,
            is_dir: false,
            children: Vec::new(),
            year: None,
            unknown_year_count: 0,
        })
    }
}

pub fn annotate_tree_years(root: &mut DirTreeNode) {
    let mut file_paths = Vec::new();
    fn collect_files(node: &DirTreeNode, paths: &mut Vec<std::path::PathBuf>) {
        if node.is_dir {
            for child in &node.children {
                collect_files(child, paths);
            }
        } else {
            paths.push(std::path::PathBuf::from(&node.path));
        }
    }
    collect_files(root, &mut file_paths);

    let metas = crate::playlist::get_or_probe_track_metadata_batch(&file_paths);
    let mut meta_map = std::collections::HashMap::with_capacity(metas.len());
    for m in metas {
        meta_map.insert(m.file_path, m.year);
    }

    fn annotate_node(
        node: &mut DirTreeNode,
        meta_map: &std::collections::HashMap<String, Option<u32>>,
    ) -> usize {
        if node.is_dir {
            let mut total_unknown = 0;
            for child in &mut node.children {
                total_unknown += annotate_node(child, meta_map);
            }
            node.unknown_year_count = total_unknown;
            node.year = None;
            total_unknown
        } else {
            let c_path = crate::utils::canonical_path_str(std::path::Path::new(&node.path));
            let year = meta_map.get(&c_path).copied().flatten();
            node.year = year;
            if year.is_none() {
                node.unknown_year_count = 1;
                1
            } else {
                node.unknown_year_count = 0;
                0
            }
        }
    }

    annotate_node(root, &meta_map);
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

    tagged_file.remove(TagType::Id3v1);
    let _ = TagType::Id3v1.remove_from_path(file_path);
    tagged_file.save_to_path(file_path, lofty::config::WriteOptions::default())
        .map_err(|e| format!("Failed to save audio tags: {}", e))?;

    if let Some((mtime, size)) = crate::utils::get_file_mtime_and_size(file_path) {
        let meta = crate::playlist::probe_track_metadata(file_path, mtime, size);
        crate::playlist::save_cached_metadata_batch(&[meta]);
    }

    Ok(())
}

pub fn batch_update_folder_tags_impl(
    folder_path: &Path,
    formats: &HashSet<String>,
    artist: Option<String>,
    album: Option<String>,
    genre: Option<String>,
    year: Option<u32>,
    cover_b64: Option<String>,
    cover_mime: Option<String>,
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
                    if let Some(ref b64) = cover_b64 {
                        while !tag.pictures().is_empty() {
                            tag.remove_picture(0);
                        }
                        if b64 != "REMOVE" && !b64.is_empty() {
                            if let Ok(data) = BASE64_STANDARD.decode(b64) {
                                let mime = cover_mime.clone().unwrap_or_else(|| "image/jpeg".to_string());
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
                        changed = true;
                    }

                    if changed {
                        tagged_file.remove(TagType::Id3v1);
                        let _ = TagType::Id3v1.remove_from_path(p);
                        let _ = tagged_file.save_to_path(p, lofty::config::WriteOptions::default());
                        if let Some((mtime, size)) = crate::utils::get_file_mtime_and_size(p) {
                            let meta = crate::playlist::probe_track_metadata(p, mtime, size);
                            crate::playlist::save_cached_metadata_batch(&[meta]);
                        }
                    }
                }
            }
        }
    }
    Ok(())
}
