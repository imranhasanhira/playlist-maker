import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MainConfig } from "../App";
import { AudioTrack } from "../components/AudioPlayer";
import { ResolvedTracksPanel, TrackPreview } from "../components/ResolvedTracksPanel";

export type { TrackPreview };

type PlaylistViewProps = {
  configPath: string;
  config: MainConfig | null;
  setConfig: (config: MainConfig | null) => void;
  formats: string;
  onPlayTrack: (track: AudioTrack, queue: AudioTrack[], playlistName: string) => void;
  onPlayQueue?: (queue: AudioTrack[], playlistName: string, shuffle?: boolean) => void;
  relativeToConfig: boolean;
};

export const PlaylistView: React.FC<PlaylistViewProps> = ({
  configPath,
  config,
  setConfig,
  formats,
  onPlayTrack,
  onPlayQueue,
  relativeToConfig,
}) => {
  const [selectedPlaylistIndex, setSelectedPlaylistIndex] = useState<number | null>(null);
  const [previews, setPreviews] = useState<TrackPreview[]>([]);
  const [previewError, setPreviewError] = useState<string>("");
  const [isLoadingPreview, setIsLoadingPreview] = useState<boolean>(false);
  const [generationLogs, setGenerationLogs] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [showLogsModal, setShowLogsModal] = useState<boolean>(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState<boolean>(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(240);
  const [configWidth, setConfigWidth] = useState<number>(360);

  // Resizing mouse drag handlers
  const handleSidebarMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const newWidth = startWidth + deltaX;
      if (newWidth > 150 && newWidth < 500) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleConfigMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = configWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const newWidth = startWidth + deltaX;
      if (newWidth > 250 && newWidth < 800) {
        setConfigWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const activePlaylist = config && selectedPlaylistIndex !== null && config.playlists[selectedPlaylistIndex] ? config.playlists[selectedPlaylistIndex] : null;

  useEffect(() => {
    setIsConfirmingDelete(false);
    if (activePlaylist && selectedPlaylistIndex !== null) {
      loadPreview();
    } else {
      setPreviews([]);
    }
  }, [selectedPlaylistIndex, config]);

  const formatPathTail = (pathStr: string) => {
    if (!pathStr) return "";
    const normalized = pathStr.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length <= 3) return pathStr;
    return "…/" + parts.slice(-3).join('/');
  };

  const loadPreview = async () => {
    if (!configPath || activePlaylist === null) return;
    setIsLoadingPreview(true);
    setPreviewError("");
    try {
      const result = await invoke<TrackPreview[]>("preview_playlist_tracks", {
        configPath,
        sourceDirOverride: null,
        playlistIndex: selectedPlaylistIndex,
        formats,
      });
      setPreviews(result);
    } catch (e) {
      setPreviews([]);
      setPreviewError(String(e));
    } finally {
      setIsLoadingPreview(false);
    }
  };

  const handleAddPlaylist = () => {
    if (!config) return;
    const newPlaylists = [...config.playlists];
    newPlaylists.push({
      name: "New Playlist",
      sources: ["."],
      exclusions: [],
    });
    setConfig({
      ...config,
      playlists: newPlaylists,
    });
    setSelectedPlaylistIndex(newPlaylists.length - 1);
  };

  const handleDeletePlaylist = () => {
    if (!config || activePlaylist === null || selectedPlaylistIndex === null) return;
    if (!isConfirmingDelete) {
      setIsConfirmingDelete(true);
      return;
    }

    const newPlaylists = config.playlists.filter((_, idx) => idx !== selectedPlaylistIndex);
    setConfig({
      ...config,
      playlists: newPlaylists,
    });
    setSelectedPlaylistIndex(null);
    setIsConfirmingDelete(false);
  };

  const handleUpdateName = (name: string) => {
    if (!config || activePlaylist === null || selectedPlaylistIndex === null) return;
    const newPlaylists = [...config.playlists];
    newPlaylists[selectedPlaylistIndex].name = name;
    setConfig({
      ...config,
      playlists: newPlaylists,
    });
  };

  const selectAndAddSource = async () => {
    if (!config || activePlaylist === null || selectedPlaylistIndex === null) return;
    try {
      const selected = await invoke<string | null>("select_directory", {
        title: "Add Source Folder",
      });
      if (selected) {
        const newPlaylists = [...config.playlists];
        const newSources = [...newPlaylists[selectedPlaylistIndex].sources];
        newSources.push(selected);
        newPlaylists[selectedPlaylistIndex].sources = newSources;
        setConfig({
          ...config,
          playlists: newPlaylists,
        });
      }
    } catch (e) {
      alert("Error picking folder: " + e);
    }
  };

  const removeSource = (srcIdx: number) => {
    if (!config || activePlaylist === null || selectedPlaylistIndex === null) return;
    const newPlaylists = [...config.playlists];
    const newSources = newPlaylists[selectedPlaylistIndex].sources.filter((_, idx) => idx !== srcIdx);
    newPlaylists[selectedPlaylistIndex].sources = newSources;
    setConfig({
      ...config,
      playlists: newPlaylists,
    });
  };

  const selectAndAddExclusion = async () => {
    if (!config || activePlaylist === null || selectedPlaylistIndex === null) return;
    try {
      const selected = await invoke<string | null>("select_directory", {
        title: "Add Exclusion Folder",
      });
      if (selected) {
        const newPlaylists = [...config.playlists];
        const currentExclusions = newPlaylists[selectedPlaylistIndex].exclusions || [];
        const newExclusions = [...currentExclusions, selected];
        newPlaylists[selectedPlaylistIndex].exclusions = newExclusions;
        setConfig({
          ...config,
          playlists: newPlaylists,
        });
      }
    } catch (e) {
      alert("Error picking folder: " + e);
    }
  };

  const removeExclusion = (exIdx: number) => {
    if (!config || activePlaylist === null || selectedPlaylistIndex === null) return;
    const newPlaylists = [...config.playlists];
    const currentExclusions = newPlaylists[selectedPlaylistIndex].exclusions || [];
    const newExclusions = currentExclusions.filter((_, idx) => idx !== exIdx);
    newPlaylists[selectedPlaylistIndex].exclusions = newExclusions;
    setConfig({
      ...config,
      playlists: newPlaylists,
    });
  };

  const handleGeneratePlaylists = async () => {
    if (!configPath) return;
    setIsGenerating(true);
    setShowLogsModal(true);
    setGenerationLogs(["Starting playlist compilation..."]);
    try {
      const logs = await invoke<string[]>("generate_all_playlists", {
        configPath,
        sourceDirOverride: null,
        targetDirOverride: null,
        relativeToConfig,
        formats,
      });
      setGenerationLogs(logs);
    } catch (e) {
      setGenerationLogs((prev) => [...prev, `ERROR: ${e}`]);
    } finally {
      setIsGenerating(false);
    }
  };

  if (!config) {
    return (
      <div className="view-container">
        <h1>Playlist Builder</h1>
        <p className="no-data">Please load a workspace configuration file in the Workspaces tab.</p>
      </div>
    );
  }

  return (
    <div className="view-container" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div className="flex justify-between align-center" style={{ marginBottom: "4px" }}>
        <div>
          <h1 style={{ fontSize: "1.4rem", margin: 0 }}>Playlist Builder</h1>
          <p className="subtitle" style={{ margin: 0, fontSize: "0.82rem" }}>Visually build, customize, and preview your playlist directories.</p>
        </div>
        <button
          className="btn btn-primary"
          onClick={handleGeneratePlaylists}
          disabled={isGenerating}
          style={{ padding: "8px 16px", fontSize: "0.85rem" }}
        >
          {isGenerating ? "Compiling..." : "⚡ Generate Playlists (.m3u)"}
        </button>
      </div>

      <div style={{ display: "flex", gap: "0", flex: 1, minHeight: 0 }}>
        {/* Playlist selection sidebar */}
        <div className="card" style={{ width: `${sidebarWidth}px`, flexShrink: 0, margin: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div className="card-title" style={{ fontSize: "1rem", borderBottom: "1px solid var(--border-color)", paddingBottom: "12px" }}>
            Playlists
          </div>
          <div style={{ flex: 1, overflowY: "auto", margin: "12px 0", paddingRight: "4px" }}>
            <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: "4px" }}>
              {config.playlists.map((pl, idx) => (
                <li
                  key={idx}
                  onClick={() => setSelectedPlaylistIndex(idx)}
                  style={{
                    padding: "8px 12px",
                    borderRadius: "6px",
                    cursor: "pointer",
                    backgroundColor: selectedPlaylistIndex === idx ? "var(--bg-tertiary)" : "transparent",
                    borderLeft: selectedPlaylistIndex === idx ? "3px solid var(--accent-purple)" : "none",
                    fontWeight: selectedPlaylistIndex === idx ? 600 : 400,
                  }}
                >
                  {pl.name}
                </li>
              ))}
            </ul>
          </div>
          <button 
            className="btn btn-secondary" 
            onClick={handleAddPlaylist} 
            style={{ 
              width: "100%", 
              marginTop: "auto", 
              flexShrink: 0,
              padding: "10px 12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px"
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: "inline-block" }}>
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            Add Playlist
          </button>
        </div>

        {/* Resizable separator handle 1 */}
        <div
          onMouseDown={handleSidebarMouseDown}
          style={{
            width: "12px",
            cursor: "col-resize",
            backgroundColor: "transparent",
            alignSelf: "stretch",
            position: "relative",
            zIndex: 10,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          }}
          className="resizable-separator"
          title="Drag to resize sidebar"
        >
          <div style={{
            width: "2px",
            height: "40px",
            borderRadius: "1px",
            backgroundColor: "var(--border-color)",
            transition: "background-color 0.2s"
          }} className="resizable-indicator" />
        </div>

        {/* Playlist properties and preview */}
        <div style={{ flex: 1, display: "flex", flexDirection: "row", gap: "0", minWidth: 0, alignItems: "stretch" }}>
          {activePlaylist ? (
            <>
              {/* Properties card */}
              <div className="card" style={{ width: `${configWidth}px`, flexShrink: 0, margin: 0, display: "flex", flexDirection: "column", overflowY: "auto" }}>
                <div className="card-title">
                  <span>Playlist Configuration</span>
                  <button 
                    className="btn btn-danger" 
                    onClick={handleDeletePlaylist} 
                    onMouseLeave={() => setIsConfirmingDelete(false)}
                    style={{ padding: "6px 12px", fontSize: "0.85rem" }}
                  >
                    {isConfirmingDelete ? "⚠️ Confirm Delete?" : "Delete Playlist"}
                  </button>
                </div>

                <div className="form-group">
                  <label className="form-label">Playlist Name</label>
                  <input
                    type="text"
                    value={activePlaylist.name}
                    onChange={(e) => handleUpdateName(e.target.value)}
                  />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label" style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Sources</span>
                      <span className="text-success" style={{ cursor: "pointer" }} onClick={selectAndAddSource}>
                        + Add Folder
                      </span>
                    </label>
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                       {activePlaylist.sources.map((src, srcIdx) => (
                         <div className="form-row" key={srcIdx}>
                           <input 
                             type="text" 
                             readOnly 
                             value={formatPathTail(src)} 
                             title={src} 
                             style={{ fontSize: "0.82rem", direction: "rtl", textAlign: "left" }} 
                           />
                           <button 
                             className="btn btn-secondary" 
                             onClick={() => removeSource(srcIdx)} 
                             style={{ padding: "8px", display: "flex", alignItems: "center", justifyContent: "center" }}
                             title="Remove Source Folder"
                           >
                             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                               <polyline points="3 6 5 6 21 6"></polyline>
                               <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                             </svg>
                           </button>
                         </div>
                       ))}
                      {activePlaylist.sources.length === 0 && (
                        <p className="no-data" style={{ padding: "8px" }}>No source paths. Add one above.</p>
                      )}
                    </div>
                  </div>

                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label" style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Exclusions</span>
                      <span className="text-warning" style={{ cursor: "pointer" }} onClick={selectAndAddExclusion}>
                        + Add Folder
                      </span>
                    </label>
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                       {(activePlaylist.exclusions || []).map((ex, exIdx) => (
                         <div className="form-row" key={exIdx}>
                           <input 
                             type="text" 
                             readOnly 
                             value={formatPathTail(ex)} 
                             title={ex} 
                             style={{ fontSize: "0.82rem", direction: "rtl", textAlign: "left" }} 
                           />
                           <button 
                             className="btn btn-secondary" 
                             onClick={() => removeExclusion(exIdx)} 
                             style={{ padding: "8px", display: "flex", alignItems: "center", justifyContent: "center" }}
                             title="Remove Exclusion Folder"
                           >
                             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                               <polyline points="3 6 5 6 21 6"></polyline>
                               <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                             </svg>
                           </button>
                         </div>
                       ))}
                      {(activePlaylist.exclusions || []).length === 0 && (
                        <p className="no-data" style={{ padding: "8px" }}>No exclusions defined.</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Resizable separator handle 2 */}
              <div
                onMouseDown={handleConfigMouseDown}
                style={{
                  width: "12px",
                  cursor: "col-resize",
                  backgroundColor: "transparent",
                  alignSelf: "stretch",
                  position: "relative",
                  zIndex: 10,
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                }}
                className="resizable-separator"
                title="Drag to resize configuration panel"
              >
                <div style={{
                  width: "2px",
                  height: "40px",
                  borderRadius: "1px",
                  backgroundColor: "var(--border-color)",
                  transition: "background-color 0.2s"
                }} className="resizable-indicator" />
              </div>

              {/* Preview card */}
              <ResolvedTracksPanel
                previews={previews}
                isLoadingPreview={isLoadingPreview}
                previewError={previewError}
                loadPreview={loadPreview}
                onPlayTrack={(track, queue, name) => onPlayTrack && onPlayTrack(track, queue, name)}
                onPlayAll={() => {
                  if (onPlayQueue && previews.length > 0) {
                    const audioTracks: AudioTrack[] = previews.map((t) => ({
                      file_path: t.file_path,
                      title: t.title,
                      artist: t.artist,
                      duration: t.duration,
                    }));
                    const playlistName = activePlaylist ? activePlaylist.name : "Playlist";
                    onPlayQueue(audioTracks, playlistName, false);
                  }
                }}
                emptyMessage="Select a playlist from the sidebar to preview resolved tracks."
                contextName={activePlaylist ? activePlaylist.name : "Playlist"}
                title={activePlaylist ? `Resolved Tracks (${previews.length})` : "Resolved Tracks"}
              />
            </>
          ) : (
            <div className="card" style={{ flex: 1, margin: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <p className="no-data">Select a playlist from the sidebar or click "+ Add Playlist" to configure rules and preview tracks.</p>
            </div>
          )}
        </div>
      </div>

      {/* Compilation logs modal */}
      {showLogsModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(0, 0, 0, 0.75)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000
        }}>
          <div className="card" style={{ width: "650px", maxHeight: "80%", display: "flex", flexDirection: "column", margin: 0, padding: "24px" }}>
            <div className="card-title" style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "12px" }}>
              <span>Playlist Compiler Logs</span>
              <button
                className="btn btn-secondary"
                onClick={() => setShowLogsModal(false)}
                disabled={isGenerating}
                style={{ padding: "6px 12px", fontSize: "0.85rem" }}
              >
                Close Logs
              </button>
            </div>
            <div className="console-log" style={{ flex: 1, minHeight: "300px", maxHeight: "400px", overflowY: "auto", marginTop: "16px" }}>
              {generationLogs.join("\n")}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
