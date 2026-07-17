import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type SanitizerViewProps = {
  formats: string;
  stripPhrases: string[];
  setStripPhrases: (phrases: string[]) => void;
  addBackgroundTask: (id: string, name: string, taskPromise: Promise<any>) => void;
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

type MetadataSanitizeItem = {
  file_path: string;
  field_name: string;
  original_value: string;
  sanitized_value: string;
};

export const SanitizerView: React.FC<SanitizerViewProps> = ({
  formats,
  stripPhrases,
  setStripPhrases,
  addBackgroundTask,
}) => {
  const [scanFolder, setScanFolder] = useState<string>("");
  const [sanitizeItems, setSanitizeItems] = useState<SanitizeItem[]>([]);
  const [selectedRenamePaths, setSelectedRenamePaths] = useState<Set<string>>(new Set());
  const [hiddenItems, setHiddenItems] = useState<HiddenFileItem[]>([]);
  const [selectedDeletePaths, setSelectedDeletePaths] = useState<Set<string>>(new Set());

  // Metadata tags sanitization state
  const [metadataItems, setMetadataItems] = useState<MetadataSanitizeItem[]>([]);
  const [selectedMetadataIndices, setSelectedMetadataIndices] = useState<Set<number>>(new Set());
  const [isCleaningMetadata, setIsCleaningMetadata] = useState<boolean>(false);

  // Cleaner Tab state
  const [sanitizerSubTab, setSanitizerSubTab] = useState<"files" | "metadata" | "hidden">("files");
  
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
      const activePhrases = stripPhrases.filter((p) => !uncheckedPhrases.has(p));

      // 1. Scan Filenames
      const renamePromise = invoke<SanitizeItem[]>("scan_sanitizer", {
        taskId: "filename_scan",
        folder,
        formats: formatsList,
        stripPhrases: activePhrases,
      });
      addBackgroundTask("filename_scan", "Filename Sanitizer Scan", renamePromise);

      // 2. Scan Hidden Files
      const hiddenPromise = invoke<HiddenFileItem[]>("scan_hidden", {
        taskId: "hidden_scan",
        folder,
      });
      addBackgroundTask("hidden_scan", "Hidden Files Scan", hiddenPromise);

      // 3. Scan Metadata Tags
      const metadataPromise = invoke<MetadataSanitizeItem[]>("scan_metadata_sanitizer", {
        taskId: "metadata_scan",
        folder,
        formats: formatsList,
        stripPhrases: activePhrases,
      });
      addBackgroundTask("metadata_scan", "Metadata Sanitizer Scan", metadataPromise);

      // Wait for all to complete in parallel
      const [renameResult, hiddenResult, metadataResult] = await Promise.all([
        renamePromise,
        hiddenPromise,
        metadataPromise,
      ]);

      setSanitizeItems(renameResult);
      setSelectedRenamePaths(new Set(renameResult.map((i) => i.original_path)));

      setHiddenItems(hiddenResult);
      setSelectedDeletePaths(new Set(hiddenResult.map((i) => i.file_path)));

      setMetadataItems(metadataResult);
      setSelectedMetadataIndices(new Set(metadataResult.map((_, idx) => idx)));
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

  const handleToggleMetadataSelect = (idx: number) => {
    const next = new Set(selectedMetadataIndices);
    if (next.has(idx)) {
      next.delete(idx);
    } else {
      next.add(idx);
    }
    setSelectedMetadataIndices(next);
  };

  const handleToggleAllMetadata = () => {
    if (selectedMetadataIndices.size === metadataItems.length) {
      setSelectedMetadataIndices(new Set());
    } else {
      setSelectedMetadataIndices(new Set(metadataItems.map((_, idx) => idx)));
    }
  };

  const executeRename = async () => {
    if (selectedRenamePaths.size === 0) return;
    const itemsToRename = sanitizeItems.filter((i) => selectedRenamePaths.has(i.original_path));
    
    const confirmed = confirm(
      `Are you absolutely sure you want to sanitize/rename these ${itemsToRename.length} files?\nThis will rename files on your local disk.`
    );
    if (!confirmed) return;

    setIsRenaming(true);
    try {
      const promise = invoke("execute_sanitizer", { items: itemsToRename });
      addBackgroundTask(`rename_${Date.now()}`, `Sanitize ${itemsToRename.length} files`, promise);
      await promise;
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
    
    const confirmed = confirm(
      `WARNING: You are about to permanently delete ${selectedDeletePaths.size} hidden files!\nThis operation is irreversible. Do you want to proceed?`
    );
    if (!confirmed) return;

    setIsDeleting(true);
    try {
      const promise = invoke("delete_hidden", { filePaths: Array.from(selectedDeletePaths) });
      addBackgroundTask(`delete_${Date.now()}`, `Delete ${selectedDeletePaths.size} hidden files`, promise);
      await promise;
      alert(`Successfully deleted ${selectedDeletePaths.size} hidden files!`);
      handleScan(scanFolder);
    } catch (e) {
      alert("Error deleting hidden files: " + e);
    } finally {
      setIsDeleting(false);
    }
  };

  const executeCleanMetadata = async () => {
    const itemsToClean = metadataItems.filter((_, idx) => selectedMetadataIndices.has(idx));
    if (itemsToClean.length === 0) return;

    const confirmed = confirm(
      `Are you sure you want to clean metadata tags for the ${itemsToClean.length} selected fields?`
    );
    if (!confirmed) return;

    setIsCleaningMetadata(true);
    try {
      const promise = invoke("execute_metadata_sanitizer", { items: itemsToClean });
      addBackgroundTask(`clean_metadata_${Date.now()}`, `Clean tags of ${itemsToClean.length} files`, promise);
      await promise;
      alert("Metadata tags cleaned successfully!");
      handleScan(scanFolder);
    } catch (e) {
      alert("Error cleaning metadata tags: " + e);
    } finally {
      setIsCleaningMetadata(false);
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
      <p className="subtitle">Scan directories to strip web names, unwanted text from filenames, clean tags/metadata, and remove hidden junk files.</p>

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
          Check or uncheck which words/phrases should be stripped from filenames and metadata, or add your own custom words to strip.
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
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          
          {/* Sub-Tabs selection bar inside card */}
          <div style={{ display: "flex", borderBottom: "1px solid var(--border-color)", paddingBottom: "12px", gap: "12px", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                className={`btn ${sanitizerSubTab === "files" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setSanitizerSubTab("files")}
                style={{ padding: "8px 16px", fontSize: "0.85rem" }}
              >
                📁 Filename Cleaner ({sanitizeItems.length})
              </button>
              <button
                className={`btn ${sanitizerSubTab === "metadata" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setSanitizerSubTab("metadata")}
                style={{ padding: "8px 16px", fontSize: "0.85rem" }}
              >
                🏷️ Metadata Tags Cleaner ({metadataItems.length})
              </button>
              <button
                className={`btn ${sanitizerSubTab === "hidden" ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setSanitizerSubTab("hidden")}
                style={{ padding: "8px 16px", fontSize: "0.85rem" }}
              >
                👻 Hidden Files Cleaner ({hiddenItems.length})
              </button>
            </div>

            {/* Action Buttons depending on sub-tab */}
            {sanitizerSubTab === "files" && sanitizeItems.length > 0 && (
              <button
                className="btn btn-primary"
                onClick={executeRename}
                disabled={selectedRenamePaths.size === 0 || isRenaming}
                style={{ padding: "8px 16px", fontSize: "0.85rem" }}
              >
                {isRenaming ? "Renaming..." : `Sanitize Names (${selectedRenamePaths.size})`}
              </button>
            )}

            {sanitizerSubTab === "metadata" && metadataItems.length > 0 && (
              <button
                className="btn btn-primary"
                onClick={executeCleanMetadata}
                disabled={selectedMetadataIndices.size === 0 || isCleaningMetadata}
                style={{ padding: "8px 16px", fontSize: "0.85rem" }}
              >
                {isCleaningMetadata ? "Cleaning..." : `Clean Tags (${selectedMetadataIndices.size})`}
              </button>
            )}

            {sanitizerSubTab === "hidden" && hiddenItems.length > 0 && (
              <button
                className="btn btn-danger"
                onClick={executeDelete}
                disabled={selectedDeletePaths.size === 0 || isDeleting}
                style={{ padding: "8px 16px", fontSize: "0.85rem" }}
              >
                {isDeleting ? "Deleting..." : `Delete Hidden (${selectedDeletePaths.size})`}
              </button>
            )}
          </div>

          {/* Sub-Tab Panels */}
          {sanitizerSubTab === "files" && (
            <div>
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
          )}

          {sanitizerSubTab === "metadata" && (
            <div>
              {metadataItems.length > 0 ? (
                <div className="table-container">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: "40px", textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={selectedMetadataIndices.size === metadataItems.length}
                            onChange={handleToggleAllMetadata}
                          />
                        </th>
                        <th>Track / File</th>
                        <th>Tag Field</th>
                        <th>Original Tag Value</th>
                        <th>Sanitized Tag Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metadataItems.map((item, idx) => (
                        <tr key={idx}>
                          <td style={{ textAlign: "center" }}>
                            <input
                              type="checkbox"
                              checked={selectedMetadataIndices.has(idx)}
                              onChange={() => handleToggleMetadataSelect(idx)}
                            />
                          </td>
                          <td>
                            <div style={{ fontWeight: 600, color: "var(--text-secondary)" }}>
                              {item.file_path.split("/").pop()}
                            </div>
                            <div className="text-secondary" style={{ fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
                              {item.file_path}
                            </div>
                          </td>
                          <td style={{ fontWeight: 600, color: "var(--accent-purple-hover)" }}>
                            {item.field_name}
                          </td>
                          <td>
                            <div style={{ color: "var(--danger)" }}>{item.original_value}</div>
                          </td>
                          <td style={{ color: "var(--success)", fontWeight: 600 }}>
                            {item.sanitized_value}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="no-data">All audio tags and descriptions are clean! No changes needed.</p>
              )}
            </div>
          )}

          {sanitizerSubTab === "hidden" && (
            <div>
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
          )}

        </div>
      )}
    </div>
  );
};
