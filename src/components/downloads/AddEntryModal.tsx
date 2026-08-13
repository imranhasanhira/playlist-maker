import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DownloadGlobalSettings, PlaylistMetadata } from "../../types";

type AddEntryModalProps = {
  isOpen: boolean;
  globalSettings: DownloadGlobalSettings;
  allExistingLabels: string[];
  existingEntries: { url: string; name: string }[];
  onClose: () => void;
  onAddEntry: (entryData: {
    url: string;
    name: string;
    labels: string;
    output_dir: string;
    audio_format: string | null;
    use_archive: boolean | null;
    metadata?: PlaylistMetadata;
    startDownloadImmediately?: boolean;
  }) => Promise<void>;
};

export const AddEntryModal: React.FC<AddEntryModalProps> = ({
  isOpen,
  globalSettings,
  allExistingLabels,
  existingEntries,
  onClose,
  onAddEntry,
}) => {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [labels, setLabels] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [audioFormat, setAudioFormat] = useState<string>("default");
  const [useArchive, setUseArchive] = useState<string>("default");

  const [isFetchingMetadata, setIsFetchingMetadata] = useState(false);
  const [fetchedMetadata, setFetchedMetadata] = useState<PlaylistMetadata | null>(null);
  const [fetchError, setFetchError] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Normalize URL for duplicate checking
  const normalizeUrl = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
  const duplicateEntry = React.useMemo(() => {
    if (!url.trim()) return null;
    const target = normalizeUrl(url);
    return existingEntries.find((e) => normalizeUrl(e.url) === target) || null;
  }, [url, existingEntries]);

  useEffect(() => {
    if (isOpen) {
      setUrl("");
      setName("");
      setLabels("");
      setOutputDir(globalSettings.default_output_dir || "");
      setAudioFormat("default");
      setUseArchive("default");
      setFetchedMetadata(null);
      setFetchError("");
    }
  }, [isOpen, globalSettings]);

  if (!isOpen) return null;

  const PREDEFINED_LABELS = ["Bangla", "Hindi", "English"];
  const combinedLabelSuggestions = Array.from(
    new Set([...PREDEFINED_LABELS, ...allExistingLabels])
  );

  const handleFetchMetadata = async () => {
    if (!url.trim()) return;
    setIsFetchingMetadata(true);
    setFetchError("");
    setFetchedMetadata(null);
    try {
      const meta = await invoke<PlaylistMetadata>("dl_fetch_playlist_metadata", {
        url: url.trim(),
      });
      setFetchedMetadata(meta);
      if (meta.title && !name.trim()) {
        setName(meta.title);
      }
    } catch (e) {
      setFetchError(String(e));
    } finally {
      setIsFetchingMetadata(false);
    }
  };

  const handlePickDir = async () => {
    try {
      const selected = await invoke<string | null>("select_directory", {
        title: "Select Output Directory for Entry",
      });
      if (selected) {
        setOutputDir(selected);
      }
    } catch (e) {
      alert("Error picking directory: " + e);
    }
  };

  const handleAddLabelChip = (chip: string) => {
    const current = labels.split(",").map((l) => l.trim()).filter(Boolean);
    if (!current.includes(chip)) {
      current.push(chip);
      setLabels(current.join(", "));
    }
  };

  const handleSubmit = async (downloadImmediately: boolean) => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setFetchError("Please enter a valid playlist or video URL.");
      return;
    }
    if (duplicateEntry) {
      alert(`An entry for this playlist URL already exists: "${duplicateEntry.name}"`);
      return;
    }

    let targetDir = outputDir.trim();
    if (!targetDir) {
      try {
        const selected = await invoke<string | null>("select_directory", {
          title: "Select Output Destination Folder for Downloads",
        });
        if (selected) {
          targetDir = selected;
          setOutputDir(selected);
        } else {
          return; // User cancelled folder selection
        }
      } catch (e) {
        alert("Please specify an output folder for downloads.");
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const finalName = name.trim() || fetchedMetadata?.title || "Playlist Entry";

      await onAddEntry({
        url: trimmedUrl,
        name: finalName,
        labels: labels.trim(),
        output_dir: targetDir,
        audio_format: audioFormat === "default" ? null : audioFormat,
        use_archive: useArchive === "default" ? null : useArchive === "true",
        metadata: fetchedMetadata || undefined,
        startDownloadImmediately: downloadImmediately,
      });

      onClose();
    } catch (e) {
      alert("Error adding entry: " + e);
    } finally {
      setIsSubmitting(false);
    }
  };


  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        className="card"
        style={{
          width: "540px",
          maxWidth: "92vw",
          maxHeight: "90vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          margin: 0,
          boxShadow: "0 20px 25px -5px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: "1.15rem", margin: 0 }}>Add New Playlist Download Entry</h2>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: "1.2rem", cursor: "pointer" }}
          >
            ✕
          </button>
        </div>

        {/* URL Input */}
        <div className="form-group" style={{ margin: 0 }}>
          <label className="form-label">Playlist / Media URL *</label>
          <div className="form-row">
            <input
              type="text"
              placeholder="https://www.youtube.com/playlist?list=..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={handleFetchMetadata}
            />
            <button
              className="btn btn-secondary"
              type="button"
              onClick={handleFetchMetadata}
              disabled={isFetchingMetadata || !url.trim()}
              style={{ fontSize: "0.8rem" }}
            >
              {isFetchingMetadata ? "Fetching..." : "Fetch Info"}
            </button>
          </div>
          {duplicateEntry && (
            <div style={{ fontSize: "0.8rem", color: "var(--warning)", backgroundColor: "rgba(245, 158, 11, 0.15)", border: "1px solid var(--warning)", padding: "6px 10px", borderRadius: "6px", marginTop: "6px" }}>
              ⚠️ Duplicate URL: An entry for this playlist already exists ("{duplicateEntry.name}")
            </div>
          )}
          {fetchError && (
            <div style={{ fontSize: "0.8rem", color: "var(--danger)", backgroundColor: "rgba(239, 68, 68, 0.15)", border: "1px solid var(--danger)", padding: "6px 10px", borderRadius: "6px", marginTop: "6px", wordBreak: "break-word" }}>
              ❌ Could not fetch metadata: {fetchError}
            </div>
          )}
          {fetchedMetadata && (
            <div style={{ fontSize: "0.78rem", color: "var(--success)", marginTop: "4px" }}>
              ✓ Found: "{fetchedMetadata.title}" ({fetchedMetadata.total_songs} songs)
            </div>
          )}
        </div>


        {/* Entry Name */}
        <div className="form-group" style={{ margin: 0 }}>
          <label className="form-label">Entry Display Name</label>
          <input
            type="text"
            placeholder="e.g. Bangla Classics Collection"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        {/* Labels & Suggestions */}
        <div className="form-group" style={{ margin: 0 }}>
          <label className="form-label">Labels (comma-separated)</label>
          <input
            type="text"
            placeholder="Bangla, Classics, Coke Studio..."
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
          />

          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "6px" }}>
            <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", alignSelf: "center" }}>Suggestions:</span>
            {combinedLabelSuggestions.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => handleAddLabelChip(tag)}
                style={{
                  fontSize: "0.7rem",
                  padding: "2px 8px",
                  borderRadius: "10px",
                  border: "1px solid var(--border-color)",
                  backgroundColor: "var(--bg-tertiary)",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                }}
              >
                + {tag}
              </button>
            ))}
          </div>
        </div>

        {/* Output Directory Picker */}
        <div className="form-group" style={{ margin: 0 }}>
          <label className="form-label">Output Destination Folder</label>
          <div className="form-row">
            <input
              type="text"
              value={outputDir}
              onChange={(e) => setOutputDir(e.target.value)}
              placeholder="e.g. /Music/Youtube"
            />
            <button className="btn btn-secondary" type="button" onClick={handlePickDir}>
              Choose...
            </button>
          </div>
        </div>

        {/* Format & Archive Overrides */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Audio Format Override</label>
            <select value={audioFormat} onChange={(e) => setAudioFormat(e.target.value)}>
              <option value="default">Use Global Default ({globalSettings.default_audio_format})</option>
              <option value="m4a/mp3">m4a/mp3 (Best)</option>
              <option value="m4a">m4a (Lossless)</option>
              <option value="mp3">mp3 (Audio only)</option>
            </select>
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Use Download Archive</label>
            <select value={useArchive} onChange={(e) => setUseArchive(e.target.value)}>
              <option value="default">Use Global Default ({globalSettings.default_use_archive ? "Enabled" : "Disabled"})</option>
              <option value="true">Enabled (Skip downloaded)</option>
              <option value="false">Disabled (Re-download all)</option>
            </select>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "8px" }}>
          <button className="btn btn-secondary" type="button" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => handleSubmit(false)}
            disabled={isSubmitting || !url.trim() || !!duplicateEntry}
          >
            {isSubmitting ? "⏳ Adding Entry..." : "💾 Add Entry"}
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => handleSubmit(true)}
            disabled={isSubmitting || !url.trim() || !!duplicateEntry}
          >
            {isSubmitting ? "⏳ Adding & Downloading..." : "🚀 Add & Download Now"}
          </button>
        </div>
      </div>
    </div>
  );
};
