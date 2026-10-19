import React from "react";
import { ExportTrackItem, TrackDiffField } from "../../types";

export interface ExportDiffModalProps {
  inspectDiffItem: ExportTrackItem | null;
  onClose: () => void;
  onApplyUpdate: (item: ExportTrackItem) => void;
  isApplyingAction?: boolean;
}

export const ExportDiffModal: React.FC<ExportDiffModalProps> = ({
  inspectDiffItem,
  onClose,
  onApplyUpdate,
  isApplyingAction = false,
}) => {
  if (!inspectDiffItem) return null;

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ zIndex: 1100 }}>
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
          <button className="btn btn-secondary" onClick={onClose} style={{ padding: "4px 8px" }}>
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
                inspectDiffItem.diff_details.diffs.map((diff: TrackDiffField, idx: number) => (
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
            onClick={() => onApplyUpdate(inspectDiffItem)}
            style={{ padding: "6px 14px", backgroundColor: "var(--warning)", borderColor: "var(--warning)", color: "#000", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            ⚡ Apply This Update to USB
          </button>
          <button className="btn btn-secondary" onClick={onClose} style={{ padding: "6px 16px" }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
