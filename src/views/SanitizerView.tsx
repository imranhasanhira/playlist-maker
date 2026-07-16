import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type SanitizerViewProps = {
  formats: string;
  stripPhrases: string[];
  setStripPhrases: (phrases: string[]) => void;
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

export const SanitizerView: React.FC<SanitizerViewProps> = ({
  formats,
  stripPhrases,
  setStripPhrases,
}) => {
  const [scanFolder, setScanFolder] = useState<string>("");
  const [sanitizeItems, setSanitizeItems] = useState<SanitizeItem[]>([]);
  const [selectedRenamePaths, setSelectedRenamePaths] = useState<Set<string>>(new Set());
  const [hiddenItems, setHiddenItems] = useState<HiddenFileItem[]>([]);
  const [selectedDeletePaths, setSelectedDeletePaths] = useState<Set<string>>(new Set());
  
  // Custom phrase state
  const [newPhrase, setNewPhrase] = useState<string>("");
  const [uncheckedPhrases, setUncheckedPhrases] = useState<Set<string>>(new Set());

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
      // Filter out unchecked phrases
      const activePhrases = stripPhrases.filter((p) => !uncheckedPhrases.has(p));

      const renameResult = await invoke<SanitizeItem[]>("scan_sanitizer", {
        folder,
        formats: formatsList,
        stripPhrases: activePhrases,
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
    
    // Explicit confirmation
    const confirmed = confirm(
      `Are you absolutely sure you want to sanitize/rename these ${itemsToRename.length} files?\nThis will rename files on your local disk.`
    );
    if (!confirmed) return;

    setIsRenaming(true);
    try {
      await invoke("execute_sanitizer", { items: itemsToRename });
      alert(`Successfully sanitized ${itemsToRename.length} files!`);
      handleScan(scanFolder);
    } catch (e) {
      alert("Error executing sanitization: " + e);
    } finally {
      setIsRenaming(false);
    }
  };

  const executeDelete = async () => {
    if (selectedDeletePaths.size === 0) return;
    
    // Explicit confirmation
    const confirmed = confirm(
      `WARNING: You are about to permanently delete ${selectedDeletePaths.size} hidden files!\nThis operation is irreversible. Do you want to proceed?`
    );
    if (!confirmed) return;

    setIsDeleting(true);
    try {
      await invoke("delete_hidden", { filePaths: Array.from(selectedDeletePaths) });
      alert(`Successfully deleted ${selectedDeletePaths.size} hidden files!`);
      handleScan(scanFolder);
    } catch (e) {
      alert("Error deleting hidden files: " + e);
    } finally {
      setIsDeleting(false);
    }
  };

  const togglePhrase = (phrase: string) => {
    const next = new Set(uncheckedPhrases);
    if (next.has(phrase)) {
      next.delete(phrase);
    } else {
      next.add(phrase);
    }
    setUncheckedPhrases(next);
  };

  const addCustomPhrase = () => {
    const phrase = newPhrase.trim();
    if (!phrase) return;
    if (stripPhrases.includes(phrase)) {
      alert("Phrase is already in the list!");
      return;
    }
    setStripPhrases([...stripPhrases, phrase]);
    setNewPhrase("");
  };

  const removeCustomPhrase = (phrase: string) => {
    setStripPhrases(stripPhrases.filter((p) => p !== phrase));
    const next = new Set(uncheckedPhrases);
    next.delete(phrase);
    setUncheckedPhrases(next);
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
      <h1>Sanitizer & Cleaner</h1>
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

      {/* Customizable Strip rules checklist */}
      <div className="card">
        <div className="card-title">Editable Sanitization Rules</div>
        <p className="text-secondary" style={{ fontSize: "0.85rem", marginBottom: "12px" }}>
          Check or uncheck which words/phrases should be stripped from filenames, or add your own custom words to strip.
        </p>

        {/* Custom Input */}
        <div className="form-row" style={{ marginBottom: "16px", maxWidth: "450px" }}>
          <input
            type="text"
            value={newPhrase}
            onChange={(e) => setNewPhrase(e.target.value)}
            placeholder="Add new word or phrase to strip..."
          />
          <button className="btn btn-secondary" onClick={addCustomPhrase}>
            + Add Word
          </button>
        </div>

        {/* Phrases wrap container */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "8px",
            maxHeight: "150px",
            overflowY: "auto",
            border: "1px solid var(--border-color)",
            borderRadius: "8px",
            padding: "12px",
            backgroundColor: "var(--bg-tertiary)",
          }}
        >
          {stripPhrases.map((phrase) => {
            const isChecked = !uncheckedPhrases.has(phrase);
            return (
              <div
                key={phrase}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "4px 8px",
                  borderRadius: "6px",
                  backgroundColor: "var(--bg-surface)",
                  border: "1px solid var(--border-color)",
                  fontSize: "0.8rem",
                  cursor: "pointer",
                }}
                onClick={() => togglePhrase(phrase)}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => {}} // handled by click on parent div
                  style={{ cursor: "pointer", width: "auto" }}
                />
                <span style={{ color: isChecked ? "var(--text-primary)" : "var(--text-muted)" }}>
                  {phrase}
                </span>
                <span
                  style={{ marginLeft: "4px", color: "var(--danger)", fontWeight: 700 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeCustomPhrase(phrase);
                  }}
                  title="Remove from rules"
                >
                  ×
                </span>
              </div>
            );
          })}
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
                  {isRenaming ? "Renaming..." : `Sanitize Selected (${selectedRenamePaths.size})`}
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
