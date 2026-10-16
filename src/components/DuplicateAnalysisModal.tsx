import React, { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AudioTrack,
  DeleteDuplicatesResult,
  DuplicateAnalysisProgressPayload,
  DuplicateAnalysisReport,
  DuplicateGroup,
  DuplicateTrackEntry,
  PruneCacheReport,
} from "../types";
import { formatDuration, formatSize } from "../utils/formatters";

const formatEta = (seconds: number | null | undefined): string => {
  if (seconds === null || seconds === undefined || isNaN(seconds) || seconds < 0) {
    return "Estimating ETA...";
  }
  if (seconds === 0) {
    return "Complete";
  }
  if (seconds < 1) {
    return "Almost done (< 1s)";
  }
  if (seconds < 5) {
    return "< 5s remaining";
  }
  if (seconds < 60) {
    return `~${Math.round(seconds)}s remaining`;
  }
  const mins = Math.floor(seconds / 60);
  const remainingSecs = Math.round(seconds % 60);
  if (mins < 60) {
    return remainingSecs > 0 ? `~${mins}m ${remainingSecs}s remaining` : `~${mins}m remaining`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `~${hours}h ${remMins}m remaining` : `~${hours}h remaining`;
};

type DuplicateAnalysisModalProps = {
  isOpen: boolean;
  onClose: () => void;
  configPath: string;
  playlistIndex: number | null; // null = Global across all playlists & workspace
  playlistName?: string;
  formats: string;
  onPlayTrack: (track: AudioTrack, queue: AudioTrack[], playlistName: string) => void;
};

export const DuplicateAnalysisModal: React.FC<DuplicateAnalysisModalProps> = ({
  isOpen,
  onClose,
  configPath,
  playlistIndex,
  playlistName,
  formats,
  onPlayTrack,
}) => {
  const [report, setReport] = useState<DuplicateAnalysisReport | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [analysisProgress, setAnalysisProgress] = useState<DuplicateAnalysisProgressPayload | null>(null);
  const [error, setError] = useState<string>("");
  const [computeAcoustic, setComputeAcoustic] = useState<boolean>(true);
  const [maxAcousticSecs, setMaxAcousticSecs] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("max_acoustic_secs");
      return saved ? Math.max(20, Math.min(120, parseInt(saved, 10))) : 60;
    } catch (e) {
      return 60;
    }
  });
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [pruneStatus, setPruneStatus] = useState<string>("");
  const [isPruning, setIsPruning] = useState<boolean>(false);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [actionStatus, setActionStatus] = useState<string>("");

  useEffect(() => {
    if (!isOpen) return;
    let unlisten: (() => void) | null = null;
    let isMounted = true;

    const setupListener = async () => {
      try {
        const u = await listen<DuplicateAnalysisProgressPayload>(
          "duplicate-analysis-progress",
          (event) => {
            if (isMounted) {
              setAnalysisProgress(event.payload);
            }
          }
        );
        if (isMounted) {
          unlisten = u;
        } else {
          u();
        }
      } catch (e) {
        console.error("Failed to attach duplicate progress listener:", e);
      }
    };

    setupListener();

    return () => {
      isMounted = false;
      if (unlisten) {
        unlisten();
      }
      invoke("cancel_any_task", { taskId: "duplicate_analysis" }).catch(() => {});
    };
  }, [isOpen]);

  const handleClose = () => {
    if (isLoading) {
      invoke("cancel_any_task", { taskId: "duplicate_analysis" }).catch(() => {});
    }
    onClose();
  };

  const runAnalysis = async (acousticOverride?: boolean, maxSecsOverride?: number) => {
    if (!configPath) return;
    setIsLoading(true);
    setError("");
    setPruneStatus("");
    setAnalysisProgress(null);
    try {
      const useAcoustic = acousticOverride !== undefined ? acousticOverride : computeAcoustic;
      const maxSecs = maxSecsOverride !== undefined ? maxSecsOverride : maxAcousticSecs;
      const res = await invoke<DuplicateAnalysisReport>("analyze_playlist_duplicates", {
        taskId: "duplicate_analysis",
        configPath,
        sourceDirOverride: null,
        playlistIndex: playlistIndex,
        formats,
        computeAcoustic: useAcoustic,
        maxAcousticSeconds: maxSecs,
      });
      setReport(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && configPath) {
      runAnalysis();
    }
  }, [isOpen, configPath, playlistIndex]);

  const handlePruneCache = async (clearAll = false) => {
    setIsPruning(true);
    setPruneStatus("");
    try {
      const res = await invoke<PruneCacheReport>("prune_fingerprint_cache", {
        clearAll,
      });
      if (clearAll) {
        setPruneStatus(`Cleared ${res.pruned_count} cached fingerprints.`);
      } else {
        setPruneStatus(
          `Pruned ${res.pruned_count} stale entries (${res.remaining_count} active entries remain).`
        );
      }
      runAnalysis();
    } catch (e) {
      setPruneStatus(`Cache prune error: ${e}`);
    } finally {
      setIsPruning(false);
    }
  };

  const handleRevealInFinder = async (filePath: string) => {
    try {
      await invoke("reveal_in_finder", { filePath });
    } catch (e) {
      alert("Error revealing file: " + e);
    }
  };

  const handleDeleteAllDuplicates = async () => {
    if (!report || report.redundant_files_count === 0 || isDeleting) return;

    const toDelete: string[] = [];
    let totalBytes = 0;
    for (const group of report.duplicate_groups) {
      for (const track of group.tracks) {
        if (!track.is_winner) {
          toDelete.push(track.file_path);
          totalBytes += track.size_bytes;
        }
      }
    }

    if (toDelete.length === 0) return;

    const confirmMsg = `Permanently delete all ${toDelete.length} redundant duplicate copies (${formatSize(totalBytes)}) from disk?\n\nThe kept winner of each group will be preserved. This operation cannot be undone.`;
    if (!window.confirm(confirmMsg)) return;

    setIsDeleting(true);
    setActionStatus("");
    try {
      const res = await invoke<DeleteDuplicatesResult>("delete_duplicate_files", {
        filePaths: toDelete,
      });

      if (res.errors.length > 0) {
        alert(
          `Deleted ${res.deleted_count} duplicate files (${formatSize(res.freed_bytes)} freed), but encountered ${res.failed_count} errors:\n\n${res.errors.slice(0, 5).join("\n")}`
        );
      }

      setActionStatus(`Deleted ${res.deleted_count} duplicate file(s) and freed ${formatSize(res.freed_bytes)} of disk space.`);
      await runAnalysis();
    } catch (e) {
      alert(`Error deleting duplicates: ${e}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleKeepThisAndDeleteOthers = async (group: DuplicateGroup, keepTrack: DuplicateTrackEntry) => {
    if (isDeleting) return;
    const otherTracks = group.tracks.filter((t) => t.file_path !== keepTrack.file_path);
    if (otherTracks.length === 0) return;

    const fileName = keepTrack.file_path.split(/[/\\]/).pop() || keepTrack.title;
    const otherFilesList = otherTracks
      .map((t) => `• ${t.file_path.split(/[/\\]/).pop() || t.title} (${formatSize(t.size_bytes)})`)
      .join("\n");
    const otherBytes = otherTracks.reduce((sum, t) => sum + t.size_bytes, 0);

    const confirmMsg = `Keep this track and permanently delete the other ${otherTracks.length} duplicate copy(ies) from disk?\n\nKEPT:\n• ${fileName}\n\nDELETE FROM DISK (${formatSize(otherBytes)} freed):\n${otherFilesList}`;
    if (!window.confirm(confirmMsg)) return;

    setIsDeleting(true);
    setActionStatus("");
    try {
      const filePaths = otherTracks.map((t) => t.file_path);
      const res = await invoke<DeleteDuplicatesResult>("delete_duplicate_files", {
        filePaths,
      });

      if (res.errors.length > 0) {
        alert(`Failed to delete some files:\n\n${res.errors.join("\n")}`);
      }

      setActionStatus(`Kept "${fileName}" and deleted ${res.deleted_count} duplicate file(s) (${formatSize(res.freed_bytes)} freed).`);

      // Immediately remove this group from the report view
      setReport((prev) => {
        if (!prev) return null;
        const remainingGroups = prev.duplicate_groups.filter((g) => g.group_id !== group.group_id);
        return {
          ...prev,
          duplicate_groups: remainingGroups,
          redundant_files_count: Math.max(0, prev.redundant_files_count - otherTracks.length),
          redundant_bytes: Math.max(0, prev.redundant_bytes - otherBytes),
        };
      });
    } catch (e) {
      alert(`Error deleting duplicate files: ${e}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const handlePlayGroupTrack = (group: DuplicateGroup, entry: DuplicateTrackEntry) => {
    const queue: AudioTrack[] = group.tracks.map((t) => ({
      file_path: t.file_path,
      title: `${t.title} [${t.is_winner ? "KEPT" : "SKIPPED"} • ${t.format_ext}]`,
      artist: t.artist || t.source_folder,
      duration: t.duration,
    }));
    const target: AudioTrack = {
      file_path: entry.file_path,
      title: `${entry.title} [${entry.is_winner ? "KEPT" : "SKIPPED"} • ${entry.format_ext}]`,
      artist: entry.artist || entry.source_folder,
      duration: entry.duration,
    };
    onPlayTrack(target, queue, `Duplicates: ${group.canonical_title}`);
  };

  const filteredGroups = useMemo(() => {
    if (!report) return [];
    const q = searchQuery.trim().toLowerCase();
    return report.duplicate_groups.filter((g) => {
      if (tierFilter !== "all" && g.match_tier !== tierFilter) {
        return false;
      }
      if (!q) return true;
      if (
        g.canonical_title.toLowerCase().includes(q) ||
        g.canonical_artist.toLowerCase().includes(q) ||
        g.match_label.toLowerCase().includes(q)
      ) {
        return true;
      }
      return g.tracks.some(
        (t) =>
          t.relative_path.toLowerCase().includes(q) ||
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          t.source_folder.toLowerCase().includes(q)
      );
    });
  }, [report, searchQuery, tierFilter]);

  if (!isOpen) return null;

  const getTierBadgeStyle = (tier: string) => {
    switch (tier) {
      case "exact_hash":
        return {
          bg: "rgba(34, 197, 94, 0.15)",
          color: "var(--success)",
          border: "rgba(34, 197, 94, 0.35)",
          icon: "📦",
        };
      case "youtube_id":
        return {
          bg: "rgba(239, 68, 68, 0.15)",
          color: "#f87171",
          border: "rgba(239, 68, 68, 0.35)",
          icon: "🆔",
        };
      case "acoustic":
        return {
          bg: "rgba(138, 92, 246, 0.18)",
          color: "var(--accent-purple-hover)",
          border: "rgba(138, 92, 246, 0.4)",
          icon: "🎧",
        };
      default:
        return {
          bg: "rgba(245, 158, 11, 0.15)",
          color: "var(--warning)",
          border: "rgba(245, 158, 11, 0.35)",
          icon: "🏷️",
        };
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: "74px",
        backgroundColor: "rgba(0, 0, 0, 0.78)",
        backdropFilter: "blur(5px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1100,
        padding: "20px",
      }}
      onClick={handleClose}
    >
      <div
        className="card"
        style={{
          width: "960px",
          maxWidth: "96vw",
          height: "84vh",
          maxHeight: "820px",
          margin: 0,
          padding: "18px 22px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          overflow: "hidden",
          boxShadow: "0 20px 50px rgba(0,0,0,0.6)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: "1px solid var(--border-color)",
            paddingBottom: "12px",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <h2 style={{ margin: 0, fontSize: "1.2rem", display: "flex", alignItems: "center", gap: "8px" }}>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ color: "var(--accent-purple)" }}
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span>Duplicate Songs Analysis</span>
              </h2>
              <span
                style={{
                  fontSize: "0.75rem",
                  padding: "2px 8px",
                  borderRadius: "12px",
                  backgroundColor: "rgba(138, 92, 246, 0.15)",
                  color: "var(--accent-purple-hover)",
                  border: "1px solid rgba(138, 92, 246, 0.35)",
                  fontWeight: 600,
                }}
              >
                {playlistIndex !== null
                  ? `Playlist: ${playlistName || `#${playlistIndex + 1}`}`
                  : "Global (All Playlists & Workspace)"}
              </span>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                backgroundColor: "var(--bg-tertiary)",
                border: "1px solid var(--border-color)",
                borderRadius: "6px",
                padding: "3px 6px",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: "0.78rem",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  userSelect: "none",
                  padding: "1px 4px",
                }}
                title="Progressive Acoustic Scan: Detects duplicates even with intro/outro ads, transcoding differences, or duration offsets"
              >
                <input
                  type="checkbox"
                  checked={computeAcoustic}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setComputeAcoustic(next);
                    runAnalysis(next, maxAcousticSecs);
                  }}
                  style={{ cursor: "pointer", accentColor: "var(--accent-purple)" }}
                />
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 18v-6a9 9 0 0 1 18 0v6"></path>
                  <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path>
                </svg>
                <span>Acoustic</span>
              </label>

              {computeAcoustic && (
                <div style={{ display: "flex", alignItems: "center", borderLeft: "1px solid var(--border-color)", paddingLeft: "6px" }}>
                  <select
                    value={maxAcousticSecs}
                    onChange={(e) => {
                      const next = parseInt(e.target.value, 10);
                      setMaxAcousticSecs(next);
                      try {
                        localStorage.setItem("max_acoustic_secs", String(next));
                      } catch {}
                      runAnalysis(computeAcoustic, next);
                    }}
                    style={{
                      fontSize: "0.74rem",
                      padding: "2px 6px",
                      borderRadius: "4px",
                      backgroundColor: "var(--bg-surface)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-color)",
                      cursor: "pointer",
                      outline: "none",
                    }}
                    title="Progressive Verification Depth: If the intro matches, progressively verifies subsequent seconds up to this maximum duration to eliminate false positives."
                  >
                    <option value={20}>Progressive: up to 20s (Fast)</option>
                    <option value={40}>Progressive: up to 40s</option>
                    <option value={60}>Progressive: up to 60s (Recommended)</option>
                    <option value={90}>Progressive: up to 90s (Deep)</option>
                    <option value={120}>Progressive: up to 120s (Full 2m)</option>
                  </select>
                </div>
              )}
            </div>

            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => handlePruneCache(false)}
              disabled={isLoading || isPruning}
              style={{
                width: "30px",
                height: "30px",
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "6px",
              }}
              title="Prune Stale Cache (cleans deleted files from fingerprint cache)"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z"/>
                <path d="m5 2 5 5"/>
                <path d="M2 13h15"/>
                <path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z"/>
              </svg>
            </button>

            {report && report.redundant_files_count > 0 && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleDeleteAllDuplicates}
                disabled={isLoading || isDeleting}
                style={{
                  width: "30px",
                  height: "30px",
                  padding: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "6px",
                  backgroundColor: "rgba(239, 68, 68, 0.15)",
                  border: "1px solid var(--danger)",
                  color: "var(--danger)",
                  cursor: isDeleting ? "not-allowed" : "pointer",
                }}
                title={`Delete all dups found: Permanently delete all ${report.redundant_files_count} redundant duplicate copies (${formatSize(report.redundant_bytes)}) from disk, preserving the chosen winner of each group`}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  <line x1="10" y1="11" x2="10" y2="17"></line>
                  <line x1="14" y1="11" x2="14" y2="17"></line>
                </svg>
              </button>
            )}

            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => runAnalysis()}
              disabled={isLoading || isDeleting}
              style={{
                width: "30px",
                height: "30px",
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "6px",
              }}
              title="Rescan duplicates"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={isLoading ? { animation: "spin 1s linear infinite" } : undefined}
              >
                <path d="M23 4v6h-6" />
                <path d="M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>

            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleClose}
              style={{
                width: "30px",
                height: "30px",
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "6px",
              }}
              title="Close duplicate analysis"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>

        {/* Summary Metrics Bar */}
        {report && !isLoading && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "10px" }}>
            <div
              style={{
                backgroundColor: "var(--bg-tertiary)",
                border: "1px solid var(--border-color)",
                borderRadius: "8px",
                padding: "8px 12px",
              }}
            >
              <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600 }}>
                Scanned Tracks
              </div>
              <div style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--text-primary)", marginTop: "2px" }}>
                {report.total_scanned_files} files
              </div>
            </div>

            <div
              style={{
                backgroundColor: "var(--bg-tertiary)",
                border: "1px solid var(--border-color)",
                borderRadius: "8px",
                padding: "8px 12px",
              }}
            >
              <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600 }}>
                Duplicate Songs
              </div>
              <div
                style={{
                  fontSize: "1.05rem",
                  fontWeight: 700,
                  color: report.duplicate_groups.length > 0 ? "var(--warning)" : "var(--success)",
                  marginTop: "2px",
                }}
              >
                {report.duplicate_groups.length} groups
              </div>
            </div>

            <div
              style={{
                backgroundColor: "var(--bg-tertiary)",
                border: "1px solid var(--border-color)",
                borderRadius: "8px",
                padding: "8px 12px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600 }}>
                  Skipped Redundant Copies
                </span>
                {report.redundant_files_count > 0 && (
                  <button
                    type="button"
                    onClick={handleDeleteAllDuplicates}
                    disabled={isLoading || isDeleting}
                    style={{
                      background: "rgba(239, 68, 68, 0.15)",
                      border: "1px solid var(--danger)",
                      color: "var(--danger)",
                      borderRadius: "4px",
                      cursor: isDeleting ? "not-allowed" : "pointer",
                      padding: "2px 5px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      lineHeight: 1,
                    }}
                    title={`Delete all duplicates found: Permanently delete all ${report.redundant_files_count} redundant duplicate copies (${formatSize(report.redundant_bytes)}) from disk, preserving the kept winner of each group`}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                  </button>
                )}
              </div>
              <div style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--text-primary)", marginTop: "2px" }}>
                {report.redundant_files_count} files ({formatSize(report.redundant_bytes)})
              </div>
            </div>

            <div
              style={{
                backgroundColor: "var(--bg-tertiary)",
                border: "1px solid var(--border-color)",
                borderRadius: "8px",
                padding: "8px 12px",
              }}
              title="SQLite fingerprint cache entries (automatically skips deleted files)"
            >
              <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600 }}>
                Fingerprint Cache
              </div>
              <div style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--accent-purple-hover)", marginTop: "2px" }}>
                {report.cache_total_entries} cached
                {report.cache_stale_pruned > 0 ? ` (${report.cache_stale_pruned} pruned)` : ""}
              </div>
            </div>
          </div>
        )}

        {actionStatus && (
          <div
            style={{
              fontSize: "0.78rem",
              padding: "6px 12px",
              borderRadius: "6px",
              backgroundColor: "rgba(34, 197, 94, 0.12)",
              border: "1px solid rgba(34, 197, 94, 0.3)",
              color: "var(--success)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>{actionStatus}</span>
            <button
              type="button"
              onClick={() => setActionStatus("")}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-secondary)",
                cursor: "pointer",
                padding: "0 4px",
                fontSize: "0.85rem",
                lineHeight: 1,
              }}
              title="Dismiss notification"
            >
              ✕
            </button>
          </div>
        )}

        {pruneStatus && (
          <div
            style={{
              fontSize: "0.78rem",
              padding: "6px 12px",
              borderRadius: "6px",
              backgroundColor: "rgba(34, 197, 94, 0.12)",
              border: "1px solid rgba(34, 197, 94, 0.3)",
              color: "var(--success)",
            }}
          >
            {pruneStatus}
          </div>
        )}

        {/* Filter & Search Bar */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" }}>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {[
              {
                key: "all",
                title: "All Types: View all duplicate groups",
                icon: (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                    <polyline points="2 17 12 22 22 17"></polyline>
                    <polyline points="2 12 12 17 22 12"></polyline>
                  </svg>
                ),
              },
              {
                key: "exact_hash",
                title: "Exact Audio: Identical decoded audio stream hash",
                icon: (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="4" y1="9" x2="20" y2="9"></line>
                    <line x1="4" y1="15" x2="20" y2="15"></line>
                    <line x1="10" y1="3" x2="8" y2="21"></line>
                    <line x1="16" y1="3" x2="14" y2="21"></line>
                  </svg>
                ),
              },
              {
                key: "youtube_id",
                title: "Same YouTube ID: Video ID embedded in metadata or filename",
                icon: (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="4" width="20" height="16" rx="2.18" ry="2.18"></rect>
                    <polygon points="10 8 16 12 10 16 10 8" fill="currentColor"></polygon>
                  </svg>
                ),
              },
              {
                key: "acoustic",
                title: "Acoustic / Ad Offset: Sliding spectral fingerprint match (detects intro/outro ads)",
                icon: (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 18v-6a9 9 0 0 1 18 0v6"></path>
                    <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path>
                  </svg>
                ),
              },
              {
                key: "metadata",
                title: "Title & Artist: Normalized alphanumeric tag match",
                icon: (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
                    <line x1="7" y1="7" x2="7.01" y2="7"></line>
                  </svg>
                ),
              },
            ].map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`btn ${tierFilter === tab.key ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setTierFilter(tab.key)}
                style={{
                  width: "30px",
                  height: "30px",
                  padding: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "6px",
                }}
                title={tab.title}
              >
                {tab.icon}
              </button>
            ))}
          </div>

          <div style={{ width: "240px" }}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="🔍 Filter duplicates..."
              style={{ padding: "5px 10px", fontSize: "0.8rem", width: "100%" }}
            />
          </div>
        </div>

        {/* Main Content List */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            paddingRight: "4px",
          }}
        >
          {isLoading ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "30px 20px",
              }}
            >
              <div
                style={{
                  width: "560px",
                  maxWidth: "92vw",
                  backgroundColor: "var(--bg-secondary)",
                  border: "1px solid var(--border-color)",
                  borderRadius: "14px",
                  padding: "24px 28px",
                  boxShadow: "var(--shadow-md)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "16px",
                  boxSizing: "border-box",
                }}
              >
                {/* Header row */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", minHeight: "42px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        width: "38px",
                        height: "38px",
                        borderRadius: "10px",
                        backgroundColor: "var(--accent-purple-glow)",
                        border: "1px solid var(--border-color)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "var(--accent-purple)",
                        flexShrink: 0,
                      }}
                    >
                      <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ animation: "spin 1.2s linear infinite" }}
                      >
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                      </svg>
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        style={{
                          fontSize: "0.95rem",
                          fontWeight: 600,
                          color: "var(--text-primary)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {analysisProgress?.phase_label || "Analyzing tracks & computing fingerprints..."}
                      </div>
                      <div
                        style={{
                          fontSize: "0.78rem",
                          color: "var(--text-secondary)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {analysisProgress?.phase === "clustering"
                          ? "Clustering pairwise duplicates & transitive matches"
                          : "Deterministic stream hash, YouTube ID, & acoustic verification"}
                      </div>
                    </div>
                  </div>

                  {/* Percentage counter */}
                  <div style={{ textAlign: "right", flexShrink: 0, minWidth: "64px" }}>
                    <div
                      style={{
                        fontSize: "1.5rem",
                        fontWeight: 700,
                        color: "var(--accent-purple)",
                        fontVariantNumeric: "tabular-nums",
                        lineHeight: 1,
                      }}
                    >
                      {(analysisProgress?.progress ?? 0).toFixed(0)}%
                    </div>
                  </div>
                </div>

                {/* Progress bar container */}
                <div
                  style={{
                    width: "100%",
                    height: "10px",
                    backgroundColor: "var(--bg-surface)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "999px",
                    overflow: "hidden",
                    position: "relative",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.max(2, Math.min(100, analysisProgress?.progress ?? 0))}%`,
                      height: "100%",
                      background: "linear-gradient(90deg, var(--accent-indigo), var(--accent-purple))",
                      borderRadius: "999px",
                      transition: "width 0.6s ease-out",
                    }}
                  />
                </div>

                {/* Stats & ETA row */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "nowrap",
                    gap: "8px",
                    height: "28px",
                    fontSize: "0.8rem",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", color: "var(--text-secondary)", minWidth: 0, overflow: "hidden" }}>
                    <span style={{ fontWeight: 600, color: "var(--text-primary)", whiteSpace: "nowrap" }}>
                      {analysisProgress
                        ? `${analysisProgress.current} / ${analysisProgress.total} tracks`
                        : "Counting tracks..."}
                    </span>
                    {analysisProgress && analysisProgress.speed > 0 && (
                      <span
                        style={{
                          backgroundColor: "var(--bg-tertiary)",
                          border: "1px solid var(--border-color)",
                          padding: "2px 8px",
                          borderRadius: "4px",
                          fontSize: "0.75rem",
                          color: "var(--text-secondary)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        ⚡ {analysisProgress.speed.toFixed(1)} files/sec
                      </span>
                    )}
                  </div>

                  {/* Human ETA badge */}
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      backgroundColor: "var(--accent-purple-glow)",
                      border: "1px solid var(--border-color)",
                      color: "var(--accent-purple)",
                      padding: "3px 10px",
                      borderRadius: "6px",
                      fontWeight: 600,
                      fontSize: "0.78rem",
                      flexShrink: 0,
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span>⏱</span>
                    <span>{formatEta(analysisProgress?.eta_secs)}</span>
                  </div>
                </div>

                {/* Current file scanning */}
                <div
                  style={{
                    backgroundColor: "var(--bg-tertiary)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "6px",
                    height: "36px",
                    boxSizing: "border-box",
                    padding: "0 12px",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    fontSize: "0.76rem",
                    color: "var(--text-secondary)",
                    minWidth: 0,
                  }}
                >
                  <span style={{ flexShrink: 0, color: "var(--text-muted)" }}>Scanning:</span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--text-primary)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      minWidth: 0,
                    }}
                    title={analysisProgress?.current_file || undefined}
                  >
                    {analysisProgress?.current_file || "Reading tracks from workspace & playlists..."}
                  </span>
                </div>

                {/* Helpful footnote */}
                <div
                  style={{
                    fontSize: "0.72rem",
                    color: "var(--text-muted)",
                    textAlign: "center",
                    lineHeight: 1.4,
                  }}
                >
                  Deterministic duplicate analysis computes exact audio hashes, YouTube IDs, normalized metadata tags, and sliding acoustic fingerprints. Cached fingerprints skip re-computation on subsequent runs.
                </div>
              </div>
            </div>
          ) : error ? (
            <div className="no-data" style={{ color: "var(--danger)" }}>
              Error analyzing duplicates: {error}
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="no-data" style={{ padding: "48px 20px" }}>
              {report && report.duplicate_groups.length === 0
                ? "✅ No duplicate songs detected in this scope!"
                : "No duplicate groups match your current filter."}
            </div>
          ) : (
            filteredGroups.map((group, gIdx) => {
              const badge = getTierBadgeStyle(group.match_tier);
              return (
                <div
                  key={group.group_id}
                  style={{
                    backgroundColor: "var(--bg-tertiary)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "8px",
                    overflow: "hidden",
                    flexShrink: 0,
                  }}
                >
                  {/* Group Header */}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "8px 12px",
                      backgroundColor: "var(--bg-surface)",
                      borderBottom: "1px solid var(--border-color)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: "0.72rem",
                          fontFamily: "var(--font-mono)",
                          color: "var(--text-secondary)",
                          fontWeight: 600,
                        }}
                      >
                        #{gIdx + 1}
                      </span>
                      <span
                        style={{
                          fontWeight: 700,
                          fontSize: "0.9rem",
                          color: "var(--text-primary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {group.canonical_title}
                      </span>
                      {group.canonical_artist && (
                        <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                          — {group.canonical_artist}
                        </span>
                      )}
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                      <span
                        style={{
                          fontSize: "0.72rem",
                          padding: "2px 8px",
                          borderRadius: "10px",
                          backgroundColor: badge.bg,
                          color: badge.color,
                          border: `1px solid ${badge.border}`,
                          fontWeight: 600,
                        }}
                      >
                        {badge.icon} {group.match_label} ({group.confidence}%)
                      </span>
                    </div>
                  </div>

                  {/* Tracks inside group table */}
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                      <thead>
                        <tr
                          style={{
                            borderBottom: "1px solid var(--border-color)",
                            backgroundColor: "var(--bg-surface)",
                            color: "var(--text-secondary)",
                            fontSize: "0.68rem",
                            textTransform: "uppercase",
                            letterSpacing: "0.5px",
                          }}
                        >
                          <th style={{ width: "34px", padding: "6px 8px", textAlign: "center" }}></th>
                          <th style={{ width: "95px", padding: "6px 8px", textAlign: "left" }}>Status</th>
                          <th style={{ padding: "6px 8px", textAlign: "left" }}>File Name</th>
                          <th style={{ width: "160px", padding: "6px 8px", textAlign: "left" }}>Source Folder</th>
                          <th style={{ width: "125px", padding: "6px 8px", textAlign: "right" }}>Format</th>
                          <th style={{ width: "65px", padding: "6px 8px", textAlign: "right" }}>Duration</th>
                          <th style={{ width: "75px", padding: "6px 8px", textAlign: "right" }}>Size</th>
                          <th style={{ width: "68px", padding: "6px 8px", textAlign: "center" }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.tracks.map((t, tIdx) => {
                          const fileName = t.file_path.split(/[/\\]/).pop() || t.title;
                          return (
                            <tr
                              key={tIdx}
                              className={t.is_winner ? "row-winner" : undefined}
                              data-winner={t.is_winner}
                              style={{
                                borderBottom: tIdx < group.tracks.length - 1 ? "1px solid var(--border-color)" : "none",
                              }}
                            >
                              {/* 1. Play Button */}
                              <td style={{ padding: "6px 8px", textAlign: "center", verticalAlign: "middle" }}>
                                <button
                                  type="button"
                                  className="btn btn-secondary"
                                  onClick={() => handlePlayGroupTrack(group, t)}
                                  style={{
                                    width: "24px",
                                    height: "24px",
                                    padding: 0,
                                    borderRadius: "50%",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    backgroundColor: "var(--accent-purple)",
                                    color: "#fff",
                                    border: "none",
                                    cursor: "pointer",
                                  }}
                                  title={`Play "${fileName}"`}
                                >
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                                  </svg>
                                </button>
                              </td>

                              {/* 2. Status Badge */}
                              <td style={{ padding: "6px 8px", textAlign: "left", verticalAlign: "middle" }}>
                                {t.is_winner ? (
                                  <span
                                    style={{
                                      fontSize: "0.68rem",
                                      padding: "2px 6px",
                                      borderRadius: "4px",
                                      backgroundColor: "rgba(34, 197, 94, 0.16)",
                                      color: "var(--success)",
                                      border: "1px solid rgba(34, 197, 94, 0.4)",
                                      fontWeight: 700,
                                      whiteSpace: "nowrap",
                                      display: "inline-block",
                                    }}
                                    title={`Kept as Superior File: ${t.winner_reason}`}
                                  >
                                    🏆 KEPT
                                  </span>
                                ) : (
                                  <span
                                    style={{
                                      fontSize: "0.68rem",
                                      padding: "2px 6px",
                                      borderRadius: "4px",
                                      backgroundColor: "rgba(239, 68, 68, 0.12)",
                                      color: "var(--text-secondary)",
                                      border: "1px solid var(--border-color)",
                                      fontWeight: 600,
                                      whiteSpace: "nowrap",
                                      display: "inline-block",
                                    }}
                                    title={`Skipped duplicate (${t.winner_reason})`}
                                  >
                                    ⏭️ SKIPPED
                                  </span>
                                )}
                              </td>

                              {/* 3. File Name (Hover shows full path) */}
                              <td style={{ padding: "6px 8px", textAlign: "left", verticalAlign: "middle", minWidth: 0 }}>
                                <div
                                  style={{
                                    fontSize: "0.82rem",
                                    fontWeight: 600,
                                    fontFamily: "var(--font-mono)",
                                    color: t.is_winner ? "var(--text-primary)" : "var(--text-secondary)",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    cursor: "pointer",
                                  }}
                                  title={t.file_path}
                                >
                                  {fileName}
                                </div>
                                {t.playlist_names.length > 0 && playlistIndex === null && (
                                  <div
                                    style={{
                                      fontSize: "0.68rem",
                                      color: "var(--text-secondary)",
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                      marginTop: "1px",
                                    }}
                                    title={t.playlist_names.join(", ")}
                                  >
                                    🎶 {t.playlist_names.join(", ")}
                                  </div>
                                )}
                              </td>

                              {/* 4. Source Folder */}
                              <td style={{ padding: "6px 8px", textAlign: "left", verticalAlign: "middle" }}>
                                <span
                                  style={{
                                    fontSize: "0.72rem",
                                    color: "var(--text-secondary)",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    display: "block",
                                  }}
                                  title={`Source folder: ${t.source_folder}`}
                                >
                                  📁 {t.source_folder}
                                </span>
                              </td>

                              {/* 5. Format & Bitrate (with optional ad offset) */}
                              <td style={{ padding: "6px 8px", textAlign: "right", verticalAlign: "middle", whiteSpace: "nowrap" }}>
                                {t.offset_secs !== undefined && t.offset_secs !== null && Math.abs(t.offset_secs) >= 1 && (
                                  <span
                                    style={{
                                      fontSize: "0.68rem",
                                      padding: "1px 5px",
                                      borderRadius: "4px",
                                      backgroundColor: "rgba(245, 158, 11, 0.16)",
                                      color: "var(--warning)",
                                      border: "1px solid rgba(245, 158, 11, 0.35)",
                                      fontFamily: "var(--font-mono)",
                                      marginRight: "4px",
                                    }}
                                    title="Duration difference compared to kept version (e.g. extra intro/outro ad)"
                                  >
                                    {t.offset_secs > 0 ? `+${t.offset_secs.toFixed(0)}s` : `${t.offset_secs.toFixed(0)}s`}
                                  </span>
                                )}
                                <span
                                  style={{
                                    fontSize: "0.7rem",
                                    padding: "2px 6px",
                                    borderRadius: "4px",
                                    backgroundColor: "var(--bg-primary)",
                                    border: "1px solid var(--border-color)",
                                    fontFamily: "var(--font-mono)",
                                    color: "var(--text-primary)",
                                  }}
                                  title={`Format: ${t.format_ext} | Bitrate: ${t.bitrate_kbps} kbps`}
                                >
                                  {t.format_ext} {t.bitrate_kbps > 0 ? `• ${t.bitrate_kbps}k` : ""}
                                </span>
                              </td>

                              {/* 6. Duration */}
                              <td
                                style={{
                                  padding: "6px 8px",
                                  textAlign: "right",
                                  verticalAlign: "middle",
                                  fontSize: "0.74rem",
                                  fontFamily: "var(--font-mono)",
                                  color: "var(--text-secondary)",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {formatDuration(t.duration)}
                              </td>

                              {/* 7. Size */}
                              <td
                                style={{
                                  padding: "6px 8px",
                                  textAlign: "right",
                                  verticalAlign: "middle",
                                  fontSize: "0.72rem",
                                  fontFamily: "var(--font-mono)",
                                  color: "var(--text-secondary)",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {formatSize(t.size_bytes)}
                              </td>

                              {/* 8. Actions: Keep this & delete others, Reveal in Finder */}
                              <td style={{ padding: "6px 8px", textAlign: "center", verticalAlign: "middle", whiteSpace: "nowrap" }}>
                                <div style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() => handleKeepThisAndDeleteOthers(group, t)}
                                    disabled={isDeleting || group.tracks.length <= 1}
                                    style={{
                                      width: "24px",
                                      height: "24px",
                                      padding: 0,
                                      display: "inline-flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      borderRadius: "4px",
                                      backgroundColor: t.is_winner ? "rgba(34, 197, 94, 0.18)" : "rgba(139, 92, 246, 0.12)",
                                      borderColor: t.is_winner ? "rgba(34, 197, 94, 0.45)" : "rgba(139, 92, 246, 0.35)",
                                      color: t.is_winner ? "var(--success)" : "var(--accent-purple)",
                                      cursor: isDeleting ? "not-allowed" : "pointer",
                                    }}
                                    title={`Keep this, and delete others: Keep "${fileName}" and permanently delete the other ${group.tracks.length - 1} duplicate copy(ies) in this group from disk`}
                                  >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                                      <polyline points="22 4 12 14.01 9 11.01" />
                                    </svg>
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() => handleRevealInFinder(t.file_path)}
                                    style={{
                                      width: "24px",
                                      height: "24px",
                                      padding: 0,
                                      display: "inline-flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      borderRadius: "4px",
                                    }}
                                    title={`Reveal in Finder: ${t.file_path}`}
                                  >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                                    </svg>
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
