import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./components/Sidebar";
import { AudioPlayer, AudioTrack } from "./components/AudioPlayer";
import { WorkspaceView, MainConfig } from "./views/WorkspaceView";
import { PlaylistView } from "./views/PlaylistView";
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

function App() {
  const [currentView, setCurrentView] = useState<string>("workspaces");
  const [configPath, setConfigPath] = useState<string>("");
  const [config, setConfig] = useState<MainConfig | null>(null);
  
  // Settings merged state
  const [formats, setFormats] = useState<string>("mp3,aac,ogg,wma,alac,m4a,wav,flac");
  const [relativeToConfig, setRelativeToConfig] = useState<boolean>(true);
  
  // Sanitizer custom strip phrases
  const [stripPhrases, setStripPhrases] = useState<string[]>(DEFAULT_STRIP_PHRASES);
  
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
            formats={formats}
            setFormats={setFormats}
            relativeToConfig={relativeToConfig}
            setRelativeToConfig={setRelativeToConfig}
          />
        )}

        {currentView === "playlists" && (
          <PlaylistView
            configPath={configPath}
            config={config}
            setConfig={setConfig}
            formats={formats}
            onPlayTrack={handlePlayTrack}
            relativeToConfig={relativeToConfig}
          />
        )}

        {currentView === "tools" && (
          <ToolsView
            formats={formats}
            stripPhrases={stripPhrases}
            setStripPhrases={setStripPhrases}
          />
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
