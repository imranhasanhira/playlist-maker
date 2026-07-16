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
};

export const WorkspaceView: React.FC<WorkspaceViewProps> = ({
  configPath,
  setConfigPath,
  config,
  setConfig,
  onLoadConfig,
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
    if (!configPath || !config) return;
    try {
      await invoke("save_workspace", {
        configPath,
        config,
      });
      alert("Configuration saved successfully!");
    } catch (e) {
      alert("Error saving configuration: " + e);
    }
  };

  const handleCreateNewConfig = async () => {
    try {
      const selected = await invoke<string | null>("select_file", {
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
        alert("New workspace created at " + selected);
      }
    } catch (e) {
      alert("Error creating workspace: " + e);
    }
  };

  return (
    <div className="view-container">
      <h1>Workspace Configurations</h1>
      <p className="subtitle">Load, edit, or create your playlist config YAML workspaces.</p>

      <div className="card">
        <div className="card-title">
          <span>Load Configuration</span>
          <button className="btn btn-secondary" onClick={handleCreateNewConfig}>
            + Create New Config
          </button>
        </div>
        
        <div className="form-group">
          <label className="form-label">Active YAML Config Path</label>
          <div className="form-row">
            <input
              type="text"
              readOnly
              value={configPath}
              placeholder="No config loaded. Click 'Browse' to choose a yaml file."
            />
            <button className="btn btn-secondary" onClick={selectConfigFile}>
              Browse File...
            </button>
          </div>
        </div>
      </div>

      {config && (
        <div className="card">
          <div className="card-title">Workspace Directories</div>

          <div className="form-group">
            <label className="form-label">Music Source Directory (sourceDir)</label>
            <div className="form-row">
              <input
                type="text"
                value={config.sourceDir || ""}
                onChange={(e) => setConfig({ ...config, sourceDir: e.target.value })}
                placeholder="Select path where music files reside"
              />
              <button className="btn btn-secondary" onClick={selectSourceDir}>
                Choose Folder
              </button>
            </div>
            <p className="text-secondary" style={{ fontSize: "0.8rem", marginTop: "4px" }}>
              Can be relative to config directory or an absolute path.
            </p>
          </div>

          <div className="form-group">
            <label className="form-label">Playlists Output Directory (targetDir)</label>
            <div className="form-row">
              <input
                type="text"
                value={config.targetDir || ""}
                onChange={(e) => setConfig({ ...config, targetDir: e.target.value })}
                placeholder="Select path where .m3u files will be saved"
              />
              <button className="btn btn-secondary" onClick={selectTargetDir}>
                Choose Folder
              </button>
            </div>
            <p className="text-secondary" style={{ fontSize: "0.8rem", marginTop: "4px" }}>
              Can be relative to config directory or an absolute path.
            </p>
          </div>

          <div className="form-group" style={{ marginTop: "24px" }}>
            <div className="flex justify-between align-center">
              <div>
                <span style={{ fontWeight: 600 }}>Playlists Defined:</span> {config.playlists.length}
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
