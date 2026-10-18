import React, { useState, useEffect, useMemo, useRef, useLayoutEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  MainConfig,
  ExportStatus,
  ExportTrackItem,
  ExportOrphanItem,
  ExportPlaylistItem,
  ExportDiffReport,
} from "../types";
import { formatSize, formatSpeed, formatEta } from "../utils/formatters";
import { useDebounce } from "../hooks/useDebounce";
import { ConfirmModal } from "../components/common/ConfirmModal";

export type { ExportStatus, ExportTrackItem, ExportOrphanItem, ExportPlaylistItem, ExportDiffReport };

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

  const [skipDuplicates, setSkipDuplicates] = useState<boolean>(false);
  const [deleteOrphans, setDeleteOrphans] = useState<boolean>(false);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportLogs, setExportLogs] = useState<string[]>([]);
  const [showLogsModal, setShowLogsModal] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<"new" | "updated" | "renamed" | "uptodate" | "orphans" | "warnings">("new");
  const [inspectDiffItem, setInspectDiffItem] = useState<ExportTrackItem | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const debouncedSearchQuery = useDebounce(searchQuery, 250);
  const [visibleLimit, setVisibleLimit] = useState<number>(100);
  const [expandedWarningIndex, setExpandedWarningIndex] = useState<number | null>(null);

  useEffect(() => {
    setVisibleLimit(100);
  }, [activeTab, debouncedSearchQuery, diffReport]);

  const handleTableScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollTop + clientHeight >= scrollHeight - 250) {
      setVisibleLimit((prev) => prev + 100);
    }
  };

  const filteredItems = useMemo(() => {
    if (!diffReport) return { newFiles: [], updatedFiles: [], renamedFiles: [], upToDateFiles: [], orphanFiles: [], warningItems: [] };
    const q = debouncedSearchQuery.trim().toLowerCase();
    const warnings = diffReport.warnings || [];
    const renamed = diffReport.renamed_files || [];
    const updated = diffReport.updated_files || [];
    
    if (!q) {
      return {
        newFiles: diffReport.new_files,
        updatedFiles: updated,
        renamedFiles: renamed,
        upToDateFiles: diffReport.up_to_date_files,
        orphanFiles: diffReport.orphan_files,
        warningItems: warnings,
      };
    }

    return {
      newFiles: diffReport.new_files.filter(
        (item) => item.relative_path.toLowerCase().includes(q) || item.dest_relative_path.toLowerCase().includes(q)
      ),
      updatedFiles: updated.filter(
        (item) => item.relative_path.toLowerCase().includes(q) || item.dest_relative_path.toLowerCase().includes(q)
      ),
      renamedFiles: renamed.filter(
        (item) => item.relative_path.toLowerCase().includes(q) || item.dest_relative_path.toLowerCase().includes(q) || (item.old_dest_relative_path || "").toLowerCase().includes(q)
      ),
      upToDateFiles: diffReport.up_to_date_files.filter(
        (item) => item.relative_path.toLowerCase().includes(q) || item.dest_relative_path.toLowerCase().includes(q)
      ),
      orphanFiles: diffReport.orphan_files.filter(
        (item) => item.relative_path.toLowerCase().includes(q)
      ),
      warningItems: warnings.filter(
        (item) => item.target_path.toLowerCase().includes(q) || item.message.toLowerCase().includes(q)
      ),
    };
  }, [diffReport, debouncedSearchQuery]);

  type ExportSortField = "status" | "source" | "dest" | "size";
  type ExportSortOrder = "asc" | "desc";
  const [sortField, setSortField] = useState<ExportSortField | null>(null);
  const [sortOrder, setSortOrder] = useState<ExportSortOrder>("asc");

  const handleToggleSort = (field: ExportSortField) => {
    if (sortField === field) {
      if (sortOrder === "asc") {
        setSortOrder("desc");
      } else {
        setSortField(null);
        setSortOrder("asc");
      }
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

  const renderSortIndicator = (field: ExportSortField) => {
    if (sortField !== field) {
      return (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3, marginLeft: "4px", verticalAlign: "middle" }}>
          <path d="M7 15l5 5 5-5M7 9l5-5 5 5"/>
        </svg>
      );
    }
    return (
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--accent-purple-hover)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: "4px", verticalAlign: "middle" }}>
        {sortOrder === "asc" ? (
          <path d="M18 15l-6-6-6 6"/>
        ) : (
          <path d="M6 9l6 6 6-6"/>
        )}
      </svg>
    );
  };

  const sortedItems = useMemo(() => {
    const sortList = <T extends { status?: string; is_playlist?: boolean; relative_path: string; dest_relative_path?: string; size_bytes?: number }>(items: T[]): T[] => {
      if (!sortField) return items;
      return [...items].sort((a, b) => {
        let comp = 0;
        if (sortField === "status") {
          const sa = a.status || (a.is_playlist ? "PLAYLIST" : "AUDIO");
          const sb = b.status || (b.is_playlist ? "PLAYLIST" : "AUDIO");
          comp = sa.localeCompare(sb);
        } else if (sortField === "source") {
          comp = a.relative_path.localeCompare(b.relative_path);
        } else if (sortField === "dest") {
          const da = a.dest_relative_path || "";
          const db = b.dest_relative_path || "";
          comp = da.localeCompare(db);
        } else if (sortField === "size") {
          comp = (a.size_bytes || 0) - (b.size_bytes || 0);
        }
        return sortOrder === "asc" ? comp : -comp;
      });
    };

    return {
      newFiles: sortList(filteredItems.newFiles),
      updatedFiles: sortList(filteredItems.updatedFiles),
      renamedFiles: sortList(filteredItems.renamedFiles),
      upToDateFiles: sortList(filteredItems.upToDateFiles),
      orphanFiles: sortList(filteredItems.orphanFiles),
      warningItems: filteredItems.warningItems,
    };
  }, [filteredItems, sortField, sortOrder]);

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

  const getAbsPathsForSelected = () => {
    if (!diffReport) return [];
    const map = new Map<string, string>();
    diffReport.new_files.forEach((f) => map.set(f.relative_path, f.file_path));
    (diffReport.updated_files || []).forEach((f) => map.set(f.relative_path, f.file_path));
    (diffReport.renamed_files || []).forEach((f) => map.set(f.relative_path, f.file_path));
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


  const [isApplyingAction, setIsApplyingAction] = useState<boolean>(false);
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    confirmText: string;
    confirmVariant?: "primary" | "danger";
    executingText?: string;
    onConfirm: () => Promise<void> | void;
  } | null>(null);

  const [notification, setNotification] = useState<{
    message: string;
    type: "success" | "error" | "info";
  } | null>(null);

  useEffect(() => {
    if (!notification) return;
    const timer = setTimeout(() => setNotification(null), 4000);
    return () => clearTimeout(timer);
  }, [notification]);

  const handleApplyRenames = (selectedOnly?: boolean, singleItem?: ExportTrackItem) => {
    const targetDir = exportDir || diffReport?.destination;
    if (!targetDir) {
      setNotification({ message: "No export destination directory specified.", type: "error" });
      return;
    }
    const toProcess = singleItem
      ? [singleItem]
      : selectedOnly
        ? sortedItems.renamedFiles.filter(item => selectedItemPaths.has(item.relative_path))
        : sortedItems.renamedFiles;

    if (toProcess.length === 0) {
      setNotification({
        message: selectedOnly ? "No renamed tracks selected to apply." : "No renamed tracks to process.",
        type: "info",
      });
      return;
    }

    setConfirmModal({
      title: "🔄 Confirm Track Renames",
      message: `Apply instant filesystem rename for ${toProcess.length} track(s) on destination USB (${targetDir})? No large audio data will need to be re-copied.`,
      confirmText: `Rename ${toProcess.length} File(s)`,
      confirmVariant: "primary",
      executingText: "Renaming tracks on destination...",
      onConfirm: async () => {
        setIsApplyingAction(true);
        try {
          const count = await invoke<number>("apply_export_renames", {
            destination: targetDir,
            items: toProcess,
          });
          setNotification({ message: `Successfully renamed ${count} track(s) on destination!`, type: "success" });
          setSelectedItemPaths(new Set());
          setConfirmModal(null);
          await handleAnalyzeDiff();
        } catch (e) {
          setNotification({ message: "Error applying renames: " + e, type: "error" });
          setConfirmModal(null);
        } finally {
          setIsApplyingAction(false);
        }
      },
    });
  };

  const handleApplyCopies = (actionType: "new" | "updated" | "force", selectedOnly?: boolean, singleItem?: ExportTrackItem) => {
    const targetDir = exportDir || diffReport?.destination;
    if (!targetDir) {
      setNotification({ message: "No export destination directory specified.", type: "error" });
      return;
    }
    const sourceList = actionType === "new" ? sortedItems.newFiles : actionType === "updated" ? sortedItems.updatedFiles : sortedItems.upToDateFiles;
    const toProcess = singleItem
      ? [singleItem]
      : selectedOnly
        ? sourceList.filter(item => selectedItemPaths.has(item.relative_path))
        : sourceList;

    if (toProcess.length === 0) {
      setNotification({
        message: selectedOnly ? "No tracks selected in this tab to transfer." : "No tracks available to transfer.",
        type: "info",
      });
      return;
    }

    const actionLabel = actionType === "new" ? "Copy New" : actionType === "updated" ? "Update Tags / Content" : "Force Re-copy";
    const title = actionType === "new" ? "🟢 Copy New Tracks" : actionType === "updated" ? "🟠 Update Modified Tracks" : "⚪ Force Re-copy Tracks";
    const desc = actionType === "updated"
      ? `Transfer and update ${toProcess.length} modified track(s) on USB with latest tags, cover art, and content?`
      : `${actionLabel} for ${toProcess.length} track(s) to destination USB?`;

    setConfirmModal({
      title,
      message: desc,
      confirmText: `${actionLabel} (${toProcess.length})`,
      confirmVariant: "primary",
      executingText: `Transferring ${toProcess.length} track(s) to destination...`,
      onConfirm: async () => {
        setIsApplyingAction(true);
        try {
          const count = await invoke<number>("apply_export_copies", {
            destination: targetDir,
            items: toProcess,
          });
          setNotification({ message: `Successfully transferred ${count} track(s) to destination!`, type: "success" });
          setSelectedItemPaths(new Set());
          setConfirmModal(null);
          await handleAnalyzeDiff();
        } catch (e) {
          setNotification({ message: "Error transferring files: " + e, type: "error" });
          setConfirmModal(null);
        } finally {
          setIsApplyingAction(false);
        }
      },
    });
  };

  const handleDeleteOrphans = (selectedOnly?: boolean, singleItem?: ExportOrphanItem) => {
    const targetDir = exportDir || diffReport?.destination;
    if (!targetDir) {
      setNotification({ message: "No export destination directory specified.", type: "error" });
      return;
    }
    const toProcess = singleItem
      ? [singleItem]
      : selectedOnly
        ? sortedItems.orphanFiles.filter(item => selectedItemPaths.has(item.relative_path))
        : sortedItems.orphanFiles;

    if (toProcess.length === 0) {
      setNotification({
        message: selectedOnly ? "No orphan files selected to delete." : "No orphan files to delete.",
        type: "info",
      });
      return;
    }

    setConfirmModal({
      title: "🗑 Confirm Orphan Deletion",
      message: `Permanently delete ${toProcess.length} orphan file(s) from destination USB? This action cannot be undone.`,
      confirmText: `Delete ${toProcess.length} Orphan(s)`,
      confirmVariant: "danger",
      executingText: "Deleting orphan files...",
      onConfirm: async () => {
        setIsApplyingAction(true);
        try {
          const filePaths = toProcess.map(o => o.file_path);
          const count = await invoke<number>("delete_export_files", { filePaths });
          setNotification({ message: `Successfully deleted ${count} orphan file(s)!`, type: "success" });
          setSelectedItemPaths(new Set());
          setConfirmModal(null);
          await handleAnalyzeDiff();
        } catch (e) {
          setNotification({ message: "Error deleting orphans: " + e, type: "error" });
          setConfirmModal(null);
        } finally {
          setIsApplyingAction(false);
        }
      },
    });
  };

  const [isCleaningHidden, setIsCleaningHidden] = useState<boolean>(false);

  const handleCleanHiddenFiles = (destPath: string) => {
    if (!destPath) {
      setNotification({ message: "No export destination directory specified.", type: "error" });
      return;
    }
    setConfirmModal({
      title: "🧹 Clean Hidden System Files",
      message: `Clean all macOS resource fork junk files (._*) from "${destPath}"?`,
      confirmText: "Clean Hidden Files",
      confirmVariant: "primary",
      executingText: "Cleaning hidden system files...",
      onConfirm: async () => {
        setIsCleaningHidden(true);
        try {
          const count = await invoke<number>("clean_export_hidden_files", { destination: destPath });
          setNotification({ message: `Successfully cleaned ${count} hidden system file(s)!`, type: "success" });
          setConfirmModal(null);
          await handleAnalyzeDiff();
        } catch (e) {
          setNotification({ message: "Error cleaning hidden files: " + e, type: "error" });
          setConfirmModal(null);
        } finally {
          setIsCleaningHidden(false);
        }
      },
    });
  };

  useEffect(() => {
    try {
      localStorage.setItem("export_target_dir", exportDir);
      if (diffReport && diffReport.destination !== exportDir) {
        setDiffReport(null);
      }
    } catch (e) {}
  }, [exportDir]);


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

  const handleAnalyzeDiff = async (skipDupsOverride?: boolean | React.MouseEvent) => {
    if (!configPath || !exportDir) {
      alert("Please select a valid export destination directory first.");
      return;
    }
    const effectiveSkipDups =
      typeof skipDupsOverride === "boolean" ? skipDupsOverride : skipDuplicates;
    setIsAnalyzing(true);
    try {
      const formatsList = formats.split(",").map((f) => f.trim());
      const report = await invoke<ExportDiffReport>("analyze_export_diff", {
        configPath,
        destination: exportDir,
        formats: formatsList,
        relativeToConfig,
        skipDuplicates: effectiveSkipDups,
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



  const handleCancelExport = async () => {
    try {
      await invoke("cancel_export");
      setExportLogs((prev) => [...prev, "🛑 Stopping export process..."]);
    } catch (e) {
      console.error("Error stopping export:", e);
    }
  };

  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const isExportAutoScrollRef = useRef<boolean>(true);
  const [isExportAutoScroll, setIsExportAutoScroll] = useState<boolean>(true);

  const handleExportLogsScroll = () => {
    if (!logContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight <= 45;
    isExportAutoScrollRef.current = isAtBottom;
    setIsExportAutoScroll((prev) => (prev !== isAtBottom ? isAtBottom : prev));
  };

  const handleExportScrollToLatest = () => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      isExportAutoScrollRef.current = true;
      setIsExportAutoScroll(true);
    }
  };

  useLayoutEffect(() => {
    if (logContainerRef.current && isExportAutoScrollRef.current) {
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
    isExportAutoScrollRef.current = true;
    setIsExportAutoScroll(true);
    const cmdStr = `$ sync-export --config "${configPath}" --destination "${exportDir}" --formats "${formats || "all"}"${skipDuplicates ? " --skip-duplicates" : ""}${deleteOrphans ? " --delete-orphans" : ""}`;
    setExportLogs([cmdStr, "Initializing smart sync export..."]);
    setExportProgress(null);

    const taskId = `export_${Date.now()}`;
    let unlistenLog: (() => void) | null = null;
    let unlistenProgress: (() => void) | null = null;

    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenLog = await listen<string>("export-log", (event) => {
        setExportLogs((prev) => {
          if (event.payload.startsWith("$ sync-export ") && prev.some((l) => l.startsWith("$ sync-export "))) {
            return prev;
          }
          return [...prev, event.payload];
        });
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
        skipDuplicates,
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
            <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
              <label
                style={{ display: "flex", alignItems: "center", gap: "7px", cursor: "pointer", fontSize: "0.85rem", color: "var(--text-secondary)" }}
                title="Deduplicate songs across playlists (Rule 1 priority + format quality), export only the superior file, and update all playlists referencing that song to point to the superior file"
              >
                <input
                  type="checkbox"
                  checked={skipDuplicates}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setSkipDuplicates(next);
                    if (diffReport && exportDir) {
                      handleAnalyzeDiff(next);
                    }
                  }}
                  style={{ width: "16px", height: "16px", accentColor: "var(--accent-purple)" }}
                />
                <span>Skip duplicates</span>
              </label>

              <label
                style={{ display: "flex", alignItems: "center", gap: "7px", cursor: "pointer", fontSize: "0.85rem", color: "var(--text-secondary)" }}
                title="Remove files in the destination folder that are no longer referenced by any exported playlist"
              >
                <input
                  type="checkbox"
                  checked={deleteOrphans}
                  onChange={(e) => setDeleteOrphans(e.target.checked)}
                  style={{ width: "16px", height: "16px", accentColor: "var(--accent-purple)" }}
                />
                <span>Delete orphans</span>
              </label>
            </div>

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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: "10px" }}>
          <div className="card" style={{ padding: "12px 14px", margin: 0 }}>
            <div className="text-secondary" style={{ fontSize: "0.75rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
              🟢 New Tracks
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
              🟠 Updated Tracks
            </div>
            <div style={{ fontSize: "1.2rem", fontWeight: 700, marginTop: "4px", color: (diffReport.updated_files?.length || 0) > 0 ? "var(--warning)" : "var(--text-primary)" }}>
              {diffReport.updated_files?.length || 0} files
            </div>
            <div className="text-secondary" style={{ fontSize: "0.78rem", fontFamily: "var(--font-mono)", marginTop: "2px" }}>
              {formatSize(diffReport.total_bytes_updated || 0)}
            </div>
          </div>

          <div className="card" style={{ padding: "12px 14px", margin: 0 }}>
            <div className="text-secondary" style={{ fontSize: "0.75rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
              🔄 Renamed (Instant)
            </div>
            <div style={{ fontSize: "1.2rem", fontWeight: 700, marginTop: "4px", color: (diffReport.renamed_files?.length || 0) > 0 ? "var(--accent-blue)" : "var(--text-primary)" }}>
              {diffReport.renamed_files?.length || 0} files
            </div>
            <div className="text-secondary" style={{ fontSize: "0.78rem", fontFamily: "var(--font-mono)", marginTop: "2px" }}>
              {formatSize(diffReport.total_bytes_renamed || 0)} (0s USB copy)
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
                🟢 New ({filteredItems.newFiles.length})
              </button>
              <button
                className={`btn ${activeTab === "updated" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setActiveTab("updated")}
                style={{
                  padding: "4px 12px",
                  fontSize: "0.8rem",
                  borderColor: filteredItems.updatedFiles.length > 0 ? "var(--warning)" : undefined,
                  color: filteredItems.updatedFiles.length > 0 && activeTab !== "updated" ? "var(--warning)" : undefined,
                }}
              >
                🟠 Updated ({filteredItems.updatedFiles.length})
              </button>
              <button
                className={`btn ${activeTab === "renamed" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setActiveTab("renamed")}
                style={{
                  padding: "4px 12px",
                  fontSize: "0.8rem",
                  borderColor: filteredItems.renamedFiles.length > 0 ? "var(--accent-blue)" : undefined,
                  color: filteredItems.renamedFiles.length > 0 && activeTab !== "renamed" ? "var(--accent-blue)" : undefined,
                }}
              >
                🔄 Renamed ({filteredItems.renamedFiles.length})
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
              <button
                className={`btn ${activeTab === "warnings" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setActiveTab("warnings")}
                style={{
                  padding: "4px 12px",
                  fontSize: "0.8rem",
                  borderColor: filteredItems.warningItems.length > 0 ? "var(--warning)" : undefined,
                  color: filteredItems.warningItems.length > 0 && activeTab !== "warnings" ? "var(--warning)" : undefined,
                }}
              >
                ⚠️ Warnings ({filteredItems.warningItems.length})
              </button>

              {activeTab === "warnings" && diffReport?.warnings?.some((w) => w.warning_type === "apple_double") && (
                <button
                  className="btn btn-secondary"
                  disabled={isCleaningHidden}
                  onClick={() => handleCleanHiddenFiles(exportDir)}
                  style={{
                    padding: "4px 10px",
                    fontSize: "0.8rem",
                    borderColor: "var(--danger)",
                    color: "var(--danger)",
                    marginLeft: "4px",
                    fontWeight: 600,
                  }}
                  title="Clean all hidden macOS resource fork files (._*) in destination"
                >
                  {isCleaningHidden ? "Cleaning..." : "🧹 Clean Hidden Files"}
                </button>
              )}

              {/* Contextual Apply / Action Buttons */}
              {selectedItemPaths.size === 0 && (
                <>
                  {activeTab === "new" && filteredItems.newFiles.length > 0 && (
                    <button
                      className="btn btn-secondary"
                      disabled={isApplyingAction}
                      onClick={() => handleApplyCopies("new", false)}
                      style={{ padding: "3px 10px", fontSize: "0.75rem", borderColor: "var(--success)", color: "var(--success)", fontWeight: 600, marginLeft: "4px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                      title="Copy all new tracks to destination USB"
                    >
                      <span>⚡ Copy All New ({filteredItems.newFiles.length})</span>
                    </button>
                  )}
                  {activeTab === "updated" && filteredItems.updatedFiles.length > 0 && (
                    <button
                      className="btn btn-secondary"
                      disabled={isApplyingAction}
                      onClick={() => handleApplyCopies("updated", false)}
                      style={{ padding: "3px 10px", fontSize: "0.75rem", borderColor: "var(--warning)", color: "var(--warning)", fontWeight: 600, marginLeft: "4px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                      title="Transfer all modified tracks to update destination with new metadata"
                    >
                      <span>⚡ Apply All Updates ({filteredItems.updatedFiles.length})</span>
                    </button>
                  )}
                  {activeTab === "renamed" && filteredItems.renamedFiles.length > 0 && (
                    <button
                      className="btn btn-secondary"
                      disabled={isApplyingAction}
                      onClick={() => handleApplyRenames(false)}
                      style={{ padding: "3px 10px", fontSize: "0.75rem", borderColor: "var(--accent-blue)", color: "var(--accent-blue)", fontWeight: 600, marginLeft: "4px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                      title="Apply instant filesystem rename for all detected renamed tracks"
                    >
                      <span>⚡ Apply All Renames ({filteredItems.renamedFiles.length})</span>
                    </button>
                  )}
                  {activeTab === "orphans" && filteredItems.orphanFiles.length > 0 && (
                    <button
                      className="btn btn-secondary"
                      disabled={isApplyingAction}
                      onClick={() => handleDeleteOrphans(false)}
                      style={{ padding: "3px 10px", fontSize: "0.75rem", borderColor: "var(--danger)", color: "var(--danger)", fontWeight: 600, marginLeft: "4px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                      title="Delete all detected orphan files from destination USB"
                    >
                      <span>🗑 Clean All Orphans ({filteredItems.orphanFiles.length})</span>
                    </button>
                  )}
                </>
              )}

              {/* Action Panel for Selected items */}
              {selectedItemPaths.size > 0 && (
                <div style={{ display: "flex", gap: "6px", alignItems: "center", borderLeft: "1px solid var(--border-color)", paddingLeft: "10px", marginLeft: "4px" }}>
                  <span style={{ fontWeight: 600, color: "var(--accent-purple)", fontSize: "0.78rem" }}>
                    {selectedItemPaths.size} selected
                  </span>

                  {/* Primary Tab Apply Button for Selection */}
                  {activeTab === "new" && (
                    <button
                      className="btn btn-primary"
                      disabled={isApplyingAction}
                      onClick={() => handleApplyCopies("new", true)}
                      style={{ padding: "3px 10px", fontSize: "0.75rem", backgroundColor: "var(--success)", borderColor: "var(--success)", color: "#fff", fontWeight: 600, display: "flex", alignItems: "center", gap: "4px" }}
                      title={`Copy ${selectedItemPaths.size} selected new file(s) to destination USB`}
                    >
                      <span>⚡ Apply / Copy ({selectedItemPaths.size})</span>
                    </button>
                  )}
                  {activeTab === "updated" && (
                    <button
                      className="btn btn-primary"
                      disabled={isApplyingAction}
                      onClick={() => handleApplyCopies("updated", true)}
                      style={{ padding: "3px 10px", fontSize: "0.75rem", backgroundColor: "var(--warning)", borderColor: "var(--warning)", color: "#000", fontWeight: 600, display: "flex", alignItems: "center", gap: "4px" }}
                      title={`Transfer ${selectedItemPaths.size} selected updated file(s) to overwrite destination with new tags/content`}
                    >
                      <span>⚡ Apply / Update ({selectedItemPaths.size})</span>
                    </button>
                  )}
                  {activeTab === "renamed" && (
                    <button
                      className="btn btn-primary"
                      disabled={isApplyingAction}
                      onClick={() => handleApplyRenames(true)}
                      style={{ padding: "3px 10px", fontSize: "0.75rem", backgroundColor: "var(--accent-blue)", borderColor: "var(--accent-blue)", color: "#fff", fontWeight: 600, display: "flex", alignItems: "center", gap: "4px" }}
                      title={`Instantly rename ${selectedItemPaths.size} selected file(s) on destination USB`}
                    >
                      <span>⚡ Apply / Rename ({selectedItemPaths.size})</span>
                    </button>
                  )}
                  {activeTab === "uptodate" && (
                    <button
                      className="btn btn-secondary"
                      disabled={isApplyingAction}
                      onClick={() => handleApplyCopies("force", true)}
                      style={{ padding: "3px 10px", fontSize: "0.75rem", fontWeight: 600, display: "flex", alignItems: "center", gap: "4px" }}
                      title={`Force re-copy ${selectedItemPaths.size} selected file(s) to destination`}
                    >
                      <span>🔄 Apply / Re-copy ({selectedItemPaths.size})</span>
                    </button>
                  )}
                  {activeTab === "orphans" && (
                    <button
                      className="btn btn-danger"
                      disabled={isApplyingAction}
                      onClick={() => handleDeleteOrphans(true)}
                      style={{ padding: "3px 10px", fontSize: "0.75rem", fontWeight: 600, display: "flex", alignItems: "center", gap: "4px" }}
                      title={`Delete ${selectedItemPaths.size} selected orphan file(s) from destination USB`}
                    >
                      <span>🗑 Apply / Delete ({selectedItemPaths.size})</span>
                    </button>
                  )}

                  {(activeTab === "new" || activeTab === "updated") && (
                    <button className="btn btn-secondary" onClick={handleToggleExcludeSelected} style={{ padding: "3px 8px", fontSize: "0.75rem" }}>
                      {areAllSelectedExcluded ? "✅ Include" : "🚫 Exclude"}
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
              sortedItems.newFiles.length > 0 ? (
                <>
                  <table style={{ tableLayout: "fixed", width: "100%" }}>
                    <thead>
                      <tr>
                        <th style={{ width: "36px", textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={
                              sortedItems.newFiles.length > 0 &&
                              sortedItems.newFiles.every((item) => selectedItemPaths.has(item.relative_path))
                            }
                            onChange={() => handleToggleSelectAll(sortedItems.newFiles)}
                            style={{ cursor: "pointer" }}
                          />
                        </th>
                        <th
                          style={{ width: "100px", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("status")}
                          title="Click to sort by Status"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center" }}>
                            <span>Status</span>
                            {renderSortIndicator("status")}
                          </div>
                        </th>
                        <th
                          style={{ width: "55%", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("source")}
                          title="Click to sort by Source Path"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center" }}>
                            <span>Source Relative Path</span>
                            {renderSortIndicator("source")}
                          </div>
                        </th>
                        <th
                          style={{ width: "25%", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("dest")}
                          title="Click to sort by Target Path"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center" }}>
                            <span>Target Relative Path</span>
                            {renderSortIndicator("dest")}
                          </div>
                        </th>
                        <th
                          style={{ width: "90px", textAlign: "right", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("size")}
                          title="Click to sort by File Size"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end" }}>
                            <span>Size</span>
                            {renderSortIndicator("size")}
                          </div>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedItems.newFiles.slice(0, visibleLimit).map((item, idx) => {
                        const isExcluded = excludedPaths.has(item.relative_path);
                        const isSelected = selectedItemPaths.has(item.relative_path);
                        return (
                          <tr
                            key={idx}
                            className={isSelected ? "selected" : undefined}
                            data-selected={isSelected}
                            title={item.file_path}
                            onClick={(e) => handleToggleSelectItem(item.relative_path, idx, e.shiftKey, sortedItems.newFiles)}
                            style={{ cursor: "pointer", userSelect: "none" }}
                          >
                            <td style={{ textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={(e) => handleToggleSelectItem(item.relative_path, idx, (e.nativeEvent as MouseEvent).shiftKey, sortedItems.newFiles)}
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
                  {sortedItems.newFiles.length > visibleLimit && (
                    <div className="text-secondary" style={{ textAlign: "center", padding: "8px", fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
                      Showing {visibleLimit} of {sortedItems.newFiles.length} files (Scroll down to load more)
                    </div>
                  )}
                </>
              ) : (
                <div className="no-data">
                  {searchQuery ? "No matching files found." : "All audio files in destination are already up-to-date!"}
                </div>
              )
            )}

            {activeTab === "updated" && (
              sortedItems.updatedFiles.length > 0 ? (
                <>
                  <table style={{ tableLayout: "fixed", width: "100%" }}>
                    <thead>
                      <tr>
                        <th style={{ width: "36px", textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={
                              sortedItems.updatedFiles.length > 0 &&
                              sortedItems.updatedFiles.every((item) => selectedItemPaths.has(item.relative_path))
                            }
                            onChange={() => handleToggleSelectAll(sortedItems.updatedFiles)}
                            style={{ cursor: "pointer" }}
                          />
                        </th>
                        <th
                          style={{ width: "95px", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("status")}
                          title="Click to sort by Status"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center" }}>
                            <span>Status</span>
                            {renderSortIndicator("status")}
                          </div>
                        </th>
                        <th style={{ width: "185px" }}>Changes Detected</th>
                        <th
                          style={{ width: "32%", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("source")}
                          title="Click to sort by Source Path"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center" }}>
                            <span>Source Relative Path</span>
                            {renderSortIndicator("source")}
                          </div>
                        </th>
                        <th
                          style={{ width: "24%", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("dest")}
                          title="Click to sort by Target Path"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center" }}>
                            <span>Target Relative Path</span>
                            {renderSortIndicator("dest")}
                          </div>
                        </th>
                        <th
                          style={{ width: "80px", textAlign: "right", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("size")}
                          title="Click to sort by File Size"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end" }}>
                            <span>Size</span>
                            {renderSortIndicator("size")}
                          </div>
                        </th>
                        <th style={{ width: "85px", textAlign: "center" }}>Diff</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedItems.updatedFiles.slice(0, visibleLimit).map((item, idx) => {
                        const isExcluded = excludedPaths.has(item.relative_path);
                        const isSelected = selectedItemPaths.has(item.relative_path);
                        const diff = item.diff_details;
                        return (
                          <tr
                            key={idx}
                            className={isSelected ? "selected" : undefined}
                            data-selected={isSelected}
                            title="Click row to select, or click '🔍 Diff' to inspect changes"
                            onClick={(e) => handleToggleSelectItem(item.relative_path, idx, e.shiftKey, sortedItems.updatedFiles)}
                            style={{ cursor: "pointer", userSelect: "none" }}
                          >
                            <td style={{ textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={(e) => handleToggleSelectItem(item.relative_path, idx, (e.nativeEvent as MouseEvent).shiftKey, sortedItems.updatedFiles)}
                                style={{ cursor: "pointer" }}
                              />
                            </td>
                            <td>
                              {isExcluded ? (
                                <span className="badge" style={{ backgroundColor: "rgba(239, 68, 68, 0.15)", color: "var(--danger)", border: "1px solid var(--danger)", padding: "2px 6px", borderRadius: "4px", fontSize: "0.72rem" }}>
                                  EXCLUDED
                                </span>
                              ) : (
                                <span className="badge" style={{ backgroundColor: "rgba(245, 158, 11, 0.15)", color: "var(--warning)", border: "1px solid var(--warning)", padding: "2px 6px", borderRadius: "4px", fontSize: "0.72rem", fontWeight: 600 }}>
                                  🟠 UPDATED
                                </span>
                              )}
                            </td>
                            <td>
                              <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", alignItems: "center" }}>
                                {diff?.has_tag_changes && (
                                  <span className="badge" style={{ backgroundColor: "rgba(245, 158, 11, 0.15)", color: "var(--warning)", border: "1px solid var(--warning)", padding: "1px 5px", borderRadius: "3px", fontSize: "0.68rem" }}>
                                    🏷️ Tags
                                  </span>
                                )}
                                {diff?.has_artwork_changes && (
                                  <span className="badge" style={{ backgroundColor: "rgba(168, 85, 247, 0.15)", color: "var(--accent-purple)", border: "1px solid var(--accent-purple)", padding: "1px 5px", borderRadius: "3px", fontSize: "0.68rem" }}>
                                    🖼️ Cover
                                  </span>
                                )}
                                {diff?.has_audio_changes ? (
                                  <span className="badge" style={{ backgroundColor: "rgba(239, 68, 68, 0.15)", color: "var(--danger)", border: "1px solid var(--danger)", padding: "1px 5px", borderRadius: "3px", fontSize: "0.68rem" }}>
                                    🔊 Audio
                                  </span>
                                ) : (
                                  <span className="badge" style={{ backgroundColor: "rgba(34, 197, 94, 0.15)", color: "var(--success)", border: "1px solid var(--success)", padding: "1px 5px", borderRadius: "3px", fontSize: "0.68rem" }} title="Audio stream identical; tags/artwork updated">
                                    🎶 Audio Same
                                  </span>
                                )}
                              </div>
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
                            <td style={{ textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                              <div style={{ display: "inline-flex", gap: "4px" }}>
                                <button
                                  className="btn btn-secondary"
                                  onClick={() => setInspectDiffItem(item)}
                                  style={{ padding: "2px 8px", fontSize: "0.72rem", display: "inline-flex", alignItems: "center", gap: "3px", borderColor: "var(--warning)", color: "var(--warning)" }}
                                  title="Inspect git-diff of tags, cover art, and audio stream"
                                >
                                  🔍 Diff
                                </button>
                                <button
                                  className="btn btn-primary"
                                  disabled={isApplyingAction}
                                  onClick={() => handleApplyCopies("updated", false, item)}
                                  style={{ padding: "2px 8px", fontSize: "0.72rem", display: "inline-flex", alignItems: "center", gap: "3px", backgroundColor: "var(--warning)", borderColor: "var(--warning)", color: "#000", fontWeight: 600 }}
                                  title="Update this file on USB destination"
                                >
                                  ⚡ Update
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {sortedItems.updatedFiles.length > visibleLimit && (
                    <div className="text-secondary" style={{ textAlign: "center", padding: "8px", fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
                      Showing {visibleLimit} of {sortedItems.updatedFiles.length} files (Scroll down to load more)
                    </div>
                  )}
                </>
              ) : (
                <div className="no-data">
                  {searchQuery ? "No matching updated files found." : "No modified files detected. All existing destination tracks match source library metadata."}
                </div>
              )
            )}

            {activeTab === "renamed" && (
              sortedItems.renamedFiles.length > 0 ? (
                <>
                  <table style={{ tableLayout: "fixed", width: "100%" }}>
                    <thead>
                      <tr>
                        <th style={{ width: "36px", textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={
                              sortedItems.renamedFiles.length > 0 &&
                              sortedItems.renamedFiles.every((item) => selectedItemPaths.has(item.relative_path))
                            }
                            onChange={() => handleToggleSelectAll(sortedItems.renamedFiles)}
                            style={{ cursor: "pointer" }}
                          />
                        </th>
                        <th
                          style={{ width: "110px", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("status")}
                          title="Click to sort by Status"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center" }}>
                            <span>Status</span>
                            {renderSortIndicator("status")}
                          </div>
                        </th>
                        <th
                          style={{ width: "36%", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("source")}
                          title="Click to sort by Source Path"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center" }}>
                            <span>Source Relative Path (New Name)</span>
                            {renderSortIndicator("source")}
                          </div>
                        </th>
                        <th
                          style={{ width: "36%", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("dest")}
                          title="Click to sort by Destination Rename"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center" }}>
                            <span>Destination Rename (Old → New)</span>
                            {renderSortIndicator("dest")}
                          </div>
                        </th>
                        <th
                          style={{ width: "80px", textAlign: "right", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("size")}
                          title="Click to sort by File Size"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end" }}>
                            <span>Size</span>
                            {renderSortIndicator("size")}
                          </div>
                        </th>
                        <th style={{ width: "80px", textAlign: "center" }}>
                          <span>Action</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedItems.renamedFiles.slice(0, visibleLimit).map((item, idx) => {
                        const isSelected = selectedItemPaths.has(item.relative_path);
                        return (
                          <tr
                            key={idx}
                            className={isSelected ? "selected" : undefined}
                            data-selected={isSelected}
                            title={item.file_path}
                            onClick={(e) => handleToggleSelectItem(item.relative_path, idx, e.shiftKey, sortedItems.renamedFiles)}
                            style={{ cursor: "pointer", userSelect: "none" }}
                          >
                            <td style={{ textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={(e) => handleToggleSelectItem(item.relative_path, idx, (e.nativeEvent as MouseEvent).shiftKey, sortedItems.renamedFiles)}
                                style={{ cursor: "pointer" }}
                              />
                            </td>
                            <td>
                              <span className="badge" style={{ backgroundColor: "rgba(59, 130, 246, 0.15)", color: "var(--accent-blue)", border: "1px solid var(--accent-blue)", padding: "2px 6px", borderRadius: "4px", fontSize: "0.72rem", fontWeight: 600 }}>
                                🔄 RENAMED
                              </span>
                            </td>
                            <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.file_path}>
                              {item.relative_path}
                            </td>
                            <td className="text-secondary" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>
                              <span style={{ textDecoration: "line-through", opacity: 0.65 }}>{item.old_dest_relative_path}</span>
                              <span style={{ margin: "0 6px", color: "var(--accent-blue)" }}>→</span>
                              <span style={{ color: "var(--success)", fontWeight: 600 }}>{item.dest_relative_path}</span>
                            </td>
                            <td style={{ fontFamily: "var(--font-mono)", textAlign: "right", fontSize: "0.78rem" }}>
                              {formatSize(item.size_bytes)}
                            </td>
                            <td style={{ textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                              <button
                                className="btn btn-primary"
                                disabled={isApplyingAction}
                                onClick={() => handleApplyRenames(false, item)}
                                style={{ padding: "2px 8px", fontSize: "0.72rem", display: "inline-flex", alignItems: "center", gap: "3px", backgroundColor: "var(--accent-blue)", borderColor: "var(--accent-blue)", color: "#fff", fontWeight: 600 }}
                                title="Apply instant filesystem rename for this track on destination USB"
                              >
                                ⚡ Rename
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {sortedItems.renamedFiles.length > visibleLimit && (
                    <div className="text-secondary" style={{ textAlign: "center", padding: "8px", fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
                      Showing {visibleLimit} of {sortedItems.renamedFiles.length} files (Scroll down to load more)
                    </div>
                  )}
                </>
              ) : (
                <div className="no-data">
                  {searchQuery ? "No matching renamed files found." : "No renamed files detected. All tracks already match target destination paths."}
                </div>
              )
            )}

            {activeTab === "uptodate" && (
              sortedItems.upToDateFiles.length > 0 ? (
                <>
                  <table style={{ tableLayout: "fixed", width: "100%" }}>
                    <thead>
                      <tr>
                        <th style={{ width: "36px", textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={
                              sortedItems.upToDateFiles.length > 0 &&
                              sortedItems.upToDateFiles.every((item) => selectedItemPaths.has(item.relative_path))
                            }
                            onChange={() => handleToggleSelectAll(sortedItems.upToDateFiles)}
                            style={{ cursor: "pointer" }}
                          />
                        </th>
                        <th
                          style={{ width: "100px", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("status")}
                          title="Click to sort by Status"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center" }}>
                            <span>Status</span>
                            {renderSortIndicator("status")}
                          </div>
                        </th>
                        <th
                          style={{ width: "55%", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("source")}
                          title="Click to sort by Source Path"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center" }}>
                            <span>Source Relative Path</span>
                            {renderSortIndicator("source")}
                          </div>
                        </th>
                        <th
                          style={{ width: "25%", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("dest")}
                          title="Click to sort by Target Path"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center" }}>
                            <span>Target Relative Path</span>
                            {renderSortIndicator("dest")}
                          </div>
                        </th>
                        <th
                          style={{ width: "90px", textAlign: "right", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("size")}
                          title="Click to sort by File Size"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end" }}>
                            <span>Size</span>
                            {renderSortIndicator("size")}
                          </div>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedItems.upToDateFiles.slice(0, visibleLimit).map((item, idx) => {
                        const isSelected = selectedItemPaths.has(item.relative_path);
                        return (
                          <tr
                            key={idx}
                            className={isSelected ? "selected" : undefined}
                            data-selected={isSelected}
                            title={item.file_path}
                            onClick={(e) => handleToggleSelectItem(item.relative_path, idx, e.shiftKey, sortedItems.upToDateFiles)}
                            style={{ cursor: "pointer", userSelect: "none" }}
                          >
                            <td style={{ textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={(e) => handleToggleSelectItem(item.relative_path, idx, (e.nativeEvent as MouseEvent).shiftKey, sortedItems.upToDateFiles)}
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
                  {sortedItems.upToDateFiles.length > visibleLimit && (
                    <div className="text-secondary" style={{ textAlign: "center", padding: "8px", fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
                      Showing {visibleLimit} of {sortedItems.upToDateFiles.length} files (Scroll down to load more)
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
              sortedItems.orphanFiles.length > 0 ? (
                <>
                  <table style={{ tableLayout: "fixed", width: "100%" }}>
                    <thead>
                      <tr>
                        <th style={{ width: "36px", textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={
                              sortedItems.orphanFiles.length > 0 &&
                              sortedItems.orphanFiles.every((item) => selectedItemPaths.has(item.relative_path))
                            }
                            onChange={() => handleToggleSelectAll(sortedItems.orphanFiles)}
                            style={{ cursor: "pointer" }}
                          />
                        </th>
                        <th
                          style={{ width: "100px", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("status")}
                          title="Click to sort by Type"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center" }}>
                            <span>Type</span>
                            {renderSortIndicator("status")}
                          </div>
                        </th>
                        <th
                          style={{ width: "70%", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("source")}
                          title="Click to sort by Orphan Path"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center" }}>
                            <span>Destination Orphan Relative Path</span>
                            {renderSortIndicator("source")}
                          </div>
                        </th>
                        <th
                          style={{ width: "90px", textAlign: "right", cursor: "pointer", userSelect: "none" }}
                          onClick={() => handleToggleSort("size")}
                          title="Click to sort by File Size"
                        >
                          <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end" }}>
                            <span>Size</span>
                            {renderSortIndicator("size")}
                          </div>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedItems.orphanFiles.slice(0, visibleLimit).map((item, idx) => {
                        const isSelected = selectedItemPaths.has(item.relative_path);
                        return (
                          <tr
                            key={idx}
                            className={isSelected ? "selected" : undefined}
                            data-selected={isSelected}
                            title={item.file_path}
                            onClick={(e) => handleToggleSelectItem(item.relative_path, idx, e.shiftKey, sortedItems.orphanFiles)}
                            style={{ cursor: "pointer", userSelect: "none" }}
                          >
                            <td style={{ textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={(e) => handleToggleSelectItem(item.relative_path, idx, (e.nativeEvent as MouseEvent).shiftKey, sortedItems.orphanFiles)}
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
                  {sortedItems.orphanFiles.length > visibleLimit && (
                    <div className="text-secondary" style={{ textAlign: "center", padding: "8px", fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
                      Showing {visibleLimit} of {sortedItems.orphanFiles.length} files (Scroll down to load more)
                    </div>
                  )}
                </>
              ) : (
                <div className="no-data">
                  {searchQuery ? "No matching files found." : "No orphan files found in target destination!"}
                </div>
              )
            )}

            {activeTab === "warnings" && (
              filteredItems.warningItems.length > 0 ? (
                <>
                  <table style={{ tableLayout: "fixed", width: "100%" }}>
                    <thead>
                      <tr>
                        <th style={{ width: "120px" }}>Scope</th>
                        <th style={{ width: "260px" }}>Target Folder / Directory</th>
                        <th style={{ width: "90px", textAlign: "center" }}>Affected</th>
                        <th>Compatibility Issue & Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredItems.warningItems.slice(0, visibleLimit).map((warn, idx) => {
                        const isExpanded = expandedWarningIndex === idx;
                        return (
                          <React.Fragment key={idx}>
                            <tr>
                              <td>
                                <span className="badge" style={{
                                  backgroundColor: warn.scope === "directory" ? "rgba(239, 68, 68, 0.15)" : warn.scope === "system" ? "rgba(234, 179, 8, 0.15)" : "var(--bg-tertiary)",
                                  color: warn.scope === "directory" ? "var(--danger)" : warn.scope === "system" ? "var(--warning)" : "var(--text-primary)",
                                  border: "1px solid var(--border-color)",
                                  padding: "2px 6px",
                                  borderRadius: "4px",
                                  fontSize: "0.72rem",
                                  fontWeight: 600,
                                }}>
                                  {warn.warning_type === "invalid_symbol" && "🚨 "}
                                  {warn.warning_type === "illegal_char" && "⛔ "}
                                  {warn.warning_type === "path_too_long" && "📏 "}
                                  {warn.warning_type === "non_ascii" && "🇧🇩 "}
                                  {warn.warning_type === "apple_double" && "🍏 "}
                                  {warn.scope.toUpperCase()}
                                </span>
                              </td>
                              <td style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={warn.target_path}>
                                {warn.target_path}
                              </td>
                              <td style={{ textAlign: "center", fontFamily: "var(--font-mono)", fontSize: "0.8rem", fontWeight: 600 }}>
                                {warn.affected_count} {warn.affected_count === 1 ? "item" : "items"}
                              </td>
                              <td style={{ fontSize: "0.82rem" }}>
                                <div style={{ color: "var(--warning)", fontWeight: 500 }}>{warn.message}</div>
                                {warn.sample_files && warn.sample_files.length > 0 && (
                                  <button
                                    className="btn btn-secondary"
                                    onClick={() => setExpandedWarningIndex(isExpanded ? null : idx)}
                                    style={{ marginTop: "4px", padding: "2px 8px", fontSize: "0.72rem" }}
                                  >
                                    {isExpanded ? "▾ Hide sample files" : `▸ Show sample files (${warn.sample_files.length})`}
                                  </button>
                                )}
                                {warn.warning_type === "apple_double" && (
                                  <button
                                    className="btn btn-secondary"
                                    disabled={isCleaningHidden}
                                    onClick={() => handleCleanHiddenFiles(warn.target_path)}
                                    style={{
                                      marginTop: "4px",
                                      marginLeft: warn.sample_files && warn.sample_files.length > 0 ? "6px" : "0",
                                      padding: "2px 8px",
                                      fontSize: "0.72rem",
                                      color: "var(--danger)",
                                      borderColor: "var(--danger)",
                                      fontWeight: 600,
                                    }}
                                    title="Delete all hidden macOS resource fork files (._*) from this destination"
                                  >
                                    {isCleaningHidden ? "Cleaning..." : "🧹 Clean Hidden Files"}
                                  </button>
                                )}
                              </td>
                            </tr>
                            {isExpanded && warn.sample_files && warn.sample_files.length > 0 && (
                              <tr className="row-static" data-static="true" style={{ backgroundColor: "var(--bg-tertiary)" }}>
                                <td colSpan={4} style={{ padding: "8px 16px" }}>
                                  <div style={{ fontSize: "0.76rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "4px" }}>
                                    Sample Affected Track Paths ({warn.sample_files.length}):
                                  </div>
                                  <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "0.76rem", fontFamily: "var(--font-mono)", color: "var(--text-primary)" }}>
                                    {warn.sample_files.map((file, fIdx) => (
                                      <li key={fIdx} style={{ marginBottom: "2px" }}>{file}</li>
                                    ))}
                                  </ul>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                  {filteredItems.warningItems.length > visibleLimit && (
                    <div className="text-secondary" style={{ textAlign: "center", padding: "8px", fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
                      Showing {visibleLimit} of {filteredItems.warningItems.length} warning groups (Scroll down to load more)
                    </div>
                  )}
                </>
              ) : (
                <div className="no-data">
                  {searchQuery ? "No matching warnings found." : "No compatibility warnings detected for this export configuration."}
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
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span style={{ fontWeight: 600, fontSize: "1rem" }}>Export Progress & Logs</span>
                  {!isExportAutoScroll && exportLogs.length > 0 && (
                    <button
                      type="button"
                      onClick={handleExportScrollToLatest}
                      style={{
                        backgroundColor: "rgba(138, 92, 246, 0.15)",
                        color: "var(--accent-purple-hover)",
                        border: "1px solid var(--accent-purple)",
                        borderRadius: "14px",
                        padding: "2px 10px",
                        fontSize: "0.74rem",
                        fontWeight: 600,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: "4px",
                        transition: "all 0.2s ease",
                      }}
                      title="Click to jump to latest logs and resume auto-scroll"
                    >
                      <span>⬇ Jump to latest</span>
                    </button>
                  )}
                </div>
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

              <div
                ref={logContainerRef}
                onScroll={handleExportLogsScroll}
                className="console-log"
                style={{ flex: 1, minHeight: "260px", maxHeight: "400px", overflowY: "auto", marginTop: "12px" }}
              >
                {exportLogs.join("\n")}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Git-Diff Style Inspection Modal */}
      {inspectDiffItem && (
        <div className="modal-backdrop" onClick={() => setInspectDiffItem(null)} style={{ zIndex: 1100 }}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "750px", width: "90%", maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border-color)", paddingBottom: "12px", marginBottom: "16px" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: "1.1rem", display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ color: "var(--warning)" }}>🟠 Updated Track Diff</span>
                </h3>
                <div style={{ fontSize: "0.82rem", color: "var(--text-secondary)", marginTop: "4px", fontFamily: "var(--font-mono)" }}>
                  {inspectDiffItem.relative_path}
                </div>
              </div>
              <button className="btn btn-secondary" onClick={() => setInspectDiffItem(null)} style={{ padding: "4px 8px" }}>
                ✕
              </button>
            </div>

            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "14px" }}>
              {/* Badges overview */}
              <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Changes detected:</span>
                {inspectDiffItem.diff_details?.has_tag_changes && (
                  <span className="badge" style={{ backgroundColor: "rgba(245, 158, 11, 0.15)", color: "var(--warning)", border: "1px solid var(--warning)", padding: "2px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: 600 }}>
                    🏷️ Metadata Tags
                  </span>
                )}
                {inspectDiffItem.diff_details?.has_artwork_changes && (
                  <span className="badge" style={{ backgroundColor: "rgba(168, 85, 247, 0.15)", color: "var(--accent-purple)", border: "1px solid var(--accent-purple)", padding: "2px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: 600 }}>
                    🖼️ Cover Art
                  </span>
                )}
                {inspectDiffItem.diff_details?.has_audio_changes ? (
                  <span className="badge" style={{ backgroundColor: "rgba(239, 68, 68, 0.15)", color: "var(--danger)", border: "1px solid var(--danger)", padding: "2px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: 600 }}>
                    🔊 Audio Stream Re-encoded
                  </span>
                ) : (
                  <span className="badge" style={{ backgroundColor: "rgba(34, 197, 94, 0.15)", color: "var(--success)", border: "1px solid var(--success)", padding: "2px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: 600 }}>
                    🎶 Audio Stream Unchanged
                  </span>
                )}
              </div>

              {/* Git-Diff Style Comparison Table */}
              <div style={{ border: "1px solid var(--border-color)", borderRadius: "6px", overflow: "hidden", backgroundColor: "var(--bg-secondary)" }}>
                <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 1fr", padding: "8px 12px", borderBottom: "1px solid var(--border-color)", fontWeight: 600, fontSize: "0.78rem", color: "var(--text-secondary)", textTransform: "uppercase" }}>
                  <span>Field</span>
                  <span style={{ color: "var(--danger)" }}>- Destination USB (Old)</span>
                  <span style={{ color: "var(--success)" }}>+ Source Library (New)</span>
                </div>

                <div style={{ display: "flex", flexDirection: "column" }}>
                  {inspectDiffItem.diff_details?.diffs && inspectDiffItem.diff_details.diffs.length > 0 ? (
                    inspectDiffItem.diff_details.diffs.map((diff, idx) => (
                      <div
                        key={idx}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "130px 1fr 1fr",
                          padding: "8px 12px",
                          borderBottom: idx < inspectDiffItem.diff_details!.diffs.length - 1 ? "1px solid var(--border-color)" : "none",
                          fontSize: "0.82rem",
                          fontFamily: "var(--font-mono)",
                          backgroundColor: idx % 2 === 0 ? "transparent" : "rgba(255, 255, 255, 0.02)",
                        }}
                      >
                        <span style={{ fontWeight: 600, color: "var(--text-primary)", fontFamily: "inherit" }}>
                          {diff.field}
                        </span>
                        <span style={{ color: "var(--danger)", wordBreak: "break-word", paddingRight: "8px" }}>
                          {diff.old_value ? `- ${diff.old_value}` : <span style={{ opacity: 0.4 }}>&lt;None&gt;</span>}
                        </span>
                        <span style={{ color: "var(--success)", wordBreak: "break-word" }}>
                          {diff.new_value ? `+ ${diff.new_value}` : <span style={{ opacity: 0.4 }}>&lt;Removed&gt;</span>}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div style={{ padding: "16px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.82rem" }}>
                      No granular field differences detected (timestamp or file size mismatch).
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--border-color)", paddingTop: "12px", marginTop: "16px" }}>
              <button
                className="btn btn-primary"
                disabled={isApplyingAction}
                onClick={() => {
                  const item = inspectDiffItem;
                  setInspectDiffItem(null);
                  handleApplyCopies("updated", false, item);
                }}
                style={{ padding: "6px 14px", backgroundColor: "var(--warning)", borderColor: "var(--warning)", color: "#000", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: "6px" }}
              >
                ⚡ Apply This Update to USB
              </button>
              <button className="btn btn-secondary" onClick={() => setInspectDiffItem(null)} style={{ padding: "6px 16px" }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          message={confirmModal.message}
          confirmText={confirmModal.confirmText}
          confirmVariant={confirmModal.confirmVariant || "primary"}
          isExecuting={isApplyingAction}
          executingText={confirmModal.executingText || "Applying changes..."}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => {
            if (!isApplyingAction) setConfirmModal(null);
          }}
        />
      )}

      {/* Toast Notification */}
      {notification && (
        <div
          style={{
            position: "fixed",
            bottom: "24px",
            right: "24px",
            zIndex: 10001,
            backgroundColor: notification.type === "success" ? "var(--success)" : notification.type === "error" ? "var(--danger)" : "var(--accent-blue)",
            color: "#fff",
            padding: "12px 20px",
            borderRadius: "8px",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)",
            fontWeight: 600,
            fontSize: "0.85rem",
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <span>{notification.message}</span>
          <button
            onClick={() => setNotification(null)}
            style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: "1rem", lineHeight: 1 }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
};
