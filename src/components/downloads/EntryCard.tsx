import React from "react";
import { DownloadEntry, DownloadJob } from "../../types";
import { ProgressBar } from "../common/ProgressBar";

type EntryCardProps = {
  entry: DownloadEntry;
  isSelected: boolean;
  activeJob?: DownloadJob;
  isRefreshing?: boolean;
  onSelect: () => void;
};

export const EntryCard: React.FC<EntryCardProps> = ({
  entry,
  isSelected,
  activeJob,
  isRefreshing = false,
  onSelect,
}) => {
  // Determine badge color and label
  let statusColor = "var(--accent-indigo)";
  let statusText = "New";
  let statusBg = "rgba(99, 102, 241, 0.15)";

  if (activeJob && activeJob.status === "running") {
    statusColor = "var(--accent-purple-hover)";
    statusText = "Downloading";
    statusBg = "rgba(138, 92, 246, 0.18)";
  } else {
    switch (entry.status) {
      case "complete":
        statusColor = "var(--success)";
        statusText = "Complete";
        statusBg = "rgba(16, 185, 129, 0.15)";
        break;
      case "partial":
        statusColor = "var(--warning)";
        statusText = "Partial";
        statusBg = "rgba(245, 158, 11, 0.15)";
        break;
      case "downloading":
        statusColor = "var(--accent-purple-hover)";
        statusText = "Downloading";
        statusBg = "rgba(138, 92, 246, 0.18)";
        break;
      case "error":
        statusColor = "var(--danger)";
        statusText = "Error";
        statusBg = "rgba(239, 68, 68, 0.15)";
        break;
      case "stale":
        statusColor = "var(--text-muted)";
        statusText = "Stale";
        statusBg = "rgba(107, 114, 128, 0.15)";
        break;
      case "new":
      default:
        statusColor = "#3b82f6";
        statusText = "New";
        statusBg = "rgba(59, 130, 246, 0.15)";
        break;
    }
  }

  const labelList = entry.labels
    ? entry.labels.split(",").map((l) => l.trim()).filter(Boolean)
    : [];

  return (
    <div
      onClick={onSelect}
      style={{
        padding: "10px 12px",
        borderRadius: "8px",
        border: isSelected ? "1.5px solid var(--accent-purple)" : "1px solid var(--border-color)",
        backgroundColor: isSelected ? "rgba(138, 92, 246, 0.12)" : "var(--bg-tertiary)",
        boxShadow: isSelected ? "0 0 8px rgba(138, 92, 246, 0.2)" : "none",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        transition: "all 0.15s ease",
        userSelect: "none",
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      {/* Row 1: Playlist Name FULL WIDTH */}
      <div
        style={{
          fontWeight: 600,
          fontSize: "0.9rem",
          color: "var(--text-primary)",
          width: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          lineHeight: 1.3,
        }}
        title={entry.name || entry.url}
      >
        {entry.name || entry.url}
      </div>

      {/* Row 2: Labels on Left + Status Badge on Right (Same Line) */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", gap: "6px" }}>
        {/* Label Pills */}
        <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", flex: 1, minWidth: 0 }}>
          {labelList.map((label) => (
            <span
              key={label}
              style={{
                fontSize: "0.66rem",
                padding: "1px 5px",
                borderRadius: "4px",
                backgroundColor: "var(--bg-surface)",
                color: "var(--text-secondary)",
                border: "1px solid var(--border-color)",
              }}
            >
              {label}
            </span>
          ))}
        </div>

        {/* Status Badge & Refresh Spinner */}
        <div style={{ display: "flex", alignItems: "center", gap: "4px", flexShrink: 0, marginLeft: "auto" }}>
          {isRefreshing && (
            <span
              style={{
                fontSize: "0.68rem",
                color: "var(--accent-purple-hover)",
                animation: "spin 1s linear infinite",
                display: "inline-block",
              }}
              title="Refreshing metadata in background..."
            >
              🔄
            </span>
          )}
          <span
            style={{
              fontSize: "0.68rem",
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: "10px",
              backgroundColor: isRefreshing ? "rgba(138, 92, 246, 0.18)" : statusBg,
              color: isRefreshing ? "var(--accent-purple-hover)" : statusColor,
              border: `1px solid ${isRefreshing ? "var(--accent-purple)" : statusColor}`,
              whiteSpace: "nowrap",
            }}
          >
            {isRefreshing ? "Refreshing..." : statusText}
          </span>
        </div>
      </div>

      {/* Live job progress bar if active */}
      {activeJob && activeJob.status === "running" ? (
        <div>
          <ProgressBar progress={activeJob.progress} status="running" height={4} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.72rem", color: "var(--text-secondary)", marginTop: "4px" }}>
            <span>
              {activeJob.current_item && activeJob.total_items
                ? `Track ${activeJob.current_item}/${activeJob.total_items}`
                : "Downloading..."}
            </span>
            <span>{Math.round(activeJob.progress)}%</span>
          </div>
        </div>
      ) : null}

      {/* Row 4: Song count on Bottom Left */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", marginTop: "2px" }}>
        <span style={{ fontSize: "0.76rem", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {entry.total_songs > 0
            ? entry.songs_on_disk > entry.total_songs
              ? `${entry.songs_on_disk} downloaded (${entry.total_songs} in playlist)`
              : `${entry.songs_on_disk} / ${entry.total_songs} downloaded`
            : entry.songs_on_disk > 0
            ? `${entry.songs_on_disk} downloaded`
            : "0 downloaded"}
        </span>
      </div>
    </div>
  );
};
