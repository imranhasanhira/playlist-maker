import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MainConfig } from "../App";

type LibraryViewProps = {
  config: MainConfig | null;
  formats: string;
  addBackgroundTask: (id: string, name: string, taskPromise: Promise<any>) => void;
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
}) => {
  const [treeRoot, setTreeRoot] = useState<DirTreeNode | null>(null);
  const [isLoadingTree, setIsLoadingTree] = useState<boolean>(false);
  const [treeError, setTreeError] = useState<string>("");
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());

  // Resizable panel width state
  const [leftWidth, setLeftWidth] = useState<number>(280);

  // Selected item
  const [selectedNode, setSelectedNode] = useState<DirTreeNode | null>(null);

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

  useEffect(() => {
    if (config?.sourceDir) {
      loadLibraryTree();
    } else {
      setTreeRoot(null);
    }
  }, [config?.sourceDir, formats]);

  const loadLibraryTree = async () => {
    if (!config?.sourceDir) return;
    setIsLoadingTree(true);
    setTreeError("");
    try {
      const formatsList = formats.split(",").map((f) => f.trim());
      const rootNode = await invoke<DirTreeNode>("read_dir_tree", {
        folder: config.sourceDir,
        formats: formatsList,
      });
      setTreeRoot(rootNode);
    } catch (e) {
      setTreeError(String(e));
    } finally {
      setIsLoadingTree(false);
    }
  };

  const toggleCollapse = (path: string) => {
    const next = new Set(collapsedPaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    setCollapsedPaths(next);
  };

  const handleSelectNode = async (node: DirTreeNode) => {
    setSelectedNode(node);
    setSelectedFileTags(null);
    setBatchArtist("");
    setBatchAlbum("");
    setBatchGenre("");
    setBatchYear("");
    setBatchCoverB64("");
    setBatchCoverMime("");

    if (!node.is_dir) {
      setIsReadingTags(true);
      try {
        const tags = await invoke<TrackTags>("read_track_tags", {
          filePath: node.path,
        });
        setSelectedFileTags(tags);
      } catch (e) {
        alert("Failed to read metadata tags: " + e);
      } finally {
        setIsReadingTags(false);
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

  const handleSaveBatchTags = async () => {
    if (!selectedNode || !selectedNode.is_dir) return;
    
    const yearNum = batchYear ? parseInt(batchYear) : null;
    if (batchYear && (isNaN(yearNum!) || yearNum! <= 0)) {
      alert("Please enter a valid positive number for Year.");
      return;
    }

    const confirmed = confirm(
      `Are you sure you want to batch update metadata tags for all matching tracks in folder:\n"${selectedNode.name}"?`
    );
    if (!confirmed) return;

    setIsSavingBatch(true);
    try {
      const formatsList = formats.split(",").map((f) => f.trim());
      
      const coverParam = batchCoverB64 === "" ? null : batchCoverB64;
      const mimeParam = batchCoverB64 === "REMOVE" || batchCoverB64 === "" ? null : batchCoverMime;

      const promise = invoke("batch_update_folder_tags", {
        folderPath: selectedNode.path,
        formats: formatsList,
        artist: batchArtist || null,
        album: batchAlbum || null,
        genre: batchGenre || null,
        year: yearNum || null,
        coverB64: coverParam,
        coverMime: mimeParam,
      });

      addBackgroundTask(
        `batch_tags_${Date.now()}`,
        `Batch tag folder ${selectedNode.name}`,
        promise
      );
      await promise;
      alert("Batch tag updates completed successfully!");
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

  const renderTree = (node: DirTreeNode, depth = 0) => {
    const isCollapsed = collapsedPaths.has(node.path);
    const isSelected = selectedNode?.path === node.path;
    
    return (
      <div key={node.path} style={{ display: "flex", flexDirection: "column", gap: "2px", userSelect: "none" }}>
        <div
          onClick={(e) => {
            e.stopPropagation();
            if (node.is_dir) {
              toggleCollapse(node.path);
            }
            handleSelectNode(node);
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
        >
          {node.is_dir ? (
            <>
              <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", width: "12px" }}>
                {isCollapsed ? "▶" : "▼"}
              </span>
              <span>📁</span>
            </>
          ) : (
            <>
              <span style={{ width: "12px" }} />
              <span>🎵</span>
            </>
          )}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {node.name}
          </span>
        </div>
        
        {node.is_dir && !isCollapsed && node.children.length > 0 && (
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
            <button className="btn btn-secondary" onClick={loadLibraryTree} disabled={isLoadingTree} style={{ padding: "4px 8px", fontSize: "0.75rem" }}>
              {isLoadingTree ? "Scanning..." : "🔄 Refresh"}
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

        {/* Resizable separator handle */}
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

        {/* Right Side: Editors */}
        <div style={{ flex: 1, overflowY: "auto", minWidth: 0, paddingLeft: "8px" }}>
          {selectedNode ? (
            selectedNode.is_dir ? (
              // Batch Folder Tag Editor
              <div className="card" style={{ margin: 0 }}>
                <div className="card-title">
                  <span>Batch Metadata Editor</span>
                </div>
                
                <div style={{ marginBottom: "16px" }}>
                  <div style={{ fontSize: "1.05rem", fontWeight: 600 }}>📁 {selectedNode.name}</div>
                  <div className="text-secondary" style={{ fontSize: "0.8rem", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
                    {selectedNode.path}
                  </div>
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
                  <div style={{ fontSize: "1.05rem", fontWeight: 600 }}>🎵 {selectedNode.name}</div>
                  <div className="text-secondary" style={{ fontSize: "0.8rem", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
                    {selectedNode.path}
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
    </div>
  );
};
