import React, { useState, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MainConfig } from "../App";

type ExportViewProps = {
  configPath: string;
  config: MainConfig | null;
  formats: string;
  relativeToConfig: boolean;
  addBackgroundTask: (id: string, name: string, taskPromise: Promise<any>) => void;
  diffReport: ExportDiffReport | null;
  setDiffReport: (report: ExportDiffReport | null) => void;
  isStale: boolean;
  onDismissStale: () => void;
};

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

export const ExportView: React.FC<ExportViewProps> = ({
  configPath,
  config,
  formats,
  relativeToConfig,
  addBackgroundTask,
  diffReport,
  setDiffReport,
  isStale,
  onDismissStale,
}) => {
  const [exportDir, setExportDir] = useState<string>(() => {
    try {
      return localStorage.getItem("export_target_dir") || "";
    } catch (e) {
      return "";
    }
  });

  const [deleteOrphans, setDeleteOrphans] = useState<boolean>(false);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportLogs, setExportLogs] = useState<string[]>([]);
  const [showLogsModal, setShowLogsModal] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<"new" | "uptodate" | "orphans">("new");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [visibleLimit, setVisibleLimit] = useState<number>(100);

  useEffect(() => {
    setVisibleLimit(100);
  }, [activeTab, searchQuery, diffReport]);

  const handleTableScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollTop + clientHeight >= scrollHeight - 250) {
      setVisibleLimit((prev) => prev + 100);
    }
  };

  const filteredItems = useMemo(() => {
    if (!diffReport) return { newFiles: [], upToDateFiles: [], orphanFiles: [] };
    const q = searchQuery.trim().toLowerCase();
    
    if (!q) {
      return {
        newFiles: diffReport.new_files,
        upToDateFiles: diffReport.up_to_date_files,
        orphanFiles: diffReport.orphan_files,
      };
    }

    return {
      newFiles: diffReport.new_files.filter(
        (item) => item.relative_path.toLowerCase().includes(q) || item.dest_relative_path.toLowerCase().includes(q)
      ),
      upToDateFiles: diffReport.up_to_date_files.filter(
        (item) => item.relative_path.toLowerCase().includes(q) || item.dest_relative_path.toLowerCase().includes(q)
      ),
      orphanFiles: diffReport.orphan_files.filter(
        (item) => item.relative_path.toLowerCase().includes(q)
      ),
    };
  }, [diffReport, searchQuery]);

  const [selectedItemPaths, setSelectedItemPaths] = useState<Set<string>>(new Set());
  const [excludedPaths, setExcludedPaths] = useState<Set<string>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

  useEffect(() => {
    setSelectedItemPaths(new Set());
    setLastSelectedIndex(null);
  }, [activeTab]);

  const handleToggleSelectAll = (visibleItems: Array<{ relative_path: string }>) => {
    const allSelected = visibleItems.length > 0 && visibleItems.every((item) => selectedItemPaths.has(item.relative_path));
    const next = new Set(selectedItemPaths);
    if (allSelected) {
      visibleItems.forEach((item) => next.delete(item.relative_path));
    } else {
      visibleItems.forEach((item) => next.add(item.relative_path));
    }
    setSelectedItemPaths(next);
  };

  const handleToggleSelectItem = (
    relPath: string,
    currentIndex: number,
    isShiftKey: boolean,
    visibleItems: Array<{ relative_path: string }>
  ) => {
    const next = new Set(selectedItemPaths);

    if (isShiftKey && lastSelectedIndex !== null && lastSelectedIndex !== currentIndex) {
      const start = Math.min(lastSelectedIndex, currentIndex);
      const end = Math.max(lastSelectedIndex, currentIndex);
      for (let i = start; i <= end; i++) {
        if (visibleItems[i]) {
          next.add(visibleItems[i].relative_path);
        }
      }
    } else {
      if (next.has(relPath)) {
        next.delete(relPath);
      } else {
        next.add(relPath);
      }
    }

    setLastSelectedIndex(currentIndex);
    setSelectedItemPaths(next);
  };

  const [showDeleteConfirmModal, setShowDeleteConfirmModal] = useState<boolean>(false);

  const getAbsPathsForSelected = () => {
    if (!diffReport) return [];
    const map = new Map<string, string>();
    diffReport.new_files.forEach((f) => map.set(f.relative_path, f.file_path));
    diffReport.up_to_date_files.forEach((f) => map.set(f.relative_path, f.file_path));
    diffReport.orphan_files.forEach((f) => map.set(f.relative_path, f.file_path));
    
    const absPaths: string[] = [];
    selectedItemPaths.forEach((rel) => {
      const abs = map.get(rel);
      if (abs) absPaths.push(abs);
    });
    return absPaths;
  };

  const areAllSelectedExcluded = selectedItemPaths.size > 0 && Array.from(selectedItemPaths).every((p) => excludedPaths.has(p));

  const handleToggleExcludeSelected = () => {
    const next = new Set(excludedPaths);
    if (areAllSelectedExcluded) {
      selectedItemPaths.forEach((path) => next.delete(path));
    } else {
      selectedItemPaths.forEach((path) => next.add(path));
    }
    setExcludedPaths(next);
  };

  const handleRevealSelected = async () => {
    const absPaths = getAbsPathsForSelected();
    if (absPaths.length === 0) return;
    try {
      for (const path of absPaths) {
        await invoke("reveal_in_finder", { filePath: path });
      }
    } catch (e) {
      alert("Error revealing file: " + e);
    }
  };

  const handleCopyPathsToClipboard = () => {
    if (selectedItemPaths.size === 0) return;
    const text = Array.from(selectedItemPaths).join("\n");
    navigator.clipboard.writeText(text);
    alert(`Copied ${selectedItemPaths.size} path(s) to clipboard!`);
  };

  const handleDeleteSelected = () => {
    if (selectedItemPaths.size === 0) return;
    setShowDeleteConfirmModal(true);
  };

  const executeDeleteSelected = async () => {
    setShowDeleteConfirmModal(false);
    const absPaths = getAbsPathsForSelected();
    if (absPaths.length === 0) return;
    try {
      const count = await invoke<number>("delete_export_files", { filePaths: absPaths });
      alert(`Successfully deleted ${count} file(s) from disk.`);
      setSelectedItemPaths(new Set());
      handleAnalyzeDiff();
    } catch (e) {
      alert("Error deleting files: " + e);
    }
  };

  useEffect(() => {
    try {
      localStorage.setItem("export_target_dir", exportDir);
      if (diffReport && diffReport.destination !== exportDir) {
        setDiffReport(null);
      }
    } catch (e) {}
  }, [exportDir]);

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const handlePickDestination = async () => {
    try {
      const selected = await invoke<string | null>("select_directory", {
        title: "Select Export Target Directory",
      });
      if (selected) {
        setExportDir(selected);
        setDiffReport(null);
      }
    } catch (e) {
      alert("Error picking folder: " + e);
    }
  };

  const handleAnalyzeDiff = async () => {
    if (!configPath || !exportDir) {
      alert("Please select a valid export destination directory first.");
      return;
    }
    setIsAnalyzing(true);
    try {
      const formatsList = formats.split(",").map((f) => f.trim());
      const report = await invoke<ExportDiffReport>("analyze_export_diff", {
        configPath,
        destination: exportDir,
        formats: formatsList,
        relativeToConfig,
      });
      setDiffReport(report);
      onDismissStale();
    } catch (e) {
      alert("Error analyzing export diff: " + e);
    } finally {
      setIsAnalyzing(false);
    }
  };

  type ExportProgress = {
    current_file_index: number;
    total_files: number;
    copied_bytes: number;
    total_bytes: number;
    current_file: string;
    startTime: number;
  };

  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);

  const formatSpeed = (bytesPerSec: number) => {
    if (bytesPerSec <= 0 || !isFinite(bytesPerSec)) return "0 B/s";
    const k = 1024;
    const sizes = ["B/s", "KB/s", "MB/s", "GB/s"];
    const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
    return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const formatEta = (seconds: number) => {
    if (seconds <= 0 || !isFinite(seconds)) return "0s";
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    if (m < 60) return `${m}m ${s}s`;
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return `${h}h ${remM}m`;
  };

  const handleCancelExport = async () => {
    try {
      await invoke("cancel_export");
      setExportLogs((prev) => [...prev, "🛑 Stopping export process..."]);
    } catch (e) {
      console.error("Error stopping export:", e);
    }
  };

  const logContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [exportLogs]);

  const handleStartExport = async () => {
    if (!configPath || !exportDir) {
      alert("Please select a valid export destination directory first.");
      return;
    }
    setIsExporting(true);
    setShowLogsModal(true);
    setExportLogs(["Initializing smart sync export..."]);
    setExportProgress(null);

    const taskId = `export_${Date.now()}`;
    let unlistenLog: (() => void) | null = null;
    let unlistenProgress: (() => void) | null = null;

    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenLog = await listen<string>("export-log", (event) => {
        setExportLogs((prev) => [...prev, event.payload]);
      });

      unlistenProgress = await listen<any>("export-progress", (event) => {
        const payload = event.payload;
        setExportProgress((prev) => ({
          ...payload,
          startTime: prev?.startTime || Date.now(),
        }));
      });

      const formatsList = formats.split(",").map((f) => f.trim());
      const promise = invoke<string[]>("execute_export", {
        taskId,
        configPath,
        destination: exportDir,
        deleteOrphans,
        excludedPaths: Array.from(excludedPaths),
        formats: formatsList,
        relativeToConfig,
      });

      addBackgroundTask(taskId, "Smart Sync Export", promise);
      await promise;

      // Re-analyze diff after export completes
      handleAnalyzeDiff();
    } catch (e) {
      setExportLogs((prev) => [...prev, `ERROR: ${e}`]);
    } finally {
      if (unlistenLog) unlistenLog();
      if (unlistenProgress) unlistenProgress();
      setIsExporting(false);
    }
  };

  if (!config) {
    return (
      <div className="view-container">
        <h1>Export Playlists & Media</h1>
        <p className="no-data">Please load a workspace configuration file in the Workspaces tab.</p>
      </div>
    );
  }

  return (
    <div className="view-container" style={{ display: "flex", flexDirection: "column", height: "100%", gap: "16px" }}>
      <div>
        <h1>Export Playlists & Media</h1>
        <p className="subtitle" style={{ margin: 0 }}>
          Smart sync playlists and audio tracks to an external drive or destination folder.
        </p>
      </div>

      {/* Stale Config Warning Banner */}
      {isStale && diffReport && (
        <div
          style={{
            backgroundColor: "rgba(234, 179, 8, 0.12)",
            border: "1px solid var(--warning)",
            padding: "10px 14px",
            borderRadius: "8px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: "0.85rem",
            color: "var(--text-primary)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ color: "var(--warning)", fontSize: "1.1rem" }}>⚠️</span>
            <span>Workspace configuration or playlists have changed since the last diff analysis.</span>
            <button
              className="btn btn-secondary"
              onClick={handleAnalyzeDiff}
              disabled={isAnalyzing}
              style={{ padding: "3px 10px", fontSize: "0.78rem", backgroundColor: "var(--bg-secondary)" }}
            >
              🔍 Re-analyze Diff
            </button>
          </div>
          <button
            onClick={onDismissStale}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: "1.1rem",
              padding: "0 4px",
              lineHeight: 1,
            }}
            title="Dismiss warning"
          >
            ✕
          </button>
        </div>
      )}

      {/* Control Header Card */}
      <div className="card" style={{ padding: "14px 16px", margin: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
              <label className="form-label" style={{ fontSize: "0.85rem" }}>
                Target Export Destination Folder
              </label>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="text"
                  value={exportDir}
                  onChange={(e) => {
                    setExportDir(e.target.value);
                    setDiffReport(null);
                  }}
                  placeholder="Select export target folder (e.g. /Volumes/USB-DRIVE)"
                  style={{ flex: 1, fontSize: "0.88rem" }}
                />
                <button className="btn btn-secondary" onClick={handlePickDestination} style={{ padding: "6px 14px", fontSize: "0.85rem" }}>
                  📁 Browse
                </button>
              </div>
            </div>

            <div style={{ display: "flex", gap: "8px", alignItems: "flex-end", alignSelf: "flex-end" }}>
              <button
                className="btn btn-secondary"
                onClick={handleAnalyzeDiff}
                disabled={isAnalyzing || !exportDir}
                style={{ padding: "8px 16px", fontSize: "0.85rem", display: "flex", alignItems: "center", gap: "6px" }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"></circle>
                  <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                </svg>
                {isAnalyzing ? "Analyzing..." : "Analyze Diff"}
              </button>

              <button
                className="btn btn-primary"
                onClick={handleStartExport}
                disabled={isExporting || isAnalyzing || !exportDir || !diffReport}
                style={{ padding: "8px 18px", fontSize: "0.85rem", display: "flex", alignItems: "center", gap: "6px", backgroundColor: "var(--accent-purple)" }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"></line>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                </svg>
                {isExporting ? "Exporting..." : "Start Export"}
              </button>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--border-color)", paddingTop: "10px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "0.85rem", color: "var(--text-secondary)" }}>
              <input
                type="checkbox"
                checked={deleteOrphans}
                onChange={(e) => setDeleteOrphans(e.target.checked)}
                style={{ width: "16px", height: "16px", accentColor: "var(--accent-purple)" }}
              />
              <span>Delete orphan files in destination folder (files no longer in playlists)</span>
            </label>

            {diffReport && (
              <span className="text-secondary" style={{ fontSize: "0.8rem", fontFamily: "var(--font-mono)" }}>
                📁 playlists/ ({diffReport.playlists.length} M3U) | 📁 music/ ({diffReport.new_files.length + diffReport.up_to_date_files.length} tracks)
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      {diffReport && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px" }}>
          <div className="card" style={{ padding: "12px 14px", margin: 0 }}>
            <div className="text-secondary" style={{ fontSize: "0.75rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
              🟢 New / Modified
            </div>
            <div style={{ fontSize: "1.2rem", fontWeight: 700, marginTop: "4px", color: "var(--text-primary)" }}>
              {diffReport.new_files.length} files
            </div>
            <div className="text-secondary" style={{ fontSize: "0.78rem", fontFamily: "var(--font-mono)", marginTop: "2px" }}>
              {formatSize(diffReport.total_bytes_to_copy)}
            </div>
          </div>

          <div className="card" style={{ padding: "12px 14px", margin: 0 }}>
            <div className="text-secondary" style={{ fontSize: "0.75rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
              ⚪ Up to Date (Skipped)
            </div>
            <div style={{ fontSize: "1.2rem", fontWeight: 700, marginTop: "4px", color: "var(--text-primary)" }}>
              {diffReport.up_to_date_files.length} files
            </div>
            <div className="text-secondary" style={{ fontSize: "0.78rem", fontFamily: "var(--font-mono)", marginTop: "2px" }}>
              {formatSize(diffReport.total_bytes_up_to_date)}
            </div>
          </div>

          <div className="card" style={{ padding: "12px 14px", margin: 0 }}>
            <div className="text-secondary" style={{ fontSize: "0.75rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
              🔴 Destination Orphans
            </div>
            <div style={{ fontSize: "1.2rem", fontWeight: 700, marginTop: "4px", color: diffReport.orphan_files.length > 0 ? "var(--danger)" : "var(--text-primary)" }}>
              {diffReport.orphan_files.length} files
            </div>
            <div className="text-secondary" style={{ fontSize: "0.78rem", fontFamily: "var(--font-mono)", marginTop: "2px" }}>
              {formatSize(diffReport.total_bytes_orphans)}
            </div>
          </div>

          <div className="card" style={{ padding: "12px 14px", margin: 0 }}>
            <div className="text-secondary" style={{ fontSize: "0.75rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
              🎶 Playlists to Export
            </div>
            <div style={{ fontSize: "1.2rem", fontWeight: 700, marginTop: "4px", color: "var(--accent-purple)" }}>
              {diffReport.playlists.length} M3U8
            </div>
            <div className="text-secondary" style={{ fontSize: "0.78rem", fontFamily: "var(--font-mono)", marginTop: "2px" }}>
              Relative M3U links
            </div>
          </div>
        </div>
      )}

      {/* Main Diff Dashboard */}
      {diffReport ? (
        <div className="card" style={{ flex: 1, display: "flex", flexDirection: "column", margin: 0, overflow: "hidden", padding: "14px 16px" }}>
          {/* Subtabs, Action Panel right of Orphan tab, and Search */}
          <div style={{ display: "flex", gap: "12px", borderBottom: "1px solid var(--border-color)", paddingBottom: "10px", marginBottom: "12px", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <button
                className={`btn ${activeTab === "new" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setActiveTab("new")}
                style={{ padding: "4px 12px", fontSize: "0.8rem" }}
              >
                🟢 New / Modified ({filteredItems.newFiles.length})
              </button>
              <button
                className={`btn ${activeTab === "uptodate" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setActiveTab("uptodate")}
                style={{ padding: "4px 12px", fontSize: "0.8rem" }}
              >
                ⚪ Up-to-Date ({filteredItems.upToDateFiles.length})
              </button>
              <button
                className={`btn ${activeTab === "orphans" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setActiveTab("orphans")}
                style={{ padding: "4px 12px", fontSize: "0.8rem" }}
              >
                🔴 Orphan Files ({filteredItems.orphanFiles.length})
              </button>

              {/* Action Panel right of Orphan Files tab */}
              {selectedItemPaths.size > 0 && (
                <div style={{ display: "flex", gap: "6px", alignItems: "center", borderLeft: "1px solid var(--border-color)", paddingLeft: "10px", marginLeft: "4px" }}>
                  <span style={{ fontWeight: 600, color: "var(--accent-purple)", fontSize: "0.78rem" }}>
                    {selectedItemPaths.size} selected
                  </span>
                  {activeTab === "new" && (
                    <button className="btn btn-secondary" onClick={handleToggleExcludeSelected} style={{ padding: "3px 8px", fontSize: "0.75rem" }}>
                      {areAllSelectedExcluded ? "✅ Include" : "🚫 Exclude"}
                    </button>
                  )}
                  {activeTab === "orphans" && (
                    <button className="btn btn-danger" onClick={handleDeleteSelected} style={{ padding: "3px 8px", fontSize: "0.75rem" }}>
                      🗑 Delete
                    </button>
                  )}
                  <button className="btn btn-secondary" onClick={() => handleRevealSelected()} style={{ padding: "3px 8px", fontSize: "0.75rem" }}>
                    📁 Finder
                  </button>
                  <button className="btn btn-secondary" onClick={handleCopyPathsToClipboard} style={{ padding: "3px 8px", fontSize: "0.75rem" }}>
                    📋 Copy
                  </button>
                  <button className="btn btn-secondary" onClick={() => setSelectedItemPaths(new Set())} style={{ padding: "3px 6px", fontSize: "0.75rem" }} title="Clear Selection">
                    ✕
                  </button>
                </div>
              )}
            </div>

            <div style={{ width: "200px" }}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="🔍 Search files..."
                style={{ padding: "4px 10px", fontSize: "0.8rem", width: "100%" }}
              />
            </div>
          </div>

          <div className="table-container" onScroll={handleTableScroll} style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
            {activeTab === "new" && (
              filteredItems.newFiles.length > 0 ? (
                <>
                  <table style={{ tableLayout: "fixed", width: "100%" }}>
                    <thead>
                      <tr>
                        <th style={{ width: "36px", textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={
                              filteredItems.newFiles.length > 0 &&
                              filteredItems.newFiles.every((item) => selectedItemPaths.has(item.relative_path))
                            }
                            onChange={() => handleToggleSelectAll(filteredItems.newFiles)}
                            style={{ cursor: "pointer" }}
                          />
                        </th>
                        <th style={{ width: "100px" }}>Status</th>
                        <th style={{ width: "55%" }}>Source Relative Path</th>
                        <th style={{ width: "25%" }}>Target Relative Path</th>
                        <th style={{ width: "90px", textAlign: "right" }}>Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredItems.newFiles.slice(0, visibleLimit).map((item, idx) => {
                        const isExcluded = excludedPaths.has(item.relative_path);
                        const isSelected = selectedItemPaths.has(item.relative_path);
                        return (
                          <tr
                            key={idx}
                            title={item.file_path}
                            onClick={(e) => handleToggleSelectItem(item.relative_path, idx, e.shiftKey, filteredItems.newFiles)}
                            style={{ backgroundColor: isSelected ? "var(--accent-purple-glow)" : "transparent", cursor: "pointer", userSelect: "none" }}
                          >
                            <td style={{ textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={(e) => handleToggleSelectItem(item.relative_path, idx, (e.nativeEvent as MouseEvent).shiftKey, filteredItems.newFiles)}
                                style={{ cursor: "pointer" }}
                              />
                            </td>
                            <td>
                              {isExcluded ? (
                                <span className="badge" style={{ backgroundColor: "rgba(239, 68, 68, 0.15)", color: "var(--danger)", border: "1px solid var(--danger)", padding: "2px 6px", borderRadius: "4px", fontSize: "0.72rem" }}>
                                  EXCLUDED
                                </span>
                              ) : (
                                <span className="badge" style={{ backgroundColor: "rgba(34, 197, 94, 0.15)", color: "var(--success)", border: "1px solid var(--success)", padding: "2px 6px", borderRadius: "4px", fontSize: "0.72rem" }}>
                                  {item.status === "Modified" ? "MODIFIED" : "NEW"}
                                </span>
                              )}
                            </td>
                            <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: isExcluded ? "line-through" : "none", opacity: isExcluded ? 0.6 : 1 }} title={item.file_path}>
                              {item.relative_path}
                            </td>
                            <td className="text-secondary" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>
                              {item.dest_relative_path}
                            </td>
                            <td style={{ fontFamily: "var(--font-mono)", textAlign: "right", fontSize: "0.78rem" }}>
                              {formatSize(item.size_bytes)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {filteredItems.newFiles.length > visibleLimit && (
                    <div className="text-secondary" style={{ textAlign: "center", padding: "8px", fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
                      Showing {visibleLimit} of {filteredItems.newFiles.length} files (Scroll down to load more)
                    </div>
                  )}
                </>
              ) : (
                <div className="no-data">
                  {searchQuery ? "No matching files found." : "All audio files in destination are already up-to-date!"}
                </div>
              )
            )}

            {activeTab === "uptodate" && (
              filteredItems.upToDateFiles.length > 0 ? (
                <>
                  <table style={{ tableLayout: "fixed", width: "100%" }}>
                    <thead>
                      <tr>
                        <th style={{ width: "36px", textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={
                              filteredItems.upToDateFiles.length > 0 &&
                              filteredItems.upToDateFiles.every((item) => selectedItemPaths.has(item.relative_path))
                            }
                            onChange={() => handleToggleSelectAll(filteredItems.upToDateFiles)}
                            style={{ cursor: "pointer" }}
                          />
                        </th>
                        <th style={{ width: "100px" }}>Status</th>
                        <th style={{ width: "55%" }}>Source Relative Path</th>
                        <th style={{ width: "25%" }}>Target Relative Path</th>
                        <th style={{ width: "90px", textAlign: "right" }}>Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredItems.upToDateFiles.slice(0, visibleLimit).map((item, idx) => {
                        const isSelected = selectedItemPaths.has(item.relative_path);
                        return (
                          <tr
                            key={idx}
                            title={item.file_path}
                            onClick={(e) => handleToggleSelectItem(item.relative_path, idx, e.shiftKey, filteredItems.upToDateFiles)}
                            style={{ backgroundColor: isSelected ? "var(--accent-purple-glow)" : "transparent", cursor: "pointer", userSelect: "none" }}
                          >
                            <td style={{ textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={(e) => handleToggleSelectItem(item.relative_path, idx, (e.nativeEvent as MouseEvent).shiftKey, filteredItems.upToDateFiles)}
                                style={{ cursor: "pointer" }}
                              />
                            </td>
                            <td>
                              <span className="badge" style={{ backgroundColor: "var(--bg-tertiary)", color: "var(--text-muted)", border: "1px solid var(--border-color)", padding: "2px 6px", borderRadius: "4px", fontSize: "0.72rem" }}>
                                SKIPPED
                              </span>
                            </td>
                            <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.file_path}>
                              {item.relative_path}
                            </td>
                            <td className="text-secondary" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>
                              {item.dest_relative_path}
                            </td>
                            <td style={{ fontFamily: "var(--font-mono)", textAlign: "right", fontSize: "0.78rem" }}>
                              {formatSize(item.size_bytes)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {filteredItems.upToDateFiles.length > visibleLimit && (
                    <div className="text-secondary" style={{ textAlign: "center", padding: "8px", fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
                      Showing {visibleLimit} of {filteredItems.upToDateFiles.length} files (Scroll down to load more)
                    </div>
                  )}
                </>
              ) : (
                <div className="no-data">
                  {searchQuery ? "No matching files found." : "No up-to-date files found. Run export to populate destination."}
                </div>
              )
            )}

            {activeTab === "orphans" && (
              filteredItems.orphanFiles.length > 0 ? (
                <>
                  <table style={{ tableLayout: "fixed", width: "100%" }}>
                    <thead>
                      <tr>
                        <th style={{ width: "36px", textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={
                              filteredItems.orphanFiles.length > 0 &&
                              filteredItems.orphanFiles.every((item) => selectedItemPaths.has(item.relative_path))
                            }
                            onChange={() => handleToggleSelectAll(filteredItems.orphanFiles)}
                            style={{ cursor: "pointer" }}
                          />
                        </th>
                        <th style={{ width: "100px" }}>Type</th>
                        <th style={{ width: "70%" }}>Destination Orphan Relative Path</th>
                        <th style={{ width: "90px", textAlign: "right" }}>Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredItems.orphanFiles.slice(0, visibleLimit).map((item, idx) => {
                        const isSelected = selectedItemPaths.has(item.relative_path);
                        return (
                          <tr
                            key={idx}
                            title={item.file_path}
                            onClick={(e) => handleToggleSelectItem(item.relative_path, idx, e.shiftKey, filteredItems.orphanFiles)}
                            style={{ backgroundColor: isSelected ? "var(--accent-purple-glow)" : "transparent", cursor: "pointer", userSelect: "none" }}
                          >
                            <td style={{ textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={(e) => handleToggleSelectItem(item.relative_path, idx, (e.nativeEvent as MouseEvent).shiftKey, filteredItems.orphanFiles)}
                                style={{ cursor: "pointer" }}
                              />
                            </td>
                            <td>
                              <span className="badge" style={{ backgroundColor: "rgba(239, 68, 68, 0.15)", color: "var(--danger)", border: "1px solid var(--danger)", padding: "2px 6px", borderRadius: "4px", fontSize: "0.72rem" }}>
                                {item.is_playlist ? "PLAYLIST" : "AUDIO"}
                              </span>
                            </td>
                            <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.file_path}>
                              {item.relative_path}
                            </td>
                            <td style={{ fontFamily: "var(--font-mono)", textAlign: "right", fontSize: "0.78rem" }}>
                              {formatSize(item.size_bytes)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {filteredItems.orphanFiles.length > visibleLimit && (
                    <div className="text-secondary" style={{ textAlign: "center", padding: "8px", fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
                      Showing {visibleLimit} of {filteredItems.orphanFiles.length} files (Scroll down to load more)
                    </div>
                  )}
                </>
              ) : (
                <div className="no-data">
                  {searchQuery ? "No matching files found." : "No orphan files found in target destination!"}
                </div>
              )
            )}
          </div>
        </div>
      ) : (
        <div className="card" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", margin: 0 }}>
          <p className="no-data">Select an export destination folder above and click "Analyze Diff" to preview changes.</p>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirmModal && (
        <div style={{
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
          zIndex: 1000
        }}>
          <div className="card" style={{ width: "480px", display: "flex", flexDirection: "column", margin: 0, padding: "20px", gap: "14px" }}>
            <div className="card-title" style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "10px", margin: 0 }}>
              <span style={{ color: "var(--danger)", display: "flex", alignItems: "center", gap: "8px", fontSize: "1.05rem" }}>
                ⚠️ Confirm Permanent Deletion
              </span>
            </div>

            <div style={{ fontSize: "0.88rem", lineHeight: 1.5 }}>
              Are you sure you want to permanently delete <strong>{selectedItemPaths.size}</strong> selected file(s) from disk?
              <div style={{ color: "var(--danger)", fontSize: "0.8rem", marginTop: "8px", fontWeight: 500 }}>
                ⚠️ This action cannot be undone!
              </div>
            </div>

            <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", borderTop: "1px solid var(--border-color)", paddingTop: "12px", marginTop: "4px" }}>
              <button className="btn btn-secondary" onClick={() => setShowDeleteConfirmModal(false)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={executeDeleteSelected}>
                🗑 Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Execution Logs Modal */}
      {showLogsModal && (() => {
        const progressPercent = exportProgress && exportProgress.total_bytes > 0
          ? Math.min(100, Math.round((exportProgress.copied_bytes / exportProgress.total_bytes) * 100))
          : 0;

        const elapsedSec = exportProgress ? Math.max(0.1, (Date.now() - exportProgress.startTime) / 1000) : 0;
        const currentSpeed = exportProgress ? exportProgress.copied_bytes / elapsedSec : 0;
        const remainingBytes = exportProgress ? Math.max(0, exportProgress.total_bytes - exportProgress.copied_bytes) : 0;
        const etaSec = currentSpeed > 0 ? remainingBytes / currentSpeed : 0;

        return (
          <div style={{
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
            zIndex: 1000
          }}>
            <div className="card" style={{ width: "720px", maxHeight: "85%", display: "flex", flexDirection: "column", margin: 0, padding: "20px" }}>
              <div className="card-title" style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontWeight: 600, fontSize: "1rem" }}>Export Progress & Logs</span>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  {isExporting && (
                    <button
                      className="btn btn-danger"
                      onClick={handleCancelExport}
                      style={{ padding: "4px 12px", fontSize: "0.8rem" }}
                    >
                      🛑 Stop Export
                    </button>
                  )}
                  <button
                    className="btn btn-secondary"
                    onClick={() => setShowLogsModal(false)}
                    style={{ padding: "4px 12px", fontSize: "0.8rem" }}
                  >
                    Close
                  </button>
                </div>
              </div>

              {/* Sticky Progress Header */}
              {exportProgress && (
                <div style={{
                  backgroundColor: "var(--bg-tertiary)",
                  border: "1px solid var(--border-color)",
                  padding: "12px 14px",
                  borderRadius: "8px",
                  marginTop: "12px",
                  marginBottom: "4px"
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", fontWeight: 600, marginBottom: "8px" }}>
                    <span style={{ color: "var(--text-primary)" }}>
                      {exportProgress.current_file_index} out of {exportProgress.total_files} files ({progressPercent}%)
                    </span>
                    <span style={{ color: "var(--accent-purple)", fontFamily: "var(--font-mono)" }}>
                      {formatSize(exportProgress.copied_bytes)} / {formatSize(exportProgress.total_bytes)} ({formatSpeed(currentSpeed)})
                    </span>
                  </div>

                  {/* Progress Bar Track with Inline Stop/Cross Button */}
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                    <div style={{ flex: 1, height: "8px", backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-color)", borderRadius: "4px", overflow: "hidden" }}>
                      <div style={{ width: `${progressPercent}%`, height: "100%", backgroundColor: isExporting ? "var(--accent-purple)" : "var(--success)", transition: "width 0.3s ease" }} />
                    </div>
                    {isExporting && (
                      <button
                        onClick={handleCancelExport}
                        style={{
                          background: "rgba(239, 68, 68, 0.15)",
                          border: "1px solid var(--danger)",
                          color: "var(--danger)",
                          borderRadius: "4px",
                          cursor: "pointer",
                          padding: "2px 6px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          gap: "4px",
                        }}
                        title="Stop Export Task"
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18"></line>
                          <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                        <span>Stop</span>
                      </button>
                    )}
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem", color: "var(--text-muted)" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60%" }} title={exportProgress.current_file}>
                      📄 {exportProgress.current_file}
                    </span>
                    <span style={{ fontWeight: 600, color: isExporting ? "var(--accent-purple-hover)" : "var(--success)" }}>
                      {isExporting ? `⏱ ETA: ${formatEta(etaSec)}` : exportLogs.some(l => l.includes("stopped")) ? "🛑 Stopped" : "✅ Export Complete"}
                    </span>
                  </div>
                </div>
              )}

              <div ref={logContainerRef} className="console-log" style={{ flex: 1, minHeight: "260px", maxHeight: "400px", overflowY: "auto", marginTop: "12px" }}>
                {exportLogs.join("\n")}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};
