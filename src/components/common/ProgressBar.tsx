import React from "react";

export interface ProgressBarProps {
  progress: number;
  height?: number;
  status?: "running" | "completed" | "failed";
  onCancel?: () => void;
  cancelTitle?: string;
  style?: React.CSSProperties;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  progress,
  height = 6,
  status = "running",
  onCancel,
  cancelTitle = "Stop Task",
  style,
}) => {
  const clampProgress = Math.min(100, Math.max(0, progress));

  const fillColor =
    status === "completed"
      ? "var(--success)"
      : status === "failed"
      ? "var(--danger)"
      : "var(--accent-purple)";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%", ...style }}>
      <div
        style={{
          flex: 1,
          height: `${height}px`,
          backgroundColor: "var(--bg-tertiary)",
          border: "1px solid var(--border-color)",
          borderRadius: `${height / 2}px`,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${clampProgress}%`,
            backgroundColor: fillColor,
            transition: "width 0.4s ease",
          }}
        />
      </div>
      {onCancel && status === "running" && (
        <button
          onClick={onCancel}
          style={{
            background: "rgba(239, 68, 68, 0.15)",
            border: "1px solid var(--danger)",
            color: "var(--danger)",
            borderRadius: "4px",
            cursor: "pointer",
            padding: "1px 5px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "0.7rem",
            lineHeight: 1,
            flexShrink: 0,
          }}
          title={cancelTitle}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      )}
    </div>
  );
};
