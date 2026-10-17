import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SanitizeItem, HiddenFileItem, MetadataSanitizeItem, FontIssueItem } from "../types";
import { formatSize } from "../utils/formatters";
import { ConfirmModal } from "../components/common/ConfirmModal";

type ExecutionReport = {
  success_count: number;
  failure_count: number;
  errors: string[];
};

type UnifiedScanResult = {
  filename_items: SanitizeItem[];
  metadata_items: MetadataSanitizeItem[];
  font_issue_items: FontIssueItem[];
  hidden_items: HiddenFileItem[];
  total_scanned_files: number;
};

type SanitizerViewProps = {
  formats: string;
  stripPhrases: string[];
  setStripPhrases: (phrases: string[]) => void;
  addBackgroundTask: (id: string, name: string, taskPromise: Promise<any>) => void;
  scanFolder: string;
  setScanFolder: (folder: string) => void;
  sanitizeItems: SanitizeItem[];
  setSanitizeItems: (items: SanitizeItem[]) => void;
  hiddenItems: HiddenFileItem[];
  setHiddenItems: (items: HiddenFileItem[]) => void;
  metadataItems: MetadataSanitizeItem[];
  setMetadataItems: (items: MetadataSanitizeItem[]) => void;
};

export const SanitizerView: React.FC<SanitizerViewProps> = ({
  formats,
  stripPhrases,
  setStripPhrases,
  addBackgroundTask,
  scanFolder,
  setScanFolder,
  sanitizeItems,
  setSanitizeItems,
  hiddenItems,
  setHiddenItems,
  metadataItems,
  setMetadataItems,
}) => {
  const [selectedRenamePaths, setSelectedRenamePaths] = useState<Set<string>>(
    () => new Set(sanitizeItems.map((i) => i.original_path))
  );
  const [selectedDeletePaths, setSelectedDeletePaths] = useState<Set<string>>(
    () => new Set(hiddenItems.map((i) => i.file_path))
  );

  // Metadata tags sanitization state
  const [selectedMetadataIndices, setSelectedMetadataIndices] = useState<Set<number>>(
    () => new Set(metadataItems.map((_, idx) => idx))
  );
  const [isCleaningMetadata, setIsCleaningMetadata] = useState<boolean>(false);

  // Font Issues state
  const [fontIssueItems, setFontIssueItems] = useState<FontIssueItem[]>([]);
  const [selectedFontIssuePaths, setSelectedFontIssuePaths] = useState<Set<string>>(new Set());
  const [isScanningFontIssues, setIsScanningFontIssues] = useState<boolean>(false);
  const [isApplyingOption1, setIsApplyingOption1] = useState<boolean>(false);
  const [isApplyingOption2, setIsApplyingOption2] = useState<boolean>(false);

  // Cleaner Tab state
  const [sanitizerSubTab, setSanitizerSubTab] = useState<"files" | "metadata" | "font_issues" | "hidden">("files");
  
  // Custom phrase state
  const [isRulesExpanded, setIsRulesExpanded] = useState<boolean>(false);
  const [newPhrase, setNewPhrase] = useState<string>("");
  const [uncheckedPhrases, setUncheckedPhrases] = useState<Set<string>>(new Set());

  const [isScanningFilenames, setIsScanningFilenames] = useState<boolean>(false);
  const [isScanningHidden, setIsScanningHidden] = useState<boolean>(false);
  const [isScanningMetadata, setIsScanningMetadata] = useState<boolean>(false);
  const [isRenaming, setIsRenaming] = useState<boolean>(false);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const isScanningAny = isScanningFilenames || isScanningHidden || isScanningMetadata || isScanningFontIssues;

  const selectScanFolder = async () => {
    try {
      const selected = await invoke<string | null>("select_directory", {
        title: "Select Directory to Scan",
      });
      if (selected) {
        setScanFolder(selected);
      }
    } catch (e) {
      alert("Error picking directory: " + e);
    }
  };

  const handleScanFilenames = async (folder: string) => {
    if (!folder) return;
    setIsScanningFilenames(true);
    try {
      const formatsList = formats.split(",").map((f) => f.trim());
      const activePhrases = stripPhrases.filter((p) => !uncheckedPhrases.has(p));

      const renamePromise = invoke<SanitizeItem[]>("scan_sanitizer", {
        taskId: "filename_scan",
        folder,
        formats: formatsList,
        stripPhrases: activePhrases,
      });
      addBackgroundTask("filename_scan", "Filename Sanitizer Scan", renamePromise);
      const renameResult = await renamePromise;
      setSanitizeItems(renameResult);
      setSelectedRenamePaths(new Set(renameResult.map((i) => i.original_path)));
    } catch (e) {
      alert("Error scanning filenames: " + e);
    } finally {
      setIsScanningFilenames(false);
    }
  };

  const handleScanHidden = async (folder: string) => {
    if (!folder) return;
    setIsScanningHidden(true);
    try {
      const hiddenPromise = invoke<HiddenFileItem[]>("scan_hidden", {
        taskId: "hidden_scan",
        folder,
      });
      addBackgroundTask("hidden_scan", "Hidden Files Scan", hiddenPromise);
      const hiddenResult = await hiddenPromise;
      setHiddenItems(hiddenResult);
      setSelectedDeletePaths(new Set(hiddenResult.map((i) => i.file_path)));
    } catch (e) {
      alert("Error scanning hidden files: " + e);
    } finally {
      setIsScanningHidden(false);
    }
  };

  const handleScanMetadata = async (folder: string) => {
    if (!folder) return;
    setIsScanningMetadata(true);
    try {
      const formatsList = formats.split(",").map((f) => f.trim());
      const activePhrases = stripPhrases.filter((p) => !uncheckedPhrases.has(p));

      const metadataPromise = invoke<MetadataSanitizeItem[]>("scan_metadata_sanitizer", {
        taskId: "metadata_scan",
        folder,
        formats: formatsList,
        stripPhrases: activePhrases,
      });
      addBackgroundTask("metadata_scan", "Metadata Sanitizer Scan", metadataPromise);
      const metadataResult = await metadataPromise;
      setMetadataItems(metadataResult);
      setSelectedMetadataIndices(new Set(metadataResult.map((_, idx) => idx)));
    } catch (e) {
      alert("Error scanning metadata tags: " + e);
    } finally {
      setIsScanningMetadata(false);
    }
  };

  const handleScanFontIssues = async (folder: string) => {
    if (!folder) return;
    setIsScanningFontIssues(true);
    try {
      const formatsList = formats.split(",").map((f) => f.trim());
      const promise = invoke<FontIssueItem[]>("scan_font_issues", {
        taskId: "font_issues_scan",
        folder,
        formats: formatsList,
      });
      addBackgroundTask("font_issues_scan", "Scan Font Issues", promise);
      const result = await promise;
      setFontIssueItems(result);
      setSelectedFontIssuePaths(new Set(result.map((i) => i.file_path)));
      setSanitizerSubTab("font_issues");
    } catch (e) {
      alert("Error scanning font issues: " + e);
    } finally {
      setIsScanningFontIssues(false);
    }
  };

  const handleApplyUtf16Tags = async () => {
    if (selectedFontIssuePaths.size === 0) return;
    setIsApplyingOption1(true);
    const count = selectedFontIssuePaths.size;
    const taskId = `font_rewrite_${Date.now()}`;
    try {
      const promise = invoke<ExecutionReport>("apply_font_issue_option1", {
        filePaths: Array.from(selectedFontIssuePaths),
      });
      addBackgroundTask(taskId, `Rewrite ID3 tags for ${count} files`, promise);
      const res = await promise;
      if (res.failure_count > 0) {
        alert(`Updated tags for ${res.success_count} file(s). Warning: ${res.failure_count} file(s) failed:\n${res.errors.slice(0, 5).join("\n")}`);
      } else {
        alert(`Successfully updated tags for ${res.success_count} file(s)!`);
      }
      setFontIssueItems((prev) => prev.filter((i) => !selectedFontIssuePaths.has(i.file_path)));
      setSelectedFontIssuePaths(new Set());
    } catch (e) {
      alert("Error updating tags: " + e);
    } finally {
      setIsApplyingOption1(false);
    }
  };

  const handleApplyTransliterate = async (targetType: "both" | "tags" | "filenames") => {
    if (selectedFontIssuePaths.size === 0) return;
    setIsApplyingOption2(true);
    const count = selectedFontIssuePaths.size;
    const taskId = `font_transliterate_${Date.now()}`;
    const typeLabel = targetType === "both" ? "both tags & filenames" : targetType === "filenames" ? "filenames" : "tags";
    try {
      const promise = invoke<ExecutionReport>("apply_font_issue_option2", {
        filePaths: Array.from(selectedFontIssuePaths),
        targetType,
      });
      addBackgroundTask(taskId, `Transliterate ${typeLabel} for ${count} files`, promise);
      const res = await promise;
      if (res.failure_count > 0) {
        alert(`Transliterated ${typeLabel} for ${res.success_count} file(s). Warning: ${res.failure_count} file(s) had issues:\n${res.errors.slice(0, 5).join("\n")}`);
      } else {
        alert(`Successfully transliterated ${typeLabel} for ${res.success_count} file(s) to Romanized Banglish!`);
      }
      setFontIssueItems((prev) => prev.filter((i) => !selectedFontIssuePaths.has(i.file_path)));
      setSelectedFontIssuePaths(new Set());
    } catch (e) {
      alert("Error applying transliteration: " + e);
    } finally {
      setIsApplyingOption2(false);
    }
  };

  const handleApplySingleFontIssue = async (filePath: string, targetType: "both" | "tags" | "filenames") => {
    try {
      const res = await invoke<ExecutionReport>("apply_font_issue_option2", {
        filePaths: [filePath],
        targetType,
      });
      if (res.failure_count > 0) {
        alert(`Warning: Failed to transliterate:\n${res.errors.join("\n")}`);
      } else {
        setFontIssueItems((prev) => prev.filter((i) => i.file_path !== filePath));
        setSelectedFontIssuePaths((prev) => {
          const next = new Set(prev);
          next.delete(filePath);
          return next;
        });
      }
    } catch (e) {
      alert("Error applying transliteration: " + e);
    }
  };

  const handleScanAll = async (folder: string) => {
    if (!folder) return;
    setIsScanningFilenames(true);
    setIsScanningHidden(true);
    setIsScanningMetadata(true);
    setIsScanningFontIssues(true);
    try {
      const formatsList = formats.split(",").map((f) => f.trim());
      const activePhrases = stripPhrases.filter((p) => !uncheckedPhrases.has(p));
      const taskId = `unified_scan_${Date.now()}`;
      const promise = invoke<UnifiedScanResult>("scan_all_unified", {
        taskId,
        folder,
        formats: formatsList,
        stripPhrases: activePhrases,
      });
      addBackgroundTask(taskId, "Unified Library Scan (Single Pass)", promise);
      const res = await promise;
      setSanitizeItems(res.filename_items);
      setSelectedRenamePaths(new Set(res.filename_items.map((i) => i.original_path)));
      setMetadataItems(res.metadata_items);
      setSelectedMetadataIndices(new Set(res.metadata_items.map((_, idx) => idx)));
      setFontIssueItems(res.font_issue_items);
      setSelectedFontIssuePaths(new Set(res.font_issue_items.map((i) => i.file_path)));
      setHiddenItems(res.hidden_items);
      setSelectedDeletePaths(new Set(res.hidden_items.map((i) => i.file_path)));
    } catch (e) {
      alert("Error during unified scan: " + e);
    } finally {
      setIsScanningFilenames(false);
      setIsScanningHidden(false);
      setIsScanningMetadata(false);
      setIsScanningFontIssues(false);
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

  const handleToggleFontIssueSelect = (path: string) => {
    const next = new Set(selectedFontIssuePaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    setSelectedFontIssuePaths(next);
  };

  const handleToggleAllFontIssues = () => {
    if (selectedFontIssuePaths.size === fontIssueItems.length) {
      setSelectedFontIssuePaths(new Set());
    } else {
      setSelectedFontIssuePaths(new Set(fontIssueItems.map((i) => i.file_path)));
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

  const [confirmModal, setConfirmModal] = useState<{
    type: "rename" | "metadata" | "hidden";
    title: string;
    message: string;
    count: number;
  } | null>(null);

  const promptExecuteRename = () => {
    if (selectedRenamePaths.size === 0) return;
    const itemsToRename = sanitizeItems.filter((i) => selectedRenamePaths.has(i.original_path));
    setConfirmModal({
      type: "rename",
      title: "Sanitize & Rename Filenames",
      message: `Are you sure you want to sanitize and rename ${itemsToRename.length} file(s) on disk?`,
      count: itemsToRename.length,
    });
  };

  const handleConfirmExecuteRename = async () => {
    setConfirmModal(null);
    if (selectedRenamePaths.size === 0) return;
    const itemsToRename = sanitizeItems.filter((i) => selectedRenamePaths.has(i.original_path));
    const taskId = `rename_${Date.now()}`;
    setIsRenaming(true);
    try {
      const promise = invoke<ExecutionReport>("execute_sanitizer", { taskId, items: itemsToRename });
      addBackgroundTask(taskId, `Sanitize ${itemsToRename.length} filenames`, promise);
      const res = await promise;
      if (res.failure_count > 0) {
        alert(`Renamed ${res.success_count} file(s). Warning: ${res.failure_count} file(s) failed:\n${res.errors.slice(0, 5).join("\n")}`);
      } else {
        alert(`Successfully sanitized & renamed ${res.success_count} file(s)!`);
      }
      setSanitizeItems(sanitizeItems.filter((i) => !selectedRenamePaths.has(i.original_path)));
      setSelectedRenamePaths(new Set());
    } catch (e) {
      alert("Error executing sanitization: " + e);
    } finally {
      setIsRenaming(false);
    }
  };

  const promptExecuteDelete = () => {
    if (selectedDeletePaths.size === 0) return;
    setConfirmModal({
      type: "hidden",
      title: "Delete Hidden Files",
      message: `WARNING: You are about to permanently delete ${selectedDeletePaths.size} hidden file(s) from disk. This operation is irreversible!`,
      count: selectedDeletePaths.size,
    });
  };

  const handleConfirmExecuteDelete = async () => {
    setConfirmModal(null);
    if (selectedDeletePaths.size === 0) return;
    const taskId = `delete_${Date.now()}`;
    setIsDeleting(true);
    try {
      const promise = invoke<ExecutionReport>("delete_hidden", { taskId, filePaths: Array.from(selectedDeletePaths) });
      addBackgroundTask(taskId, `Delete ${selectedDeletePaths.size} hidden files`, promise);
      const res = await promise;
      if (res.failure_count > 0) {
        alert(`Deleted ${res.success_count} file(s). Warning: ${res.failure_count} file(s) failed:\n${res.errors.slice(0, 5).join("\n")}`);
      } else {
        alert(`Successfully deleted ${res.success_count} hidden file(s)!`);
      }
      setHiddenItems(hiddenItems.filter((i) => !selectedDeletePaths.has(i.file_path)));
      setSelectedDeletePaths(new Set());
    } catch (e) {
      alert("Error deleting hidden files: " + e);
    } finally {
      setIsDeleting(false);
    }
  };

  const promptExecuteCleanMetadata = () => {
    const itemsToClean = metadataItems.filter((_, idx) => selectedMetadataIndices.has(idx));
    if (itemsToClean.length === 0) return;
    setConfirmModal({
      type: "metadata",
      title: "Clean Metadata Tags",
      message: `Are you sure you want to clean metadata tags for the ${itemsToClean.length} selected tag fields?`,
      count: itemsToClean.length,
    });
  };

  const handleConfirmExecuteCleanMetadata = async () => {
    setConfirmModal(null);
    const itemsToClean = metadataItems.filter((_, idx) => selectedMetadataIndices.has(idx));
    if (itemsToClean.length === 0) return;
    const taskId = `clean_metadata_${Date.now()}`;
    setIsCleaningMetadata(true);
    try {
      const promise = invoke<ExecutionReport>("execute_metadata_sanitizer", { taskId, items: itemsToClean });
      addBackgroundTask(taskId, `Clean tags of ${itemsToClean.length} files`, promise);
      const res = await promise;
      if (res.failure_count > 0) {
        alert(`Cleaned ${res.success_count} tag field(s). Warning: ${res.failure_count} field(s) failed:\n${res.errors.slice(0, 5).join("\n")}`);
      } else {
        alert(`Successfully cleaned ${res.success_count} metadata tag field(s)!`);
      }
      setMetadataItems(metadataItems.filter((_, idx) => !selectedMetadataIndices.has(idx)));
      setSelectedMetadataIndices(new Set());
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

  const addCustomPhrases = () => {
    if (!newPhrase.trim()) return;

    // Split by newlines, carriage returns, or comma delimiters
    const lines = newPhrase
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) return;

    // Deduplicate over the whole list (case-insensitive deduplication while preserving casing)
    const existingLower = new Set(stripPhrases.map((p) => p.trim().toLowerCase()));
    const newUniqueToAdd: string[] = [];

    for (const item of lines) {
      const lower = item.toLowerCase();
      if (!existingLower.has(lower)) {
        existingLower.add(lower);
        newUniqueToAdd.push(item);
      }
    }

    if (newUniqueToAdd.length === 0) {
      alert("All entered phrases are already in the list!");
      return;
    }

    // Merge and deduplicate whole list preserving original order
    const combined = [...stripPhrases, ...newUniqueToAdd];
    const seen = new Set<string>();
    const deduplicatedList: string[] = [];
    for (const p of combined) {
      const trimmed = p.trim();
      const lower = trimmed.toLowerCase();
      if (lower && !seen.has(lower)) {
        seen.add(lower);
        deduplicatedList.push(trimmed);
      }
    }

    setStripPhrases(deduplicatedList);

    // Make sure newly added phrases are enabled/checked
    const nextUnchecked = new Set(uncheckedPhrases);
    for (const a of newUniqueToAdd) {
      nextUnchecked.delete(a);
    }
    setUncheckedPhrases(nextUnchecked);

    setNewPhrase("");
  };

  const removeCustomPhrase = (phrase: string) => {
    setStripPhrases(stripPhrases.filter((p) => p !== phrase));
    const next = new Set(uncheckedPhrases);
    next.delete(phrase);
    setUncheckedPhrases(next);
  };

  const renderMetadataDiff = (original: string, sanitized: string) => {
    const issues: string[] = [];

    if (original.startsWith(" ") || original.endsWith(" ")) {
      issues.push("Whitespace at edge");
    }
    if (original.includes("  ")) {
      issues.push("Multiple spaces");
    }
    if (original.includes("\n") || original.includes("\r") || original.includes("\t")) {
      issues.push("Newline / Tab in tag");
    }
    const hasInvisible = /[\u0000-\u001F\u007F-\u009F\u00A0\u2000-\u200F\u2028-\u202F\uFEFF\uF000-\uFFFF]/.test(original);
    if (hasInvisible) {
      issues.push("Invisible / control symbol");
    }
    if (issues.length === 0 && original !== sanitized) {
      issues.push("Punctuation / text cleaned");
    }

    const visualOriginal = original
      .replace(/^ +/, (m) => "␣".repeat(m.length))
      .replace(/ +$/, (m) => "␣".repeat(m.length))
      .replace(/ {2,}/g, (m) => " " + "␣".repeat(m.length - 1));

    return (
      <div>
        <div style={{ color: "var(--danger)", fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", fontSize: "0.85rem" }}>
          "{visualOriginal}"
        </div>
        {issues.length > 0 && (
          <div style={{ display: "flex", gap: "4px", marginTop: "4px", flexWrap: "wrap" }}>
            {issues.map((iss, i) => (
              <span
                key={i}
                className="badge"
                style={{
                  fontSize: "0.68rem",
                  padding: "1px 5px",
                  borderRadius: "3px",
                  backgroundColor: "rgba(234, 179, 8, 0.15)",
                  color: "var(--warning)",
                  border: "1px solid var(--warning)",
                }}
              >
                ⚠️ {iss}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  };


  return (
    <div className="view-container">
      <h1>Sanitizer & Cleaner</h1>
      <p className="subtitle">Scan directories to strip web names, unwanted text from filenames, clean tags/metadata, and remove hidden junk files.</p>

      {/* Target directory selector & Scan Buttons */}
      <div className="card">
        <div className="form-group" style={{ marginBottom: "14px" }}>
          <div className="form-row">
            <input
              type="text"
              value={scanFolder}
              onChange={(e) => setScanFolder(e.target.value)}
              placeholder="Select folder to analyze..."
            />
            <button className="btn btn-secondary" onClick={selectScanFolder}>
              Choose Folder
            </button>
          </div>
        </div>

        {/* Scan Action Buttons Bar (Line 1) */}
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <button
            className="btn btn-primary"
            disabled={!scanFolder || isScanningAny}
            onClick={() => handleScanAll(scanFolder)}
            style={{ padding: "6px 14px", fontSize: "0.85rem" }}
            title="Scan Filenames, Metadata Tags, Font Issues, and Hidden Files together"
          >
            {isScanningAny ? "Scanning..." : "⚡ Scan All"}
          </button>
          <button
            className="btn btn-secondary"
            disabled={!scanFolder || isScanningFilenames}
            onClick={() => handleScanFilenames(scanFolder)}
            style={{ padding: "6px 12px", fontSize: "0.85rem" }}
          >
            {isScanningFilenames ? "Scanning..." : "📁 Scan Filenames"}
          </button>
          <button
            className="btn btn-secondary"
            disabled={!scanFolder || isScanningMetadata}
            onClick={() => handleScanMetadata(scanFolder)}
            style={{ padding: "6px 12px", fontSize: "0.85rem" }}
          >
            {isScanningMetadata ? "Scanning..." : "🏷️ Scan Metadata Tags"}
          </button>
          <button
            className="btn btn-secondary"
            disabled={!scanFolder || isScanningFontIssues}
            onClick={() => handleScanFontIssues(scanFolder)}
            style={{ padding: "6px 12px", fontSize: "0.85rem" }}
          >
            {isScanningFontIssues ? "Scanning..." : "🔤 Scan Font Issues"}
          </button>
          <button
            className="btn btn-secondary"
            disabled={!scanFolder || isScanningHidden}
            onClick={() => handleScanHidden(scanFolder)}
            style={{ padding: "6px 12px", fontSize: "0.85rem" }}
          >
            {isScanningHidden ? "Scanning..." : "👻 Scan Hidden Files"}
          </button>
        </div>
      </div>

      {/* Customizable Strip rules checklist */}
      <div className="card" style={{ padding: isRulesExpanded ? "16px 20px" : "12px 20px" }}>
        <div
          className="card-title"
          onClick={() => setIsRulesExpanded(!isRulesExpanded)}
          style={{
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            margin: 0,
            userSelect: "none",
          }}
        >
          <span>⚙️ Editable Sanitization Rules ({stripPhrases.length - uncheckedPhrases.size} active phrases)</span>
          <span style={{ fontSize: "0.82rem", color: "var(--accent-purple)", fontWeight: 600 }}>
            {isRulesExpanded ? "▾ Hide Rules" : "▸ Expand Rules"}
          </span>
        </div>

        {isRulesExpanded && (
          <div style={{ marginTop: "14px" }}>
            <p className="text-secondary" style={{ fontSize: "0.85rem", marginBottom: "12px" }}>
              Check or uncheck which words/phrases should be stripped from filenames and metadata, or add your own custom words to strip.
            </p>

            {/* Custom Multiline Input */}
            <div style={{ marginBottom: "16px", maxWidth: "560px", display: "flex", flexDirection: "column", gap: "8px" }}>
              <textarea
                value={newPhrase}
                onChange={(e) => setNewPhrase(e.target.value)}
                placeholder="Paste or type words/phrases to strip (multiline supported, one per line)..."
                rows={3}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  borderRadius: "6px",
                  border: "1px solid var(--border-color)",
                  backgroundColor: "var(--bg-surface)",
                  color: "var(--text-primary)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.82rem",
                  resize: "vertical",
                  boxSizing: "border-box",
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    addCustomPhrases();
                  }
                }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="text-secondary" style={{ fontSize: "0.72rem" }}>
                  Tip: Paste multiple lines at once. Press <kbd style={{ padding: "1px 4px", fontSize: "0.7rem", borderRadius: "3px", backgroundColor: "var(--bg-tertiary)" }}>Ctrl/⌘</kbd> + <kbd style={{ padding: "1px 4px", fontSize: "0.7rem", borderRadius: "3px", backgroundColor: "var(--bg-tertiary)" }}>Enter</kbd> to add.
                </span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={addCustomPhrases}
                  style={{ padding: "6px 14px", fontSize: "0.8rem", whiteSpace: "nowrap" }}
                >
                  + Add Phrases
                </button>
              </div>
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
        )}
      </div>

      {/* Scanned Results Panel */}
      {scanFolder && (
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          
          {/* Issue Tabs (Line 2) */}
          <div style={{ display: "flex", borderBottom: "2px solid var(--border-color)", gap: "4px" }}>
            <button
              onClick={() => setSanitizerSubTab("files")}
              style={{
                padding: "8px 16px",
                fontSize: "0.85rem",
                fontWeight: sanitizerSubTab === "files" ? 600 : 400,
                borderBottom: sanitizerSubTab === "files" ? "2px solid var(--accent-purple)" : "2px solid transparent",
                marginBottom: "-2px",
                backgroundColor: "transparent",
                color: sanitizerSubTab === "files" ? "var(--text-primary)" : "var(--text-secondary)",
                border: "none",
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              📁 Filenames {isScanningFilenames ? "⌛" : `(${sanitizeItems.length})`}
            </button>
            <button
              onClick={() => setSanitizerSubTab("metadata")}
              style={{
                padding: "8px 16px",
                fontSize: "0.85rem",
                fontWeight: sanitizerSubTab === "metadata" ? 600 : 400,
                borderBottom: sanitizerSubTab === "metadata" ? "2px solid var(--accent-purple)" : "2px solid transparent",
                marginBottom: "-2px",
                backgroundColor: "transparent",
                color: sanitizerSubTab === "metadata" ? "var(--text-primary)" : "var(--text-secondary)",
                border: "none",
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              🏷️ Metadata Tags {isScanningMetadata ? "⌛" : `(${metadataItems.length})`}
            </button>
            <button
              onClick={() => setSanitizerSubTab("font_issues")}
              style={{
                padding: "8px 16px",
                fontSize: "0.85rem",
                fontWeight: sanitizerSubTab === "font_issues" ? 600 : 400,
                borderBottom: sanitizerSubTab === "font_issues" ? "2px solid var(--accent-purple)" : "2px solid transparent",
                marginBottom: "-2px",
                backgroundColor: "transparent",
                color: sanitizerSubTab === "font_issues" ? "var(--text-primary)" : "var(--text-secondary)",
                border: "none",
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              🔤 Font Issues {isScanningFontIssues ? "⌛" : `(${fontIssueItems.length})`}
            </button>
            <button
              onClick={() => setSanitizerSubTab("hidden")}
              style={{
                padding: "8px 16px",
                fontSize: "0.85rem",
                fontWeight: sanitizerSubTab === "hidden" ? 600 : 400,
                borderBottom: sanitizerSubTab === "hidden" ? "2px solid var(--accent-purple)" : "2px solid transparent",
                marginBottom: "-2px",
                backgroundColor: "transparent",
                color: sanitizerSubTab === "hidden" ? "var(--text-primary)" : "var(--text-secondary)",
                border: "none",
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              👻 Hidden Files {isScanningHidden ? "⌛" : `(${hiddenItems.length})`}
            </button>
          </div>

          {/* Issue Action Buttons Bar (Line 3) */}
          <div style={{ display: "flex", gap: "8px", alignItems: "center", minHeight: "34px" }}>
            {sanitizerSubTab === "files" && sanitizeItems.length > 0 && (
              <button
                className="btn btn-primary"
                onClick={promptExecuteRename}
                disabled={selectedRenamePaths.size === 0 || isRenaming || isScanningFilenames}
                style={{ padding: "6px 14px", fontSize: "0.82rem" }}
              >
                {isRenaming ? "Renaming..." : `Sanitize Names (${selectedRenamePaths.size})`}
              </button>
            )}

            {sanitizerSubTab === "metadata" && metadataItems.length > 0 && (
              <button
                className="btn btn-primary"
                onClick={promptExecuteCleanMetadata}
                disabled={selectedMetadataIndices.size === 0 || isCleaningMetadata || isScanningMetadata}
                style={{ padding: "6px 14px", fontSize: "0.82rem" }}
              >
                {isCleaningMetadata ? "Cleaning..." : `Clean Tags (${selectedMetadataIndices.size})`}
              </button>
            )}

            {sanitizerSubTab === "font_issues" && fontIssueItems.length > 0 && (
              <>
                <button
                  className="btn btn-primary"
                  onClick={() => handleApplyTransliterate("both")}
                  disabled={selectedFontIssuePaths.size === 0 || isApplyingOption2 || isScanningFontIssues}
                  style={{ padding: "6px 14px", fontSize: "0.82rem", fontWeight: 600 }}
                  title="Transliterates Bangla script and PUA symbols in both ID3 metadata tags AND physical filenames on disk to clean phonetic Romanized Banglish (ASCII), guaranteeing full car display compatibility"
                >
                  {isApplyingOption2 ? "Applying..." : `⚡ Transliterate Both (${selectedFontIssuePaths.size})`}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => handleApplyTransliterate("filenames")}
                  disabled={selectedFontIssuePaths.size === 0 || isApplyingOption2 || isScanningFontIssues}
                  style={{ padding: "6px 12px", fontSize: "0.82rem" }}
                  title="Transliterates Bangla script and PUA symbols in physical file names on disk to clean phonetic Romanized Banglish (ASCII)"
                >
                  {isApplyingOption2 ? "Applying..." : `📁 Rename Files (${selectedFontIssuePaths.size})`}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => handleApplyTransliterate("tags")}
                  disabled={selectedFontIssuePaths.size === 0 || isApplyingOption2 || isScanningFontIssues}
                  style={{ padding: "6px 12px", fontSize: "0.82rem" }}
                  title="Transliterates Bangla script in Title & Artist metadata tags to clean phonetic Romanized Banglish (ASCII), keeping files on disk unchanged"
                >
                  {isApplyingOption2 ? "Applying..." : `🏷️ Clean Tags (${selectedFontIssuePaths.size})`}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={handleApplyUtf16Tags}
                  disabled={selectedFontIssuePaths.size === 0 || isApplyingOption1 || isScanningFontIssues}
                  style={{ padding: "6px 12px", fontSize: "0.82rem" }}
                  title="Preserves real Bangla text in Title & Artist tags, stripping PUA symbols"
                >
                  {isApplyingOption1 ? "Applying..." : `Rewrite ID3 Tags (${selectedFontIssuePaths.size})`}
                </button>
              </>
            )}

            {sanitizerSubTab === "hidden" && hiddenItems.length > 0 && (
              <button
                className="btn btn-danger"
                onClick={promptExecuteDelete}
                disabled={selectedDeletePaths.size === 0 || isDeleting || isScanningHidden}
                style={{ padding: "6px 14px", fontSize: "0.82rem" }}
              >
                {isDeleting ? "Deleting..." : `Delete Hidden (${selectedDeletePaths.size})`}
              </button>
            )}
          </div>

          {/* Sub-Tab Panels */}
          {sanitizerSubTab === "files" && (
            <div>
              {isScanningFilenames ? (
                <div className="no-data">Scanning filenames for web phrases...</div>
              ) : sanitizeItems.length > 0 ? (
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
              {isScanningMetadata ? (
                <div className="no-data">Scanning audio tags & metadata fields...</div>
              ) : metadataItems.length > 0 ? (
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
                            <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>
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
                            {renderMetadataDiff(item.original_value, item.sanitized_value)}
                          </td>
                          <td>
                            <div style={{ color: "var(--success)", fontWeight: 600, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", fontSize: "0.85rem" }}>
                              "{item.sanitized_value}"
                            </div>
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

          {sanitizerSubTab === "font_issues" && (
            <div>
              {isScanningFontIssues ? (
                <div className="no-data">Scanning for font & Unicode script issues...</div>
              ) : fontIssueItems.length > 0 ? (
                <div className="table-container">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: "40px", textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={selectedFontIssuePaths.size === fontIssueItems.length}
                            onChange={handleToggleAllFontIssues}
                          />
                        </th>
                        <th style={{ width: "240px" }}>File Path / Location</th>
                        <th style={{ width: "160px" }}>Detected Issue</th>
                        <th style={{ width: "180px" }}>ID3 Target</th>
                        <th>Banglish Transliteration Preview</th>
                        <th style={{ width: "160px", textAlign: "center" }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fontIssueItems.map((item, idx) => (
                        <tr key={idx}>
                          <td style={{ textAlign: "center" }}>
                            <input
                              type="checkbox"
                              checked={selectedFontIssuePaths.has(item.file_path)}
                              onChange={() => handleToggleFontIssueSelect(item.file_path)}
                            />
                          </td>
                          <td>
                            <div style={{ fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.relative_path}>
                              {item.relative_path.split("/").pop()}
                            </div>
                            <div className="text-secondary" style={{ fontSize: "0.75rem", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.file_path}>
                              {item.relative_path}
                            </div>
                          </td>
                          <td>
                            <span className="badge" style={{ backgroundColor: "rgba(234, 179, 8, 0.15)", color: "var(--warning)", border: "1px solid var(--warning)", padding: "2px 6px", borderRadius: "4px", fontSize: "0.72rem" }}>
                              {item.detected_issue}
                            </span>
                          </td>
                          <td style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                            {item.option1_preview}
                          </td>
                          <td style={{ color: "var(--success)", fontWeight: 600, fontFamily: "var(--font-mono)", fontSize: "0.82rem" }}>
                            {item.option2_preview}
                          </td>
                          <td style={{ textAlign: "center" }}>
                            <div style={{ display: "flex", gap: "6px", justifyContent: "center" }}>
                              <button
                                className="btn btn-primary"
                                onClick={() => handleApplySingleFontIssue(item.file_path, "both")}
                                style={{ padding: "3px 8px", fontSize: "0.75rem", fontWeight: 600 }}
                                title="Transliterate both tags & filename for this track to clean ASCII"
                              >
                                ⚡ Fix
                              </button>
                              <button
                                className="btn btn-secondary"
                                onClick={() => handleApplySingleFontIssue(item.file_path, "filenames")}
                                style={{ padding: "3px 8px", fontSize: "0.75rem" }}
                                title="Rename file to clean ASCII on disk"
                              >
                                📁 Rename
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="no-data">No font or character encoding issues detected! No changes needed.</p>
              )}
            </div>
          )}

          {sanitizerSubTab === "hidden" && (
            <div>
              {isScanningHidden ? (
                <div className="no-data">Scanning for hidden system junk files...</div>
              ) : hiddenItems.length > 0 ? (
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
                            <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{item.file_name}</div>
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

          {/* Action Confirmation Modal */}
          {confirmModal && (
            <ConfirmModal
              title={confirmModal.title}
              message={confirmModal.message}
              confirmText={`Confirm (${confirmModal.count})`}
              confirmVariant={confirmModal.type === "hidden" ? "danger" : "primary"}
              onConfirm={() => {
                if (confirmModal.type === "rename") handleConfirmExecuteRename();
                if (confirmModal.type === "hidden") handleConfirmExecuteDelete();
                if (confirmModal.type === "metadata") handleConfirmExecuteCleanMetadata();
              }}
              onCancel={() => setConfirmModal(null)}
            />
          )}
        </div>
      )}
    </div>
  );
};
