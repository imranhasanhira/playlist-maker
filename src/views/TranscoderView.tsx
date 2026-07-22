import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ProgressBar } from "../components/common/ProgressBar";

type TranscoderViewProps = {
  addBackgroundTask?: (id: string, name: string, taskPromise: Promise<any>) => void;
};

type QueueItem = {
  filePath: string;
  fileName: string;
  status: "pending" | "converting" | "success" | "failed";
  errorMsg?: string;
};

type TaskProgress = {
  task_id: string;
  task_name: string;
  index: number;
  total: number;
  status: string;
  message: string;
  filePath?: string;
};

type TranscodeJob = {
  file_path: string;
  output_dir: string;
  bitrate: number;
};

export const TranscoderView: React.FC<TranscoderViewProps> = ({ addBackgroundTask }) => {
  const [outputDir, setOutputDir] = useState<string>("");
  const [bitrate, setBitrate] = useState<number>(320); // default CBR 320kbps
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [currentProgress, setCurrentProgress] = useState<number>(0);
  const [currentProgressText, setCurrentProgressText] = useState<string>("");

  useEffect(() => {
    // Listen to background progress events
    const unlisten = listen<TaskProgress>("task-progress", (event) => {
      const { task_id, index, total, status, message, filePath } = event.payload;
      if (task_id !== "flac_transcode") return;

      const isSuccess = !message.startsWith("Failed");

      setQueue((prevQueue) =>
        prevQueue.map((item) => {
          if (item.filePath === filePath) {
            return {
              ...item,
              status: isSuccess ? "success" : "failed",
              errorMsg: isSuccess ? undefined : message,
            };
          }
          return item;
        })
      );

      // Set progress bar
      const currentFile = index + 1;
      const percentage = Math.round((currentFile / total) * 100);
      setCurrentProgress(percentage);
      setCurrentProgressText(`Processed ${currentFile} of ${total} files (${percentage}%)`);

      if (currentFile === total && status === "completed") {
        setIsProcessing(false);
        alert("FLAC conversion completed!");
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const selectOutputDir = async () => {
    try {
      const selected = await invoke<string | null>("select_directory", {
        title: "Select MP3 Output Directory",
      });
      if (selected) {
        setOutputDir(selected);
      }
    } catch (e) {
      alert("Error picking directory: " + e);
    }
  };

  const handleAddFiles = async () => {
    try {
      const selected = await invoke<string | null>("select_file", {
        title: "Select FLAC Files to Convert",
        filterName: "FLAC Audio",
        filterExt: "flac",
      });
      if (selected) {
        const fileName = selected.split("/").pop() || selected;
        setQueue((prev) => [
          ...prev,
          {
            filePath: selected,
            fileName,
            status: "pending",
          },
        ]);
      }
    } catch (e) {
      alert("Error selecting file: " + e);
    }
  };

  const handleAddFolder = async () => {
    try {
      const selected = await invoke<string | null>("select_directory", {
        title: "Select Folder Containing FLAC Files",
      });
      if (selected) {
        const scanPromise = invoke<string[]>("scan_flac_files", {
          taskId: "flac_scan",
          folder: selected,
        });

        if (addBackgroundTask) {
          addBackgroundTask("flac_scan", "Scan folder for FLAC files", scanPromise);
        }

        const files = await scanPromise;

        const newItems: QueueItem[] = files.map((filePath) => {
          const fileName = filePath.split("/").pop() || filePath;
          return {
            filePath,
            fileName,
            status: "pending",
          };
        });

        // Filter out duplicates
        setQueue((prev) => {
          const existing = new Set(prev.map((i) => i.filePath));
          const filteredNew = newItems.filter((i) => !existing.has(i.filePath));
          return [...prev, ...filteredNew];
        });
      }
    } catch (e) {
      alert("Error adding folder: " + e);
    }
  };

  const handleClearQueue = () => {
    if (isProcessing) return;
    setQueue([]);
    setCurrentProgress(0);
    setCurrentProgressText("");
  };

  const startTranscoding = async () => {
    if (queue.length === 0 || !outputDir) {
      alert("Please add files and configure an output directory.");
      return;
    }

    const pendingJobs = queue.filter((i) => i.status === "pending" || i.status === "failed");
    if (pendingJobs.length === 0) {
      alert("No pending or failed files to convert.");
      return;
    }

    const confirmed = confirm(
      `Are you sure you want to transcode ${pendingJobs.length} FLAC files to MP3 at ${bitrate} kbps?\nOutput will be written to: ${outputDir}`
    );
    if (!confirmed) return;

    // Set converting status in state
    setQueue((prev) =>
      prev.map((i) =>
        i.status === "pending" || i.status === "failed"
          ? { ...i, status: "converting" as const }
          : i
      )
    );

    setIsProcessing(true);
    setCurrentProgress(0);
    setCurrentProgressText(`Starting conversion of ${pendingJobs.length} files...`);

    const jobs: TranscodeJob[] = pendingJobs.map((item) => ({
      file_path: item.filePath,
      output_dir: outputDir,
      bitrate,
    }));

    try {
      await invoke("start_transcoding_queue", { jobs });
    } catch (e) {
      alert("Failed to start transcode queue: " + e);
      setIsProcessing(false);
    }
  };

  return (
    <div className="view-container">
      <h1>FLAC-to-MP3 Transcoder</h1>
      <p className="subtitle">Batch transcode FLAC tracks into high-quality MP3s with full metadata retention.</p>

      {/* Target config settings */}
      <div className="card">
        <div className="card-title">Transcoding Configuration</div>
        <div style={{ display: "flex", gap: "16px" }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">MP3 Output Directory</label>
            <div className="form-row">
              <input
                type="text"
                readOnly
                value={outputDir}
                placeholder="Select output folder..."
              />
              <button className="btn btn-secondary" onClick={selectOutputDir} disabled={isProcessing}>
                Choose Folder
              </button>
            </div>
          </div>

          <div className="form-group" style={{ width: "240px" }}>
            <label className="form-label">Bitrate Quality</label>
            <select
              value={bitrate}
              onChange={(e) => setBitrate(parseInt(e.target.value))}
              disabled={isProcessing}
            >
              <option value={320}>CBR 320 kbps (Highest Quality)</option>
              <option value={256}>CBR 256 kbps (High Quality)</option>
              <option value={192}>CBR 192 kbps (Standard)</option>
              <option value={128}>CBR 128 kbps (Low Quality)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Conversion Queue Panel */}
      <div className="card" style={{ display: "flex", flexDirection: "column", minHeight: "350px" }}>
        <div className="card-title">
          <span>Conversion Queue ({queue.length} files)</span>
          <div style={{ display: "flex", gap: "8px" }}>
            <button className="btn btn-secondary" onClick={handleAddFiles} disabled={isProcessing}>
              + Add Files
            </button>
            <button className="btn btn-secondary" onClick={handleAddFolder} disabled={isProcessing}>
              + Add Folder
            </button>
            <button className="btn btn-secondary" onClick={handleClearQueue} disabled={isProcessing}>
              Clear Queue
            </button>
            <button
              className="btn btn-primary"
              onClick={startTranscoding}
              disabled={isProcessing || queue.length === 0 || !outputDir}
            >
              🚀 Start Transcoding
            </button>
          </div>
        </div>

        {isProcessing && (
          <div style={{ marginBottom: "20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.9rem", fontWeight: 600, marginBottom: "6px" }}>
              <span>{currentProgressText}</span>
              <span>{currentProgress}%</span>
            </div>
            <ProgressBar progress={currentProgress} status="running" height={8} />
          </div>
        )}

        {queue.length > 0 ? (
          <div className="table-container" style={{ flex: 1, overflowY: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Filename</th>
                  <th>Status</th>
                  <th>Actions / Details</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((item, idx) => (
                  <tr key={idx}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{item.fileName}</div>
                      <div className="text-secondary" style={{ fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
                        {item.filePath}
                      </div>
                    </td>
                    <td style={{ width: "120px" }}>
                      {item.status === "pending" && <span className="tag text-secondary">Pending</span>}
                      {item.status === "converting" && <span className="tag text-warning">Converting...</span>}
                      {item.status === "success" && <span className="tag tag-success">Completed</span>}
                      {item.status === "failed" && <span className="tag tag-danger">Failed</span>}
                    </td>
                    <td style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                      {item.errorMsg && <span className="text-danger">{item.errorMsg}</span>}
                      {item.status === "success" && <span className="text-success">MP3 created with full tags</span>}
                      {item.status === "pending" && <span>Ready to transcode</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="no-data">Queue is empty. Click "+ Add Files" or "+ Add Folder" to populate the transcoder.</p>
        )}
      </div>
    </div>
  );
};
