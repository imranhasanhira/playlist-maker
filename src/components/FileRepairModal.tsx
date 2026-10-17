import React, { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  MainConfig,
  Mp3UpgradeScanReport,
  Mp3UpgradeProgressPayload,
  Mp3UpgradeExecutionReport,
  Mp3UpgradeResultItem,
} from "../types";
import { formatSize } from "../utils/formatters";
import { ConfirmModal } from "./common/ConfirmModal";

export type FileRepairModalProps = {
  isOpen: boolean;
  onClose: () => void;
  config: MainConfig | null;
  initialFolder?: string;
  playlistName?: string;
};

export const FileRepairModal: React.FC<FileRepairModalProps> = ({
  isOpen,
  onClose,
  config,
  initialFolder,
  playlistName,
}) => {
  const defaultFolder = useMemo(() => {
    if (config?.workspaceDir) return config.workspaceDir.replace(/\\/g, "/");
    if (config?.sourceDir) return config.sourceDir.replace(/\\/g, "/");
    return "";
  }, [config]);

  const [folderPath, setFolderPath] = useState<string>(initialFolder || defaultFolder);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [checkMp3ToM4a, setCheckMp3ToM4a] = useState<boolean>(true);
  const [checkTagsParams, setCheckTagsParams] = useState<boolean>(true);
  const [checkCoverArt, setCheckCoverArt] = useState<boolean>(true);
  const [scanReport, setScanReport] = useState<Mp3UpgradeScanReport | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [deleteMp3OnSuccess, setDeleteMp3OnSuccess] = useState<boolean>(true);
  const [isRepairing, setIsRepairing] = useState<boolean>(false);
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);
  const [progress, setProgress] = useState<Mp3UpgradeProgressPayload | null>(null);
  const [executionReport, setExecutionReport] = useState<Mp3UpgradeExecutionReport | null>(null);
  const [activeTab, setActiveTab] = useState<"queue" | "report">("queue");
  const [reportFilter, setReportFilter] = useState<"all" | "failed" | "success">("all");
  const [searchFilter, setSearchFilter] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleOpenUrl = async (url: string) => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  };

  const handleScan = async (overrideFolder?: string, keepExecutionReport = false) => {
    const target = (overrideFolder || folderPath).trim();
    if (!target) return;
    setIsScanning(true);
    setErrorMsg("");
    setScanReport(null);
    if (!keepExecutionReport) {
      setExecutionReport(null);
      setActiveTab("queue");
    }
    setSelectedPaths(new Set());
    setProgress(null);

    try {
      const report = await invoke<Mp3UpgradeScanReport>("scan_mp3s_for_m4a_upgrade", {
        folderPath: target,
        checkMp3ToM4a,
        checkTagsParams,
        checkCoverArt,
      });
      setScanReport(report);
      // Pre-select candidates that need action (exclude those already converted to M4A unless missing params)
      const initialSelected = new Set(
        report.candidates.filter((c) => !c.m4a_already_exists || !c.is_mp3).map((c) => c.path)
      );
      setSelectedPaths(
        initialSelected.size > 0
          ? initialSelected
          : new Set(report.candidates.map((c) => c.path))
      );
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setIsScanning(false);
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<Mp3UpgradeProgressPayload>("mp3-upgrade-progress", (event) => {
      setProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const handleBrowseFolder = async () => {
    try {
      const selected = await invoke<string | null>("select_directory", {
        title: "Select Folder to Scan for File Repair",
      });
      if (selected) {
        const cleanPath = selected.replace(/\\/g, "/");
        setFolderPath(cleanPath);
        handleScan(cleanPath);
      }
    } catch (e) {
      console.error("Failed to select directory:", e);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    const target = initialFolder?.trim() || defaultFolder;
    if (target) {
      setFolderPath(target);
      handleScan(target);
    }
  }, [isOpen, initialFolder, defaultFolder]);

  const handleToggleSelect = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleSelectAll = (select: boolean) => {
    if (!scanReport) return;
    if (select) {
      setSelectedPaths(new Set(scanReport.candidates.map((c) => c.path)));
    } else {
      setSelectedPaths(new Set());
    }
  };

  const handleStartRepairClick = () => {
    if (!scanReport || selectedPaths.size === 0 || isRepairing) return;
    setShowConfirmModal(true);
  };

  const executeRepair = async () => {
    if (!scanReport || selectedPaths.size === 0 || isRepairing) return;

    const candidatesToRepair = scanReport.candidates.filter((c) =>
      selectedPaths.has(c.path)
    );

    setIsRepairing(true);
    setErrorMsg("");
    setExecutionReport(null);
    setProgress({
      current: 0,
      total: candidatesToRepair.length,
      current_file: "Starting file repair...",
      status: "starting",
      success_count: 0,
      failed_count: 0,
      saved_bytes: 0,
    });

    try {
      const result = await invoke<Mp3UpgradeExecutionReport>("execute_mp3_to_m4a_upgrade", {
        candidates: candidatesToRepair,
        deleteMp3OnSuccess,
      });
      setExecutionReport(result);
      // If there were any errors, automatically switch to the error/report tab so user can inspect immediately
      if (result.failed_count > 0) {
        setActiveTab("report");
      }
      // Auto refresh scan after completion while keeping execution report intact
      await handleScan(undefined, true);
    } catch (e) {
      console.error("Repair error:", e);
      setErrorMsg(String(e));
    } finally {
      setIsRepairing(false);
    }
  };

  const handleCancelRepair = async () => {
    try {
      await invoke("cancel_mp3_to_m4a_upgrade");
    } catch (e) {
      console.error("Error cancelling repair:", e);
    }
  };

  const resultMap = useMemo(() => {
    const map = new Map<string, Mp3UpgradeResultItem>();
    if (executionReport) {
      for (const res of executionReport.results) {
        map.set(res.path, res);
        // Also map by filename in case path changed due to dead ID removal
        map.set(res.filename, res);
      }
    }
    return map;
  }, [executionReport]);

  const filteredCandidates = useMemo(() => {
    if (!scanReport) return [];
    const q = searchFilter.trim().toLowerCase();
    if (!q) return scanReport.candidates;
    return scanReport.candidates.filter(
      (c) =>
        c.filename.toLowerCase().includes(q) ||
        c.title.toLowerCase().includes(q) ||
        c.artist.toLowerCase().includes(q) ||
        c.youtube_id.toLowerCase().includes(q)
    );
  }, [scanReport, searchFilter]);

  const filteredResults = useMemo(() => {
    if (!executionReport) return [];
    let items = executionReport.results;
    if (reportFilter === "failed") {
      items = items.filter((r) => !r.success);
    } else if (reportFilter === "success") {
      items = items.filter((r) => r.success);
    }
    const q = searchFilter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (r) =>
        r.filename.toLowerCase().includes(q) ||
        r.youtube_id.toLowerCase().includes(q) ||
        (r.error && r.error.toLowerCase().includes(q))
    );
  }, [executionReport, reportFilter, searchFilter]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.75)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "20px",
      }}
    >
      <div
        className="card"
        style={{
          width: "min(1500px, 96vw)",
          maxWidth: "96vw",
          height: "92vh",
          maxHeight: "94vh",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          padding: "22px",
          boxSizing: "border-box",
          overflow: "hidden",
        }}
      >
        {/* Modal Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "1px solid var(--border-color)", paddingBottom: "12px" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "1.2rem", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span>🛠️</span> File Repair (Format / Tags / Parameters)
              {playlistName && (
                <span
                  style={{
                    fontSize: "0.75rem",
                    padding: "3px 8px",
                    borderRadius: "6px",
                    backgroundColor: "rgba(139, 92, 246, 0.15)",
                    color: "var(--accent-purple)",
                    border: "1px solid rgba(139, 92, 246, 0.35)",
                    fontWeight: 600,
                  }}
                >
                  🎶 Playlist: {playlistName}
                </span>
              )}
            </h2>
            <p className="subtitle" style={{ margin: "4px 0 0 0", fontSize: "0.82rem" }}>
              Scan local tracks for embedded YouTube metadata: repair missing tags, restore artwork, update parameters, or upgrade formats (safe in-place replacement).
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={isRepairing}
            style={{ width: "30px", height: "30px", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Folder Selector & Scan Options */}
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", backgroundColor: "var(--bg-tertiary)", padding: "12px", borderRadius: "8px", border: "1px solid var(--border-color)" }}>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <div style={{ flex: 1, display: "flex", gap: "8px", alignItems: "center" }}>
              <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                Target Folder:
              </span>
              <input
                type="text"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                placeholder="/path/to/music/folder"
                disabled={isScanning || isRepairing}
                style={{ flex: 1, padding: "6px 10px", fontSize: "0.82rem", fontFamily: "var(--font-mono)" }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleBrowseFolder}
                disabled={isScanning || isRepairing}
                style={{ padding: "6px 12px", fontSize: "0.8rem", whiteSpace: "nowrap" }}
              >
                📁 Browse...
              </button>
            </div>

            <button
              type="button"
              className="btn btn-primary"
              onClick={() => handleScan()}
              disabled={isScanning || isRepairing || !folderPath.trim()}
              style={{ padding: "6px 18px", fontSize: "0.82rem", display: "flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap" }}
            >
              {isScanning ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: "spin 1s linear infinite" }}>
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  Scanning...
                </>
              ) : (
                "🔍 Scan & Inspect"
              )}
            </button>
          </div>

          {/* Verification Criteria Checkboxes */}
          <div style={{ display: "flex", gap: "20px", alignItems: "center", borderTop: "1px solid var(--border-color)", paddingTop: "8px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Inspection Criteria:
            </span>
            <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.8rem", cursor: "pointer", color: "var(--text-primary)" }}>
              <input
                type="checkbox"
                checked={checkMp3ToM4a}
                onChange={(e) => setCheckMp3ToM4a(e.target.checked)}
                disabled={isScanning || isRepairing}
              />
              <span>Format Upgrade (MP3 to M4A)</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.8rem", cursor: "pointer", color: "var(--text-primary)" }}>
              <input
                type="checkbox"
                checked={checkTagsParams}
                onChange={(e) => setCheckTagsParams(e.target.checked)}
                disabled={isScanning || isRepairing}
              />
              <span>Missing Tags & Parameters (Title/Artist)</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.8rem", cursor: "pointer", color: "var(--text-primary)" }}>
              <input
                type="checkbox"
                checked={checkCoverArt}
                onChange={(e) => setCheckCoverArt(e.target.checked)}
                disabled={isScanning || isRepairing}
              />
              <span>Missing Cover Art / Thumbnail</span>
            </label>
          </div>
        </div>

        {errorMsg && (
          <div style={{ padding: "8px 12px", borderRadius: "6px", backgroundColor: "rgba(239, 68, 68, 0.15)", border: "1px solid var(--danger)", color: "var(--danger)", fontSize: "0.82rem" }}>
            ❌ {errorMsg}
          </div>
        )}

        {/* Scan Summary Metrics */}
        {scanReport && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "10px" }}>
            <div style={{ backgroundColor: "var(--bg-tertiary)", border: "1px solid var(--border-color)", borderRadius: "8px", padding: "8px 12px" }}>
              <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600 }}>Scanned Files</div>
              <div style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--text-primary)", marginTop: "2px" }}>
                {scanReport.total_files_scanned} files
              </div>
            </div>

            <div style={{ backgroundColor: "var(--bg-tertiary)", border: "1px solid var(--border-color)", borderRadius: "8px", padding: "8px 12px" }}>
              <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600 }}>Repair Queue</div>
              <div style={{ fontSize: "1.05rem", fontWeight: 700, color: scanReport.candidates.length > 0 ? "var(--accent-purple)" : "var(--text-secondary)", marginTop: "2px" }}>
                {scanReport.candidates.length} tracks
              </div>
            </div>

            <div style={{ backgroundColor: "var(--bg-tertiary)", border: "1px solid var(--border-color)", borderRadius: "8px", padding: "8px 12px" }}>
              <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600 }}>MP3 Files Found</div>
              <div style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--accent-indigo)", marginTop: "2px" }}>
                {scanReport.total_mp3s_found}
              </div>
            </div>

            <div style={{ backgroundColor: "var(--bg-tertiary)", border: "1px solid var(--border-color)", borderRadius: "8px", padding: "8px 12px" }}>
              <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600 }}>In-Place Tag / Art Issues</div>
              <div style={{ fontSize: "1.05rem", fontWeight: 700, color: scanReport.param_issues_count > 0 ? "var(--warning)" : "var(--text-secondary)", marginTop: "2px" }}>
                {scanReport.param_issues_count} tracks
              </div>
            </div>

            <div style={{ backgroundColor: "var(--bg-tertiary)", border: "1px solid var(--border-color)", borderRadius: "8px", padding: "8px 12px" }}>
              <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600 }}>Already Verified M4A</div>
              <div style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--success)", marginTop: "2px" }}>
                {scanReport.already_upgraded_count}
              </div>
            </div>
          </div>
        )}

        {/* Live Repair Progress Card */}
        {isRepairing && progress && (
          <div style={{ backgroundColor: "var(--bg-tertiary)", border: "1px solid var(--accent-purple)", borderRadius: "8px", padding: "12px 16px", display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: "spin 1s linear infinite", color: "var(--accent-purple)" }}>
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)" }}>
                  Repairing via yt-dlp ({progress.current} / {progress.total})
                </span>
              </div>
              <span style={{ fontSize: "0.8rem", fontFamily: "var(--font-mono)", color: "var(--accent-purple)", fontWeight: 700 }}>
                {((progress.current / Math.max(1, progress.total)) * 100).toFixed(0)}%
              </span>
            </div>

            {/* Progress bar */}
            <div style={{ width: "100%", height: "8px", backgroundColor: "var(--bg-surface)", borderRadius: "999px", overflow: "hidden" }}>
              <div
                style={{
                  width: `${Math.max(2, Math.min(100, (progress.current / Math.max(1, progress.total)) * 100))}%`,
                  height: "100%",
                  backgroundColor: "var(--accent-purple)",
                  transition: "width 0.4s ease-out",
                }}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.75rem", color: "var(--text-secondary)" }}>
              <span style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60%" }}>
                📄 {progress.current_file}
              </span>
              <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                <span style={{ color: "var(--success)" }}>✓ {progress.success_count} ok</span>
                {progress.failed_count > 0 && <span style={{ color: "var(--danger)" }}>✗ {progress.failed_count} failed</span>}
                {progress.saved_bytes > 0 && <span>💾 {formatSize(progress.saved_bytes)} freed</span>}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleCancelRepair}
                  style={{ padding: "2px 8px", fontSize: "0.72rem" }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Post-execution Report Card */}
        {executionReport && (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: "8px",
              backgroundColor: executionReport.failed_count > 0 ? "rgba(245, 158, 11, 0.12)" : "rgba(34, 197, 94, 0.12)",
              border: `1px solid ${executionReport.failed_count > 0 ? "rgba(245, 158, 11, 0.35)" : "rgba(34, 197, 94, 0.35)"}`,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "10px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, color: "var(--success)", fontSize: "0.85rem" }}>
                ✨ {executionReport.success_count} track(s) repaired successfully
              </span>
              {executionReport.failed_count > 0 && (
                <span style={{ fontWeight: 700, color: "var(--danger)", fontSize: "0.85rem" }}>
                  ✗ {executionReport.failed_count} track(s) failed / unavailable
                </span>
              )}
              {executionReport.results.some((r) => r.dead_tag_cleaned) && (
                <span
                  style={{
                    fontSize: "0.75rem",
                    padding: "2px 8px",
                    borderRadius: "4px",
                    backgroundColor: "rgba(139, 92, 246, 0.15)",
                    color: "var(--accent-purple)",
                    border: "1px solid rgba(139, 92, 246, 0.3)",
                    fontWeight: 600,
                  }}
                >
                  🧹 Cleaned dead tags from {executionReport.results.filter((r) => r.dead_tag_cleaned).length} file(s)
                </span>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              {executionReport.freed_bytes > 0 && (
                <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--text-primary)" }}>
                  💾 {formatSize(executionReport.freed_bytes)} space saved
                </span>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setActiveTab(activeTab === "report" ? "queue" : "report")}
                style={{ padding: "4px 10px", fontSize: "0.78rem" }}
              >
                {activeTab === "report" ? "📋 Back to Candidate Queue" : `🔍 Inspect Error Details (${executionReport.results.length})`}
              </button>
            </div>
          </div>
        )}

        {/* Navigation Tabs and Controls */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <button
              type="button"
              className={`btn ${activeTab === "queue" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setActiveTab("queue")}
              style={{ padding: "5px 14px", fontSize: "0.8rem", display: "flex", alignItems: "center", gap: "6px" }}
            >
              <span>Repair Queue</span>
              {scanReport && (
                <span
                  style={{
                    fontSize: "0.7rem",
                    padding: "1px 6px",
                    borderRadius: "999px",
                    backgroundColor: activeTab === "queue" ? "rgba(255,255,255,0.2)" : "var(--bg-tertiary)",
                    fontWeight: 700,
                  }}
                >
                  {scanReport.candidates.length}
                </span>
              )}
            </button>

            {executionReport && (
              <button
                type="button"
                className={`btn ${activeTab === "report" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setActiveTab("report")}
                style={{ padding: "5px 14px", fontSize: "0.8rem", display: "flex", alignItems: "center", gap: "6px" }}
              >
                <span>Repair Results & Errors</span>
                <span
                  style={{
                    fontSize: "0.7rem",
                    padding: "1px 6px",
                    borderRadius: "999px",
                    backgroundColor: executionReport.failed_count > 0 ? "rgba(239, 68, 68, 0.25)" : "rgba(34, 197, 94, 0.25)",
                    color: executionReport.failed_count > 0 ? "var(--danger)" : "var(--success)",
                    fontWeight: 700,
                  }}
                >
                  {executionReport.failed_count > 0 ? `${executionReport.failed_count} errors` : `${executionReport.success_count} ok`}
                </span>
              </button>
            )}

            {activeTab === "queue" && scanReport && scanReport.candidates.length > 0 && (
              <div style={{ display: "flex", gap: "6px", marginLeft: "10px", alignItems: "center" }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => handleSelectAll(selectedPaths.size !== scanReport.candidates.length)}
                  disabled={isRepairing}
                  style={{ padding: "3px 8px", fontSize: "0.72rem" }}
                >
                  {selectedPaths.size === scanReport.candidates.length ? "Deselect All" : "Select All"}
                </button>
                <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                  {selectedPaths.size} of {scanReport.candidates.length} selected
                </span>
              </div>
            )}

            {activeTab === "report" && executionReport && (
              <div style={{ display: "flex", gap: "6px", marginLeft: "10px", alignItems: "center" }}>
                <button
                  type="button"
                  className={`btn ${reportFilter === "all" ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => setReportFilter("all")}
                  style={{ padding: "3px 8px", fontSize: "0.72rem" }}
                >
                  All ({executionReport.results.length})
                </button>
                <button
                  type="button"
                  className={`btn ${reportFilter === "failed" ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => setReportFilter("failed")}
                  style={{ padding: "3px 8px", fontSize: "0.72rem" }}
                >
                  ❌ Errors Only ({executionReport.failed_count})
                </button>
                <button
                  type="button"
                  className={`btn ${reportFilter === "success" ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => setReportFilter("success")}
                  style={{ padding: "3px 8px", fontSize: "0.72rem" }}
                >
                  ✓ Succeeded ({executionReport.success_count})
                </button>
              </div>
            )}
          </div>

          <div style={{ width: "240px" }}>
            <input
              type="text"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder={activeTab === "queue" ? "🔍 Search repair queue..." : "🔍 Search error log..."}
              style={{ padding: "4px 8px", fontSize: "0.78rem", width: "100%" }}
            />
          </div>
        </div>

        {/* Main Content Area */}
        <div style={{ flex: 1, overflowY: "auto", border: "1px solid var(--border-color)", borderRadius: "8px" }}>
          {activeTab === "queue" ? (
            /* Queue Table */
            !scanReport ? (
              <div className="no-data" style={{ padding: "60px 20px", textAlign: "center" }}>
                Click "Scan & Inspect" to find files requiring format upgrade, metadata repair, or parameter update.
              </div>
            ) : filteredCandidates.length === 0 ? (
              <div className="no-data" style={{ padding: "60px 20px", textAlign: "center" }}>
                {scanReport.candidates.length === 0
                  ? "No files requiring repair or format upgrade found in this directory."
                  : "No candidates match the search filter."}
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border-color)", backgroundColor: "var(--bg-surface)", color: "var(--text-secondary)", fontSize: "0.68rem", textTransform: "uppercase" }}>
                    <th style={{ width: "36px", padding: "6px 8px", textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={selectedPaths.size === scanReport.candidates.length && scanReport.candidates.length > 0}
                        onChange={(e) => handleSelectAll(e.target.checked)}
                        disabled={isRepairing}
                      />
                    </th>
                    <th style={{ width: "145px", padding: "6px 8px", textAlign: "left" }}>Status</th>
                    <th style={{ width: "185px", padding: "6px 8px", textAlign: "left" }}>Issue / Action</th>
                    <th style={{ padding: "6px 8px", textAlign: "left" }}>File Name & Tags</th>
                    <th style={{ width: "140px", padding: "6px 8px", textAlign: "left" }}>YouTube ID</th>
                    <th style={{ width: "80px", padding: "6px 8px", textAlign: "right" }}>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCandidates.map((c, idx) => {
                    const isChecked = selectedPaths.has(c.path);
                    const lastResult = resultMap.get(c.path) || resultMap.get(c.filename);

                    return (
                      <tr
                        key={idx}
                        style={{
                          borderBottom: idx < filteredCandidates.length - 1 ? "1px solid var(--border-color)" : "none",
                          backgroundColor: isChecked ? "rgba(139, 92, 246, 0.04)" : "transparent",
                        }}
                      >
                        <td style={{ padding: "6px 8px", textAlign: "center", verticalAlign: "middle" }}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => handleToggleSelect(c.path)}
                            disabled={isRepairing}
                          />
                        </td>

                        <td style={{ padding: "6px 8px", textAlign: "left", verticalAlign: "middle" }}>
                          {c.m4a_already_exists && c.is_mp3 ? (
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
                              }}
                              title="Matching .m4a already exists on disk"
                            >
                              ✓ .m4a exists
                            </span>
                          ) : !c.is_mp3 ? (
                            <span
                              style={{
                                fontSize: "0.68rem",
                                padding: "2px 6px",
                                borderRadius: "4px",
                                backgroundColor: "rgba(245, 158, 11, 0.14)",
                                color: "var(--warning)",
                                border: "1px solid rgba(245, 158, 11, 0.35)",
                                fontWeight: 600,
                                whiteSpace: "nowrap",
                              }}
                              title="Same file will be safely re-downloaded with full tags and replaced in-place"
                            >
                              🔧 In-Place Repair
                            </span>
                          ) : (
                            <span
                              style={{
                                fontSize: "0.68rem",
                                padding: "2px 6px",
                                borderRadius: "4px",
                                backgroundColor: "rgba(139, 92, 246, 0.14)",
                                color: "var(--accent-purple)",
                                border: "1px solid rgba(139, 92, 246, 0.35)",
                                fontWeight: 600,
                                whiteSpace: "nowrap",
                              }}
                            >
                              ⚡ Ready to repair
                            </span>
                          )}

                          {lastResult && !lastResult.success && (
                            <div
                              style={{
                                fontSize: "0.68rem",
                                color: "var(--danger)",
                                marginTop: "3px",
                                display: "flex",
                                alignItems: "center",
                                gap: "3px",
                                fontWeight: 600,
                              }}
                              title={lastResult.error || "Repair failed"}
                            >
                              <span>⚠️</span>
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "130px" }}>
                                {lastResult.dead_tag_cleaned ? "Video removed on YT" : "Failed in last run"}
                              </span>
                            </div>
                          )}
                        </td>

                        <td style={{ padding: "6px 8px", textAlign: "left", verticalAlign: "middle" }}>
                          <span
                            style={{
                              fontSize: "0.68rem",
                              padding: "2px 6px",
                              borderRadius: "4px",
                              backgroundColor: c.is_mp3 ? "rgba(139, 92, 246, 0.12)" : "rgba(14, 165, 233, 0.12)",
                              color: c.is_mp3 ? "var(--accent-purple-hover)" : "var(--accent-cyan, #0ea5e9)",
                              border: `1px solid ${c.is_mp3 ? "rgba(139, 92, 246, 0.3)" : "rgba(14, 165, 233, 0.3)"}`,
                              fontWeight: 600,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {c.reason}
                          </span>
                        </td>

                        <td style={{ padding: "6px 8px", textAlign: "left", verticalAlign: "middle" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            <span
                              style={{
                                fontSize: "0.65rem",
                                padding: "1px 4px",
                                borderRadius: "3px",
                                backgroundColor: c.is_mp3 ? "rgba(245, 158, 11, 0.15)" : "rgba(59, 130, 246, 0.15)",
                                color: c.is_mp3 ? "var(--warning)" : "var(--accent-indigo)",
                                fontWeight: 700,
                                fontFamily: "var(--font-mono)",
                              }}
                            >
                              {c.format_ext.toUpperCase()}
                            </span>
                            <span
                              style={{
                                fontSize: "0.8rem",
                                fontWeight: 600,
                                fontFamily: "var(--font-mono)",
                                color: "var(--text-primary)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={c.path}
                            >
                              {c.filename}
                            </span>
                          </div>
                          {c.title && c.title !== c.filename && (
                            <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: "2px" }}>
                              {c.artist ? `${c.artist} - ${c.title}` : c.title}
                            </div>
                          )}
                        </td>

                        <td style={{ padding: "6px 8px", textAlign: "left", verticalAlign: "middle" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            <button
                              type="button"
                              onClick={() => handleOpenUrl(c.youtube_url)}
                              style={{
                                background: "none",
                                border: "none",
                                padding: 0,
                                cursor: "pointer",
                                fontSize: "0.74rem",
                                fontFamily: "var(--font-mono)",
                                color: "var(--accent-purple)",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                                textDecoration: "underline",
                              }}
                              title={`Open ${c.youtube_url} in browser`}
                            >
                              <span>🆔</span>
                              <span>{c.youtube_id}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleCopy(c.youtube_url, `queue-${c.youtube_id}`)}
                              style={{
                                background: "transparent",
                                border: "none",
                                cursor: "pointer",
                                fontSize: "0.72rem",
                                padding: "1px 3px",
                                color: copiedKey === `queue-${c.youtube_id}` ? "var(--success)" : "var(--text-secondary)",
                              }}
                              title="Copy YouTube URL"
                            >
                              {copiedKey === `queue-${c.youtube_id}` ? "✓" : "📋"}
                            </button>
                          </div>
                        </td>

                        <td style={{ padding: "6px 8px", textAlign: "right", verticalAlign: "middle", fontFamily: "var(--font-mono)", fontSize: "0.74rem", color: "var(--text-secondary)" }}>
                          {formatSize(c.file_size_bytes)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          ) : (
            /* Execution & Error Report Detailed View */
            !executionReport ? (
              <div className="no-data" style={{ padding: "60px 20px", textAlign: "center" }}>
                No repair execution report available. Run a file repair to view results.
              </div>
            ) : filteredResults.length === 0 ? (
              <div className="no-data" style={{ padding: "60px 20px", textAlign: "center" }}>
                No items match the report filter.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "12px" }}>
                {filteredResults.map((item, idx) => {
                  const isCleaned = !!item.dead_tag_cleaned;
                  const isSuccess = item.success;
                  const isPermanent = !!item.error && (
                    item.error.includes("Video permanently unavailable") ||
                    item.error.toLowerCase().includes("video unavailable") ||
                    item.error.toLowerCase().includes("does not exist") ||
                    item.error.toLowerCase().includes("has been removed") ||
                    item.error.toLowerCase().includes("is no longer available") ||
                    item.error.toLowerCase().includes("terminated") ||
                    item.error.toLowerCase().includes("not a valid video id")
                  );

                  return (
                    <div
                      key={idx}
                      style={{
                        backgroundColor: isSuccess
                          ? "rgba(34, 197, 94, 0.05)"
                          : isCleaned
                          ? "rgba(139, 92, 246, 0.06)"
                          : isPermanent
                          ? "rgba(245, 158, 11, 0.06)"
                          : "rgba(239, 68, 68, 0.06)",
                        border: `1px solid ${
                          isSuccess
                            ? "rgba(34, 197, 94, 0.3)"
                            : isCleaned
                            ? "rgba(139, 92, 246, 0.35)"
                            : isPermanent
                            ? "rgba(245, 158, 11, 0.35)"
                            : "rgba(239, 68, 68, 0.35)"
                        }`,
                        borderRadius: "8px",
                        padding: "12px 14px",
                        display: "flex",
                        flexDirection: "column",
                        gap: "8px",
                      }}
                    >
                      {/* Item Header */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "10px", flexWrap: "wrap" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                          {isSuccess ? (
                            <span
                              style={{
                                fontSize: "0.72rem",
                                padding: "2px 8px",
                                borderRadius: "4px",
                                backgroundColor: "rgba(34, 197, 94, 0.16)",
                                color: "var(--success)",
                                border: "1px solid rgba(34, 197, 94, 0.4)",
                                fontWeight: 700,
                              }}
                            >
                              ✓ Repaired Successfully
                            </span>
                          ) : isCleaned ? (
                            <span
                              style={{
                                fontSize: "0.72rem",
                                padding: "2px 8px",
                                borderRadius: "4px",
                                backgroundColor: "rgba(139, 92, 246, 0.18)",
                                color: "var(--accent-purple)",
                                border: "1px solid rgba(139, 92, 246, 0.4)",
                                fontWeight: 700,
                              }}
                            >
                              🚫 Dead Video on YouTube — Dead Tag & Filename Cleaned
                            </span>
                          ) : isPermanent ? (
                            <span
                              style={{
                                fontSize: "0.72rem",
                                padding: "2px 8px",
                                borderRadius: "4px",
                                backgroundColor: "rgba(245, 158, 11, 0.18)",
                                color: "var(--warning)",
                                border: "1px solid rgba(245, 158, 11, 0.4)",
                                fontWeight: 700,
                              }}
                            >
                              🚫 Video Permanently Unavailable on YouTube
                            </span>
                          ) : (
                            <span
                              style={{
                                fontSize: "0.72rem",
                                padding: "2px 8px",
                                borderRadius: "4px",
                                backgroundColor: "rgba(239, 68, 68, 0.18)",
                                color: "var(--danger)",
                                border: "1px solid rgba(239, 68, 68, 0.4)",
                                fontWeight: 700,
                              }}
                            >
                              ✗ Network / Temporary Download Error
                            </span>
                          )}

                          <span style={{ fontSize: "0.85rem", fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--text-primary)" }}>
                            {item.filename}
                          </span>
                        </div>

                        {/* YouTube Actions */}
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => handleOpenUrl(`https://www.youtube.com/watch?v=${item.youtube_id}`)}
                            style={{ padding: "3px 8px", fontSize: "0.72rem", display: "flex", alignItems: "center", gap: "4px" }}
                            title="Open video in web browser"
                          >
                            <span>🌐 Open YT</span>
                            <span style={{ fontFamily: "var(--font-mono)" }}>[{item.youtube_id}]</span>
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => handleCopy(`https://www.youtube.com/watch?v=${item.youtube_id}`, `report-${item.youtube_id}`)}
                            style={{ padding: "3px 8px", fontSize: "0.72rem" }}
                            title="Copy YouTube URL"
                          >
                            {copiedKey === `report-${item.youtube_id}` ? "✓ Copied" : "📋 Copy URL"}
                          </button>
                        </div>
                      </div>

                      {/* Path subtitle */}
                      <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
                        📁 {item.path}
                      </div>

                      {/* Result Details */}
                      {isSuccess ? (
                        <div style={{ fontSize: "0.76rem", color: "var(--text-primary)", display: "flex", gap: "12px", alignItems: "center" }}>
                          <span>Original: {formatSize(item.original_size_bytes)}</span>
                          <span>→</span>
                          <span style={{ fontWeight: 700, color: "var(--success)" }}>New Size: {formatSize(item.new_size_bytes)}</span>
                          {item.original_size_bytes > item.new_size_bytes && (
                            <span style={{ color: "var(--success)", fontWeight: 600 }}>
                              ({formatSize(item.original_size_bytes - item.new_size_bytes)} saved)
                            </span>
                          )}
                        </div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                          {/* Error Output Box */}
                          <div
                            style={{
                              backgroundColor: "rgba(0, 0, 0, 0.4)",
                              border: "1px solid rgba(239, 68, 68, 0.3)",
                              borderRadius: "6px",
                              padding: "8px 12px",
                              fontFamily: "var(--font-mono)",
                              fontSize: "0.76rem",
                              color: "#fca5a5",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                              maxHeight: "120px",
                              overflowY: "auto",
                            }}
                          >
                            {item.error || "Unknown yt-dlp error"}
                          </div>

                          {/* Contextual Guidance */}
                          {isCleaned ? (
                            <div style={{ fontSize: "0.75rem", color: "var(--accent-purple)", display: "flex", alignItems: "flex-start", gap: "6px" }}>
                              <span>💡</span>
                              <span>
                                <strong>100% Verified Absence:</strong> The video no longer exists on YouTube. The dead ID and link were safely removed from this audio file's metadata and filename. Your existing audio file is safely preserved on disk, and it will no longer appear in future repair scans.
                              </span>
                            </div>
                          ) : isPermanent ? (
                            <div style={{ fontSize: "0.75rem", color: "var(--warning)", display: "flex", alignItems: "flex-start", gap: "6px" }}>
                              <span>⚠️</span>
                              <span>
                                <strong>Video Unavailable:</strong> YouTube confirmed this video does not exist or has been removed. (No matching embedded YouTube tags were found in the file's metadata to clean). Your original audio file is safely preserved on disk.
                              </span>
                            </div>
                          ) : (
                            <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", display: "flex", alignItems: "flex-start", gap: "6px" }}>
                              <span>ℹ️</span>
                              <span>
                                <strong>File Preserved:</strong> This appears to be a network timeout or temporary restriction. Your original audio file and metadata tags were left completely untouched so you can retry when your connection is stable.
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>

        {/* Modal Bottom Footer Actions */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--border-color)", paddingTop: "12px" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "0.8rem", color: "var(--text-primary)" }}>
            <input
              type="checkbox"
              checked={deleteMp3OnSuccess}
              onChange={(e) => setDeleteMp3OnSuccess(e.target.checked)}
              disabled={isRepairing}
            />
            <span>Safely delete old .mp3 only after .m4a download verifies (&gt;10KB)</span>
          </label>

          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isRepairing}
              style={{ padding: "6px 14px", fontSize: "0.82rem" }}
            >
              Close
            </button>

            <button
              type="button"
              className="btn btn-primary"
              onClick={handleStartRepairClick}
              disabled={isRepairing || !scanReport || selectedPaths.size === 0}
              style={{ padding: "6px 18px", fontSize: "0.82rem", display: "flex", alignItems: "center", gap: "6px" }}
            >
              {isRepairing ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: "spin 1s linear infinite" }}>
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  Processing...
                </>
              ) : (
                `🛠️ Repair ${selectedPaths.size} Selected`
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Confirmation Modal */}
      {showConfirmModal && (
        <ConfirmModal
          title="🛠️ Audio File Repair"
          message={`Start repairing & upgrading ${selectedPaths.size} track(s)?\n\n• Selected files: ${selectedPaths.size}\n• Safe atomic replacement: files are downloaded to a temporary file first and atomically swapped in-place once verified (>10KB)\n• Old MP3s: ${deleteMp3OnSuccess ? "Safely deleted ONLY if .m4a download verifies (>10KB)" : "Preserved on disk"}\n• Same-filename repairs: cleanly updated in-place with full metadata & embedded thumbnail artwork\n• Unavailable or deleted YouTube videos: existing files are preserved 100% intact.`}
          confirmText={`Repair ${selectedPaths.size} Tracks`}
          confirmVariant="primary"
          isExecuting={isRepairing}
          executingText="Processing..."
          onConfirm={() => {
            setShowConfirmModal(false);
            executeRepair();
          }}
          onCancel={() => setShowConfirmModal(false)}
        />
      )}
    </div>
  );
};
