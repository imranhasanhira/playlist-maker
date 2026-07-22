export interface AudioTrack {
  file_path: string;
  title: string;
  artist: string;
  duration: number;
}

export interface TrackPreview {
  file_path: string;
  relative_path: string;
  title: string;
  artist: string;
  duration: number;
  size_bytes: number;
}

export interface RuleConfig {
  type: "include_genre" | "exclude_genre" | "include_artist" | "exclude_artist" | "min_year" | "max_year" | "custom";
  value: string;
}

export interface PlaylistConfig {
  name: string;
  filename?: string;
  sources: string[];
  exclusions?: string[];
  rules?: RuleConfig[];
  sort_by?: "artist" | "title" | "year" | "duration" | "random";
  limit?: number;
}

export interface MainConfig {
  sourceDir: string | null;
  targetDir?: string | null;
  workspaceDir?: string;
  playlistsDir?: string;
  relativeToConfig?: boolean | null;
  playlists: PlaylistConfig[];
}

export type ExportStatus = "New" | "Modified" | "UpToDate";

export interface ExportTrackItem {
  file_path: string;
  relative_path: string;
  dest_relative_path: string;
  size_bytes: number;
  mtime_secs: number;
  status: ExportStatus;
}

export interface ExportOrphanItem {
  file_path: string;
  relative_path: string;
  size_bytes: number;
  is_playlist: boolean;
}

export interface ExportPlaylistItem {
  name: string;
  filename: string;
  track_count: number;
}

export interface ExportDiffReport {
  destination: string;
  new_files: ExportTrackItem[];
  up_to_date_files: ExportTrackItem[];
  orphan_files: ExportOrphanItem[];
  playlists: ExportPlaylistItem[];
  total_bytes_to_copy: number;
  total_bytes_up_to_date: number;
  total_bytes_orphans: number;
}

export interface ExportProgressPayload {
  task_id: string;
  current_file_index: number;
  total_files: number;
  current_file: string;
  copied_bytes: number;
  total_bytes: number;
  is_complete: boolean;
}

export interface SanitizeItem {
  original_path: string;
  original_name: string;
  sanitized_name: string;
  relative_path: string;
}

export interface HiddenFileItem {
  file_path: string;
  file_name: string;
  relative_path: string;
  size_bytes: number;
}

export interface MetadataSanitizeItem {
  file_path: string;
  field_name: string;
  original_value: string;
  sanitized_value: string;
}

export interface BgTask {
  id: string;
  name: string;
  progress: number;
  status: "running" | "completed" | "failed";
  text: string;
}

export type DownloadStatus = "running" | "completed" | "failed" | "cancelled";

export interface DownloadJob {
  id: string;
  url: string;
  output_dir: string;
  audio_format: string;
  use_archive: boolean;
  archive_path: string;
  ignore_errors: boolean;
  status: DownloadStatus;
  progress: number;
  current_item?: number;
  total_items?: number;
  title?: string;
  logs: string[];
  start_time: number;
}

export interface DownloadLogPayload {
  job_id: string;
  line: string;
}

export interface DownloadProgressPayload {
  job_id: string;
  status: DownloadStatus;
  progress: number;
  current_item?: number;
  total_items?: number;
  title?: string;
  error?: string;
}

export interface SystemBinariesStatus {
  ytdlp_installed: boolean;
  ytdlp_version?: string;
  ffmpeg_installed: boolean;
  ffmpeg_version?: string;
}
