import React, { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  RecoverableOrphansReport,
  RecoverableOrphanGroup,
  RecoverableOrphanChoice,
  OrphanRestoreItem,
  OrphanRestoreResult,
  AudioTrack,
} from "../types";
import { ConfirmModal } from "./common/ConfirmModal";
import { formatSize } from "../utils/formatters";

export interface OrphanRecoveryModalProps {
  isOpen: boolean;
  onClose: () => void;
  configPath: string;
  destination: string;
  relativeToConfig: boolean;
  onPlayTrack?: (track: AudioTrack, queue: AudioTrack[], playlistName: string) => void;
  onRecoveryComplete?: () => void;
}

export const OrphanRecoveryModal: React.FC<OrphanRecoveryModalProps> = ({
  isOpen,
  onClose,
  configPath,
  destination,
  relativeToConfig,
  onPlayTrack,
  onRecoveryComplete,
}) => {
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isRestoring, setIsRestoring] = useState<boolean>(false);
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [report, setReport] = useState<RecoverableOrphansReport | null>(null);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [groupChoiceMap, setGroupChoiceMap] = useState<Record<string, number>>({});
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedYear, setSelectedYear] = useState<string>("all");
  const [activePlayingPath, setActivePlayingPath] = useState<string | null>(null);
  const [restoreStatus, setRestoreStatus] = useState<string>("");

  const loadRecoverableOrphans = async () => {
    if (!configPath || !destination) return;
    setIsLoading(true);
    setError("");
    setRestoreStatus("");
    try {
      const res = await invoke<RecoverableOrphansReport>("scan_recoverable_hindi_orphans", {
        configPath,
        destination,
        relativeToConfig,
      });
      setReport(res);
      // Select all groups by default
      const allIds = new Set(res.groups.map((g) => g.id));
      setSelectedGroupIds(allIds);

      // Default choice index to selected_choice_index (0, highest quality format)
      const choiceMap: Record<string, number> = {};
      for (const g of res.groups) {
        choiceMap[g.id] = g.selected_choice_index || 0;
      }
      setGroupChoiceMap(choiceMap);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadRecoverableOrphans();
    }
  }, [isOpen, configPath, destination]);

  const availableYears = useMemo(() => {
    if (!report) return [];
    const set = new Set<string>();
    for (const g of report.groups) {
      if (g.year) set.add(g.year);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [report]);

  const filteredGroups = useMemo(() => {
    if (!report) return [];
    const q = searchQuery.trim().toLowerCase();
    return report.groups.filter((g) => {
      if (selectedYear !== "all" && g.year !== selectedYear) {
        return false;
      }
      if (!q) return true;
      if (g.song_name.toLowerCase().includes(q)) return true;
      if (g.year.toLowerCase().includes(q)) return true;
      if (g.target_source_path.toLowerCase().includes(q)) return true;
      return g.choices.some(
        (c) =>
          c.filename.toLowerCase().includes(q) ||
          c.relative_path.toLowerCase().includes(q)
      );
    });
  }, [report, searchQuery, selectedYear]);

  const isAllFilteredSelected = useMemo(() => {
    if (filteredGroups.length === 0) return false;
    return filteredGroups.every((g) => selectedGroupIds.has(g.id));
  }, [filteredGroups, selectedGroupIds]);

  const isSomeFilteredSelected = useMemo(() => {
    if (filteredGroups.length === 0) return false;
    const count = filteredGroups.filter((g) => selectedGroupIds.has(g.id)).length;
    return count > 0 && count < filteredGroups.length;
  }, [filteredGroups, selectedGroupIds]);

  const handleToggleSelectAll = () => {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (isAllFilteredSelected) {
        for (const g of filteredGroups) {
          next.delete(g.id);
        }
      } else {
        for (const g of filteredGroups) {
          next.add(g.id);
        }
      }
      return next;
    });
  };

  const handleToggleSelectGroup = (groupId: string) => {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const handleSelectChoice = (groupId: string, choiceIndex: number) => {
    setGroupChoiceMap((prev) => ({
      ...prev,
      [groupId]: choiceIndex,
    }));
  };

  const handlePlayPreview = (group: RecoverableOrphanGroup, choice: RecoverableOrphanChoice) => {
    setActivePlayingPath(choice.file_path);
    if (onPlayTrack) {
      const target: AudioTrack = {
        file_path: choice.file_path,
        title: choice.filename,
        artist: `Year: ${group.year}`,
        duration: choice.duration_secs,
      };
      onPlayTrack(target, [target], `Pendrive Preview: ${group.song_name}`);
    }
  };

  const { selectedCount, selectedBytes } = useMemo(() => {
    if (!report) return { selectedCount: 0, selectedBytes: 0 };
    let count = 0;
    let bytes = 0;
    for (const g of report.groups) {
      if (!selectedGroupIds.has(g.id)) continue;
      count++;
      const choiceIdx = groupChoiceMap[g.id] ?? 0;
      const choice = g.choices[choiceIdx] || g.choices[0];
      if (choice) {
        bytes += choice.size_bytes;
      }
    }
    return { selectedCount: count, selectedBytes: bytes };
  }, [report, selectedGroupIds, groupChoiceMap]);

  const handleStartRestoreClick = () => {
    if (!report || selectedCount === 0 || isRestoring) return;
    setShowConfirmModal(true);
  };

  const executeRestore = async () => {
    if (!report || selectedCount === 0 || isRestoring) return;

    const transfers: OrphanRestoreItem[] = [];
    for (const g of report.groups) {
      if (!selectedGroupIds.has(g.id)) continue;
      const choiceIdx = groupChoiceMap[g.id] ?? 0;
      const choice = g.choices[choiceIdx] || g.choices[0];
      if (!choice) continue;

      // Adjust target extension to match chosen file extension
      const chosenExt = choice.filename.split(".").pop()?.toLowerCase() || "m4a";
      const targetPathObj = g.target_source_path.replace(/\.[^/.]+$/, `.${chosenExt}`);

      transfers.push({
        source_pendrive_path: choice.file_path,
        target_source_path: targetPathObj,
      });
    }

    if (transfers.length === 0) return;

    setIsRestoring(true);
    setRestoreStatus("");
    setError("");
    try {
      const result = await invoke<OrphanRestoreResult>("restore_orphan_tracks_to_source", {
        transfers,
      });

      if (result.errors && result.errors.length > 0) {
        setError(
          `Copied ${result.restored_count} song(s) (${formatSize(result.restored_bytes)}), but encountered ${result.failed_count} errors:\n${result.errors.slice(0, 5).join("\n")}`
        );
      }

      setRestoreStatus(
        `✅ Successfully restored ${result.restored_count} song(s) (${formatSize(result.restored_bytes)}) back into your local Hindi/year library!`
      );

      // Re-scan after short delay or trigger completion
      setTimeout(() => {
        loadRecoverableOrphans();
        if (onRecoveryComplete) {
          onRecoveryComplete();
        }
      }, 1000);
    } catch (e) {
      setError(`Error restoring files: ${e}`);
    } finally {
      setIsRestoring(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "20px",
      }}
      onClick={onClose}
    >
      <div
        className="modal-content"
        style={{
          backgroundColor: "var(--bg-primary)",
          border: "1px solid var(--border-color)",
          borderRadius: "12px",
          width: "92vw",
          maxWidth: "1050px",
          height: "88vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 20px 40px rgba(0, 0, 0, 0.5)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--border-color)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            backgroundColor: "var(--bg-secondary)",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ fontSize: "1.2rem" }}>📦</span>
              <h2 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700, color: "var(--text-primary)" }}>
                Recover Missing Source Tracks from Pendrive
              </h2>
              {report && (
                <span
                  style={{
                    backgroundColor: report.total_missing_songs > 0 ? "rgba(34, 197, 94, 0.18)" : "var(--bg-tertiary)",
                    color: report.total_missing_songs > 0 ? "var(--success)" : "var(--text-muted)",
                    border: `1px solid ${report.total_missing_songs > 0 ? "rgba(34, 197, 94, 0.4)" : "var(--border-color)"}`,
                    padding: "2px 8px",
                    borderRadius: "999px",
                    fontSize: "0.75rem",
                    fontWeight: 700,
                  }}
                >
                  {report.total_missing_songs} missing songs detected
                </span>
              )}
            </div>
            <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: "4px" }}>
              Copies songs deleted from your local library (<code style={{ color: "var(--accent-purple)", fontSize: "0.76rem" }}>.../Hindi/year/&lt;year&gt;/</code>) back from the pendrive. If newer formats (M4A) exist on the pendrive, they are preferred automatically.
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={loadRecoverableOrphans}
              disabled={isLoading || isRestoring}
              style={{ padding: "4px 10px", fontSize: "0.78rem" }}
              title="Rescan pendrive and library"
            >
              🔄 Refresh
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isRestoring}
              style={{ padding: "4px 10px", fontSize: "0.8rem" }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Status / Success Message */}
        {restoreStatus && (
          <div
            style={{
              padding: "10px 20px",
              backgroundColor: "rgba(34, 197, 94, 0.12)",
              borderBottom: "1px solid rgba(34, 197, 94, 0.3)",
              color: "var(--success)",
              fontSize: "0.82rem",
              fontWeight: 600,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>{restoreStatus}</span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setRestoreStatus("")}
              style={{ padding: "1px 6px", fontSize: "0.7rem", height: "20px" }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Error Message */}
        {error && !isLoading && (
          <div
            style={{
              padding: "10px 20px",
              backgroundColor: "rgba(239, 68, 68, 0.12)",
              borderBottom: "1px solid rgba(239, 68, 68, 0.3)",
              color: "var(--danger)",
              fontSize: "0.82rem",
              fontWeight: 600,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ whiteSpace: "pre-line" }}>{error}</span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setError("")}
              style={{ padding: "1px 6px", fontSize: "0.7rem", height: "20px" }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Toolbar & Filter Bar */}
        <div
          style={{
            padding: "10px 20px",
            borderBottom: "1px solid var(--border-color)",
            backgroundColor: "var(--bg-tertiary)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "10px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            {/* Master Checkbox */}
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                cursor: "pointer",
                userSelect: "none",
                fontWeight: 600,
                fontSize: "0.78rem",
                color: "var(--text-primary)",
                backgroundColor: "var(--bg-secondary)",
                padding: "3px 8px",
                borderRadius: "6px",
                border: "1px solid var(--border-color)",
              }}
            >
              <input
                type="checkbox"
                checked={isAllFilteredSelected}
                ref={(el) => {
                  if (el) el.indeterminate = isSomeFilteredSelected;
                }}
                onChange={handleToggleSelectAll}
                disabled={filteredGroups.length === 0 || isRestoring}
                style={{ cursor: "pointer", width: "14px", height: "14px", accentColor: "var(--accent-purple)", margin: 0 }}
              />
              <span>
                {selectedCount >= filteredGroups.length && filteredGroups.length > 0
                  ? `All ${filteredGroups.length} selected`
                  : `${selectedCount} of ${filteredGroups.length} selected`}
              </span>
            </label>

            {/* Year Filter */}
            {availableYears.length > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ fontSize: "0.76rem", color: "var(--text-secondary)" }}>Year:</span>
                <select
                  value={selectedYear}
                  onChange={(e) => setSelectedYear(e.target.value)}
                  style={{
                    backgroundColor: "var(--bg-secondary)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "6px",
                    padding: "2px 8px",
                    fontSize: "0.76rem",
                  }}
                >
                  <option value="all">All Years ({availableYears.length})</option>
                  {availableYears.map((yr) => (
                    <option key={yr} value={yr}>
                      {yr}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Search Input */}
            <div style={{ position: "relative" }}>
              <input
                type="text"
                placeholder="Search song or year..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  backgroundColor: "var(--bg-secondary)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-color)",
                  borderRadius: "6px",
                  padding: "3px 8px 3px 24px",
                  fontSize: "0.76rem",
                  width: "200px",
                }}
              />
              <span style={{ position: "absolute", left: "7px", top: "5px", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                🔍
              </span>
            </div>
          </div>

          {/* Quick Action Button */}
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleStartRestoreClick}
            disabled={isRestoring || selectedCount === 0}
            style={{
              padding: "4px 14px",
              fontSize: "0.8rem",
              fontWeight: 700,
              backgroundColor: selectedCount > 0 ? "var(--success)" : "var(--bg-secondary)",
              borderColor: selectedCount > 0 ? "var(--success)" : "var(--border-color)",
              color: selectedCount > 0 ? "#fff" : "var(--text-muted)",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <span>📥</span>
            <span>
              {isRestoring
                ? "Restoring Tracks..."
                : `Copy Selected (${selectedCount} songs • ${formatSize(selectedBytes)}) to Source`}
            </span>
          </button>
        </div>

        {/* Main Content Area */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 20px" }}>
          {isLoading ? (
            <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--text-secondary)" }}>
              <div style={{ fontSize: "1.8rem", marginBottom: "12px" }}>⏳</div>
              <div style={{ fontSize: "0.95rem", fontWeight: 600 }}>
                Scanning pendrive for missing Hindi/year tracks...
              </div>
              <div style={{ fontSize: "0.8rem", marginTop: "4px", color: "var(--text-muted)" }}>
                Comparing orphan files against local library paths and audio fingerprints.
              </div>
            </div>
          ) : error ? (
            <div className="no-data" style={{ color: "var(--danger)", padding: "40px 20px" }}>
              Error scanning recoverable orphans: {error}
            </div>
          ) : filteredGroups.length === 0 ? (
            <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--text-secondary)" }}>
              <div style={{ fontSize: "2rem", marginBottom: "10px" }}>✅</div>
              <div style={{ fontSize: "1rem", fontWeight: 700, color: "var(--text-primary)" }}>
                No missing Hindi/year tracks detected
              </div>
              <div style={{ fontSize: "0.82rem", color: "var(--text-muted)", marginTop: "4px" }}>
                All Hindi/year tracks found on the pendrive already exist in your local source library!
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {filteredGroups.map((group) => {
                const isSelected = selectedGroupIds.has(group.id);
                const choiceIdx = groupChoiceMap[group.id] ?? 0;
                const hasMultipleChoices = group.choices.length > 1;

                return (
                  <div
                    key={group.id}
                    style={{
                      backgroundColor: isSelected ? "var(--bg-secondary)" : "var(--bg-surface)",
                      border: `1px solid ${isSelected ? "rgba(139, 92, 246, 0.4)" : "var(--border-color)"}`,
                      borderRadius: "8px",
                      padding: "10px 14px",
                      transition: "all 0.15s ease",
                      opacity: isSelected ? 1 : 0.6,
                    }}
                  >
                    {/* Track Title and Header */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: "8px",
                        flexWrap: "wrap",
                        gap: "8px",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: 0 }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleToggleSelectGroup(group.id)}
                          style={{
                            cursor: "pointer",
                            width: "15px",
                            height: "15px",
                            accentColor: "var(--accent-purple)",
                            margin: 0,
                          }}
                        />

                        {/* Year Badge */}
                        <span
                          style={{
                            backgroundColor: "rgba(139, 92, 246, 0.15)",
                            color: "var(--accent-purple)",
                            border: "1px solid rgba(139, 92, 246, 0.35)",
                            borderRadius: "4px",
                            padding: "1px 6px",
                            fontSize: "0.72rem",
                            fontWeight: 700,
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          {group.year}
                        </span>

                        {/* Song Name */}
                        <span
                          style={{
                            fontSize: "0.88rem",
                            fontWeight: 700,
                            color: "var(--text-primary)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                          title={group.song_name}
                        >
                          {group.song_name}
                        </span>

                        {hasMultipleChoices && (
                          <span
                            style={{
                              backgroundColor: "rgba(245, 158, 11, 0.15)",
                              color: "var(--warning)",
                              border: "1px solid rgba(245, 158, 11, 0.35)",
                              borderRadius: "4px",
                              padding: "1px 6px",
                              fontSize: "0.68rem",
                              fontWeight: 600,
                            }}
                          >
                            {group.choices.length} choices on pendrive
                          </span>
                        )}
                      </div>

                      {/* Right controls */}
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => handleToggleSelectGroup(group.id)}
                          style={{ padding: "1px 7px", fontSize: "0.7rem", height: "22px" }}
                        >
                          {isSelected ? "Skip" : "Include"}
                        </button>
                      </div>
                    </div>

                    {/* Target Destination in Source Library */}
                    <div
                      style={{
                        fontSize: "0.74rem",
                        color: "var(--text-muted)",
                        marginBottom: "8px",
                        display: "flex",
                        alignItems: "center",
                        gap: "5px",
                        fontFamily: "var(--font-mono)",
                        backgroundColor: "var(--bg-tertiary)",
                        padding: "3px 8px",
                        borderRadius: "4px",
                      }}
                      title={group.target_source_path}
                    >
                      <span style={{ color: "var(--success)", fontWeight: 700 }}>Restore Target:</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {group.target_source_path}
                      </span>
                    </div>

                    {/* Choices List */}
                    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                      {group.choices.map((choice, cIdx) => {
                        const isChoiceSelected = choiceIdx === cIdx;
                        const isPlaying = activePlayingPath === choice.file_path;

                        return (
                          <div
                            key={choice.file_path}
                            onClick={() => handleSelectChoice(group.id, cIdx)}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              padding: "4px 8px",
                              borderRadius: "5px",
                              backgroundColor: isChoiceSelected ? "rgba(139, 92, 246, 0.08)" : "transparent",
                              border: `1px solid ${isChoiceSelected ? "rgba(139, 92, 246, 0.3)" : "transparent"}`,
                              cursor: "pointer",
                              fontSize: "0.78rem",
                              gap: "8px",
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0, flex: 1 }}>
                              {hasMultipleChoices && (
                                <input
                                  type="radio"
                                  name={`choice_${group.id}`}
                                  checked={isChoiceSelected}
                                  onChange={() => handleSelectChoice(group.id, cIdx)}
                                  onClick={(e) => e.stopPropagation()}
                                  style={{ cursor: "pointer", margin: 0 }}
                                />
                              )}

                              {/* Play preview button */}
                              <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handlePlayPreview(group, choice);
                                }}
                                style={{
                                  width: "22px",
                                  height: "22px",
                                  padding: 0,
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  borderRadius: "4px",
                                  backgroundColor: isPlaying ? "var(--accent-purple-glow)" : "var(--bg-surface)",
                                  color: isPlaying ? "var(--accent-purple)" : "var(--text-secondary)",
                                  borderColor: isPlaying ? "var(--accent-purple)" : "var(--border-color)",
                                }}
                                title="Listen to preview"
                              >
                                {isPlaying ? "🔊" : "▶"}
                              </button>

                              {/* Format Badge */}
                              <span
                                style={{
                                  fontSize: "0.68rem",
                                  fontWeight: 700,
                                  padding: "1px 5px",
                                  borderRadius: "3px",
                                  backgroundColor: choice.is_m4a ? "rgba(34, 197, 94, 0.18)" : "var(--bg-tertiary)",
                                  color: choice.is_m4a ? "var(--success)" : "var(--text-secondary)",
                                  border: `1px solid ${choice.is_m4a ? "rgba(34, 197, 94, 0.35)" : "var(--border-color)"}`,
                                }}
                              >
                                {choice.format}
                              </span>

                              {/* Filename */}
                              <span
                                style={{
                                  fontWeight: isChoiceSelected ? 600 : 400,
                                  color: "var(--text-primary)",
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                                title={choice.filename}
                              >
                                {choice.filename}
                              </span>

                              {/* Match Reason Tag */}
                              <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                                • {choice.match_reason}
                              </span>
                            </div>

                            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexShrink: 0 }}>
                              <span style={{ fontSize: "0.72rem", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
                                {formatSize(choice.size_bytes)}
                              </span>
                              <span
                                style={{
                                  fontSize: "0.68rem",
                                  color: "var(--text-muted)",
                                  maxWidth: "200px",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                                title={`Pendrive relative path: ${choice.relative_path}`}
                              >
                                {choice.relative_path}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--border-color)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            backgroundColor: "var(--bg-secondary)",
          }}
        >
          <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
            Selected: <strong style={{ color: "var(--text-primary)" }}>{selectedCount}</strong> songs (
            <span style={{ fontFamily: "var(--font-mono)" }}>{formatSize(selectedBytes)}</span>) to copy back to source library
          </div>

          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isRestoring}
              style={{ padding: "4px 14px", fontSize: "0.8rem" }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleStartRestoreClick}
              disabled={isRestoring || selectedCount === 0}
              style={{
                padding: "4px 16px",
                fontSize: "0.8rem",
                fontWeight: 700,
                backgroundColor: selectedCount > 0 ? "var(--success)" : "var(--bg-secondary)",
                borderColor: selectedCount > 0 ? "var(--success)" : "var(--border-color)",
                color: selectedCount > 0 ? "#fff" : "var(--text-muted)",
              }}
            >
              {isRestoring ? "Restoring..." : `Copy Selected (${selectedCount})`}
            </button>
          </div>
        </div>
      </div>

      {/* Confirmation Modal */}
      {showConfirmModal && (
        <ConfirmModal
          title="📥 Restore Missing Tracks to Source"
          message={`Copy ${selectedCount} song(s) (${formatSize(selectedBytes)}) from pendrive back to your source library?\n\nTarget directory:\n${report?.source_base_dir || ""}/.../Hindi/year/<year>/\n\n• Selected files will be restored under their respective Hindi/year/<year>/ folder.\n• If newer/preferred formats (e.g. M4A) exist on the pendrive, they will be copied.`}
          confirmText={`Copy ${selectedCount} Tracks`}
          confirmVariant="primary"
          isExecuting={isRestoring}
          executingText="Copying tracks from pendrive..."
          onConfirm={() => {
            setShowConfirmModal(false);
            executeRestore();
          }}
          onCancel={() => {
            if (!isRestoring) setShowConfirmModal(false);
          }}
        />
      )}
    </div>
  );
};
