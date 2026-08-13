import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DownloadEntry, DownloadGlobalSettings, DeleteFilesReport, DownloadJob } from "../../types";

type EntryDetailProps = {
  entry: DownloadEntry | null;
  globalSettings: DownloadGlobalSettings;
  allExistingLabels: string[];
  activeJob?: DownloadJob;
  isRefreshingEntry?: boolean;
  onSaveEntry: (updated: DownloadEntry) => Promise<void>;
  onRefreshMetadata: (entry: DownloadEntry) => Promise<void>;
  onStartDownload: (entry: DownloadEntry) => Promise<void>;
  onCancelDownload?: (jobId: string) => Promise<void>;
  onDeleteEntry: (entryId: string) => void;
  onDeleteFilesExecuted: (entryId: string) => Promise<void>;
};

export const EntryDetail: React.FC<EntryDetailProps> = ({
  entry,
  globalSettings,
  allExistingLabels,
  activeJob,
  isRefreshingEntry = false,
  onSaveEntry,
  onRefreshMetadata,
  onStartDownload,
  onCancelDownload,
  onDeleteEntry,
  onDeleteFilesExecuted,
}) => {
  const [formData, setFormData] = useState<DownloadEntry | null>(entry);
  const [isSaving, setIsSaving] = useState(false);
  const [localIsRefreshing, setLocalIsRefreshing] = useState(false);
  const isRefreshing = isRefreshingEntry || localIsRefreshing;

  // Delete Files Modal State
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isFetchingDeleteReport, setIsFetchingDeleteReport] = useState(false);
  const [deleteReport, setDeleteReport] = useState<DeleteFilesReport | null>(null);
  const [isExecutingDeleteFiles, setIsExecutingDeleteFiles] = useState(false);

  useEffect(() => {
    setFormData(entry);
  }, [entry]);

  if (!formData) {
    return (
      <div className="no-data" style={{ margin: "auto", textAlign: "center", padding: "40px" }}>
        Select a playlist entry from the grid on the left, or click "+ Add Entry" to create a new download entry.
      </div>
    );
  }

  const PREDEFINED_TAGS = ["Bangla", "Hindi", "English"];
  const combinedSuggestions = Array.from(new Set([...PREDEFINED_TAGS, ...allExistingLabels]));

  const handlePickDir = async () => {
    try {
      const selected = await invoke<string | null>("select_directory", {
        title: "Select Output Folder for Entry",
      });
      if (selected) {
        setFormData({ ...formData, output_dir: selected });
      }
    } catch (e) {
      alert("Error picking directory: " + e);
    }
  };

  const handleAddChip = (chip: string) => {
    const current = formData.labels.split(",").map((l) => l.trim()).filter(Boolean);
    if (!current.includes(chip)) {
      current.push(chip);
      setFormData({ ...formData, labels: current.join(", ") });
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSaveEntry({
        ...formData,
        updated_at: Date.now(),
      });
    } catch (e) {
      alert("Error saving entry: " + e);
    } finally {
      setIsSaving(false);
    }
  };

  const handleRefresh = async () => {
    setLocalIsRefreshing(true);
    try {
      await onRefreshMetadata(formData);
    } catch (e) {
      alert("Error refreshing metadata: " + e);
    } finally {
      setLocalIsRefreshing(false);
    }
  };

  const handleOpenDeleteFilesModal = async () => {
    setShowDeleteModal(true);
    setIsFetchingDeleteReport(true);
    try {
      const report = await invoke<DeleteFilesReport>("dl_get_delete_files_report", {
        outputDir: formData.output_dir,
        playlistTitle: formData.playlist_title || formData.name,
      });
      setDeleteReport(report);
    } catch (e) {
      alert("Error generating delete files report: " + e);
    } finally {
      setIsFetchingDeleteReport(false);
    }
  };

  const handleConfirmDeleteFiles = async () => {
    setIsExecutingDeleteFiles(true);
    try {
      await invoke("dl_execute_delete_files", {
        outputDir: formData.output_dir,
        playlistTitle: formData.playlist_title || formData.name,
        archivePath: globalSettings.archive_path,
        videoIds: [], // delete all IDs matching playlist folder
      });
      setShowDeleteModal(false);
      await onDeleteFilesExecuted(formData.id);
      alert("Successfully deleted all downloaded files for this entry.");
    } catch (e) {
      alert("Error deleting files: " + e);
    } finally {
      setIsExecutingDeleteFiles(false);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const effectiveFormat = formData.audio_format || globalSettings.default_audio_format;
  const effectiveArchive = formData.use_archive !== null ? formData.use_archive : globalSettings.default_use_archive;
  const isDownloading = activeJob?.status === "running";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", overflowY: "auto", flexShrink: 0 }}>
      {/* Header & Primary Actions */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border-color)", paddingBottom: "8px" }}>
        <h3 style={{ fontSize: "1.05rem", margin: 0, fontWeight: 600 }}>Entry Configuration & Details</h3>

        <div style={{ display: "flex", gap: "8px" }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleRefresh}
            disabled={isRefreshing || isDownloading}
            style={{ padding: "4px 10px", fontSize: "0.78rem" }}
            title="Parse playlist URL again to check for new songs and refresh disk count"
          >
            {isRefreshing ? "Parsing..." : "🔄 Refresh Playlist"}
          </button>

          {isDownloading ? (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => activeJob && onCancelDownload && onCancelDownload(activeJob.id)}
              style={{ padding: "4px 14px", fontSize: "0.82rem" }}
              title="Stop current download job"
            >
              🛑 Cancel Download
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onStartDownload(formData)}
              style={{ padding: "4px 14px", fontSize: "0.82rem" }}
            >
              🚀 Download Now
            </button>
          )}
        </div>
      </div>

      {/* Grid Form */}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
        {/* Name Input */}
        <div className="form-group" style={{ margin: 0 }}>
          <label className="form-label">Entry Name</label>
          <input
            type="text"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder="Entry display name..."
          />
        </div>

        {/* URL Input */}
        <div className="form-group" style={{ margin: 0 }}>
          <label className="form-label">Playlist / Media URL</label>
          <input
            type="text"
            value={formData.url}
            onChange={(e) => setFormData({ ...formData, url: e.target.value })}
            placeholder="https://..."
            style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}
          />
        </div>

        {/* Labels Input */}
        <div className="form-group" style={{ margin: 0, gridColumn: "span 2" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <label className="form-label">Labels (comma-separated)</label>
            <div style={{ display: "flex", gap: "4px" }}>
              {combinedSuggestions.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => handleAddChip(tag)}
                  style={{
                    fontSize: "0.68rem",
                    padding: "1px 6px",
                    borderRadius: "8px",
                    border: "1px solid var(--border-color)",
                    backgroundColor: "var(--bg-tertiary)",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                  }}
                >
                  + {tag}
                </button>
              ))}
            </div>
          </div>
          <input
            type="text"
            value={formData.labels}
            onChange={(e) => setFormData({ ...formData, labels: e.target.value })}
            placeholder="e.g. Bangla, Classics, Coke Studio"
          />
        </div>

        {/* Output Directory Picker */}
        <div className="form-group" style={{ margin: 0, gridColumn: "span 2" }}>
          <label className="form-label">Output Directory Destination</label>
          <div className="form-row">
            <input
              type="text"
              value={formData.output_dir}
              onChange={(e) => setFormData({ ...formData, output_dir: e.target.value })}
              placeholder="e.g. /Music/Youtube"
            />
            <button className="btn btn-secondary" type="button" onClick={handlePickDir}>
              Browse...
            </button>
          </div>
        </div>

        {/* Format & Archive Select Overrides */}
        <div className="form-group" style={{ margin: 0 }}>
          <label className="form-label">Audio Format Override</label>
          <select
            value={formData.audio_format || "default"}
            onChange={(e) =>
              setFormData({
                ...formData,
                audio_format: e.target.value === "default" ? null : e.target.value,
              })
            }
          >
            <option value="default">Global Default ({globalSettings.default_audio_format})</option>
            <option value="m4a/mp3">m4a/mp3 (Best)</option>
            <option value="m4a">m4a (Lossless)</option>
            <option value="mp3">mp3 (Audio only)</option>
          </select>
        </div>

        <div className="form-group" style={{ margin: 0 }}>
          <label className="form-label">Use Archive Override</label>
          <select
            value={formData.use_archive === null ? "default" : formData.use_archive ? "true" : "false"}
            onChange={(e) =>
              setFormData({
                ...formData,
                use_archive: e.target.value === "default" ? null : e.target.value === "true",
              })
            }
          >
            <option value="default">Global Default ({globalSettings.default_use_archive ? "Enabled" : "Disabled"})</option>
            <option value="true">Enabled (Skip downloaded)</option>
            <option value="false">Disabled (Re-download all)</option>
          </select>
        </div>
      </div>

      {/* Metadata Readout Card */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: "8px",
          backgroundColor: "var(--bg-tertiary)",
          padding: "10px 14px",
          borderRadius: "8px",
          border: "1px solid var(--border-color)",
          fontSize: "0.8rem",
        }}
      >
        <div>
          <span className="text-secondary">Songs Count: </span>
          <strong style={{ color: "var(--text-primary)" }}>
            {formData.total_songs > 0
              ? formData.songs_on_disk > formData.total_songs
                ? `${formData.songs_on_disk} downloaded (${formData.total_songs} in playlist)`
                : `${formData.songs_on_disk} / ${formData.total_songs} downloaded`
              : `${formData.songs_on_disk} downloaded`}
          </strong>
        </div>


        <div>
          <span className="text-secondary">Effective Format: </span>
          <strong style={{ color: "var(--accent-purple-hover)" }}>{effectiveFormat}</strong>
        </div>

        <div>
          <span className="text-secondary">Archive Status: </span>
          <strong>{effectiveArchive ? "Active (archive.txt)" : "Disabled"}</strong>
        </div>

        {formData.artist && (
          <div>
            <span className="text-secondary">Uploader/Artist: </span>
            <span>{formData.artist}</span>
          </div>
        )}

        {formData.last_download_at && (
          <div style={{ gridColumn: "span 2" }}>
            <span className="text-secondary">Last Download: </span>
            <span>{new Date(formData.last_download_at).toLocaleString()}</span>
          </div>
        )}
      </div>

      {/* Bottom Actions Row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "4px" }}>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handleSave}
          disabled={isSaving}
          style={{ padding: "6px 16px", fontSize: "0.82rem" }}
        >
          {isSaving ? "Saving..." : "💾 Save Changes"}
        </button>

        <div style={{ display: "flex", gap: "8px" }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onDeleteEntry(formData.id)}
            style={{ padding: "4px 10px", fontSize: "0.78rem", color: "var(--text-secondary)" }}
            title="Deletes only this entry from downloads management list. Files remain on disk."
          >
            🗑 Delete Entry
          </button>

          <button
            type="button"
            className="btn btn-danger"
            onClick={handleOpenDeleteFilesModal}
            style={{ padding: "4px 10px", fontSize: "0.78rem" }}
            title="Deletes all downloaded audio files for this playlist entry from disk and clears archive IDs"
          >
            ⚠️ Delete Files from Disk
          </button>
        </div>
      </div>

      {/* Delete Files Blatant Warning Modal */}
      {showDeleteModal && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.8)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1100,
            backdropFilter: "blur(5px)",
          }}
        >
          <div
            className="card"
            style={{
              width: "580px",
              maxWidth: "92vw",
              maxHeight: "85vh",
              display: "flex",
              flexDirection: "column",
              gap: "14px",
              margin: 0,
              border: "2px solid var(--danger)",
              boxShadow: "0 0 25px rgba(239, 68, 68, 0.3)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px", color: "var(--danger)" }}>
              <span style={{ fontSize: "1.6rem" }}>⚠️</span>
              <h2 style={{ fontSize: "1.15rem", margin: 0, color: "var(--danger)" }}>
                BLATANT WARNING: Delete Downloaded Files
              </h2>
            </div>

            <p style={{ fontSize: "0.88rem", color: "var(--text-primary)", margin: 0, lineHeight: 1.4 }}>
              Are you sure you want to permanently delete all downloaded files for entry <strong>"{formData.name}"</strong>?
              This operation will permanently erase files from disk and remove their records from <code style={{ fontFamily: "var(--font-mono)" }}>archive.txt</code>.
            </p>

            {isFetchingDeleteReport ? (
              <div style={{ padding: "20px", textAlign: "center", fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                Scanning folder for target files...
              </div>
            ) : deleteReport ? (
              <div>
                <div style={{ fontSize: "0.82rem", fontWeight: 600, marginBottom: "6px", display: "flex", justifyContent: "space-between" }}>
                  <span>Files to be deleted ({deleteReport.files.length} items):</span>
                  <span style={{ color: "var(--danger)" }}>Total Size: {formatBytes(deleteReport.total_bytes)}</span>
                </div>

                <div
                  style={{
                    maxHeight: "180px",
                    overflowY: "auto",
                    backgroundColor: "var(--bg-primary)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "6px",
                    padding: "8px",
                    fontSize: "0.75rem",
                    fontFamily: "var(--font-mono)",
                    lineHeight: 1.4,
                  }}
                >
                  {deleteReport.files.length === 0 ? (
                    <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>No matching files found in output directory.</span>
                  ) : (
                    deleteReport.files.map((f) => (
                      <div key={f} style={{ wordBreak: "break-all", color: "var(--text-secondary)" }}>
                        📄 {f}
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : null}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "8px" }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowDeleteModal(false)}
                disabled={isExecutingDeleteFiles}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleConfirmDeleteFiles}
                disabled={isExecutingDeleteFiles || (deleteReport?.files.length === 0)}
                style={{ padding: "8px 20px" }}
              >
                {isExecutingDeleteFiles ? "Deleting Files..." : "🚨 Yes, Delete All Files"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
