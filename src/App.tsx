import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./components/Sidebar";
import { AudioPlayer, AudioTrack } from "./components/AudioPlayer";
import { WorkspaceView, MainConfig } from "./views/WorkspaceView";
import { PlaylistView } from "./views/PlaylistView";
import { SanitizerView } from "./views/SanitizerView";
import { TranscoderView } from "./views/TranscoderView";
import { SettingsView } from "./views/SettingsView";
import "./App.css";

function App() {
  const [currentView, setCurrentView] = useState<string>("workspaces");
  const [configPath, setConfigPath] = useState<string>("");
  const [config, setConfig] = useState<MainConfig | null>(null);
  const [formats, setFormats] = useState<string>("mp3,aac,ogg,wma,alac,m4a,wav,flac");
  
  // Audio player state
  const [activeTrack, setActiveTrack] = useState<AudioTrack | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  const handleLoadConfig = async (path: string) => {
    try {
      const loadedConfig = await invoke<MainConfig>("load_workspace", {
        configPath: path,
      });
      setConfig(loadedConfig);
    } catch (e) {
      alert("Error loading workspace config: " + e);
    }
  };

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
          />
        )}

        {currentView === "playlists" && (
          <PlaylistView
            configPath={configPath}
            config={config}
            setConfig={setConfig}
            formats={formats}
            onPlayTrack={handlePlayTrack}
          />
        )}

        {currentView === "sanitizer" && (
          <SanitizerView formats={formats} />
        )}

        {currentView === "transcoder" && (
          <TranscoderView />
        )}

        {currentView === "settings" && (
          <SettingsView formats={formats} setFormats={setFormats} />
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
