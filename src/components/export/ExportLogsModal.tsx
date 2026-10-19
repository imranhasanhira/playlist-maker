import React from "react";
import { formatSize, formatSpeed, formatEta } from "../../utils/formatters";

export interface ExportProgressWithStart {
  current_file: string;
  current_file_index: number;
  total_files: number;
  copied_bytes: number;
  total_bytes: number;
  current_file_copied_bytes?: number;
  current_file_total_bytes?: number;
  startTime: number;
}

export interface ExportLogsModalProps {
  isOpen: boolean;
  onClose: () => void;
  exportProgress: ExportProgressWithStart | null;
  isExporting: boolean;
  isExportAutoScroll: boolean;
  exportLogs: string[];
  onCancelExport: () => void;
  onScrollToLatest: () => void;
  onLogsScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  logContainerRef: React.RefObject<HTMLDivElement | null>;
}

export const ExportLogsModal: React.FC<ExportLogsModalProps> = ({
  isOpen,
  onClose,
  exportProgress,
  isExporting,
  isExportAutoScroll,
  exportLogs,
  onCancelExport,
  onScrollToLatest,
  onLogsScroll,
  logContainerRef,
}) => {
  if (!isOpen) return null;

  const progressPercent =
    exportProgress && exportProgress.total_bytes > 0
      ? Math.min(100, Math.round((exportProgress.copied_bytes / exportProgress.total_bytes) * 100))
      : 0;

  const elapsedSec = exportProgress ? Math.max(0.1, (Date.now() - exportProgress.startTime) / 1000) : 0;
  const currentSpeed = exportProgress ? exportProgress.copied_bytes / elapsedSec : 0;
  const remainingBytes = exportProgress ? Math.max(0, exportProgress.total_bytes - exportProgress.copied_bytes) : 0;
  const etaSec = currentSpeed > 0 ? remainingBytes / currentSpeed : 0;

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
      }}
    >
      <div className="card" style={{ width: "720px", maxHeight: "85%", display: "flex", flexDirection: "column", margin: 0, padding: "20px" }}>
        <div className="card-title" style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontWeight: 600, fontSize: "1rem" }}>Export Progress & Logs</span>
            {!isExportAutoScroll && exportLogs.length > 0 && (
              <button
                type="button"
                onClick={onScrollToLatest}
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
                onClick={onCancelExport}
                style={{ padding: "4px 12px", fontSize: "0.8rem" }}
              >
                🛑 Stop Export
              </button>
            )}
            <button
              className="btn btn-secondary"
              onClick={onClose}
              style={{ padding: "4px 12px", fontSize: "0.8rem" }}
            >
              Close
            </button>
          </div>
        </div>

        {/* Sticky Progress Header */}
        {exportProgress && (
          <div
            style={{
              backgroundColor: "var(--bg-tertiary)",
              border: "1px solid var(--border-color)",
              padding: "12px 14px",
              borderRadius: "8px",
              marginTop: "12px",
              marginBottom: "4px",
            }}
          >
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
                  onClick={onCancelExport}
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
                {isExporting ? `⏱ ETA: ${formatEta(etaSec)}` : exportLogs.some((l) => l.includes("stopped")) ? "🛑 Stopped" : "✅ Export Complete"}
              </span>
            </div>
          </div>
        )}

        <div
          ref={logContainerRef as React.RefObject<HTMLDivElement>}
          onScroll={onLogsScroll}
          className="console-log"
          style={{ flex: 1, minHeight: "260px", maxHeight: "400px", overflowY: "auto", marginTop: "12px" }}
        >
          {exportLogs.join("\n")}
        </div>
      </div>
    </div>
  );
};
