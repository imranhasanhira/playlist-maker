import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MainConfig } from "../App";
import { AudioTrack } from "../components/AudioPlayer";
import { ResolvedTracksPanel, TrackPreview } from "../components/ResolvedTracksPanel";

type LibraryViewProps = {
  config: MainConfig | null;
  formats: string;
  addBackgroundTask: (id: string, name: string, taskPromise: Promise<any>) => void;
  onPlayTrack?: (track: AudioTrack, queue: AudioTrack[], playlistName: string) => void;
};

type DirTreeNode = {
  name: string;
  path: string;
  is_dir: boolean;
  children: DirTreeNode[];
};

type TrackTags = {
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  year: number | null;
  track: number | null;
  cover_b64: string | null;
  cover_mime: string | null;
};

export const LibraryView: React.FC<LibraryViewProps> = ({
  config,
  formats,
  addBackgroundTask,
  onPlayTrack,
}) => {
  const [treeRoot, setTreeRoot] = useState<DirTreeNode | null>(null);
  const [isLoadingTree, setIsLoadingTree] = useState<boolean>(false);
  const [treeError, setTreeError] = useState<string>("");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("library_expanded_paths");
      if (saved) {
        return new Set(JSON.parse(saved));
      }
    } catch (e) {}
    return new Set();
  });

  useEffect(() => {
    try {
      localStorage.setItem("library_expanded_paths", JSON.stringify(Array.from(expandedPaths)));
    } catch (e) {}
  }, [expandedPaths]);

  // Resizable panel width state
  const [leftWidth, setLeftWidth] = useState<number>(280);

  // Selected items (supports Cmd / Ctrl multi-selection)
  const [selectedNodes, setSelectedNodes] = useState<Map<string, DirTreeNode>>(new Map());
  const selectedNode = selectedNodes.size === 1 ? Array.from(selectedNodes.values())[0] : null;

  // Single file tags editing
  const [selectedFileTags, setSelectedFileTags] = useState<TrackTags | null>(null);
  const [isReadingTags, setIsReadingTags] = useState<boolean>(false);
  const [isSavingTags, setIsSavingTags] = useState<boolean>(false);

  // Batch folder tags editing
  const [batchArtist, setBatchArtist] = useState<string>("");
  const [batchAlbum, setBatchAlbum] = useState<string>("");
  const [batchGenre, setBatchGenre] = useState<string>("");
  const [batchYear, setBatchYear] = useState<string>("");
  const [batchCoverB64, setBatchCoverB64] = useState<string>("");
  const [batchCoverMime, setBatchCoverMime] = useState<string>("");
  const [isSavingBatch, setIsSavingBatch] = useState<boolean>(false);
  const [showBatchConfirmModal, setShowBatchConfirmModal] = useState<boolean>(false);

  // Resolved tracks for directory preview panel
  const [middleWidth, setMiddleWidth] = useState<number>(380);
  const [dirPreviews, setDirPreviews] = useState<TrackPreview[]>([]);
  const [isLoadingDirPreviews, setIsLoadingDirPreviews] = useState<boolean>(false);
  const [dirPreviewsError, setDirPreviewsError] = useState<string>("");
  const [activeFolderPath, setActiveFolderPath] = useState<string>("");
  useEffect(() => {
    if (config?.sourceDir) {
      loadLibraryTree();
    } else {
      setTreeRoot(null);
      setDirPreviews([]);
      setActiveFolderPath("");
    }
  }, [config?.sourceDir, formats]);

  const loadMultipleFolderPreviews = async (folderPaths: string[], force = false) => {
    if (folderPaths.length === 0) return;
    const compositeKey = folderPaths.slice().sort().join("|");
    if (!force && compositeKey === activeFolderPath && dirPreviews.length > 0) {
      return; // Already loaded active folder(s), skip duplicate disk scan
    }
    setActiveFolderPath(compositeKey);
    setIsLoadingDirPreviews(true);
    setDirPreviewsError("");
    try {
      const formatsList = formats.split(",").map((f) => f.trim());
      const allPreviews: TrackPreview[] = [];
      for (const folder of folderPaths) {
        const previews = await invoke<TrackPreview[]>("preview_directory_tracks", {
          folder,
          formats: formatsList,
        });
        allPreviews.push(...previews);
      }
      // Remove duplicates if any
      const unique = Array.from(new Map(allPreviews.map((t) => [t.file_path, t])).values());
      setDirPreviews(unique);
    } catch (e) {
      setDirPreviewsError(String(e));
      setDirPreviews([]);
    } finally {
      setIsLoadingDirPreviews(false);
    }
  };

  const loadFolderPreviews = async (folderPath: string, force = false) => {
    await loadMultipleFolderPreviews([folderPath], force);
  };

  const loadLibraryTree = async () => {
    if (!config?.sourceDir) return;
    setIsLoadingTree(true);
    setTreeError("");
    try {
      const formatsList = formats.split(",").map((f) => f.trim());
      const scanPromise = invoke<DirTreeNode>("read_dir_tree", {
        taskId: "library_scan",
        folder: config.sourceDir,
        formats: formatsList,
      });

      addBackgroundTask("library_scan", "Library Tree Scan", scanPromise);

      const rootNode = await scanPromise;
      setTreeRoot(rootNode);
      setExpandedPaths((prevExpanded) => {
        if (!prevExpanded || prevExpanded.size === 0) {
          return new Set([rootNode.path]);
        }
        const available = new Set<string>();
        const checkNode = (n: DirTreeNode) => {
          if (prevExpanded.has(n.path)) {
            available.add(n.path);
          }
          if (n.children) {
            for (const child of n.children) {
              checkNode(child);
            }
          }
        };
        checkNode(rootNode);
        available.add(rootNode.path);
        return available;
      });
    } catch (e) {
      setTreeError(String(e));
    } finally {
      setIsLoadingTree(false);
    }
  };

  const toggleCollapse = (path: string) => {
    const next = new Set(expandedPaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    setExpandedPaths(next);
  };

  const handleSelectNode = async (node: DirTreeNode, isMultiSelect = false) => {
    let nextSelected = new Map<string, DirTreeNode>();

    if (isMultiSelect) {
      nextSelected = new Map(selectedNodes);
      if (nextSelected.has(node.path)) {
        if (nextSelected.size > 1) {
          nextSelected.delete(node.path);
        }
      } else {
        nextSelected.set(node.path, node);
      }
    } else {
      nextSelected.set(node.path, node);
    }

    setSelectedNodes(nextSelected);

    setSelectedFileTags(null);
    setBatchArtist("");
    setBatchAlbum("");
    setBatchGenre("");
    setBatchYear("");
    setBatchCoverB64("");
    setBatchCoverMime("");

    const selectedList = Array.from(nextSelected.values());

    if (selectedList.length === 1 && !selectedList[0].is_dir) {
      const fileNode = selectedList[0];
      const lastSlash = Math.max(fileNode.path.lastIndexOf("/"), fileNode.path.lastIndexOf("\\"));
      if (lastSlash > 0) {
        const parentFolder = fileNode.path.substring(0, lastSlash);
        loadFolderPreviews(parentFolder);
      }

      setIsReadingTags(true);
      try {
        const tags = await invoke<TrackTags>("read_track_tags", {
          filePath: fileNode.path,
        });
        setSelectedFileTags(tags);
      } catch (e) {
        alert("Failed to read metadata tags: " + e);
      } finally {
        setIsReadingTags(false);
      }
    } else {
      const targetFolders = new Set<string>();
      for (const n of selectedList) {
        if (n.is_dir) {
          targetFolders.add(n.path);
        } else {
          const lastSlash = Math.max(n.path.lastIndexOf("/"), n.path.lastIndexOf("\\"));
          if (lastSlash > 0) {
            targetFolders.add(n.path.substring(0, lastSlash));
          }
        }
      }

      if (targetFolders.size > 0) {
        loadMultipleFolderPreviews(Array.from(targetFolders));
      }
    }
  };

  const handleSaveTags = async () => {
    if (!selectedNode || !selectedFileTags) return;
    setIsSavingTags(true);

    // Clean up empty strings to null for clean tag removal
    const cleanedTags = {
      ...selectedFileTags,
      title: selectedFileTags.title?.trim() === "" ? null : selectedFileTags.title,
      artist: selectedFileTags.artist?.trim() === "" ? null : selectedFileTags.artist,
      album: selectedFileTags.album?.trim() === "" ? null : selectedFileTags.album,
      genre: selectedFileTags.genre?.trim() === "" ? null : selectedFileTags.genre,
      year: selectedFileTags.year || null,
      track: selectedFileTags.track || null,
    };

    try {
      const promise = invoke("write_track_tags", {
        filePath: selectedNode.path,
        tags: cleanedTags,
      });
      addBackgroundTask(`save_tags_${Date.now()}`, `Write tags to ${selectedNode.name}`, promise);
      await promise;
      alert("Tags updated successfully!");
    } catch (e) {
      alert("Error saving tags: " + e);
    } finally {
      setIsSavingTags(false);
    }
  };

  const handleSaveBatchTags = () => {
    const selectedList = Array.from(selectedNodes.values());
    const hasDirs = selectedList.some((n) => n.is_dir) || selectedList.length > 1;
    if (!hasDirs) return;
    
    const yearNum = batchYear ? parseInt(batchYear) : null;
    if (batchYear && (isNaN(yearNum!) || yearNum! <= 0)) {
      alert("Please enter a valid positive number for Year.");
      return;
    }

    if (!batchArtist && !batchAlbum && !batchGenre && !batchYear && !batchCoverB64) {
      alert("Please specify at least one metadata tag field or cover art action to apply.");
      return;
    }

    setShowBatchConfirmModal(true);
  };

  const executeSaveBatchTags = async () => {
    const selectedList = Array.from(selectedNodes.values());
    const selectedDirs = selectedList.filter((n) => n.is_dir);
    if (selectedDirs.length === 0) return;
    setShowBatchConfirmModal(false);
    setIsSavingBatch(true);
    try {
      const yearNum = batchYear ? parseInt(batchYear) : null;
      const formatsList = formats.split(",").map((f) => f.trim());
      
      const coverParam = batchCoverB64 === "" ? null : batchCoverB64;
      const mimeParam = batchCoverB64 === "REMOVE" || batchCoverB64 === "" ? null : batchCoverMime;

      for (const dirNode of selectedDirs) {
        const promise = invoke("batch_update_folder_tags", {
          folderPath: dirNode.path,
          formats: formatsList,
          artist: batchArtist || null,
          album: batchAlbum || null,
          genre: batchGenre || null,
          year: yearNum || null,
          coverB64: coverParam,
          coverMime: mimeParam,
        });

        addBackgroundTask(
          `batch_tags_${Date.now()}_${dirNode.name}`,
          `Batch tag folder ${dirNode.name}`,
          promise
        );
        await promise;
      }

      alert(`Batch tag updates completed successfully across ${selectedDirs.length} folder(s)!`);
      if (activeFolderPath) {
        const foldersToReload = activeFolderPath.split("|");
        loadMultipleFolderPreviews(foldersToReload, true);
      }
    } catch (e) {
      alert("Error in batch folder updates: " + e);
    } finally {
      setIsSavingBatch(false);
    }
  };

  const handleUploadCover = async () => {
    try {
      const selected = await invoke<string | null>("select_file", {
        title: "Select Cover Image",
        filterName: "Images",
        filterExt: "jpg,jpeg,png",
      });
      if (selected && selectedFileTags) {
        const b64Data = await invoke<string>("read_image_base64", { filePath: selected });
        const mime = selected.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
        setSelectedFileTags({
          ...selectedFileTags,
          cover_b64: b64Data,
          cover_mime: mime,
        });
      }
    } catch (e) {
      alert("Error loading cover: " + e);
    }
  };

  const handleUploadBatchCover = async () => {
    try {
      const selected = await invoke<string | null>("select_file", {
        title: "Select Cover Image",
        filterName: "Images",
        filterExt: "jpg,jpeg,png",
      });
      if (selected) {
        const b64Data = await invoke<string>("read_image_base64", { filePath: selected });
        const mime = selected.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
        setBatchCoverB64(b64Data);
        setBatchCoverMime(mime);
      }
    } catch (e) {
      alert("Error loading cover: " + e);
    }
  };

  const handleRemoveCover = () => {
    if (selectedFileTags) {
      setSelectedFileTags({
        ...selectedFileTags,
        cover_b64: null,
        cover_mime: null,
      });
    }
  };

  // Drag resizer handler
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const newWidth = startWidth + deltaX;
      if (newWidth > 180 && newWidth < 600) {
        setLeftWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleMiddleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = middleWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const newWidth = startWidth + deltaX;
      if (newWidth > 200 && newWidth < 800) {
        setMiddleWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const renderTree = (node: DirTreeNode, depth = 0) => {
    const isExpanded = expandedPaths.has(node.path);
    const isSelected = selectedNodes.has(node.path);
    
    return (
      <div key={node.path} style={{ display: "flex", flexDirection: "column", gap: "2px", userSelect: "none" }}>
        <div
          onClick={(e) => {
            e.stopPropagation();
            handleSelectNode(node, e.metaKey || e.ctrlKey);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (node.is_dir) {
              toggleCollapse(node.path);
            }
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "6px 8px",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "0.9rem",
            backgroundColor: isSelected ? "var(--accent-purple-glow)" : "transparent",
            border: isSelected ? "1px solid var(--accent-purple)" : "1px solid transparent",
            color: isSelected ? "var(--text-primary)" : "var(--text-secondary)",
            marginLeft: `${depth * 4}px`,
          }}
          className="tree-node-item"
          title={node.path}
        >
          {node.is_dir ? (
            <>
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  toggleCollapse(node.path);
                }}
                style={{
                  fontSize: "0.8rem",
                  color: "var(--text-muted)",
                  width: "16px",
                  height: "16px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  borderRadius: "3px",
                }}
                title={isExpanded ? "Collapse Folder" : "Expand Folder"}
                className="tree-arrow"
              >
                {isExpanded ? "▼" : "▶"}
              </span>
              <span>📁</span>
            </>
          ) : (
            <>
              <span style={{ width: "16px" }} />
              <span>🎵</span>
            </>
          )}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {node.name}
          </span>
        </div>
        
        {node.is_dir && isExpanded && node.children.length > 0 && (
          <div style={{ borderLeft: "1px solid var(--border-color)", marginLeft: "14px", paddingLeft: "4px" }}>
            {node.children.map((child) => renderTree(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="view-container" style={{ display: "flex", flexDirection: "column", height: "100%", gap: "20px" }}>
      <div>
        <h1>Library Management</h1>
        <p className="subtitle" style={{ margin: 0 }}>Scan your music directories, view folders, edit tags, cover arts, and apply batch updates.</p>
      </div>

      <div style={{ display: "flex", gap: "0", flex: 1, minHeight: 0 }}>
        {/* Left Side: Directory Tree */}
        <div className="card" style={{ width: `${leftWidth}px`, flexShrink: 0, overflowY: "auto", display: "flex", flexDirection: "column", margin: 0 }}>
          <div className="card-title" style={{ fontSize: "1rem", borderBottom: "1px solid var(--border-color)", paddingBottom: "12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Library Tree</span>
            <button 
              className="btn btn-secondary" 
              onClick={loadLibraryTree} 
              disabled={isLoadingTree} 
              style={{ padding: "6px", width: "28px", height: "28px", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "6px" }}
              title={isLoadingTree ? "Scanning library files..." : "Refresh Library Tree"}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 4v6h-6"></path>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
              </svg>
            </button>
          </div>
          
          <div style={{ flex: 1, marginTop: "12px", overflowX: "hidden" }}>
            {treeError && <p className="no-data text-danger">{treeError}</p>}
            {isLoadingTree ? (
              <p className="no-data">Scanning library files...</p>
            ) : treeRoot ? (
              renderTree(treeRoot)
            ) : (
              <p className="no-data">No source directory scanned. Verify sourceDir mapping.</p>
            )}
          </div>
        </div>

        {/* Resizable separator handle 1 */}
        <div
          onMouseDown={handleMouseDown}
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
          title="Drag to resize tree panel"
        >
          <div style={{
            width: "2px",
            height: "40px",
            borderRadius: "1px",
            backgroundColor: "var(--border-color)",
            transition: "background-color 0.2s"
          }} className="resizable-indicator" />
        </div>

        {/* Middle Side: Resolved Music Tracks */}
        <div style={{ width: `${middleWidth}px`, flexShrink: 0, display: "flex", flexDirection: "column", margin: 0 }}>
          <ResolvedTracksPanel
            previews={dirPreviews}
            isLoadingPreview={isLoadingDirPreviews}
            previewError={dirPreviewsError}
            loadPreview={() => activeFolderPath && loadFolderPreviews(activeFolderPath, true)}
            onPlayTrack={onPlayTrack}
            contextName={activeFolderPath ? activeFolderPath.split(/[/\\]/).pop() || "Library" : "Library"}
            selectedFilePath={selectedNode && !selectedNode.is_dir ? selectedNode.path : null}
            onSelectTrack={(track) => handleSelectNode({ name: track.title, path: track.file_path, is_dir: false, children: [] })}
            emptyMessage="Select a folder or track from the Library Tree to preview resolved music tracks."
            title={activeFolderPath ? `Resolved Tracks (${dirPreviews.length})` : "Resolved Tracks"}
          />
        </div>

        {/* Resizable separator handle 2 */}
        <div
          onMouseDown={handleMiddleMouseDown}
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
          title="Drag to resize tracks panel"
        >
          <div style={{
            width: "2px",
            height: "40px",
            borderRadius: "1px",
            backgroundColor: "var(--border-color)",
            transition: "background-color 0.2s"
          }} className="resizable-indicator" />
        </div>

        {/* Right Side: Editors */}
        <div style={{ flex: 1, overflowY: "auto", minWidth: 0 }}>
          {selectedNodes.size > 0 ? (
            selectedNodes.size > 1 || (selectedNode && selectedNode.is_dir) ? (
              // Batch Folder Tag Editor for single folder or multiple items
              <div className="card" style={{ margin: 0 }}>
                <div className="card-title">
                  <span>Batch Metadata Editor ({selectedNodes.size} selected)</span>
                </div>
                
                <div style={{ marginBottom: "16px" }}>
                  {selectedNode ? (
                    <>
                      <div style={{ fontSize: "1.05rem", fontWeight: 600 }}>📁 {selectedNode.name}</div>
                      <div className="text-secondary" style={{ fontSize: "0.8rem", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
                        {selectedNode.path}
                      </div>
                    </>
                  ) : (
                    <div style={{ fontSize: "1rem", fontWeight: 600, color: "var(--accent-purple)" }}>
                      📁 {selectedNodes.size} Items Selected
                    </div>
                  )}
                </div>

                <p className="text-secondary" style={{ fontSize: "0.85rem", marginBottom: "16px" }}>
                  Apply batch tags to all songs inside this folder recursively. Leave fields empty if you do not want to alter them.
                </p>

                <div style={{ display: "flex", gap: "24px" }}>
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "12px" }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">Batch Artist</label>
                      <input
                        type="text"
                        value={batchArtist}
                        onChange={(e) => setBatchArtist(e.target.value)}
                        placeholder="e.g. James, Pink Floyd"
                      />
                    </div>

                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">Batch Album</label>
                      <input
                        type="text"
                        value={batchAlbum}
                        onChange={(e) => setBatchAlbum(e.target.value)}
                        placeholder="e.g. Greatest Hits"
                      />
                    </div>

                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">Batch Genre</label>
                      <input
                        type="text"
                        value={batchGenre}
                        onChange={(e) => setBatchGenre(e.target.value)}
                        placeholder="e.g. Rock, Folk, Classic"
                      />
                    </div>

                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">Batch Year</label>
                      <input
                        type="text"
                        value={batchYear}
                        onChange={(e) => setBatchYear(e.target.value)}
                        placeholder="e.g. 2026"
                      />
                    </div>

                    <button
                      className="btn btn-primary"
                      onClick={handleSaveBatchTags}
                      disabled={isSavingBatch}
                      style={{ marginTop: "12px", width: "100%" }}
                    >
                      {isSavingBatch ? "Saving Batch Updates..." : "⚡ Apply Batch Tags"}
                    </button>
                  </div>

                  {/* Batch Album Art Cover Panel */}
                  <div style={{ width: "200px", flexShrink: 0, display: "flex", flexDirection: "column", gap: "12px", alignItems: "center" }}>
                    <div className="form-label" style={{ alignSelf: "flex-start" }}>Batch Cover Art</div>
                    {batchCoverB64 === "REMOVE" ? (
                      <div
                        style={{
                          width: "200px",
                          height: "200px",
                          borderRadius: "8px",
                          backgroundColor: "rgba(239, 68, 68, 0.1)",
                          border: "1px dashed var(--danger)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "var(--danger)",
                          fontSize: "0.85rem",
                          fontWeight: 600,
                          textAlign: "center",
                          padding: "16px",
                        }}
                      >
                        ⚠️ Cover art will be REMOVED from all tracks
                      </div>
                    ) : batchCoverB64 ? (
                      <img
                        src={`data:${batchCoverMime};base64,${batchCoverB64}`}
                        alt="Batch Cover Art"
                        style={{
                          width: "200px",
                          height: "200px",
                          borderRadius: "8px",
                          objectFit: "cover",
                          border: "1px solid var(--border-color)",
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: "200px",
                          height: "200px",
                          borderRadius: "8px",
                          backgroundColor: "var(--bg-tertiary)",
                          border: "1px dashed var(--border-color)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "var(--text-secondary)",
                          fontSize: "0.85rem",
                          textAlign: "center",
                          padding: "16px",
                        }}
                      >
                        No change to cover art tags
                      </div>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px", width: "100%" }}>
                      <button type="button" className="btn btn-secondary" onClick={handleUploadBatchCover} style={{ width: "100%", fontSize: "0.8rem", padding: "6px" }}>
                        Upload image
                      </button>
                      <div style={{ display: "flex", gap: "6px", width: "100%" }}>
                        <button type="button" className="btn btn-danger" onClick={() => setBatchCoverB64("REMOVE")} style={{ flex: 1, fontSize: "0.8rem", padding: "6px" }}>
                          Remove
                        </button>
                        {(batchCoverB64 || batchCoverB64 === "REMOVE") && (
                          <button type="button" className="btn btn-secondary" onClick={() => { setBatchCoverB64(""); setBatchCoverMime(""); }} style={{ flex: 1, fontSize: "0.8rem", padding: "6px" }}>
                            Reset
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              // Single Track Tag Editor
              <div className="card" style={{ margin: 0 }}>
                <div className="card-title">
                  <span>Track Metadata Tag Editor</span>
                </div>
                
                <div style={{ marginBottom: "20px" }}>
                  <div style={{ fontSize: "1.05rem", fontWeight: 600 }}>🎵 {selectedNode?.name}</div>
                  <div className="text-secondary" style={{ fontSize: "0.8rem", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
                    {selectedNode?.path}
                  </div>
                </div>

                {isReadingTags ? (
                  <p className="no-data">Reading audio tags...</p>
                ) : selectedFileTags ? (
                  <div style={{ display: "flex", gap: "24px" }}>
                    {/* Tags inputs */}
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "12px" }}>
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label className="form-label">Title</label>
                        <input
                          type="text"
                          value={selectedFileTags.title || ""}
                          onChange={(e) => setSelectedFileTags({ ...selectedFileTags, title: e.target.value })}
                        />
                      </div>

                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label className="form-label">Artist</label>
                        <input
                          type="text"
                          value={selectedFileTags.artist || ""}
                          onChange={(e) => setSelectedFileTags({ ...selectedFileTags, artist: e.target.value })}
                        />
                      </div>

                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label className="form-label">Album</label>
                        <input
                          type="text"
                          value={selectedFileTags.album || ""}
                          onChange={(e) => setSelectedFileTags({ ...selectedFileTags, album: e.target.value })}
                        />
                      </div>

                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label className="form-label">Genre</label>
                        <input
                          type="text"
                          value={selectedFileTags.genre || ""}
                          onChange={(e) => setSelectedFileTags({ ...selectedFileTags, genre: e.target.value })}
                        />
                      </div>

                      <div style={{ display: "flex", gap: "12px" }}>
                        <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                          <label className="form-label">Year</label>
                          <input
                            type="number"
                            value={selectedFileTags.year || ""}
                            onChange={(e) => setSelectedFileTags({ ...selectedFileTags, year: e.target.value ? parseInt(e.target.value) : null })}
                          />
                        </div>

                        <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                          <label className="form-label">Track #</label>
                          <input
                            type="number"
                            value={selectedFileTags.track || ""}
                            onChange={(e) => setSelectedFileTags({ ...selectedFileTags, track: e.target.value ? parseInt(e.target.value) : null })}
                          />
                        </div>
                      </div>

                      <button
                        className="btn btn-primary"
                        onClick={handleSaveTags}
                        disabled={isSavingTags}
                        style={{ marginTop: "16px" }}
                      >
                        {isSavingTags ? "Saving tags..." : "💾 Save Metadata Tags"}
                      </button>
                    </div>

                    {/* Album Art Cover Panel */}
                    <div style={{ width: "200px", flexShrink: 0, display: "flex", flexDirection: "column", gap: "12px", alignItems: "center" }}>
                      <div className="form-label" style={{ alignSelf: "flex-start" }}>Cover Art</div>
                      {selectedFileTags.cover_b64 ? (
                        <img
                          src={`data:${selectedFileTags.cover_mime || "image/jpeg"};base64,${selectedFileTags.cover_b64}`}
                          alt="Cover Art"
                          style={{
                            width: "200px",
                            height: "200px",
                            borderRadius: "8px",
                            objectFit: "cover",
                            border: "1px solid var(--border-color)",
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            width: "200px",
                            height: "200px",
                            borderRadius: "8px",
                            backgroundColor: "var(--bg-tertiary)",
                            border: "1px dashed var(--border-color)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "var(--text-secondary)",
                            fontSize: "0.85rem",
                          }}
                        >
                          No Cover Art
                        </div>
                      )}
                      <div style={{ display: "flex", gap: "8px", width: "100%" }}>
                        <button className="btn btn-secondary" onClick={handleUploadCover} style={{ flex: 1, fontSize: "0.8rem", padding: "6px" }}>
                          Upload image
                        </button>
                        {selectedFileTags.cover_b64 && (
                          <button className="btn btn-danger" onClick={handleRemoveCover} style={{ flex: 1, fontSize: "0.8rem", padding: "6px" }}>
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="no-data">Failed to load audio tags for editing.</p>
                )}
              </div>
            )
          ) : (
            <div className="card" style={{ margin: 0 }}>
              <p className="no-data">Select a folder or track from the Library Tree to inspect and modify tags.</p>
            </div>
          )}
        </div>
      </div>

      {/* Batch update confirmation modal */}
      {showBatchConfirmModal && selectedNode && (
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
          <div className="card" style={{ width: "520px", display: "flex", flexDirection: "column", margin: 0, padding: "20px", gap: "14px" }}>
            <div className="card-title" style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "10px", margin: 0 }}>
              <span style={{ color: "var(--warning)", display: "flex", alignItems: "center", gap: "8px", fontSize: "1.05rem" }}>
                ⚠️ Confirm Batch Tag Update
              </span>
            </div>

            <div style={{ fontSize: "0.88rem" }}>
              <p style={{ marginBottom: "6px" }}>
                Are you sure you want to batch update metadata tags for all matching tracks in folder:
              </p>
              <div style={{ fontWeight: 600, color: "var(--accent-purple)", wordBreak: "break-all", background: "var(--bg-tertiary)", padding: "8px 12px", borderRadius: "6px" }}>
                📁 {selectedNode.name}
              </div>
            </div>

            <div style={{ background: "rgba(234, 179, 8, 0.12)", border: "1px solid var(--warning)", padding: "8px 12px", borderRadius: "6px", fontSize: "0.82rem", color: "var(--text-primary)" }}>
              <strong>Caution:</strong> This action will recursively overwrite specified metadata tags across all audio tracks in this folder.
            </div>

            <div style={{ fontSize: "0.85rem", background: "var(--bg-tertiary)", padding: "12px", borderRadius: "6px" }}>
              <div style={{ fontWeight: 600, marginBottom: "8px", borderBottom: "1px solid var(--border-color)", paddingBottom: "4px" }}>
                Summary of Changes to Apply:
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "6px", fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>
                <span className="text-secondary">Artist:</span>
                <span>{batchArtist ? batchArtist : <em className="text-muted">(Unchanged)</em>}</span>
                
                <span className="text-secondary">Album:</span>
                <span>{batchAlbum ? batchAlbum : <em className="text-muted">(Unchanged)</em>}</span>
                
                <span className="text-secondary">Genre:</span>
                <span>{batchGenre ? batchGenre : <em className="text-muted">(Unchanged)</em>}</span>
                
                <span className="text-secondary">Year:</span>
                <span>{batchYear ? batchYear : <em className="text-muted">(Unchanged)</em>}</span>
                
                <span className="text-secondary">Cover Art:</span>
                <span>
                  {batchCoverB64 === "REMOVE" 
                    ? <span className="text-danger">Remove Existing Cover</span> 
                    : batchCoverB64 
                      ? <span className="text-success">Set New Cover Image</span> 
                      : <em className="text-muted">(Unchanged)</em>}
                </span>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "6px" }}>
              <button
                className="btn btn-secondary"
                onClick={() => setShowBatchConfirmModal(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={executeSaveBatchTags}
                style={{ backgroundColor: "var(--accent-purple)" }}
              >
                ⚡ Yes, Apply Batch Updates
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
