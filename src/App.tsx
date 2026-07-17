import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AudioPlayer, AudioTrack } from "./components/AudioPlayer";
import { LibraryView } from "./views/LibraryView";
import { PlaylistView } from "./views/PlaylistView";
import { ToolsView } from "./views/ToolsView";
import { SettingsView } from "./views/SettingsView";
import "./App.css";

// Re-export MainConfig type for settings/views
export type MainConfig = {
  sourceDir: string | null;
  targetDir: string | null;
  relativeToConfig?: boolean | null;
  playlists: Array<{
    name: string;
    sources: string[];
    exclusions: string[] | null;
  }>;
};

const DEFAULT_STRIP_PHRASES = [
  "music.com.bd", "SVF", "Tseries",
  "Full Video", "Full audio", "Full HD", "Full Song",
  "New Video", "New Song", "New audio",
  "High Quality", "best song", "best Quality", "Best Audio", "best video", "best movie",
  "With Lyrics", "Lyrical",
  "The Movie",
  "Hindi Film", "Super Hindi Album", "Hindi Album",
  "ENGlish subtitle", "bangla subtitle", "Eng subtitle", "Eng Sub",
  "Bengali Film", "Bengla Film", "Bangla Movie", "Eskay Movies",
  "Bangla New Song", "new Bangla song", "new song", "bangla song",
  "Film", "Movie", "Songs", "Song", "Music", "Audio",
  "SUBTITLE", "sub title", "Title", "Lyrics", "Lyric", "Video",
  "Quality", "Original", "Official",
  "DVD", "Blue Ray"
];

type BgTask = {
  id: string;
  name: string;
  progress: number;
  status: "running" | "completed" | "failed";
  text: string;
};

function App() {
  const [currentView, setCurrentView] = useState<string>("library");
  const [configPath, setConfigPath] = useState<string>("");
  const [config, setConfig] = useState<MainConfig | null>(null);
  
  // Settings formats state
  const [formats, setFormats] = useState<string>("mp3,aac,ogg,wma,alac,m4a,wav,flac");
  
  // Sanitizer custom strip phrases
  const [stripPhrases, setStripPhrases] = useState<string[]>(DEFAULT_STRIP_PHRASES);
  
  // Audio player state
  const [activeTrack, setActiveTrack] = useState<AudioTrack | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  // Background Task Queue
  const [bgTasks, setBgTasks] = useState<BgTask[]>([]);

  // Modal / Onboarding Wizard State (when config is null)
  const [wizardMode, setWizardMode] = useState<"load" | "create" | null>(null);
  const [newConfigPath, setNewConfigPath] = useState<string>("");
  const [newRelativeToConfig, setNewRelativeToConfig] = useState<boolean>(true);
  const [newSourceDir, setNewSourceDir] = useState<string>("");
  const [newTargetDir, setNewTargetDir] = useState<string>("");
  const [isCreating, setIsCreating] = useState<boolean>(false);

  const addBackgroundTask = (id: string, name: string, taskPromise: Promise<any>) => {
    setBgTasks(prev => [
      ...prev.filter(t => t.id !== id),
      { id, name, progress: 20, status: "running", text: "Working..." }
    ]);

    taskPromise
      .then(() => {
        setBgTasks(prev => prev.map(t => t.id === id ? { ...t, status: "completed", progress: 100, text: "Completed ✓" } : t));
        setTimeout(() => {
          setBgTasks(prev => prev.filter(t => t.id !== id));
        }, 5000);
      })
      .catch((err) => {
        setBgTasks(prev => prev.map(t => t.id === id ? { ...t, status: "failed", progress: 100, text: `Error: ${err}` } : t));
        setTimeout(() => {
          setBgTasks(prev => prev.filter(t => t.id !== id));
        }, 12000);
      });
  };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    
    const setupListener = async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<any>("task-progress", (event) => {
          const { task_id, task_name, index, total, status, message } = event.payload;
          const progressPercent = Math.round(((index + 1) / total) * 100);
          
          setBgTasks((prev) => {
            const exists = prev.some((t) => t.id === task_id);
            if (exists) {
              return prev.map((t) =>
                t.id === task_id
                  ? {
                      ...t,
                      progress: progressPercent,
                      status: status === "completed" ? "completed" as const : "running" as const,
                      text: status === "completed" ? "Done ✓" : `Item ${index + 1} of ${total} (${progressPercent}%) - ${message || ""}`,
                    }
                  : t
              );
            } else {
              return [
                ...prev,
                {
                  id: task_id,
                  name: task_name || "Background Task",
                  progress: progressPercent,
                  status: "running" as const,
                  text: `Item ${index + 1} of ${total} (${progressPercent}%) - ${message || ""}`,
                },
              ];
            }
          });

          if (status === "completed") {
            setTimeout(() => {
              setBgTasks((prev) => prev.filter((t) => t.id !== task_id));
            }, 6000);
          }
        });
      } catch (e) {
        console.error("Failed to register transcode event listener:", e);
      }
    };

    setupListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const handleLoadConfig = async (path: string): Promise<MainConfig | null> => {
    console.log("handleLoadConfig called with path:", path);
    try {
      const loadedConfig = await invoke<MainConfig>("load_workspace", {
        configPath: path,
      });
      console.log("load_workspace returned config:", loadedConfig);
      setConfig(loadedConfig);
      return loadedConfig;
    } catch (e) {
      console.error("load_workspace failed:", e);
      alert("Error loading workspace config: " + e);
      return null;
    }
  };

  useEffect(() => {
    if (configPath) {
      handleLoadConfig(configPath);
    }
  }, []);

  const handlePlayTrack = (track: AudioTrack) => {
    setActiveTrack(track);
    setIsPlaying(true);
  };

  // Onboarding dialog actions
  const selectConfigFileOnboarding = async () => {
    try {
      const selected = await invoke<string | null>("select_file", {
        title: "Select Workspace Config YAML",
        filterName: "YAML Configurations",
        filterExt: "yaml,yml",
      });
      if (selected) {
        setConfigPath(selected);
        const loaded = await handleLoadConfig(selected);
        if (loaded) {
          if (loaded.sourceDir && loaded.targetDir) {
            setCurrentView("library");
          } else {
            alert("This configuration is missing folder mappings. Taking you to Settings to define them.");
            setCurrentView("settings");
          }
        }
      }
    } catch (e) {
      alert("Error selecting config: " + e);
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
      setCurrentView("playlists");
    } catch (e) {
      alert("Error creating configuration: " + e);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="app-container">
      {/* Top Header Navigation */}
      <header className="top-nav">
        <div className="top-nav-logo">
          <span>🎵</span> PlaylistMaker
        </div>
        <ul className="top-nav-menu">
          <li
            className={`top-nav-item ${config ? "" : "disabled"} ${currentView === "library" ? "active" : ""}`}
            style={config ? {} : { opacity: 0.4, cursor: "not-allowed" }}
            onClick={() => config && setCurrentView("library")}
            title={config ? "Inspect Library" : "Please load a workspace configuration first"}
          >
            📁 Library
          </li>
          <li
            className={`top-nav-item ${config ? "" : "disabled"} ${currentView === "playlists" ? "active" : ""}`}
            style={config ? {} : { opacity: 0.4, cursor: "not-allowed" }}
            onClick={() => config && setCurrentView("playlists")}
            title={config ? "Configure Playlists" : "Please load a workspace configuration first"}
          >
            🎶 Playlists
          </li>
          <li
            className={`top-nav-item ${currentView === "tools" ? "active" : ""}`}
            onClick={() => setCurrentView("tools")}
          >
            🛠 Tools
          </li>
          <li
            className={`top-nav-item ${currentView === "settings" ? "active" : ""}`}
            onClick={() => setCurrentView("settings")}
          >
            ⚙️ Settings
          </li>
        </ul>
      </header>

      {/* Main Content Area */}
      <main className={`main-content ${activeTrack ? "has-player" : ""}`}>
        {currentView === "library" && config && (
          <LibraryView
            config={config}
            formats={formats}
            addBackgroundTask={addBackgroundTask}
          />
        )}

        {currentView === "playlists" && config && (
          <PlaylistView
            configPath={configPath}
            config={config}
            setConfig={setConfig}
            formats={formats}
            onPlayTrack={handlePlayTrack}
            relativeToConfig={config?.relativeToConfig ?? true}
          />
        )}

        {currentView === "tools" && (
          <ToolsView
            formats={formats}
            stripPhrases={stripPhrases}
            setStripPhrases={setStripPhrases}
            addBackgroundTask={addBackgroundTask}
          />
        )}

        {currentView === "settings" && (
          <SettingsView
            configPath={configPath}
            setConfigPath={setConfigPath}
            config={config}
            setConfig={setConfig}
            onLoadConfig={handleLoadConfig}
            formats={formats}
            setFormats={setFormats}
          />
        )}

        {/* Floating Background Task Queue Panel */}
        {bgTasks.length > 0 && (
          <div style={{
            position: "fixed",
            bottom: activeTrack ? "110px" : "24px",
            right: "24px",
            width: "320px",
            backgroundColor: "rgba(22, 22, 33, 0.9)",
            backdropFilter: "blur(8px)",
            border: "1px solid var(--border-color)",
            borderRadius: "12px",
            padding: "16px",
            boxShadow: "0 8px 32px rgba(0, 0, 0, 0.6)",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            zIndex: 999,
          }}>
            <div style={{
              fontSize: "0.8rem",
              fontWeight: 700,
              color: "var(--text-secondary)",
              textTransform: "uppercase",
              letterSpacing: "1.5px",
              borderBottom: "1px solid var(--border-color)",
              paddingBottom: "8px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center"
            }}>
              <span>Background Tasks</span>
              <span style={{ fontSize: "0.75rem", color: "var(--accent-purple)", fontWeight: 600 }}>
                {bgTasks.filter(t => t.status === "running").length} active
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxHeight: "220px", overflowY: "auto" }}>
              {bgTasks.map((task) => (
                <div key={task.id} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", fontWeight: 600 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "220px" }}>
                      {task.name}
                    </span>
                    <span style={{
                      color: task.status === "completed" ? "var(--success)" : task.status === "failed" ? "var(--danger)" : "var(--accent-purple)"
                    }}>
                      {task.status === "running" ? `${task.progress}%` : task.status === "completed" ? "Done ✓" : "Failed ✗"}
                    </span>
                  </div>
                  <div style={{
                    height: "6px",
                    width: "100%",
                    backgroundColor: "var(--bg-tertiary)",
                    borderRadius: "3px",
                    overflow: "hidden"
                  }}>
                    <div style={{
                      height: "100%",
                      width: `${task.progress}%`,
                      backgroundColor: task.status === "completed" ? "var(--success)" : task.status === "failed" ? "var(--danger)" : "var(--accent-purple)",
                      transition: "width 0.4s ease"
                    }} />
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {task.text}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Sticky Audio Player */}
        <AudioPlayer
          activeTrack={activeTrack}
          isPlaying={isPlaying}
          onPlayPause={setIsPlaying}
          onClose={() => {
            setActiveTrack(null);
            setIsPlaying(false);
          }}
        />

        {/* Startup / No Config Onboarding Modal Overlay */}
        {config === null && (
          <div style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            height: "100vh",
            backgroundColor: "rgba(5, 5, 8, 0.88)",
            backdropFilter: "blur(16px)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 1000,
          }}>
            {wizardMode === null ? (
              <div className="card" style={{ maxWidth: "560px", width: "90%", padding: "40px", textAlign: "center", display: "flex", flexDirection: "column", gap: "28px" }}>
                <div>
                  <h1 style={{ fontSize: "2.2rem", marginBottom: "12px", background: "linear-gradient(135deg, var(--accent-indigo) 0%, var(--accent-purple) 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                    Welcome to PlaylistMaker
                  </h1>
                  <p className="subtitle" style={{ fontSize: "1rem" }}>
                    Load an existing workspace configuration or create a new one to begin managing your music library.
                  </p>
                </div>

                <div style={{ display: "flex", gap: "16px" }}>
                  <button
                    className="btn btn-primary"
                    onClick={selectConfigFileOnboarding}
                    style={{ flex: 1, padding: "24px 16px", fontSize: "1.05rem", display: "flex", flexDirection: "column", alignItems: "center", gap: "12px", height: "auto" }}
                  >
                    <span style={{ fontSize: "2rem" }}>📂</span>
                    <span>Load Config File</span>
                  </button>

                  <button
                    className="btn btn-secondary"
                    onClick={() => setWizardMode("create")}
                    style={{ flex: 1, padding: "24px 16px", fontSize: "1.05rem", display: "flex", flexDirection: "column", alignItems: "center", gap: "12px", height: "auto" }}
                  >
                    <span style={{ fontSize: "2rem" }}>✨</span>
                    <span>Create New Config</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="card" style={{ maxWidth: "560px", width: "90%", padding: "32px" }}>
                <div className="card-title" style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "12px", marginBottom: "20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>Create Workspace Config</span>
                  <button className="btn btn-secondary" onClick={() => setWizardMode(null)} style={{ padding: "4px 12px", fontSize: "0.8rem" }}>
                    Back
                  </button>
                </div>

                <form onSubmit={handleCreateNewConfigSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
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
                        Browse...
                      </button>
                    </div>
                  </div>

                  <div className="form-group" style={{ display: "flex", alignItems: "center", gap: "10px", backgroundColor: "var(--bg-tertiary)", padding: "12px", borderRadius: "8px", border: "1px solid var(--border-color)" }}>
                    <input
                      type="checkbox"
                      id="onboarding-relative-toggle"
                      checked={newRelativeToConfig}
                      onChange={(e) => setNewRelativeToConfig(e.target.checked)}
                      style={{ width: "auto", cursor: "pointer" }}
                    />
                    <label htmlFor="onboarding-relative-toggle" style={{ fontWeight: 600, cursor: "pointer", fontSize: "0.9rem", color: "var(--text-primary)" }}>
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

                  <button
                    className="btn btn-primary"
                    type="submit"
                    disabled={isCreating}
                    style={{ padding: "12px", fontSize: "1rem", marginTop: "12px" }}
                  >
                    {isCreating ? "Initializing Workspace..." : "🚀 Create Config & Start"}
                  </button>
                </form>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
