import React, { useState, useMemo } from "react";
import { AudioTrack, TrackPreview } from "../types";
import { formatSize, formatDuration, cleanDisplayPath } from "../utils/formatters";

export type { TrackPreview };

export interface ResolvedTracksPanelProps {
  previews: TrackPreview[];
  isLoadingPreview: boolean;
  previewError?: string;
  loadPreview?: () => void;
  onPlayTrack?: (track: AudioTrack, queue: AudioTrack[], name: string) => void;
  onPlayAll?: () => void;
  contextName?: string;
  selectedFilePath?: string | null;
  onSelectTrack?: (track: TrackPreview) => void;
  onCollapse?: () => void;
  emptyMessage?: string;
  title?: string;
  style?: React.CSSProperties;
}

type SortField = "title" | "artist" | "year" | "duration" | "size";
type SortOrder = "asc" | "desc";

export const ResolvedTracksPanel: React.FC<ResolvedTracksPanelProps> = ({
  previews,
  isLoadingPreview,
  previewError,
  loadPreview,
  onPlayTrack,
  onPlayAll,
  contextName = "Music",
  selectedFilePath,
  onSelectTrack,
  onCollapse,
  emptyMessage,
  title,
  style,
}) => {
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");

  const handleToggleSort = (field: SortField) => {
    if (sortField === field) {
      if (sortOrder === "asc") {
        setSortOrder("desc");
      } else {
        // Toggle back to default order
        setSortField(null);
        setSortOrder("asc");
      }
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

  const sortedPreviews = useMemo(() => {
    if (!sortField) return previews;

    return [...previews].sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case "title":
          comparison = (a.title || "").toLowerCase().localeCompare((b.title || "").toLowerCase());
          break;
        case "artist":
          comparison = (a.artist || "").toLowerCase().localeCompare((b.artist || "").toLowerCase());
          break;
        case "year": {
          const yA = a.year ?? 0;
          const yB = b.year ?? 0;
          comparison = yA - yB;
          break;
        }
        case "duration":
          comparison = a.duration - b.duration;
          break;
        case "size":
          comparison = a.size_bytes - b.size_bytes;
          break;
      }
      return sortOrder === "asc" ? comparison : -comparison;
    });
  }, [previews, sortField, sortOrder]);

  const renderSortIndicator = (field: SortField) => {
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

  const handlePlaySingle = (track: TrackPreview, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onPlayTrack) return;
    const audioTracks: AudioTrack[] = sortedPreviews.map((t) => ({
      file_path: t.file_path,
      title: t.title,
      artist: t.artist,
      duration: t.duration,
    }));
    onPlayTrack(
      {
        file_path: track.file_path,
        title: track.title,
        artist: track.artist,
        duration: track.duration,
      },
      audioTracks,
      contextName
    );
  };

  const handlePlayAllClick = () => {
    if (onPlayAll) {
      onPlayAll();
    } else if (onPlayTrack && sortedPreviews.length > 0) {
      const audioTracks: AudioTrack[] = sortedPreviews.map((t) => ({
        file_path: t.file_path,
        title: t.title,
        artist: t.artist,
        duration: t.duration,
      }));
      onPlayTrack(audioTracks[0], audioTracks, contextName);
    }
  };

  return (
    <div className="card" style={{ flex: 1, display: "flex", flexDirection: "column", margin: 0, minWidth: 0, overflow: "hidden", ...style }}>
      <div className="card-title" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        {onCollapse && (
          <button
            className="btn btn-secondary"
            onClick={onCollapse}
            title="Collapse Tracks Panel"
            style={{ padding: "4px 8px", fontSize: "0.75rem", display: "flex", alignItems: "center", gap: "4px" }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"></polyline>
            </svg>
          </button>
        )}
        <span>{title || `Resolved Music Tracks (${previews.length})`}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: "8px" }}>
          {onPlayTrack && (
            <button
              className="btn btn-primary"
              onClick={handlePlayAllClick}
              disabled={previews.length === 0}
              style={{ padding: "6px", width: "28px", height: "28px", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "6px" }}
              title="Play All Tracks"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>
          )}
          {loadPreview && (
            <button
              className="btn btn-secondary"
              onClick={loadPreview}
              disabled={isLoadingPreview}
              style={{ padding: "6px", width: "28px", height: "28px", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "6px" }}
              title={isLoadingPreview ? "Reloading..." : "Refresh Tracks"}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 4v6h-6"></path>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
              </svg>
            </button>
          )}
        </div>
      </div>

      {previewError && <div className="no-data text-danger">{previewError}</div>}

      {isLoadingPreview ? (
        <div className="no-data">Loading resolved file list...</div>
      ) : sortedPreviews.length > 0 ? (
        <div className="table-container" style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
          <table style={{ tableLayout: "fixed", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ width: "42px", textAlign: "center" }}>Play</th>
                <th
                  onClick={() => handleToggleSort("title")}
                  style={{ width: "45%", cursor: "pointer", userSelect: "none" }}
                  title="Click to sort by Title"
                >
                  <div style={{ display: "inline-flex", alignItems: "center" }}>
                    <span>Title</span>
                    {renderSortIndicator("title")}
                  </div>
                </th>
                <th
                  onClick={() => handleToggleSort("artist")}
                  style={{ width: "23%", cursor: "pointer", userSelect: "none" }}
                  title="Click to sort by Artist"
                >
                  <div style={{ display: "inline-flex", alignItems: "center" }}>
                    <span>Artist</span>
                    {renderSortIndicator("artist")}
                  </div>
                </th>
                <th
                  onClick={() => handleToggleSort("year")}
                  style={{ width: "55px", textAlign: "center", cursor: "pointer", userSelect: "none" }}
                  title="Click to sort by Year"
                >
                  <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    <span>Year</span>
                    {renderSortIndicator("year")}
                  </div>
                </th>
                <th
                  onClick={() => handleToggleSort("duration")}
                  style={{ width: "65px", textAlign: "right", cursor: "pointer", userSelect: "none" }}
                  title="Click to sort by Duration"
                >
                  <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end" }}>
                    <span>Duration</span>
                    {renderSortIndicator("duration")}
                  </div>
                </th>
                <th
                  onClick={() => handleToggleSort("size")}
                  style={{ width: "70px", textAlign: "right", cursor: "pointer", userSelect: "none" }}
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
              {sortedPreviews.map((track, trackIdx) => {
                const isSelected = selectedFilePath === track.file_path;
                return (
                  <tr
                    key={trackIdx}
                    className={isSelected ? "selected" : undefined}
                    data-selected={isSelected}
                    onClick={() => onSelectTrack && onSelectTrack(track)}
                    title={track.file_path}
                    style={{
                      cursor: onSelectTrack ? "pointer" : "default",
                      borderLeft: isSelected ? "3px solid var(--accent-purple)" : "none",
                    }}
                  >
                    <td style={{ width: "42px", textAlign: "center" }}>
                      {onPlayTrack && (
                        <button
                          className="btn btn-secondary"
                          onClick={(e) => handlePlaySingle(track, e)}
                          style={{
                            padding: "5px",
                            borderRadius: "50%",
                            width: "26px",
                            height: "26px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor: "pointer",
                          }}
                          title="Play Track"
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        </button>
                      )}
                    </td>
                    <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={track.file_path}>
                      <div
                        style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.85rem" }}
                        title={track.file_path}
                      >
                        {track.title || "Unknown Title"}
                      </div>
                      <div
                        className="text-secondary"
                        style={{ fontSize: "0.72rem", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        title={track.file_path}
                      >
                        {cleanDisplayPath(track.relative_path)}
                      </div>
                    </td>
                    <td
                      className="text-secondary"
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.82rem" }}
                      title={track.artist || "—"}
                    >
                      {track.artist || "—"}
                    </td>
                    <td style={{ fontFamily: "var(--font-mono)", textAlign: "center", fontSize: "0.78rem" }}>
                      {track.year ? (
                        <span style={{
                          padding: "1px 5px",
                          borderRadius: "4px",
                          backgroundColor: "rgba(138, 92, 246, 0.12)",
                          color: "var(--accent-purple-hover)",
                          border: "1px solid rgba(138, 92, 246, 0.25)",
                          fontWeight: 600
                        }}>
                          {track.year}
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-secondary)", opacity: 0.6 }}>—</span>
                      )}
                    </td>
                    <td style={{ fontFamily: "var(--font-mono)", textAlign: "right", fontSize: "0.78rem" }}>
                      {formatDuration(track.duration)}
                    </td>
                    <td style={{ fontFamily: "var(--font-mono)", textAlign: "right", fontSize: "0.78rem" }}>
                      {formatSize(track.size_bytes)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="no-data">{emptyMessage || "No music files found in specified directory."}</div>
      )}
    </div>
  );
};
