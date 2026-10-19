import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MainConfig } from "../../types";

export interface WorkspaceConfigWizardProps {
  onSuccess: (configPath: string, config: MainConfig) => void;
  onCancel?: () => void;
  submitButtonText?: string;
  cancelButtonText?: string;
  isCardWrapper?: boolean;
}

export const WorkspaceConfigWizard: React.FC<WorkspaceConfigWizardProps> = ({
  onSuccess,
  onCancel,
  submitButtonText = "🚀 Create Configuration",
  cancelButtonText = "Cancel",
  isCardWrapper = false,
}) => {
  const [newConfigPath, setNewConfigPath] = useState<string>("");
  const [newSourceDir, setNewSourceDir] = useState<string>("");
  const [newTargetDir, setNewTargetDir] = useState<string>("");
  const [newRelativeToConfig, setNewRelativeToConfig] = useState<boolean>(true);
  const [isCreating, setIsCreating] = useState<boolean>(false);

  const selectNewConfigSavePath = async () => {
    try {
      const selected = await invoke<string | null>("save_file_dialog", {
        title: "Create New Configuration YAML",
        filterName: "YAML Configurations",
        filterExt: "yaml,yml",
      });
      if (selected) {
        setNewConfigPath(selected);
      }
    } catch (e) {
      alert("Error selecting save path: " + e);
    }
  };

  const selectNewSourceDir = async () => {
    try {
      const selected = await invoke<string | null>("select_directory", {
        title: "Select Music Source Folder",
      });
      if (selected) {
        setNewSourceDir(selected);
      }
    } catch (e) {
      alert("Error selecting folder: " + e);
    }
  };

  const selectNewTargetDir = async () => {
    try {
      const selected = await invoke<string | null>("select_directory", {
        title: "Select Playlists Output Folder",
      });
      if (selected) {
        setNewTargetDir(selected);
      }
    } catch (e) {
      alert("Error selecting folder: " + e);
    }
  };

  const handleCreateNewConfigSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newConfigPath || !newSourceDir || !newTargetDir) {
      alert("Please configure save path and both directory paths.");
      return;
    }

    setIsCreating(true);
    try {
      const newConfig: MainConfig = {
        sourceDir: newSourceDir,
        targetDir: newTargetDir,
        relativeToConfig: newRelativeToConfig,
        playlists: [],
      };

      await invoke("save_workspace", {
        configPath: newConfigPath,
        config: newConfig,
      });

      onSuccess(newConfigPath, newConfig);
    } catch (e) {
      alert("Error creating configuration: " + e);
    } finally {
      setIsCreating(false);
    }
  };

  const formContent = (
    <form onSubmit={handleCreateNewConfigSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px", marginTop: isCardWrapper ? 0 : "8px" }}>
      <div className="form-group">
        <label className="form-label">Save Config File As</label>
        <div className="form-row">
          <input
            type="text"
            readOnly
            value={newConfigPath}
            placeholder="Select folder and set config name..."
            required
          />
          <button className="btn btn-secondary" type="button" onClick={selectNewConfigSavePath}>
            {isCardWrapper ? "Browse..." : "Choose Location..."}
          </button>
        </div>
      </div>

      <div className="form-group" style={{ display: "flex", alignItems: "center", gap: "10px", backgroundColor: "var(--bg-tertiary)", padding: "12px", borderRadius: "8px", border: "1px solid var(--border-color)" }}>
        <input
          type="checkbox"
          id="workspace-relative-toggle"
          checked={newRelativeToConfig}
          onChange={(e) => setNewRelativeToConfig(e.target.checked)}
          style={{ width: "auto", cursor: "pointer" }}
        />
        <label htmlFor="workspace-relative-toggle" style={{ fontWeight: 600, cursor: "pointer", fontSize: "0.9rem", color: "var(--text-primary)" }}>
          Use relative paths for directories (relativeToConfig)
        </label>
      </div>

      <div className="form-group">
        <label className="form-label">Music Source Folder (sourceDir)</label>
        <div className="form-row">
          <input
            type="text"
            readOnly
            value={newSourceDir}
            placeholder="Choose where your tracks reside..."
            required
          />
          <button className="btn btn-secondary" type="button" onClick={selectNewSourceDir}>
            Browse...
          </button>
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Playlists Output Folder (targetDir)</label>
        <div className="form-row">
          <input
            type="text"
            readOnly
            value={newTargetDir}
            placeholder="Choose where playlists will be saved..."
            required
          />
          <button className="btn btn-secondary" type="button" onClick={selectNewTargetDir}>
            Browse...
          </button>
        </div>
      </div>

      {isCardWrapper ? (
        <button
          className="btn btn-primary"
          type="submit"
          disabled={isCreating}
          style={{ padding: "12px", fontSize: "1rem", marginTop: "12px" }}
        >
          {isCreating ? "Initializing Workspace..." : submitButtonText}
        </button>
      ) : (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px" }}>
          {onCancel && (
            <button className="btn btn-secondary" type="button" onClick={onCancel}>
              {cancelButtonText}
            </button>
          )}
          <button
            className="btn btn-primary"
            type="submit"
            disabled={isCreating}
          >
            {isCreating ? "Creating..." : submitButtonText}
          </button>
        </div>
      )}
    </form>
  );

  if (isCardWrapper) {
    return (
      <div className="card" style={{ maxWidth: "560px", width: "90%", padding: "32px" }}>
        <div className="card-title" style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "12px", marginBottom: "20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Create Workspace Config</span>
          {onCancel && (
            <button className="btn btn-secondary" onClick={onCancel} style={{ padding: "4px 12px", fontSize: "0.8rem" }}>
              Back
            </button>
          )}
        </div>
        {formContent}
      </div>
    );
  }

  return formContent;
};
