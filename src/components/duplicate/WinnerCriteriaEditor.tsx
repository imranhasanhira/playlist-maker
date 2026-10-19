import React from "react";

export interface WinnerCriterion {
  id: "clean_duration" | "format_quality" | "bitrate" | "source_priority" | "playlist_priority" | "file_size";
  label: string;
  desc: string;
  enabled: boolean;
}

export const DEFAULT_WINNER_CRITERIA: WinnerCriterion[] = [
  { id: "clean_duration", label: "Clean Duration", desc: "Penalize files with intro/outro ads (>= 5s difference from cleanest track)", enabled: true },
  { id: "format_quality", label: "Format Quality", desc: "Lossless & higher fidelity (.FLAC > .WAV > .M4A > .MP3 > .OGG)", enabled: true },
  { id: "bitrate", label: "Audio Bitrate", desc: "Prefer higher bitrate (e.g. 320 kbps > 192 kbps)", enabled: true },
  { id: "source_priority", label: "Source Folder Order", desc: "Prefer files located in earlier source folders from config", enabled: true },
  { id: "playlist_priority", label: "Playlist Order", desc: "Prefer files in earlier playlists from config", enabled: true },
  { id: "file_size", label: "File Size", desc: "Prefer larger file size on disk", enabled: false },
];

export interface WinnerCriteriaEditorProps {
  showRulesConfig: boolean;
  winnerCriteria: WinnerCriterion[];
  onToggleCriterion: (id: WinnerCriterion["id"]) => void;
  onMoveCriterion: (index: number, direction: "up" | "down") => void;
  onResetCriteria: () => void;
}

export const WinnerCriteriaEditor: React.FC<WinnerCriteriaEditorProps> = ({
  showRulesConfig,
  winnerCriteria,
  onToggleCriterion,
  onMoveCriterion,
  onResetCriteria,
}) => {
  if (!showRulesConfig) return null;

  return (
    <div
      style={{
        backgroundColor: "var(--bg-tertiary)",
        border: "1px solid var(--border-color)",
        borderRadius: "8px",
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-primary)" }}>
            ⚙️ Winner Selection Priority Rules
          </span>
          <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginLeft: "8px" }}>
            Evaluated from top (#1) to bottom. Changes apply immediately in-memory.
          </span>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onResetCriteria}
          style={{ fontSize: "0.72rem", padding: "2px 8px" }}
          title="Reset rules to default priority order"
        >
          Reset to Defaults
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: "8px" }}>
        {winnerCriteria.map((crit, idx) => (
          <div
            key={crit.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "6px 10px",
              backgroundColor: crit.enabled ? "var(--bg-surface)" : "var(--bg-secondary)",
              border: `1px solid ${crit.enabled ? "var(--border-color)" : "transparent"}`,
              borderRadius: "6px",
              opacity: crit.enabled ? 1 : 0.55,
              gap: "8px",
            }}
          >
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                cursor: "pointer",
                minWidth: 0,
                flex: 1,
              }}
            >
              <input
                type="checkbox"
                checked={crit.enabled}
                onChange={() => onToggleCriterion(crit.id)}
                style={{ cursor: "pointer" }}
              />
              <span
                style={{
                  fontSize: "0.7rem",
                  fontWeight: 700,
                  padding: "1px 5px",
                  borderRadius: "4px",
                  backgroundColor: crit.enabled ? "var(--accent-purple-glow)" : "var(--bg-tertiary)",
                  color: crit.enabled ? "var(--accent-purple)" : "var(--text-secondary)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                #{idx + 1}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-primary)" }}>
                  {crit.label}
                </div>
                <div
                  style={{
                    fontSize: "0.7rem",
                    color: "var(--text-secondary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={crit.desc}
                >
                  {crit.desc}
                </div>
              </div>
            </label>

            <div style={{ display: "flex", gap: "2px", flexShrink: 0 }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => onMoveCriterion(idx, "up")}
                disabled={idx === 0}
                style={{ width: "22px", height: "22px", padding: 0, fontSize: "0.7rem", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                title="Move rule higher in priority"
              >
                ▲
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => onMoveCriterion(idx, "down")}
                disabled={idx === winnerCriteria.length - 1}
                style={{ width: "22px", height: "22px", padding: 0, fontSize: "0.7rem", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                title="Move rule lower in priority"
              >
                ▼
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
