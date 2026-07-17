import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MainConfig } from "../App";

type SettingsViewProps = {
  configPath: string;
  setConfigPath: (path: string) => void;
  config: MainConfig | null;
  setConfig: (config: MainConfig | null) => void;
  onLoadConfig: (path: string) => Promise<MainConfig | null>;
  formats: string;
  setFormats: (formats: string) => void;
};

export const SettingsView: React.FC<SettingsViewProps> = ({
  configPath,
  setConfigPath,
  config,
  setConfig,
  onLoadConfig,
  formats,
  setFormats,
}) => {
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [wizardMode, setWizardMode] = useState<"edit" | "create">("edit");

  // New config creation states
  const [newConfigPath, setNewConfigPath] = useState<string>("");
  const [newRelativeToConfig, setNewRelativeToConfig] = useState<boolean>(true);
  const [newSourceDir, setNewSourceDir] = useState<string>("");
  const [newTargetDir, setNewTargetDir] = useState<string>("");
  const [isCreating, setIsCreating] = useState<boolean>(false);

  const selectSourceDir = async () => {
    try {
      const selected = await invoke<string | null>("select_directory", {
        title: "Select Music Source Directory",
      });
      if (selected && config) {
        setConfig({
          ...config,
          sourceDir: selected,
        });
      }
    } catch (e) {
      alert("Error selecting folder: " + e);
    }
  };

  const selectTargetDir = async () => {
    try {
      const selected = await invoke<string | null>("select_directory", {
        title: "Select Playlists Target Directory",
      });
      if (selected && config) {
        setConfig({
          ...config,
          targetDir: selected,
        });
      }
    } catch (e) {
      alert("Error selecting folder: " + e);
    }
  };

  const handleSaveConfig = async () => {
    if (!configPath || !config) {
      alert("No configuration is active to save.");
      return;
    }
    
    setSaveStatus("saving");

    const cleanedConfig = {
      ...config,
      sourceDir: config.sourceDir?.trim() === "" ? null : config.sourceDir,
      targetDir: config.targetDir?.trim() === "" ? null : config.targetDir,
      relativeToConfig: config.relativeToConfig ?? true,
      playlists: config.playlists.map(pl => ({
        ...pl,
        exclusions: pl.exclusions && pl.exclusions.length === 0 ? null : pl.exclusions
      }))
    };

    try {
      await invoke("save_workspace", {
        configPath: configPath,
        config: cleanedConfig,
      });
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
      onLoadConfig(configPath);
    } catch (e) {
      setSaveStatus("idle");
      alert("Error saving configuration: " + e);
    }
  };

  // Config Switcher / Creator methods
  const handleBrowseConfig = async () => {
    try {
      const selected = await invoke<string | null>("select_file", {
        title: "Select Workspace Config YAML",
        filterName: "YAML Configurations",
        filterExt: "yaml,yml",
      });
      if (selected) {
        setConfigPath(selected);
        await onLoadConfig(selected);
      }
    } catch (e) {
      alert("Error selecting configuration: " + e);
    }
  };

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

      setConfigPath(newConfigPath);
      setConfig(newConfig);
      alert("New workspace created successfully!");
      setWizardMode("edit");
    } catch (e) {
      alert("Error creating configuration: " + e);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="view-container">
      <h1>Settings</h1>
      <p className="subtitle">Switch configurations, create new workspaces, or adjust directory mappings and audio format options.</p>

      {/* Active Workspace Configuration Selector */}
      <div className="card">
        <div className="card-title">
          <span>Active Configuration file</span>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              className={`btn btn-secondary ${wizardMode === "edit" ? "active" : ""}`}
              onClick={() => setWizardMode("edit")}
              style={{ padding: "4px 12px", fontSize: "0.8rem" }}
            >
              🔄 Active Config
            </button>
            <button
              className={`btn btn-secondary ${wizardMode === "create" ? "active" : ""}`}
              onClick={() => setWizardMode("create")}
              style={{ padding: "4px 12px", fontSize: "0.8rem" }}
            >
              ✨ Create New Config
            </button>
          </div>
        </div>

        {wizardMode === "edit" ? (
          <div className="form-group">
            <label className="form-label">Loaded Configuration Path</label>
            <div className="form-row">
              <input
                type="text"
                readOnly
                value={configPath || "No active configuration loaded."}
                placeholder="No config active"
              />
              <button className="btn btn-secondary" onClick={handleBrowseConfig}>
                Browse Config...
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleCreateNewConfigSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px", marginTop: "8px" }}>
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
                  Choose Location...
                </button>
              </div>
            </div>

            <div className="form-group" style={{ display: "flex", alignItems: "center", gap: "10px", backgroundColor: "var(--bg-tertiary)", padding: "12px", borderRadius: "8px", border: "1px solid var(--border-color)" }}>
              <input
                type="checkbox"
                id="settings-relative-toggle"
                checked={newRelativeToConfig}
                onChange={(e) => setNewRelativeToConfig(e.target.checked)}
                style={{ width: "auto", cursor: "pointer" }}
              />
              <label htmlFor="settings-relative-toggle" style={{ fontWeight: 600, cursor: "pointer", fontSize: "0.9rem", color: "var(--text-primary)" }}>
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

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px" }}>
              <button className="btn btn-secondary" type="button" onClick={() => setWizardMode("edit")}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={isCreating}
              >
                {isCreating ? "Creating..." : "🚀 Create Configuration"}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Directory Settings & relativeToConfig */}
      {config && wizardMode === "edit" && (
        <>
          <div className="card">
            <div className="card-title">Directory Mappings & Relative Preferences</div>

            <div className="form-group" style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "20px", backgroundColor: "var(--bg-tertiary)", padding: "12px", borderRadius: "8px", border: "1px solid var(--border-color)" }}>
              <input
                type="checkbox"
                id="relative-path-toggle-settings"
                checked={config.relativeToConfig ?? true}
                onChange={(e) => setConfig({ ...config, relativeToConfig: e.target.checked })}
                style={{ width: "auto", cursor: "pointer" }}
              />
              <label htmlFor="relative-path-toggle-settings" style={{ fontWeight: 600, cursor: "pointer", fontSize: "0.95rem", color: "var(--text-primary)" }}>
                Resolve directories and write playlist entries relative to the configuration file location (relativeToConfig)
              </label>
            </div>

            <div className="form-group">
              <label className="form-label">Music Source Directory (sourceDir)</label>
              <div className="form-row">
                <input
                  type="text"
                  value={config.sourceDir || ""}
                  onChange={(e) => setConfig({ ...config, sourceDir: e.target.value })}
                  placeholder="Folder where your music tracks reside"
                />
                <button className="btn btn-secondary" onClick={selectSourceDir}>
                  Choose Folder
                </button>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Playlists Output Directory (targetDir)</label>
              <div className="form-row">
                <input
                  type="text"
                  value={config.targetDir || ""}
                  onChange={(e) => setConfig({ ...config, targetDir: e.target.value })}
                  placeholder="Folder where playlist .m3u files will be created"
                />
                <button className="btn btn-secondary" onClick={selectTargetDir}>
                  Choose Folder
                </button>
              </div>
            </div>
          </div>

          {/* Allowed Extensions Card */}
          <div className="card">
            <div className="card-title">Application File Format Settings</div>
            
            <div className="form-group">
              <label className="form-label">Allowed Audio Extensions (comma-separated)</label>
              <input
                type="text"
                value={formats}
                onChange={(e) => setFormats(e.target.value)}
                placeholder="e.g. mp3,aac,ogg,wma,alac,m4a,wav,flac"
              />
              <p className="text-secondary" style={{ fontSize: "0.8rem", marginTop: "4px" }}>
                The Diamond Music Manager (library tree, playlist maker, and sanitizer) will only process files matching these extensions.
              </p>
            </div>
          </div>

          {/* Save Button */}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "24px" }}>
            <button
              className={`btn ${saveStatus === "saved" ? "btn-success" : "btn-primary"}`}
              onClick={handleSaveConfig}
              disabled={saveStatus === "saving"}
              style={{ minWidth: "240px", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", padding: "12px 24px" }}
            >
              {saveStatus === "idle" && <>💾 Save Settings Changes</>}
              {saveStatus === "saving" && <>⏳ Saving Changes...</>}
              {saveStatus === "saved" && <>✓ Settings Saved!</>}
            </button>
          </div>
        </>
      )}
    </div>
  );
};
