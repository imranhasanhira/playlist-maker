import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { DownloadGlobalSettings } from "../../types";

type GlobalSettingsPanelProps = {
  isOpen: boolean;
  settings: DownloadGlobalSettings;
  onSaveSettings: (updated: DownloadGlobalSettings) => Promise<void>;
  onClose: () => void;
};

export const GlobalSettingsPanel: React.FC<GlobalSettingsPanelProps> = ({
  isOpen,
  settings,
  onSaveSettings,
  onClose,
}) => {
  const [formState, setFormState] = React.useState<DownloadGlobalSettings>(settings);
  const [isResettingArchive, setIsResettingArchive] = React.useState(false);

  React.useEffect(() => {
    setFormState(settings);
  }, [settings, isOpen]);

  if (!isOpen) return null;

  const updateSetting = (changes: Partial<DownloadGlobalSettings>) => {
    const updated = { ...formState, ...changes };
    setFormState(updated);
    onSaveSettings(updated);
  };

  const handlePickDir = async () => {
    try {
      const selected = await invoke<string | null>("select_directory", {
        title: "Select Global Default Output Folder",
      });
      if (selected) {
        updateSetting({ default_output_dir: selected });
      }
    } catch (e) {
      alert("Error picking directory: " + e);
    }
  };

  const handleClearArchive = async () => {
    if (!confirm("Clear the entire global download archive file? All download history across all entries will be reset.")) {
      return;
    }
    setIsResettingArchive(true);
    try {
      await invoke("reset_archive_file", {
        archivePath: formState.archive_path,
        outputDir: formState.default_output_dir,
      });
      alert("Global archive file cleared successfully.");
    } catch (e) {
      alert("Error clearing archive: " + e);
    } finally {
      setIsResettingArchive(false);
    }
  };

  return (
    <div
      style={{
        backgroundColor: "var(--bg-secondary)",
        border: "1px solid var(--border-color)",
        borderRadius: "8px",
        padding: "16px",
        marginBottom: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        animation: "fadeIn 0.2s ease-in-out",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ fontSize: "0.95rem", margin: 0, fontWeight: 600 }}>
          ⚙ Global Download Settings Defaults
        </h3>
        <button
          type="button"
          onClick={onClose}
          style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: "1rem" }}
        >
          ✕
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {/* Default Output Directory */}
        <div className="form-group" style={{ margin: 0 }}>
          <label className="form-label">Global Default Output Folder</label>
          <div className="form-row">
            <input
              type="text"
              value={formState.default_output_dir}
              onChange={(e) => setFormState({ ...formState, default_output_dir: e.target.value })}
              onBlur={() => onSaveSettings(formState)}
              placeholder="e.g. /Users/name/Music/Youtube"
            />
            <button className="btn btn-secondary" type="button" onClick={handlePickDir}>
              Folder
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px" }}>
          {/* Default Audio Format */}
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Default Audio Format</label>
            <select
              value={formState.default_audio_format}
              onChange={(e) => updateSetting({ default_audio_format: e.target.value })}
            >
              <option value="m4a/mp3">m4a/mp3 (Best Quality)</option>
              <option value="m4a">m4a (Lossless)</option>
              <option value="mp3">mp3 (Audio Only)</option>
            </select>
          </div>

          {/* Max Parallel Jobs */}
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Max Parallel Downloads</label>
            <select
              value={formState.max_parallel_jobs}
              onChange={(e) => updateSetting({ max_parallel_jobs: parseInt(e.target.value) || 2 })}
            >
              <option value={1}>1 Job (Serial)</option>
              <option value={2}>2 Jobs (Recommended)</option>
              <option value={3}>3 Jobs</option>
              <option value={4}>4 Jobs</option>
            </select>
          </div>

          {/* Ignore Errors */}
          <div className="form-group" style={{ margin: 0, justifyContent: "center" }}>
            <label className="form-label">Options</label>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.82rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={formState.default_ignore_errors}
                onChange={(e) => updateSetting({ default_ignore_errors: e.target.checked })}
              />
              <span>Ignore unavailable video errors (--ignore-errors)</span>
            </label>
          </div>
        </div>

        {/* Global Archive Path & Controls */}
        <div className="form-group" style={{ margin: 0, backgroundColor: "var(--bg-tertiary)", padding: "10px", borderRadius: "6px" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.85rem", fontWeight: 600, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={formState.default_use_archive}
              onChange={(e) => updateSetting({ default_use_archive: e.target.checked })}
            />
            <span>Enable Single Global Download Archive (archive.txt)</span>
          </label>

          {formState.default_use_archive && (
            <div className="form-row" style={{ marginTop: "8px" }}>
              <input
                type="text"
                placeholder="Global archive file path (optional)..."
                value={formState.archive_path}
                onChange={(e) => setFormState({ ...formState, archive_path: e.target.value })}
                onBlur={() => onSaveSettings(formState)}
                style={{ fontSize: "0.8rem" }}
              />
              <button
                className="btn btn-secondary"
                type="button"
                onClick={handleClearArchive}
                disabled={isResettingArchive}
                style={{ padding: "4px 10px", fontSize: "0.78rem" }}
              >
                🗑 Clear Archive
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
