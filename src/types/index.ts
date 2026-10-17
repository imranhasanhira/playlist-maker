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
  year?: number | null;
}

export interface YearSplitConfig {
  enabled: boolean;
  min_tracks?: number; // Optional playlist override; falls back to global minTracksPerYearPlaylist
  include_unknown?: boolean;
  split_5y?: number[];
  split_1y?: number[];
  custom_merges?: [number, number][];
  split_unknown_parts?: number;
}

export interface YearBucketSummary {
  key: string;
  label: string;
  bucket_type: "10y" | "5y" | "1y" | "custom" | "unknown" | "unknown_split";
  parent_key: string | null;
  track_count: number;
  is_split: boolean;
  start_year: number | null;
  end_year: number | null;
  below_min_tracks?: boolean;
}

export interface PlaylistSummaryItem {
  index: number;
  name: string;
  total_tracks: number;
  year_split_enabled: boolean;
  buckets: YearBucketSummary[];
  warning_exceeds_max: boolean;
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
  year_split?: YearSplitConfig;
}

export interface MainConfig {
  sourceDir: string | null;
  targetDir?: string | null;
  workspaceDir?: string;
  playlistsDir?: string;
  relativeToConfig?: boolean | null;
  maxTracksPerPlaylist?: number | null;
  minTracksPerYearPlaylist?: number | null;
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

export interface ExportWarningItem {
  scope: "directory" | "track_group" | "system";
  target_path: string;
  warning_type: string;
  message: string;
  affected_count: number;
  sample_files?: string[];
}

export interface FontIssueItem {
  file_path: string;
  relative_path: string;
  detected_issue: string;
  option1_preview: string;
  option2_preview: string;
}

export interface ExportDiffReport {
  destination: string;
  new_files: ExportTrackItem[];
  up_to_date_files: ExportTrackItem[];
  orphan_files: ExportOrphanItem[];
  playlists: ExportPlaylistItem[];
  warnings?: ExportWarningItem[];
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

export type DownloadEntryStatus = 'new' | 'complete' | 'partial' | 'downloading' | 'error' | 'stale';

export interface DownloadEntry {
  id: string;
  url: string;
  name: string;
  labels: string;
  output_dir: string;
  audio_format: string | null;
  use_archive: boolean | null;
  ignore_errors: boolean | null;
  total_songs: number;
  songs_on_disk: number;
  playlist_title: string;
  artist: string;
  album: string;
  status: DownloadEntryStatus;
  last_download_at: number | null;
  last_error: string;
  created_at: number;
  updated_at: number;
}

export interface DownloadGlobalSettings {
  default_output_dir: string;
  default_audio_format: string;
  default_use_archive: boolean;
  archive_path: string;
  default_ignore_errors: boolean;
  max_parallel_jobs: number;
}

export interface PlaylistMetadata {
  title: string;
  artist: string;
  album: string;
  total_songs: number;
  video_ids: string[];
}

export interface DeleteFilesReport {
  files: string[];
  total_bytes: number;
}

export interface ReconcilePlaylistReport {
  playlist_title: string;
  total_online: number;
  songs_on_disk: number;
  matched_on_disk: number;
  missing_count: number;
  missing_ids: string[];
  missing_titles: string[];
  pruned_from_archive: number;
  added_to_archive: number;
  logs: string[];
}

export interface DuplicateTrackEntry {
  file_path: string;
  relative_path: string;
  source_folder: string;
  source_index: number;
  playlist_names: string[];
  title: string;
  artist: string;
  duration: number;
  size_bytes: number;
  format_ext: string;
  bitrate_kbps: number;
  youtube_id?: string | null;
  is_winner: boolean;
  offset_secs?: number | null;
  winner_reason: string;
}

export interface DuplicateGroup {
  group_id: string;
  canonical_title: string;
  canonical_artist: string;
  match_tier: "exact_hash" | "youtube_id" | "acoustic" | "metadata" | string;
  match_label: string;
  confidence: number;
  tracks: DuplicateTrackEntry[];
}

export interface DuplicateAnalysisReport {
  scope_name: string;
  total_scanned_files: number;
  duplicate_groups: DuplicateGroup[];
  redundant_files_count: number;
  redundant_bytes: number;
  cache_total_entries: number;
  cache_stale_pruned: number;
}

export interface PruneCacheReport {
  pruned_count: number;
  remaining_count: number;
}

export interface DuplicateAnalysisProgressPayload {
  phase: "fingerprinting" | "clustering" | "done" | string;
  phase_label: string;
  stage: number;
  stage_name: "metadata" | "acoustic" | "clustering" | "done" | string;
  stage_label: string;
  current: number;
  total: number;
  progress: number;
  current_file?: string | null;
  eta_secs?: number | null;
  speed: number;
}

export interface DeleteDuplicatesResult {
  deleted_count: number;
  failed_count: number;
  freed_bytes: number;
  errors: string[];
}

export interface Mp3UpgradeCandidate {
  path: string;
  filename: string;
  youtube_id: string;
  youtube_url: string;
  title: string;
  artist: string;
  file_size_bytes: number;
  format_ext: string;
  is_mp3: boolean;
  missing_tags: boolean;
  missing_artwork: boolean;
  reason: string;
  m4a_already_exists: boolean;
  m4a_path: string;
}

export interface Mp3UpgradeScanReport {
  folder: string;
  total_files_scanned: number;
  total_mp3s_found: number;
  candidates: Mp3UpgradeCandidate[];
  skipped_no_id_count: number;
  already_upgraded_count: number;
  param_issues_count: number;
}

export interface Mp3UpgradeProgressPayload {
  current: number;
  total: number;
  current_file: string;
  status: "downloading" | "cancelled" | "done" | string;
  success_count: number;
  failed_count: number;
  saved_bytes: number;
}

export interface Mp3UpgradeResultItem {
  path: string;
  filename: string;
  youtube_id: string;
  success: boolean;
  m4a_path: string | null;
  error: string | null;
  original_size_bytes: number;
  new_size_bytes: number;
  dead_tag_cleaned?: boolean;
}

export interface Mp3UpgradeExecutionReport {
  total: number;
  success_count: number;
  failed_count: number;
  skipped_count: number;
  freed_bytes: number;
  results: Mp3UpgradeResultItem[];
}

// File Repair type aliases
export type FileRepairCandidate = Mp3UpgradeCandidate;
export type FileRepairScanReport = Mp3UpgradeScanReport;
export type FileRepairProgressPayload = Mp3UpgradeProgressPayload;
export type FileRepairResultItem = Mp3UpgradeResultItem;
export type FileRepairExecutionReport = Mp3UpgradeExecutionReport;




