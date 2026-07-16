import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MainConfig } from "./WorkspaceView";

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
    try {
      const promise = invoke("write_track_tags", {
        filePath: selectedNode.path,
        tags: selectedFileTags,
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
      const promise = invoke("batch_update_folder_tags", {
        folderPath: selectedNode.path,
        formats: formatsList,
        artist: batchArtist || null,
        album: batchAlbum || null,
        genre: batchGenre || null,
        year: yearNum || null,
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

  const handleRemoveCover = () => {
    if (selectedFileTags) {
      setSelectedFileTags({
        ...selectedFileTags,
        cover_b64: null,
        cover_mime: null,
      });
    }
  };

  // Recursive Tree Node Renderer
  const renderTree = (node: DirTreeNode, depth = 0) => {
    const isCollapsed = collapsedPaths.has(node.path);
    const isSelected = selectedNode?.path === node.path;

    return (
      <div key={node.path} style={{ marginLeft: `${depth > 0 ? 12 : 0}px` }}>
        <div
          onClick={() => {
            if (node.is_dir) {
              toggleCollapse(node.path);
            }
            handleSelectNode(node);
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "4px 8px",
            borderRadius: "4px",
            cursor: "pointer",
            backgroundColor: isSelected ? "var(--bg-tertiary)" : "transparent",
            color: isSelected ? "var(--text-primary)" : "var(--text-secondary)",
            fontSize: "0.9rem",
            marginBottom: "2px",
            transition: "all 0.15s",
          }}
        >
          {node.is_dir ? (
            <>
              <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                {isCollapsed ? "▶" : "▼"}
              </span>
              <span>📁</span>
            </>
          ) : (
            <span>🎵</span>
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

  if (!config) {
    return (
      <div className="view-container">
        <h1>Library Management</h1>
        <p className="no-data">Please load a workspace configuration file in the Workspaces tab.</p>
      </div>
    );
  }

  return (
    <div className="view-container" style={{ display: "flex", flexDirection: "column", height: "100%", gap: "20px" }}>
      <div>
        <h1>Library Management</h1>
        <p className="subtitle" style={{ margin: 0 }}>Scan your music directories, view folders, edit tags, cover arts, and apply batch updates.</p>
      </div>

      <div style={{ display: "flex", gap: "24px", flex: 1, minHeight: 0 }}>
        {/* Left Side: Directory Tree */}
        <div className="card" style={{ width: "280px", flexShrink: 0, overflowY: "auto", display: "flex", flexDirection: "column", margin: 0 }}>
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

        {/* Right Side: Editors */}
        <div style={{ flex: 1, overflowY: "auto", minWidth: 0 }}>
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

                <div className="form-group">
                  <label className="form-label">Batch Artist</label>
                  <input
                    type="text"
                    value={batchArtist}
                    onChange={(e) => setBatchArtist(e.target.value)}
                    placeholder="e.g. James, Pink Floyd"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Batch Album</label>
                  <input
                    type="text"
                    value={batchAlbum}
                    onChange={(e) => setBatchAlbum(e.target.value)}
                    placeholder="e.g. Greatest Hits"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Batch Genre</label>
                  <input
                    type="text"
                    value={batchGenre}
                    onChange={(e) => setBatchGenre(e.target.value)}
                    placeholder="e.g. Rock, Folk, Classic"
                  />
                </div>

                <div className="form-group">
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
