import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MainConfig, DownloadJob, DownloadLogPayload, DownloadProgressPayload, SystemBinariesStatus } from "../types";
import { ProgressBar } from "../components/common/ProgressBar";

type DownloadsViewProps = {
  config: MainConfig | null;
};

export const DownloadsView: React.FC<DownloadsViewProps> = ({ config }) => {
  // Binary detection status
  const [binaries, setBinaries] = useState<SystemBinariesStatus | null>(null);

  useEffect(() => {
    invoke<SystemBinariesStatus>("check_system_binaries")
      .then(setBinaries)
      .catch((e) => console.error("Error checking system binaries:", e));
  }, []);
  // Input Configuration State
  const [urlInput, setUrlInput] = useState<string>("");
  const [format, setFormat] = useState<string>("m4a/mp3");
  const [useArchive, setUseArchive] = useState<boolean>(true);
  const [archivePath, setArchivePath] = useState<string>("");
  const [ignoreErrors, setIgnoreErrors] = useState<boolean>(true);
  
  // Default destination
  const defaultDest = config?.workspaceDir 
    ? `${config.workspaceDir.replace(/\\/g, "/")}/Downloads` 
    : config?.sourceDir 
      ? `${config.sourceDir.replace(/\\/g, "/")}/Downloads`
      : "";
  const [outputDir, setOutputDir] = useState<string>(defaultDest);

  useEffect(() => {
    if (!outputDir && defaultDest) {
      setOutputDir(defaultDest);
    }
  }, [config, defaultDest]);

  // Jobs & Selection State
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const selectedJob = jobs.find((j) => j.id === selectedJobId) || jobs[jobs.length - 1] || null;
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  // Scroll terminal logs to bottom automatically
  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [selectedJob?.logs]);

  // Listen to background Tauri IPC events from yt-dlp
  useEffect(() => {
    let unlistenLog: (() => void) | null = null;
    let unlistenProgress: (() => void) | null = null;

    const setupListeners = async () => {
      unlistenLog = await listen<DownloadLogPayload>("download-log", (event) => {
        const { job_id, line } = event.payload;
        setJobs((prevJobs) =>
          prevJobs.map((j) => {
            if (j.id === job_id) {
              return {
                ...j,
                logs: [...j.logs, line],
              };
            }
            return j;
          })
        );
      });

      unlistenProgress = await listen<DownloadProgressPayload>("download-progress", (event) => {
        const { job_id, status, progress, current_item, total_items, title } = event.payload;
        setJobs((prevJobs) =>
          prevJobs.map((j) => {
            if (j.id === job_id) {
              return {
                ...j,
                status: status as any,
                progress,
                current_item: current_item ?? j.current_item,
                total_items: total_items ?? j.total_items,
                title: title || j.title,
              };
            }
            return j;
          })
        );
      });
    };

    setupListeners();

    return () => {
      if (unlistenLog) unlistenLog();
      if (unlistenProgress) unlistenProgress();
    };
  }, []);

  const handlePickDirectory = async () => {
    try {
      const selected = await invoke<string | null>("select_directory", {
        title: "Select Output Destination Directory for Downloads",
      });
      if (selected) {
        setOutputDir(selected);
      }
    } catch (e) {
      alert("Error selecting directory: " + e);
    }
  };

  const handleStartDownload = async () => {
    if (!urlInput.trim()) {
      alert("Please enter a valid playlist or media URL.");
      return;
    }
    if (!outputDir.trim()) {
      alert("Please specify an output destination folder.");
      return;
    }

    const jobId = `dl_${Date.now()}`;
    const newJob: DownloadJob = {
      id: jobId,
      url: urlInput.trim(),
      output_dir: outputDir.trim(),
      audio_format: format,
      use_archive: useArchive,
      archive_path: archivePath.trim(),
      ignore_errors: ignoreErrors,
      status: "running",
      progress: 0,
      logs: [`🚀 Initializing yt-dlp download job for: ${urlInput.trim()}`],
      start_time: Date.now(),
    };

    setJobs((prev) => [...prev, newJob]);
    setSelectedJobId(jobId);
    setUrlInput(""); // Clear URL input for convenient next entry

    try {
      await invoke("start_download_job", {
        jobId,
        url: newJob.url,
        outputDir: newJob.output_dir,
        audioFormat: newJob.audio_format,
        useArchive: newJob.use_archive,
        archivePath: newJob.archive_path,
        ignoreErrors: newJob.ignore_errors,
      });
    } catch (e) {
      alert("Error starting download: " + e);
      setJobs((prev) =>
        prev.map((j) => (j.id === jobId ? { ...j, status: "failed", logs: [...j.logs, `❌ Error: ${e}`] } : j))
      );
    }
  };

  const handleCancelJob = async (jobId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      await invoke("cancel_download_job", { jobId });
      setJobs((prev) =>
        prev.map((j) =>
          j.id === jobId
            ? { ...j, status: "cancelled", logs: [...j.logs, "🛑 Download task cancelled by user."] }
            : j
        )
      );
    } catch (e) {
      console.error("Error cancelling job:", e);
    }
  };

  const handleRetryJob = async (jobToRetry: DownloadJob, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const jobId = `dl_${Date.now()}`;
    const newJob: DownloadJob = {
      id: jobId,
      url: jobToRetry.url,
      output_dir: jobToRetry.output_dir,
      audio_format: jobToRetry.audio_format,
      use_archive: jobToRetry.use_archive,
      archive_path: jobToRetry.archive_path,
      ignore_errors: jobToRetry.ignore_errors ?? true,
      status: "running",
      progress: 0,
      logs: [`🔄 Retrying download job for: ${jobToRetry.url}`],
      start_time: Date.now(),
    };

    setJobs((prev) => [...prev, newJob]);
    setSelectedJobId(jobId);

    try {
      await invoke("start_download_job", {
        jobId,
        url: newJob.url,
        outputDir: newJob.output_dir,
        audioFormat: newJob.audio_format,
        useArchive: newJob.use_archive,
        archivePath: newJob.archive_path,
        ignoreErrors: newJob.ignore_errors,
      });
    } catch (e) {
      alert("Error retrying download: " + e);
      setJobs((prev) =>
        prev.map((j) => (j.id === jobId ? { ...j, status: "failed", logs: [...j.logs, `❌ Error: ${e}`] } : j))
      );
    }
  };

  const handleClearCompleted = () => {
    setJobs((prev) => prev.filter((j) => j.status === "running"));
  };

  return (
    <div className="view-container" style={{ display: "flex", flexDirection: "column", height: "100%", flex: 1, minHeight: 0, gap: "16px", overflow: "hidden" }}>
      <div>
        <h1>Media & Playlist Downloader</h1>
        <p className="subtitle" style={{ margin: 0 }}>
          Download audio from online playlists or media URLs using <code style={{ fontFamily: "var(--font-mono)" }}>yt-dlp</code> with real-time log tracking and download archives.
        </p>
      </div>

      {/* Configuration Card */}
      <div className="card" style={{ margin: 0, display: "flex", flexDirection: "column", gap: "12px", padding: "16px 20px" }}>
        <div className="card-title" style={{ fontSize: "0.95rem", margin: 0, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Download Setup</span>
          {binaries && (
            <div style={{ display: "flex", gap: "8px", fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
              <span
                style={{
                  padding: "3px 8px",
                  borderRadius: "4px",
                  backgroundColor: binaries.ytdlp_installed ? "rgba(34, 197, 94, 0.15)" : "rgba(239, 68, 68, 0.15)",
                  color: binaries.ytdlp_installed ? "var(--success)" : "var(--danger)",
                  border: `1px solid ${binaries.ytdlp_installed ? "var(--success)" : "var(--danger)"}`,
                }}
                title={binaries.ytdlp_installed ? `yt-dlp version: ${binaries.ytdlp_version}` : "yt-dlp binary is NOT found in system PATH"}
              >
                {binaries.ytdlp_installed ? `✓ yt-dlp ${binaries.ytdlp_version || "ready"}` : "✗ yt-dlp missing"}
              </span>

              <span
                style={{
                  padding: "3px 8px",
                  borderRadius: "4px",
                  backgroundColor: binaries.ffmpeg_installed ? "rgba(34, 197, 94, 0.15)" : "rgba(234, 179, 8, 0.15)",
                  color: binaries.ffmpeg_installed ? "var(--success)" : "var(--warning)",
                  border: `1px solid ${binaries.ffmpeg_installed ? "var(--success)" : "var(--warning)"}`,
                }}
                title={binaries.ffmpeg_installed ? `ffmpeg version: ${binaries.ffmpeg_version}` : "ffmpeg binary is recommended for audio conversion/thumbnails"}
              >
                {binaries.ffmpeg_installed ? "✓ ffmpeg ready" : "⚠️ ffmpeg missing"}
              </span>
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "flex-end" }}>
          {/* Playlist URL Input */}
          <div className="form-group" style={{ flex: 2, minWidth: "300px", margin: 0 }}>
            <label className="form-label">Playlist / Media URL</label>
            <input
              type="text"
              placeholder="https://..."
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleStartDownload()}
            />
          </div>

          {/* Output Directory Picker */}
          <div className="form-group" style={{ flex: 2, minWidth: "260px", margin: 0 }}>
            <label className="form-label">Output Directory</label>
            <div className="form-row">
              <input
                type="text"
                value={outputDir}
                onChange={(e) => setOutputDir(e.target.value)}
                placeholder="workspace/Downloads/"
              />
              <button className="btn btn-secondary" onClick={handlePickDirectory}>
                Folder
              </button>
            </div>
          </div>

          {/* Audio Format Select */}
          <div className="form-group" style={{ width: "160px", margin: 0 }}>
            <label className="form-label">Audio Format</label>
            <select value={format} onChange={(e) => setFormat(e.target.value)}>
              <option value="m4a/mp3">m4a/mp3 (Best)</option>
              <option value="m4a">m4a (Lossless Audio)</option>
              <option value="mp3">mp3 (Audio Only)</option>
            </select>
          </div>

          {/* Action Button */}
          <button
            className="btn btn-primary"
            onClick={handleStartDownload}
            style={{ padding: "8px 20px", fontSize: "0.9rem", height: "38px" }}
          >
            🚀 Start Download
          </button>
        </div>

        {/* Download Options (Archive & Ignore Errors) */}
        <div style={{ display: "flex", gap: "24px", alignItems: "center", flexWrap: "wrap", paddingTop: "4px" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.85rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={useArchive}
              onChange={(e) => setUseArchive(e.target.checked)}
            />
            <span>Use Download Archive (<code style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>archive.txt</code>) to skip previously downloaded videos</span>
          </label>

          {useArchive && (
            <input
              type="text"
              placeholder="Custom archive path (optional)..."
              value={archivePath}
              onChange={(e) => setArchivePath(e.target.value)}
              style={{ width: "220px", padding: "3px 8px", fontSize: "0.78rem" }}
            />
          )}

          <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.85rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={ignoreErrors}
              onChange={(e) => setIgnoreErrors(e.target.checked)}
            />
            <span>Ignore errors for missing/unavailable videos (<code style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>--ignore-errors</code>)</span>
          </label>
        </div>
      </div>

      {/* Two-Panel Split Layout */}
      <div style={{ display: "flex", gap: "16px", flex: 1, minHeight: 0 }}>
        {/* Left Panel: Download Jobs */}
        <div className="card" style={{ width: "380px", flexShrink: 0, margin: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div className="card-title" style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Download Jobs ({jobs.length})</span>
            {jobs.some((j) => j.status !== "running") && (
              <button
                className="btn btn-secondary"
                onClick={handleClearCompleted}
                style={{ padding: "3px 8px", fontSize: "0.75rem" }}
              >
                Clear Finished
              </button>
            )}
          </div>

          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "8px", marginTop: "10px" }}>
            {jobs.length === 0 ? (
              <div className="no-data" style={{ padding: "40px 10px", textAlign: "center" }}>
                No download jobs created yet. Enter a playlist URL above to begin.
              </div>
            ) : (
              jobs.map((job) => {
                const isSelected = selectedJobId === job.id;
                const statusColor =
                  job.status === "completed"
                    ? "var(--success)"
                    : job.status === "failed" || job.status === "cancelled"
                    ? "var(--danger)"
                    : "var(--accent-purple-hover)";

                return (
                  <div
                    key={job.id}
                    onClick={() => setSelectedJobId(job.id)}
                    style={{
                      padding: "10px 12px",
                      borderRadius: "8px",
                      border: isSelected ? "1px solid var(--accent-purple)" : "1px solid var(--border-color)",
                      backgroundColor: isSelected ? "rgba(138, 92, 246, 0.12)" : "var(--bg-tertiary)",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: "6px",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontWeight: 600, fontSize: "0.85rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "220px" }} title={job.title || job.url}>
                        {job.title || job.url}
                      </span>
                      
                      {/* Status badge & Cross / Retry buttons */}
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span style={{ fontSize: "0.72rem", color: statusColor, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                          {job.status === "running" ? `${Math.round(job.progress)}%` : job.status}
                        </span>

                        {job.status === "running" ? (
                          <button
                            onClick={(e) => handleCancelJob(job.id, e)}
                            style={{
                              background: "rgba(239, 68, 68, 0.15)",
                              border: "1px solid var(--danger)",
                              color: "var(--danger)",
                              borderRadius: "4px",
                              cursor: "pointer",
                              padding: "1px 5px",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: "0.7rem",
                            }}
                            title="Stop Download Job"
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="18" y1="6" x2="6" y2="18"></line>
                              <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                          </button>
                        ) : (
                          <button
                            onClick={(e) => handleRetryJob(job, e)}
                            style={{
                              background: "rgba(138, 92, 246, 0.15)",
                              border: "1px solid var(--accent-purple)",
                              color: "var(--accent-purple-hover)",
                              borderRadius: "4px",
                              cursor: "pointer",
                              padding: "1px 5px",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: "0.7rem",
                            }}
                            title="Retry Download Job"
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M21.5 2v6h-6M2.5 22v-6h6"/>
                              <path d="M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>

                    <ProgressBar progress={job.progress} status={job.status === "cancelled" ? "failed" : job.status} height={4} />

                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.72rem", color: "var(--text-secondary)" }}>
                      <span>
                        {job.current_item && job.total_items
                          ? `Track ${job.current_item}/${job.total_items} (${job.audio_format})`
                          : `Format: ${job.audio_format}`}
                      </span>
                      <span>{new Date(job.start_time).toLocaleTimeString()}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Panel: Job Details & Real-Time Console Logs */}
        <div className="card" style={{ flex: 1, margin: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {selectedJob ? (
            <>
              <div className="card-title" style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Job Details & Execution Logs</span>
                {selectedJob.status === "running" ? (
                  <button className="btn btn-danger" onClick={() => handleCancelJob(selectedJob.id)} style={{ padding: "4px 10px", fontSize: "0.78rem" }}>
                    🛑 Stop Job
                  </button>
                ) : (
                  <button className="btn btn-secondary" onClick={() => handleRetryJob(selectedJob)} style={{ padding: "4px 10px", fontSize: "0.78rem", color: "var(--accent-purple-hover)" }}>
                    🔄 Retry Job
                  </button>
                )}
              </div>

              {/* Selected Job Metadata */}
              <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "6px", fontSize: "0.82rem", backgroundColor: "var(--bg-tertiary)", padding: "10px 14px", borderRadius: "8px", marginTop: "10px", flexShrink: 0 }}>
                <span className="text-secondary">Progress:</span>
                <span style={{ fontWeight: 600, color: "var(--accent-purple-hover)" }}>
                  {selectedJob.current_item && selectedJob.total_items
                    ? `Item ${selectedJob.current_item} of ${selectedJob.total_items} (${Math.round(selectedJob.progress)}%)`
                    : `${Math.round(selectedJob.progress)}% (${selectedJob.status})`}
                </span>

                <span className="text-secondary">URL:</span>
                <span style={{ wordBreak: "break-all", fontFamily: "var(--font-mono)" }}>{selectedJob.url}</span>
                
                <span className="text-secondary">Destination:</span>
                <span style={{ wordBreak: "break-all", fontFamily: "var(--font-mono)" }}>{selectedJob.output_dir}</span>
                
                <span className="text-secondary">Format:</span>
                <span>{selectedJob.audio_format} (Quality: 0)</span>
                
                <span className="text-secondary">Archive File:</span>
                <span>{selectedJob.use_archive ? (selectedJob.archive_path || `${selectedJob.output_dir}/archive.txt`) : "Disabled"}</span>
              </div>

              {/* Console Log Output Window (Takes Full Remaining Height) */}
              <div
                ref={logBoxRef}
                className="console-log"
                style={{
                  flex: 1,
                  minHeight: 0,
                  height: "100%",
                  overflowY: "auto",
                  marginTop: "12px",
                  fontSize: "0.78rem",
                  fontFamily: "var(--font-mono)",
                  lineHeight: 1.4,
                }}
              >
                {selectedJob.logs.length === 0 ? "Awaiting log output..." : selectedJob.logs.join("\n")}
              </div>
            </>
          ) : (
            <div className="no-data" style={{ margin: "auto" }}>
              Select a download job on the left panel to inspect details and live terminal output.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
