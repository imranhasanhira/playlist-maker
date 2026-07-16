import React from "react";
import { invoke } from "@tauri-apps/api/core";

export type MainConfig = {
  sourceDir: string | null;
  targetDir: string | null;
  playlists: Array<{
    name: string;
    sources: string[];
    exclusions: string[] | null;
  }>;
};

type WorkspaceViewProps = {
  configPath: string;
  setConfigPath: (path: string) => void;
  config: MainConfig | null;
  setConfig: (config: MainConfig | null) => void;
  onLoadConfig: (path: string) => void;
  formats: string;
  setFormats: (formats: string) => void;
  relativeToConfig: boolean;
  setRelativeToConfig: (rel: boolean) => void;
};

export const WorkspaceView: React.FC<WorkspaceViewProps> = ({
  configPath,
  setConfigPath,
  config,
  setConfig,
  onLoadConfig,
  formats,
  setFormats,
  relativeToConfig,
  setRelativeToConfig,
}) => {
  const selectConfigFile = async () => {
    try {
      const selected = await invoke<string | null>("select_file", {
        title: "Select Workspace Config YAML",
        filterName: "YAML Configurations",
        filterExt: "yaml,yml",
      });
      if (selected) {
        setConfigPath(selected);
        onLoadConfig(selected);
      }
    } catch (e) {
      alert("Error selecting file: " + e);
    }
  };

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
    
    // Clean up empty strings to null for clean serialization
    const cleanedConfig = {
      ...config,
      sourceDir: config.sourceDir?.trim() === "" ? null : config.sourceDir,
      targetDir: config.targetDir?.trim() === "" ? null : config.targetDir,
      playlists: config.playlists.map(pl => ({
        ...pl,
        exclusions: pl.exclusions && pl.exclusions.length === 0 ? null : pl.exclusions
      }))
    };

    try {
      await invoke("save_workspace", {
        configPath,
        config: cleanedConfig,
      });
      alert("Configuration saved successfully!");
      // Reload config to sync backend/frontend models
      onLoadConfig(configPath);
    } catch (e) {
      alert("Error saving configuration: " + e);
    }
  };

  const handleCreateNewConfig = async () => {
    try {
      const selected = await invoke<string | null>("save_file_dialog", {
        title: "Create New YAML Configuration File",
        filterName: "YAML Configurations",
        filterExt: "yaml,yml",
      });
      if (selected) {
        const newConfig: MainConfig = {
          sourceDir: "./Music",
          targetDir: "./Playlists",
          playlists: [],
        };
        await invoke("save_workspace", {
          configPath: selected,
          config: newConfig,
        });
        setConfigPath(selected);
        setConfig(newConfig);
        alert("New workspace created successfully at " + selected);
      }
    } catch (e) {
      alert("Error creating workspace: " + e);
    }
  };

  return (
    <div className="view-container">
      <h1>Workspace & Settings</h1>
      <p className="subtitle">Load, edit, or create your playlist configurations, and configure application settings.</p>

      {/* Configuration Loading Card */}
      <div className="card">
        <div className="card-title">
          <span>Workspace Configuration</span>
          <button className="btn btn-secondary" onClick={handleCreateNewConfig}>
            + Create New Config File
          </button>
        </div>
        
        <div className="form-group">
          <label className="form-label">Active YAML Config Path</label>
          <div className="form-row">
            <input
              type="text"
              readOnly
              value={configPath}
              placeholder="No config loaded. Click 'Browse' to choose a YAML configuration file."
            />
            <button className="btn btn-secondary" onClick={selectConfigFile}>
              Browse...
            </button>
          </div>
        </div>
      </div>

      {/* Settings / Preferences Card */}
      <div className="card">
        <div className="card-title">Application Settings</div>
        
        <div className="form-group">
          <label className="form-label">Allowed Audio Extensions (comma-separated)</label>
          <input
            type="text"
            value={formats}
            onChange={(e) => setFormats(e.target.value)}
            placeholder="e.g. mp3,aac,ogg,wma,alac,m4a,wav,flac"
          />
          <p className="text-secondary" style={{ fontSize: "0.8rem", marginTop: "4px" }}>
            The playlist maker and sanitizer will only process files matching these extensions.
          </p>
        </div>

        <div className="form-group" style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "20px" }}>
          <input
            type="checkbox"
            id="relative-path-toggle"
            checked={relativeToConfig}
            onChange={(e) => setRelativeToConfig(e.target.checked)}
            style={{ width: "auto", cursor: "pointer" }}
          />
          <label htmlFor="relative-path-toggle" style={{ fontWeight: 500, cursor: "pointer", fontSize: "0.95rem" }}>
            Resolve directories and write playlist entries relative to the configuration file location (relativeToConfig)
          </label>
        </div>
      </div>

      {/* Directory Settings (only when config is loaded) */}
      {config && (
        <div className="card">
          <div className="card-title">Workspace Directory Mappings</div>

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

          <div className="form-group" style={{ marginTop: "28px", borderTop: "1px solid var(--border-color)", paddingTop: "20px" }}>
            <div className="flex justify-between align-center">
              <div>
                <span style={{ fontWeight: 600 }}>Playlists Configured:</span> {config.playlists.length}
              </div>
              <button className="btn btn-primary" onClick={handleSaveConfig}>
                💾 Save Configuration Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
