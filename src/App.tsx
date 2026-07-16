import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./components/Sidebar";
import { AudioPlayer, AudioTrack } from "./components/AudioPlayer";
import { WorkspaceView, MainConfig } from "./views/WorkspaceView";
import { PlaylistView } from "./views/PlaylistView";
import { LibraryView } from "./views/LibraryView";
import { ToolsView } from "./views/ToolsView";
import "./App.css";

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
  const [currentView, setCurrentView] = useState<string>("workspaces");
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

  const addBackgroundTask = (id: string, name: string, taskPromise: Promise<any>) => {
    // Add task
    setBgTasks(prev => [
      ...prev.filter(t => t.id !== id), // Avoid duplicate ids
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

  // Setup global event listener for background transcoding progress
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    
    const setupListener = async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<any>("transcode-progress", (event) => {
          const { index, total, status, message } = event.payload;
          const progressPercent = Math.round(((index + 1) / total) * 100);
          
          setBgTasks((prev) => {
            const exists = prev.some((t) => t.id === "flac_transcode");
            if (exists) {
              return prev.map((t) =>
                t.id === "flac_transcode"
                  ? {
                      ...t,
                      progress: progressPercent,
                      status: status === "completed" ? "completed" as const : "running" as const,
                      text: status === "completed" ? "Done" : `File ${index + 1}/${total}: ${message || ""}`,
                    }
                  : t
              );
            } else {
              return [
                ...prev,
                {
                  id: "flac_transcode",
                  name: "FLAC Transcoding",
                  progress: progressPercent,
                  status: "running" as const,
                  text: `File ${index + 1}/${total}: ${message || ""}`,
                },
              ];
            }
          });

          if (status === "completed") {
            setTimeout(() => {
              setBgTasks((prev) => prev.filter((t) => t.id !== "flac_transcode"));
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

  const handleLoadConfig = async (path: string) => {
    console.log("handleLoadConfig called with path:", path);
    try {
      const loadedConfig = await invoke<MainConfig>("load_workspace", {
        configPath: path,
      });
      console.log("load_workspace returned config:", loadedConfig);
      setConfig(loadedConfig);
    } catch (e) {
      console.error("load_workspace failed:", e);
      alert("Error loading workspace config: " + e);
    }
  };

  // Try to load configuration at start if a default path is present
  useEffect(() => {
    if (configPath) {
      handleLoadConfig(configPath);
    }
  }, []);

  const handlePlayTrack = (track: AudioTrack) => {
    setActiveTrack(track);
    setIsPlaying(true);
  };

  return (
    <div className="app-container">
      {/* Navigation Sidebar */}
      <Sidebar
        currentView={currentView}
        onViewChange={setCurrentView}
        hasConfig={config !== null}
      />

      {/* Main Content Area */}
      <main className="main-content">
        {currentView === "workspaces" && (
          <WorkspaceView
            configPath={configPath}
            setConfigPath={setConfigPath}
            config={config}
            setConfig={setConfig}
            onLoadConfig={handleLoadConfig}
            formats={formats}
            setFormats={setFormats}
          />
        )}

        {currentView === "library" && (
          <LibraryView
            config={config}
            formats={formats}
            addBackgroundTask={addBackgroundTask}
          />
        )}

        {currentView === "playlists" && (
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
        />
      </main>
    </div>
  );
}

export default App;
