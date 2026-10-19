import React from "react";
import { DuplicateGroup, DuplicateTrackEntry } from "../../types";
import { formatDuration, formatSize } from "../../utils/formatters";

export interface TierBadgeStyle {
  bg: string;
  color: string;
  border: string;
  icon: string;
}

export const getTierBadgeStyle = (tier: string): TierBadgeStyle => {
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

export interface DuplicateGroupRowsProps {
  group: DuplicateGroup;
  gIdx: number;
  groupNumber: number;
  isGroupSelected: boolean;
  onToggleSelectGroup: (groupId: string) => void;
  excludedTrackPaths: Set<string>;
  onToggleExcludeTrack: (filePath: string) => void;
  onPlayGroupTrack: (group: DuplicateGroup, track: DuplicateTrackEntry) => void;
  onMakeWinner: (group: DuplicateGroup, track: DuplicateTrackEntry) => void;
  onDetachTrack: (group: DuplicateGroup, track: DuplicateTrackEntry) => void;
  onKeepThisAndDeleteOthers: (group: DuplicateGroup, track: DuplicateTrackEntry) => void;
  onRevealInFinder: (filePath: string) => void;
  isDeleting: boolean;
  playlistIndex: number | null;
}

export const DuplicateGroupRows: React.FC<DuplicateGroupRowsProps> = ({
  group,
  gIdx,
  groupNumber,
  isGroupSelected,
  onToggleSelectGroup,
  excludedTrackPaths,
  onToggleExcludeTrack,
  onPlayGroupTrack,
  onMakeWinner,
  onDetachTrack,
  onKeepThisAndDeleteOthers,
  onRevealInFinder,
  isDeleting,
  playlistIndex,
}) => {
  const badge = getTierBadgeStyle(group.match_tier);
  const groupRedundantTracks = group.tracks.filter(
    (t) => !t.is_winner && !excludedTrackPaths.has(t.file_path)
  );
  const groupRedundantBytes = groupRedundantTracks.reduce((sum, t) => sum + t.size_bytes, 0);

  return (
    <React.Fragment key={group.group_id}>
      {/* Group Header Row */}
      <tr
        onClick={() => onToggleSelectGroup(group.group_id)}
        style={{
          backgroundColor: isGroupSelected ? "rgba(139, 92, 246, 0.08)" : "var(--bg-secondary)",
          borderTop: gIdx > 0 ? "2px solid var(--border-color)" : "none",
          borderBottom: "1px solid var(--border-color)",
          borderLeft: isGroupSelected ? "3px solid var(--accent-purple)" : "3px solid transparent",
          cursor: "pointer",
          transition: "background-color 0.15s ease",
        }}
      >
        {/* Dedicated Checkbox column */}
        <td style={{ width: "36px", textAlign: "center", verticalAlign: "middle", padding: "6px 4px" }}>
          <input
            type="checkbox"
            checked={isGroupSelected}
            onChange={() => onToggleSelectGroup(group.group_id)}
            onClick={(e) => e.stopPropagation()}
            style={{
              cursor: "pointer",
              width: "14px",
              height: "14px",
              accentColor: "var(--accent-purple)",
              margin: 0,
            }}
            title={isGroupSelected ? "Deselect this group" : "Select this group"}
          />
        </td>
        {/* Remaining Columns */}
        <td colSpan={7} style={{ padding: "7px 10px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
              <span
                style={{
                  fontSize: "0.72rem",
                  fontFamily: "var(--font-mono)",
                  color: isGroupSelected ? "var(--accent-purple)" : "var(--text-secondary)",
                  fontWeight: 600,
                }}
              >
                #{groupNumber}
              </span>
              <span
                style={{
                  fontWeight: 700,
                  fontSize: "0.88rem",
                  color: "var(--text-primary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {group.canonical_title}
              </span>
              {group.canonical_artist && (
                <span
                  style={{
                    fontSize: "0.8rem",
                    color: "var(--text-secondary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  — {group.canonical_artist}
                </span>
              )}
              <span
                style={{
                  fontSize: "0.72rem",
                  color: "var(--text-secondary)",
                  whiteSpace: "nowrap",
                }}
              >
                ({group.tracks.length} versions)
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
              {groupRedundantTracks.length > 0 ? (
                <span
                  style={{
                    fontSize: "0.7rem",
                    padding: "2px 7px",
                    borderRadius: "10px",
                    backgroundColor: "rgba(239, 68, 68, 0.12)",
                    color: "#f87171",
                    border: "1px solid rgba(239, 68, 68, 0.3)",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                  }}
                  title={`${groupRedundantTracks.length} redundant duplicate file(s) will be deleted if fixed`}
                >
                  {groupRedundantTracks.length} dup{groupRedundantTracks.length > 1 ? "s" : ""} • {formatSize(groupRedundantBytes)}
                </span>
              ) : (
                <span
                  style={{
                    fontSize: "0.7rem",
                    padding: "2px 7px",
                    borderRadius: "10px",
                    backgroundColor: "rgba(34, 197, 94, 0.12)",
                    color: "var(--success)",
                    border: "1px solid rgba(34, 197, 94, 0.3)",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                  }}
                >
                  ✓ All Kept
                </span>
              )}
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
        </td>
      </tr>

      {/* Track Rows for Group */}
      {group.tracks.map((t) => {
        const fileName = t.file_path.split(/[/\\]/).pop() || t.title;
        return (
          <tr
            key={t.file_path}
            className={t.is_winner ? "row-winner" : undefined}
            data-winner={t.is_winner}
            style={{
              borderBottom: "1px solid var(--border-color)",
            }}
          >
            {/* 1. Checkbox Column: Empty in track rows to prevent any eye strain */}
            <td style={{ width: "36px", padding: "6px 4px", textAlign: "center", verticalAlign: "middle" }}></td>

            {/* 2. Status: Visible Keep / Delete Toggle Icon Buttons */}
            <td style={{ width: "135px", padding: "6px 8px", textAlign: "left", verticalAlign: "middle" }}>
              {t.is_winner ? (
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "2px 7px",
                    borderRadius: "4px",
                    backgroundColor: "rgba(34, 197, 94, 0.16)",
                    color: "var(--success)",
                    border: "1px solid rgba(34, 197, 94, 0.4)",
                    fontWeight: 700,
                    fontSize: "0.68rem",
                    whiteSpace: "nowrap",
                    lineHeight: 1.3,
                  }}
                  title={`Kept as Superior Winner: ${t.winner_reason}`}
                >
                  <span>🏆</span>
                  <span>Winner</span>
                </div>
              ) : (
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    backgroundColor: "var(--bg-surface)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "5px",
                    padding: "1px",
                    gap: "1px",
                  }}
                >
                  {/* Keep Toggle Icon Button */}
                  <button
                    type="button"
                    onClick={() => {
                      if (!excludedTrackPaths.has(t.file_path)) {
                        onToggleExcludeTrack(t.file_path);
                      }
                    }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "3px",
                      padding: "2px 6px",
                      fontSize: "0.68rem",
                      fontWeight: excludedTrackPaths.has(t.file_path) ? 700 : 500,
                      borderRadius: "3px",
                      border: "none",
                      backgroundColor: excludedTrackPaths.has(t.file_path)
                        ? "rgba(59, 130, 246, 0.22)"
                        : "transparent",
                      color: excludedTrackPaths.has(t.file_path) ? "#60a5fa" : "var(--text-muted)",
                      cursor: excludedTrackPaths.has(t.file_path) ? "default" : "pointer",
                      transition: "all 0.15s ease",
                      lineHeight: 1.2,
                    }}
                    title={
                      excludedTrackPaths.has(t.file_path)
                        ? "Currently marked as Kept (Preserved)"
                        : "Click to Keep and preserve this file"
                    }
                  >
                    <span style={{ fontSize: "0.7rem" }}>🛡️</span>
                    <span>Keep</span>
                  </button>

                  {/* Delete Toggle Icon Button */}
                  <button
                    type="button"
                    onClick={() => {
                      if (excludedTrackPaths.has(t.file_path)) {
                        onToggleExcludeTrack(t.file_path);
                      }
                    }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "3px",
                      padding: "2px 6px",
                      fontSize: "0.68rem",
                      fontWeight: !excludedTrackPaths.has(t.file_path) ? 700 : 500,
                      borderRadius: "3px",
                      border: "none",
                      backgroundColor: !excludedTrackPaths.has(t.file_path)
                        ? "rgba(239, 68, 68, 0.18)"
                        : "transparent",
                      color: !excludedTrackPaths.has(t.file_path) ? "#f87171" : "var(--text-muted)",
                      cursor: !excludedTrackPaths.has(t.file_path) ? "default" : "pointer",
                      transition: "all 0.15s ease",
                      lineHeight: 1.2,
                    }}
                    title={
                      !excludedTrackPaths.has(t.file_path)
                        ? "Currently marked for Deletion (Duplicate copy)"
                        : "Click to mark for deletion when fixed"
                    }
                  >
                    <span style={{ fontSize: "0.7rem" }}>🗑️</span>
                    <span>Delete</span>
                  </button>
                </div>
              )}
            </td>

            {/* 3. File Name (with subtle play button just before filename) */}
            <td style={{ padding: "6px 8px", textAlign: "left", verticalAlign: "middle", minWidth: 0, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "7px", minWidth: 0 }}>
                {/* Subtle Play Button */}
                <button
                  type="button"
                  onClick={() => onPlayGroupTrack(group, t)}
                  style={{
                    width: "20px",
                    height: "20px",
                    padding: 0,
                    borderRadius: "4px",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: "var(--bg-tertiary)",
                    color: "var(--text-secondary)",
                    border: "1px solid var(--border-color)",
                    cursor: "pointer",
                    flexShrink: 0,
                    transition: "all 0.15s ease",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = "var(--accent-purple)";
                    e.currentTarget.style.borderColor = "var(--accent-purple)";
                    e.currentTarget.style.backgroundColor = "var(--accent-purple-glow)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = "var(--text-secondary)";
                    e.currentTarget.style.borderColor = "var(--border-color)";
                    e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
                  }}
                  title={`Play "${fileName}"`}
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                  </svg>
                </button>

                <div style={{ minWidth: 0, overflow: "hidden" }}>
                  <div
                    style={{
                      fontSize: "0.82rem",
                      fontWeight: 600,
                      fontFamily: "var(--font-mono)",
                      color: t.is_winner ? "var(--text-primary)" : "var(--text-secondary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
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
                </div>
              </div>
            </td>

            {/* 4. Source Folder */}
            <td style={{ padding: "6px 8px", textAlign: "left", verticalAlign: "middle", overflow: "hidden" }}>
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

            {/* 5. Format & Bitrate */}
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

            {/* 8. Actions (Vertically aligned in 4 fixed button slots) */}
            <td style={{ padding: "6px 8px", textAlign: "center", verticalAlign: "middle", whiteSpace: "nowrap" }}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                {/* Slot 1: Make Winner / Current Winner indicator */}
                {!t.is_winner ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => onMakeWinner(group, t)}
                    disabled={isDeleting}
                    style={{
                      width: "24px",
                      height: "24px",
                      padding: 0,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: "4px",
                      fontSize: "0.8rem",
                    }}
                    title={`Set as Kept Winner: Prefer "${fileName}" as the winner for this duplicate group`}
                  >
                    👑
                  </button>
                ) : (
                  <div
                    style={{
                      width: "24px",
                      height: "24px",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "0.8rem",
                      opacity: 0.85,
                    }}
                    title="Current Kept Winner"
                  >
                    👑
                  </div>
                )}

                {/* Slot 2: Detach */}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => onDetachTrack(group, t)}
                  disabled={isDeleting}
                  style={{
                    width: "24px",
                    height: "24px",
                    padding: 0,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "4px",
                    color: "var(--accent-purple)",
                  }}
                  title={`✂️ Detach from Group: Disconnect "${fileName}" so it is treated as a separate unique song and preserved`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <line x1="20" y1="4" x2="8.12" y2="15.88" />
                    <line x1="14.47" y1="14.48" x2="20" y2="20" />
                    <line x1="8.12" y1="8.12" x2="12" y2="12" />
                  </svg>
                </button>

                {/* Slot 3: Keep this & delete others */}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => onKeepThisAndDeleteOthers(group, t)}
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
                  title={`Keep this, and delete others: Keep "${fileName}" and permanently delete other duplicate copies from disk`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                </button>

                {/* Slot 4: Reveal in Finder */}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => onRevealInFinder(t.file_path)}
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
    </React.Fragment>
  );
};
