import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type SanitizerViewProps = {
  formats: string;
};

type SanitizeItem = {
  original_path: string;
  original_name: string;
  sanitized_name: string;
  relative_path: string;
};

type HiddenFileItem = {
  file_path: string;
  file_name: string;
  relative_path: string;
  size_bytes: number;
};

export const SanitizerView: React.FC<SanitizerViewProps> = ({ formats }) => {
  const [scanFolder, setScanFolder] = useState<string>("");
  const [sanitizeItems, setSanitizeItems] = useState<SanitizeItem[]>([]);
  const [selectedRenamePaths, setSelectedRenamePaths] = useState<Set<string>>(new Set());
  const [hiddenItems, setHiddenItems] = useState<HiddenFileItem[]>([]);
  const [selectedDeletePaths, setSelectedDeletePaths] = useState<Set<string>>(new Set());
  
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [isRenaming, setIsRenaming] = useState<boolean>(false);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const selectScanFolder = async () => {
    try {
      const selected = await invoke<string | null>("select_directory", {
        title: "Select Directory to Scan",
      });
      if (selected) {
        setScanFolder(selected);
        handleScan(selected);
      }
    } catch (e) {
      alert("Error picking directory: " + e);
    }
  };

  const handleScan = async (folder: string) => {
    if (!folder) return;
    setIsScanning(true);
    try {
      const formatsList = formats.split(",").map((f) => f.trim());
      const renameResult = await invoke<SanitizeItem[]>("scan_sanitizer", {
        folder,
        formats: formatsList,
      });
      setSanitizeItems(renameResult);
      // Select all renames by default
      setSelectedRenamePaths(new Set(renameResult.map((i) => i.original_path)));

      const hiddenResult = await invoke<HiddenFileItem[]>("scan_hidden", {
        folder,
      });
      setHiddenItems(hiddenResult);
      // Select all hidden files by default
      setSelectedDeletePaths(new Set(hiddenResult.map((i) => i.file_path)));
    } catch (e) {
      alert("Error scanning folder: " + e);
    } finally {
      setIsScanning(false);
    }
  };

  const handleToggleRenameSelect = (path: string) => {
    const next = new Set(selectedRenamePaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    setSelectedRenamePaths(next);
  };

  const handleToggleAllRename = () => {
    if (selectedRenamePaths.size === sanitizeItems.length) {
      setSelectedRenamePaths(new Set());
    } else {
      setSelectedRenamePaths(new Set(sanitizeItems.map((i) => i.original_path)));
    }
  };

  const handleToggleDeleteSelect = (path: string) => {
    const next = new Set(selectedDeletePaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    setSelectedDeletePaths(next);
  };

  const handleToggleAllDelete = () => {
    if (selectedDeletePaths.size === hiddenItems.length) {
      setSelectedDeletePaths(new Set());
    } else {
      setSelectedDeletePaths(new Set(hiddenItems.map((i) => i.file_path)));
    }
  };

  const executeRename = async () => {
    if (selectedRenamePaths.size === 0) return;
    const itemsToRename = sanitizeItems.filter((i) => selectedRenamePaths.has(i.original_path));
    
    setIsRenaming(true);
    try {
      await invoke("execute_sanitizer", { items: itemsToRename });
      alert(`Successfully sanitized ${itemsToRename.length} files!`);
      // Re-scan
      handleScan(scanFolder);
    } catch (e) {
      alert("Error executing sanitization: " + e);
    } finally {
      setIsRenaming(false);
    }
  };

  const executeDelete = async () => {
    if (selectedDeletePaths.size === 0) return;
    if (!confirm(`Are you sure you want to delete ${selectedDeletePaths.size} hidden files? This action is permanent.`)) return;

    setIsDeleting(true);
    try {
      await invoke("delete_hidden", { filePaths: Array.from(selectedDeletePaths) });
      alert(`Successfully deleted ${selectedDeletePaths.size} hidden files!`);
      // Re-scan
      handleScan(scanFolder);
    } catch (e) {
      alert("Error deleting hidden files: " + e);
    } finally {
      setIsDeleting(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  return (
    <div className="view-container">
      <h1>File Name Sanitizer & Cleaner</h1>
      <p className="subtitle">Scan directories to strip web names, unwanted text, and clean up hidden files.</p>

      {/* Target directory selector */}
      <div className="card">
        <div className="card-title">Select Directory to Sanitize</div>
        <div className="form-group">
          <div className="form-row">
            <input
              type="text"
              readOnly
              value={scanFolder}
              placeholder="Select folder to analyze..."
            />
            <button className="btn btn-secondary" onClick={selectScanFolder}>
              Choose Folder
            </button>
            <button
              className="btn btn-primary"
              disabled={!scanFolder || isScanning}
              onClick={() => handleScan(scanFolder)}
            >
              {isScanning ? "Scanning..." : "🔍 Scan Folder"}
            </button>
          </div>
        </div>
      </div>

      {scanFolder && !isScanning && (
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          {/* Side-by-side rename comparison checklist */}
          <div className="card">
            <div className="card-title">
              <span>Sanitize File Names Comparison ({sanitizeItems.length} items found)</span>
              {sanitizeItems.length > 0 && (
                <button
                  className="btn btn-primary"
                  onClick={executeRename}
                  disabled={selectedRenamePaths.size === 0 || isRenaming}
                >
                  {isRenaming ? "Renaming..." : `Rename Selected (${selectedRenamePaths.size})`}
                </button>
              )}
            </div>

            {sanitizeItems.length > 0 ? (
              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: "40px", textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={selectedRenamePaths.size === sanitizeItems.length}
                          onChange={handleToggleAllRename}
                        />
                      </th>
                      <th>Original Filename</th>
                      <th>Proposed Sanitized Filename</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sanitizeItems.map((item, idx) => (
                      <tr key={idx}>
                        <td style={{ textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={selectedRenamePaths.has(item.original_path)}
                            onChange={() => handleToggleRenameSelect(item.original_path)}
                          />
                        </td>
                        <td>
                          <div style={{ color: "var(--danger)" }}>{item.original_name}</div>
                          <div className="text-secondary" style={{ fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
                            {item.relative_path}
                          </div>
                        </td>
                        <td style={{ color: "var(--success)", fontWeight: 600 }}>
                          {item.sanitized_name}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="no-data">All file names are already clean! No changes needed.</p>
            )}
          </div>

          {/* Hidden files cleaner */}
          <div className="card">
            <div className="card-title">
              <span>Delete Hidden Files ({hiddenItems.length} items found)</span>
              {hiddenItems.length > 0 && (
                <button
                  className="btn btn-danger"
                  onClick={executeDelete}
                  disabled={selectedDeletePaths.size === 0 || isDeleting}
                >
                  {isDeleting ? "Deleting..." : `Delete Selected (${selectedDeletePaths.size})`}
                </button>
              )}
            </div>

            {hiddenItems.length > 0 ? (
              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: "40px", textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={selectedDeletePaths.size === hiddenItems.length}
                          onChange={handleToggleAllDelete}
                        />
                      </th>
                      <th>File Path / Location</th>
                      <th>Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hiddenItems.map((item, idx) => (
                      <tr key={idx}>
                        <td style={{ textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={selectedDeletePaths.has(item.file_path)}
                            onChange={() => handleToggleDeleteSelect(item.file_path)}
                          />
                        </td>
                        <td>
                          <div style={{ fontWeight: 600, color: "var(--text-secondary)" }}>{item.file_name}</div>
                          <div className="text-secondary" style={{ fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
                            {item.relative_path}
                          </div>
                        </td>
                        <td style={{ fontFamily: "var(--font-mono)", width: "100px" }}>
                          {formatSize(item.size_bytes)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="no-data">No hidden files found in this directory.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
