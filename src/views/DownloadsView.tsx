import React, { useState, useEffect, useMemo, useRef } from "react";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  MainConfig,
  DownloadEntry,
  DownloadGlobalSettings,
  DownloadJob,
  DownloadLogPayload,
  DownloadProgressPayload,
  SystemBinariesStatus,
  PlaylistMetadata,
  ReconcilePlaylistReport,
} from "../types";


import { EntryCard } from "../components/downloads/EntryCard";
import { LabelFilter } from "../components/downloads/LabelFilter";
import { EntryDetail } from "../components/downloads/EntryDetail";
import { JobConsole } from "../components/downloads/JobConsole";
import { AddEntryModal } from "../components/downloads/AddEntryModal";
import { GlobalSettingsPanel } from "../components/downloads/GlobalSettingsPanel";
import { ConfirmModal } from "../components/common/ConfirmModal";

type DownloadsViewProps = {
  config: MainConfig | null;
};

function getYtDlpCommandLine(params: {
  url: string;
  outputDir: string;
  audioFormat: string;
  useArchive: boolean;
  archivePath?: string;
  ignoreErrors: boolean;
  folderName?: string;
}): string {
  const args: string[] = [];
  if (params.ignoreErrors) {
    args.push("--ignore-errors");
  }
  args.push("-f", '"ba[ext=m4a]/ba"');
  args.push("-x");
  args.push("--audio-format", params.audioFormat);
  args.push("--audio-quality", "0");
  args.push("--embed-thumbnail");
  args.push("--embed-metadata");
  args.push("--convert-thumbnails", "jpg");

  if (params.useArchive) {
    const arch = params.archivePath?.trim() ? params.archivePath : `${params.outputDir}/archive.txt`;
    args.push("--download-archive", `"${arch}"`);
  }

  const folderPart = params.folderName?.trim() ? params.folderName.trim() : "%(playlist_title)s";
  const outTemplate = `"${params.outputDir}/${folderPart}/%(title)s.%(ext)s"`;
  args.push("-o", outTemplate);
  args.push(`"${params.url}"`);

  return `$ yt-dlp ${args.join(" ")}`;
}

export const DownloadsView: React.FC<DownloadsViewProps> = ({ config }) => {
  // Binary detection status
  const [binaries, setBinaries] = useState<SystemBinariesStatus | null>(null);

  useEffect(() => {
    invoke<SystemBinariesStatus>("check_system_binaries")
      .then(setBinaries)
      .catch((e) => console.error("Error checking system binaries:", e));
  }, []);

  // Default destination calculation from active workspace
  const defaultDest = config?.workspaceDir
    ? `${config.workspaceDir.replace(/\\/g, "/")}/Youtube`
    : config?.sourceDir
    ? `${config.sourceDir.replace(/\\/g, "/")}/Youtube`
    : "";

  // Global Settings state
  const [globalSettings, setGlobalSettings] = useState<DownloadGlobalSettings>({
    default_output_dir: defaultDest,
    default_audio_format: "m4a/mp3",
    default_use_archive: true,
    archive_path: "",
    default_ignore_errors: true,
    max_parallel_jobs: 2,
  });
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);

  // Entries State
  const [entries, setEntries] = useState<DownloadEntry[]>([]);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  // Delete confirmation modal
  const [deleteConfirmEntryId, setDeleteConfirmEntryId] = useState<string | null>(null);
  const [isDeletingEntry, setIsDeletingEntry] = useState(false);

  // Background Metadata Refreshing state per entry ID
  const [refreshingEntryIds, setRefreshingEntryIds] = useState<string[]>([]);

  // Sorting state for entries
  type SortByOption = "name" | "created" | "updated";
  type SortOrder = "asc" | "desc";
  const [sortBy, setSortBy] = useState<SortByOption>("updated");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");


  // Resizable panel width state (Persisted in localStorage)
  const [leftWidth, setLeftWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("dl_left_panel_width");
      return saved ? parseInt(saved, 10) : 420;
    } catch (e) {
      return 420;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("dl_left_panel_width", leftWidth.toString());
    } catch (e) {}
  }, [leftWidth]);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const newWidth = startWidth + deltaX;
      if (newWidth > 240 && newWidth < 800) {
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

  // Label Filtering State
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [filterMode, setFilterMode] = useState<"and" | "or">("or");

  // Add Entry Modal State
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  // Jobs & Execution State (Transient, keyed by jobId)
  const [jobs, setJobs] = useState<DownloadJob[]>([]);

  // Batch Queue Engine State
  const [batchSummary, setBatchSummary] = useState<{ total: number; done: number; failed: number } | null>(null);
  const [consoleTab, setConsoleTab] = useState<"logs" | "queue">("logs");

  // Load Global Settings & Entries from SQLite on mount
  useEffect(() => {
    const loadStore = async () => {
      try {
        const settings = await invoke<DownloadGlobalSettings>("dl_store_get_global_settings");
        if (!settings.default_output_dir && defaultDest) {
          settings.default_output_dir = defaultDest;
        }
        setGlobalSettings(settings);

        const loadedEntries = await invoke<DownloadEntry[]>("dl_store_get_all_entries");
        setEntries(loadedEntries);
        if (loadedEntries.length > 0 && !selectedEntryId) {
          setSelectedEntryId(loadedEntries[0].id);
        }
      } catch (e) {
        console.error("Error loading download store:", e);
      }
    };
    loadStore();
  }, []);

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
              if (line.startsWith("$ yt-dlp ") && j.logs.some((l) => l.startsWith("$ yt-dlp "))) {
                return j;
              }
              return { ...j, logs: [...j.logs, line] };
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

        if (job_id) {
          const match = job_id.match(/^dl_([^_]+)/);
          const entryId = match ? match[1] : null;
          if (entryId) {
            setEntries((prev) =>
              prev.map((e) => {
                if (e.id === entryId) {
                  let updated = false;
                  let newTotal = e.total_songs;
                  let newCount = e.songs_on_disk;
                  if (total_items && total_items > 0 && e.total_songs !== total_items) {
                    newTotal = total_items;
                    updated = true;
                  }
                  if (current_item && current_item > 1 && current_item - 1 > e.songs_on_disk) {
                    newCount = current_item - 1;
                    updated = true;
                  }
                  return updated ? { ...e, total_songs: newTotal, songs_on_disk: newCount } : e;
                }
                return e;
              })
            );
          }
        }
      });
    };

    setupListeners();

    return () => {
      if (unlistenLog) unlistenLog();
      if (unlistenProgress) unlistenProgress();
    };
  }, []);

  // Extract all unique labels across entries
  const allExistingLabels = useMemo(() => {
    const set = new Set<string>();
    entries.forEach((e) => {
      if (e.labels) {
        e.labels.split(",").forEach((l) => {
          const trimmed = l.trim();
          if (trimmed) set.add(trimmed);
        });
      }
    });
    return Array.from(set);
  }, [entries]);



  // Filter and sort entries according to active label filter, mode, and sort option
  const filteredEntries = useMemo(() => {
    let list = entries;
    if (selectedLabels.length > 0) {
      list = entries.filter((e) => {
        const entryLabels = e.labels
          ? e.labels.split(",").map((l) => l.trim()).filter(Boolean)
          : [];
        if (filterMode === "and") {
          return selectedLabels.every((sl) => entryLabels.includes(sl));
        } else {
          return selectedLabels.some((sl) => entryLabels.includes(sl));
        }
      });
    }

    return [...list].sort((a, b) => {
      let result = 0;
      if (sortBy === "name") {
        const nameA = (a.name || a.playlist_title || a.url).toLowerCase();
        const nameB = (b.name || b.playlist_title || b.url).toLowerCase();
        result = nameA.localeCompare(nameB);
      } else if (sortBy === "created") {
        result = (a.created_at || 0) - (b.created_at || 0);
      } else if (sortBy === "updated") {
        result = (a.updated_at || 0) - (b.updated_at || 0);
      }
      return sortOrder === "asc" ? result : -result;
    });
  }, [entries, selectedLabels, filterMode, sortBy, sortOrder]);

  const selectedEntry = entries.find((e) => e.id === selectedEntryId) || null;
  const selectedEntryJob = useMemo(() => {
    if (!selectedEntryId) return undefined;
    return jobs.slice().reverse().find((j) => j.id.startsWith(`dl_${selectedEntryId}`));
  }, [jobs, selectedEntryId]);

  // Label filter handlers
  const handleToggleLabel = (label: string, isMulti: boolean) => {
    if (isMulti) {
      setSelectedLabels((prev) =>
        prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]
      );
    } else {
      setSelectedLabels((prev) =>
        prev.length === 1 && prev[0] === label ? [] : [label]
      );
    }
  };

  const handleClearLabels = () => {
    setSelectedLabels([]);
  };

  // Global Settings Saver
  const handleSaveGlobalSettings = async (updated: DownloadGlobalSettings) => {
    try {
      await invoke("dl_store_save_global_settings", { settings: updated });
      setGlobalSettings(updated);
    } catch (e) {
      alert("Error saving global settings: " + e);
    }
  };

  // Entry CRUD Operations
  const handleSaveEntry = async (updated: DownloadEntry) => {
    try {
      const oldEntry = entries.find((e) => e.id === updated.id);
      if (oldEntry && oldEntry.name && updated.name && oldEntry.name.trim() !== updated.name.trim()) {
        const outDir = updated.output_dir || globalSettings?.default_output_dir;
        if (outDir) {
          try {
            await invoke("dl_rename_entry_folder", {
              outputDir: outDir,
              oldName: oldEntry.name,
              newName: updated.name,
            });
          } catch (renameErr) {
            console.warn("Folder rename warning:", renameErr);
          }
        }
      }
      await invoke("dl_store_save_entry", { entry: updated });
      setEntries((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
    } catch (e) {
      alert("Error saving entry: " + e);
    }
  };

  const handleDeleteEntry = (entryId: string) => {
    setDeleteConfirmEntryId(entryId);
  };

  const handleConfirmDeleteEntry = async () => {
    if (!deleteConfirmEntryId) return;
    const entryId = deleteConfirmEntryId;
    setIsDeletingEntry(true);
    try {
      await invoke("dl_store_delete_entry", { id: entryId });
      setEntries((prevEntries) => {
        const remaining = prevEntries.filter((e) => e.id !== entryId);
        if (selectedEntryId === entryId) {
          setSelectedEntryId(remaining.length > 0 ? remaining[0].id : null);
        }
        return remaining;
      });
      setDeleteConfirmEntryId(null);
    } catch (e) {
      alert("Error deleting entry: " + e);
    } finally {
      setIsDeletingEntry(false);
    }
  };

  const handleDeleteFilesExecuted = async (entryId: string) => {
    // Refresh song count after deletion
    const entryToUpdate = entries.find((e) => e.id === entryId);
    if (!entryToUpdate) return;

    const count = await invoke<number>("dl_count_songs_on_disk", {
      outputDir: entryToUpdate.output_dir,
      playlistTitle: entryToUpdate.name || entryToUpdate.playlist_title,
      formats: [],
    });

    const updated = {
      ...entryToUpdate,
      songs_on_disk: count,
      status: count === 0 ? ("new" as const) : count >= entryToUpdate.total_songs ? ("complete" as const) : ("partial" as const),
      updated_at: Date.now(),
    };
    await handleSaveEntry(updated);
  };

  const handleRefreshMetadata = async (entry: DownloadEntry) => {
    setRefreshingEntryIds((prev) => [...prev, entry.id]);
    try {
      const meta = await invoke<PlaylistMetadata>("dl_fetch_playlist_metadata", {
        url: entry.url,
      });

      const count = await invoke<number>("dl_count_songs_on_disk", {
        outputDir: entry.output_dir,
        playlistTitle: entry.name || meta.title || entry.playlist_title,
        formats: [],
      });

      const updatedStatus =
        meta.total_songs > 0 && count >= meta.total_songs
          ? "complete"
          : count > 0
          ? "partial"
          : entry.status;

      // Update name if entry.name is empty, equal to default placeholder, or equal to raw URL
      const isDefaultName =
        !entry.name ||
        entry.name === "Playlist Entry" ||
        entry.name === entry.url ||
        entry.name.trim() === "";
      const finalName = isDefaultName && meta.title ? meta.title : entry.name || meta.title || "Playlist Entry";

      const updated: DownloadEntry = {
        ...entry,
        name: finalName,
        playlist_title: meta.title || entry.playlist_title || finalName,
        artist: meta.artist || entry.artist,
        album: meta.album || entry.album,
        total_songs: meta.total_songs,
        songs_on_disk: count,
        status: updatedStatus as any,
        updated_at: Date.now(),
      };

      await handleSaveEntry(updated);
    } catch (e) {
      alert(`Error parsing playlist info: ${e}\n(The playlist might be private or unavailable)`);
      // Fallback: just count disk files
      const count = await invoke<number>("dl_count_songs_on_disk", {
        outputDir: entry.output_dir,
        playlistTitle: entry.name || entry.playlist_title,
        formats: [],
      });

      const updated: DownloadEntry = {
        ...entry,
        songs_on_disk: count,
        updated_at: Date.now(),
      };
      await handleSaveEntry(updated);
    } finally {
      setRefreshingEntryIds((prev) => prev.filter((id) => id !== entry.id));
    }
  };


  // Add Entry handler
  const handleAddEntrySubmit = async (data: {
    url: string;
    name: string;
    labels: string;
    output_dir: string;
    audio_format: string | null;
    use_archive: boolean | null;
    metadata?: PlaylistMetadata;
    startDownloadImmediately?: boolean;
  }) => {
    const id = `entry_${Date.now()}`;
    const totalSongs = data.metadata?.total_songs || 0;

    const count = await invoke<number>("dl_count_songs_on_disk", {
      outputDir: data.output_dir,
      playlistTitle: data.metadata?.title || data.name,
      formats: [],
    }).catch(() => 0);

    const initialName = data.name.trim();

    const newEntry: DownloadEntry = {
      id,
      url: data.url,
      name: initialName || data.metadata?.title || "",
      labels: data.labels,
      output_dir: data.output_dir,
      audio_format: data.audio_format,
      use_archive: data.use_archive,
      ignore_errors: null,
      total_songs: totalSongs,
      songs_on_disk: count,
      playlist_title: data.metadata?.title || initialName || "",
      artist: data.metadata?.artist || "",
      album: data.metadata?.album || "",
      status: count > 0 && totalSongs > 0 && count >= totalSongs ? "complete" : count > 0 ? "partial" : "new",
      last_download_at: null,
      last_error: "",
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    try {
      await invoke("dl_store_save_entry", { entry: newEntry });
    } catch (e) {
      console.error("Error saving entry to SQLite:", e);
    }

    setEntries((prev) => [newEntry, ...prev]);
    setSelectedEntryId(id);

    // Trigger metadata refresh to update name, title, artist, total_songs once fetch completes
    handleRefreshMetadata(newEntry);

    if (data.startDownloadImmediately) {
      handleStartSingleDownload(newEntry);
    }
  };

  // Single Entry Download Trigger
  const handleStartSingleDownload = async (targetEntry: DownloadEntry) => {
    // Prevent duplicate download if entry is already downloading
    const isAlreadyRunning = jobs.some(
      (j) => (j.url === targetEntry.url || j.id.startsWith(`dl_${targetEntry.id}_`)) && j.status === "running"
    );
    if (isAlreadyRunning) {
      alert(`A download for "${targetEntry.name || targetEntry.url}" is already in progress.`);
      return;
    }

    // 1. Refresh metadata & count first
    await handleRefreshMetadata(targetEntry);

    const jobId = `dl_${targetEntry.id}_${Date.now()}`;
    const audioFormat = targetEntry.audio_format || globalSettings.default_audio_format;
    const useArchive = targetEntry.use_archive !== null ? targetEntry.use_archive : globalSettings.default_use_archive;
    const ignoreErrors = targetEntry.ignore_errors !== null ? targetEntry.ignore_errors : globalSettings.default_ignore_errors;

    const newJob: DownloadJob = {
      id: jobId,
      url: targetEntry.url,
      output_dir: targetEntry.output_dir,
      audio_format: audioFormat,
      use_archive: useArchive,
      archive_path: globalSettings.archive_path,
      ignore_errors: ignoreErrors,
      status: "running",
      progress: 0,
      logs: [
        getYtDlpCommandLine({
          url: targetEntry.url,
          outputDir: targetEntry.output_dir,
          audioFormat,
          useArchive,
          archivePath: globalSettings.archive_path,
          ignoreErrors,
          folderName: targetEntry.name,
        }),
        `🚀 Initializing yt-dlp download job for: ${targetEntry.name || targetEntry.url}`,
      ],
      start_time: Date.now(),
      title: targetEntry.name,
    };

    setJobs((prev) => [...prev, newJob]);

    // Update entry status to downloading
    const downloadingEntry = { ...targetEntry, status: "downloading" as const };
    setEntries((prev) => prev.map((e) => (e.id === targetEntry.id ? downloadingEntry : e)));
    await invoke("dl_store_save_entry", { entry: downloadingEntry });

    try {
      await invoke("start_download_job", {
        jobId,
        url: newJob.url,
        outputDir: newJob.output_dir,
        audioFormat: newJob.audio_format,
        useArchive: newJob.use_archive,
        archivePath: newJob.archive_path,
        ignoreErrors: newJob.ignore_errors,
        folderName: targetEntry.name,
      });

      await monitorJobCompletion(jobId, targetEntry);
    } catch (e) {
      console.error("Error starting download:", e);
      setJobs((prev) =>
        prev.map((j) => (j.id === jobId ? { ...j, status: "failed", logs: [...j.logs, `❌ Error: ${e}`] } : j))
      );
      const failedEntry = { ...targetEntry, status: "error" as const, last_error: String(e) };
      setEntries((prev) => prev.map((e) => (e.id === targetEntry.id ? failedEntry : e)));
      await invoke("dl_store_save_entry", { entry: failedEntry });
    }
  };

  const monitorJobCompletion = (targetJobId: string, targetEntry: DownloadEntry): Promise<"completed" | "cancelled" | "failed"> => {
    return new Promise((resolve) => {
      let lastDiskPoll = 0;
      const checkInterval = setInterval(async () => {
        const now = Date.now();
        // Periodically refresh songs on disk every 1.5s while download runs
        if (now - lastDiskPoll > 1500) {
          lastDiskPoll = now;
          try {
            const diskCount = await invoke<number>("dl_count_songs_on_disk", {
              outputDir: targetEntry.output_dir,
              playlistTitle: targetEntry.name || targetEntry.playlist_title,
              formats: [],
            });
            setEntries((prev) =>
              prev.map((e) =>
                e.id === targetEntry.id && e.songs_on_disk < diskCount
                  ? { ...e, songs_on_disk: diskCount }
                  : e
              )
            );
          } catch {
            // ignore background disk check race conditions
          }
        }

        setJobs((latestJobs) => {
          const currentJob = latestJobs.find((j) => j.id === targetJobId);
          if (currentJob && currentJob.status !== "running") {
            clearInterval(checkInterval);

            (async () => {
              const count = await invoke<number>("dl_count_songs_on_disk", {
                outputDir: targetEntry.output_dir,
                playlistTitle: targetEntry.name || targetEntry.playlist_title,
                formats: [],
              });

              const outcome: "completed" | "cancelled" | "failed" =
                currentJob.status === "completed"
                  ? "completed"
                  : currentJob.status === "cancelled"
                  ? "cancelled"
                  : "failed";

              const newStatus =
                outcome === "completed"
                  ? "complete"
                  : outcome === "cancelled"
                  ? (count > 0 ? "partial" : "stale")
                  : (count > 0 ? "partial" : "error");

              const updated: DownloadEntry = {
                ...targetEntry,
                songs_on_disk: count,
                status: newStatus as any,
                last_download_at: Date.now(),
                last_error: outcome === "failed" ? "yt-dlp process returned non-zero status" : outcome === "cancelled" ? "Cancelled by user" : "",
                updated_at: Date.now(),
              };

              setEntries((prev) => prev.map((e) => (e.id === targetEntry.id ? updated : e)));
              await invoke("dl_store_save_entry", { entry: updated });
              resolve(outcome);
            })();
          }
          return latestJobs;
        });
      }, 500);
    });
  };

  const handleCancelJob = async (jobId: string) => {
    try {
      await invoke("cancel_download_job", { jobId });
      setJobs((prev) =>
        prev.map((j) => (j.id === jobId ? { ...j, status: "cancelled", logs: [...j.logs, "🛑 Task cancelled by user."] } : j))
      );
    } catch (e) {
      console.error("Error cancelling job:", e);
    }
  };

  // Reconcile single entry archive with disk
  const [reconcilingEntryIds, setReconcilingEntryIds] = useState<string[]>([]);
  const [isReconcilingAll, setIsReconcilingAll] = useState<boolean>(false);

  const handleReconcileEntry = async (targetEntry: DownloadEntry) => {
    setReconcilingEntryIds((prev) => [...prev, targetEntry.id]);
    setConsoleTab("logs");

    const jobId = `dl_${targetEntry.id}_${Date.now()}`;
    const audioFormat = targetEntry.audio_format || globalSettings.default_audio_format;
    const useArchive = targetEntry.use_archive !== null ? targetEntry.use_archive : globalSettings.default_use_archive;
    const ignoreErrors = targetEntry.ignore_errors !== null ? targetEntry.ignore_errors : globalSettings.default_ignore_errors;

    // Check if an existing job for this entry already had logs to create a clear gap
    const existingJob = jobs.slice().reverse().find((j) => j.id.startsWith(`dl_${targetEntry.id}`));
    const initialLogs: string[] = [];
    if (existingJob && existingJob.logs.length > 0) {
      initialLogs.push("", "--------------------------------------------------------------------------------", "");
    }

    const newJob: DownloadJob = {
      id: jobId,
      url: targetEntry.url,
      output_dir: targetEntry.output_dir,
      audio_format: audioFormat,
      use_archive: useArchive,
      archive_path: globalSettings.archive_path,
      ignore_errors: ignoreErrors,
      status: "running",
      progress: 0,
      logs: initialLogs,
      start_time: Date.now(),
      title: targetEntry.name,
    };

    setJobs((prev) => [...prev, newJob]);

    try {
      const report = await invoke<ReconcilePlaylistReport>("dl_reconcile_playlist_archive", {
        jobId,
        url: targetEntry.url,
        outputDir: targetEntry.output_dir,
        playlistTitle: targetEntry.name || targetEntry.playlist_title,
        archivePath: globalSettings.archive_path,
      });

      setJobs((prev) =>
        prev.map((j) => (j.id === jobId ? { ...j, status: "completed", progress: 100 } : j))
      );

      // Refresh metadata and songs on disk count
      await handleRefreshMetadata(targetEntry);

      if (report.missing_count > 0) {
        alert(
          `Reconciliation Complete for "${report.playlist_title}":\n\n` +
          `• Total Online: ${report.total_online}\n` +
          `• Verified on Disk: ${report.matched_on_disk}\n` +
          `• Missing from Disk: ${report.missing_count}\n` +
          `• Pruned from Archive: ${report.pruned_from_archive}\n\n` +
          `Click "Download" to fetch the ${report.missing_count} missing track(s)!`
        );
      } else {
        alert(
          `Reconciliation Complete for "${report.playlist_title}":\n\n` +
          `All ${report.matched_on_disk} track(s) are already present on disk.\n` +
          `The archive has been verified and fully synchronized.`
        );
      }
    } catch (e) {
      console.error("Error reconciling archive:", e);
      setJobs((prev) =>
        prev.map((j) => (j.id === jobId ? { ...j, status: "failed", logs: [...j.logs, `❌ Reconcile Error: ${e}`] } : j))
      );
      alert(`Error reconciling archive: ${e}`);
    } finally {
      setReconcilingEntryIds((prev) => prev.filter((id) => id !== targetEntry.id));
    }
  };

  const handleReconcileAllPlaylists = async () => {
    if (entries.length === 0) {
      alert("No playlist entries available to reconcile.");
      return;
    }

    if (!confirm(`Reconcile archives for all ${entries.length} playlist entries?\n\nThis will scan local folders for each playlist, verify existing songs against YouTube, and prune missing songs from the archive so Download will fetch only the missing tracks.`)) {
      return;
    }

    setIsReconcilingAll(true);
    setConsoleTab("logs");

    const globalJobId = selectedEntry
      ? `dl_${selectedEntry.id}_reconcile_all_${Date.now()}`
      : `dl_reconcile_all_${Date.now()}`;

    const newJob: DownloadJob = {
      id: globalJobId,
      url: selectedEntry?.url || "",
      output_dir: selectedEntry?.output_dir || globalSettings.default_output_dir,
      audio_format: globalSettings.default_audio_format,
      use_archive: globalSettings.default_use_archive,
      archive_path: globalSettings.archive_path,
      ignore_errors: globalSettings.default_ignore_errors,
      status: "running",
      progress: 0,
      logs: [
        "",
        "================================================================================",
        `🔄 RECONCILING ARCHIVES FOR ALL PLAYLISTS (${entries.length} total)`,
        "================================================================================",
      ],
      start_time: Date.now(),
      title: "All Playlists Archive Reconciliation",
    };

    setJobs((prev) => [...prev, newJob]);

    let totalMissingAcrossAll = 0;
    let reconciledCount = 0;

    for (const entry of entries) {
      try {
        const report = await invoke<ReconcilePlaylistReport>("dl_reconcile_playlist_archive", {
          jobId: globalJobId,
          url: entry.url,
          outputDir: entry.output_dir,
          playlistTitle: entry.name || entry.playlist_title,
          archivePath: globalSettings.archive_path,
        });
        totalMissingAcrossAll += report.missing_count;
        reconciledCount++;
      } catch (e) {
        setJobs((prev) =>
          prev.map((j) => (j.id === globalJobId ? { ...j, logs: [...j.logs, `❌ Failed to reconcile "${entry.name}": ${e}`] } : j))
        );
      }
    }

    setJobs((prev) =>
      prev.map((j) =>
        j.id === globalJobId
          ? {
              ...j,
              status: "completed",
              progress: 100,
              logs: [
                ...j.logs,
                "",
                "================================================================================",
                `🎉 All ${reconciledCount} playlist(s) reconciled successfully!`,
                `Total missing track(s) across all playlists: ${totalMissingAcrossAll}`,
                "================================================================================\n",
              ],
            }
          : j
      )
    );

    // Refresh store entries to update songs_on_disk counts
    try {
      const loadedEntries = await invoke<DownloadEntry[]>("dl_store_get_all_entries");
      setEntries(loadedEntries);
    } catch (e) {}

    setIsReconcilingAll(false);
    alert(
      `All ${reconciledCount} playlist(s) reconciled!\n\n` +
      `Total missing tracks across all playlists: ${totalMissingAcrossAll}\n` +
      `You can now click "Download All" or download individual entries to fetch missing tracks.`
    );
  };

  // Batch "Download All" Queue Engine
  const [batchQueueEntries, setBatchQueueEntries] = useState<DownloadEntry[]>([]);
  const isBatchCancelledRef = useRef(false);

  const handleCancelAllBatchJobs = async () => {
    isBatchCancelledRef.current = true;
    // Kill all running jobs in parallel
    const runningJobs = jobs.filter((j) => j.status === "running");
    for (const job of runningJobs) {
      await handleCancelJob(job.id);
    }
  };

  const handleStartBatchDownload = async () => {
    // Find URLs of entries that are ALREADY running
    const activeJobUrls = new Set(
      jobs.filter((j) => j.status === "running").map((j) => j.url)
    );

    // Exclude complete entries AND entries that are currently downloading
    const queueEntries = filteredEntries.filter(
      (e) => e.status !== "complete" && !activeJobUrls.has(e.url)
    );

    if (queueEntries.length === 0) {
      if (activeJobUrls.size > 0) {
        alert("All remaining incomplete entries are already downloading!");
      } else {
        alert("All visible entries in this filter are already complete!");
      }
      return;
    }

    isBatchCancelledRef.current = false;
    setBatchQueueEntries(queueEntries);
    setBatchSummary({ total: queueEntries.length, done: 0, failed: 0 });
    setConsoleTab("queue");

    const maxParallel = globalSettings.max_parallel_jobs || 2;
    const remainingQueue = [...queueEntries];

    const runNextBatchItem = async (): Promise<void> => {
      if (remainingQueue.length === 0 || isBatchCancelledRef.current) return;
      const nextEntry = remainingQueue.shift()!;

      // Try single run
      let outcome = await runSingleJobInBatch(nextEntry);

      // DO NOT retry if manually cancelled by user!
      if (outcome === "failed" && !isBatchCancelledRef.current) {
        // Retry ONCE for transient network error
        outcome = await runSingleJobInBatch(nextEntry);
      }

      const isSuccess = outcome === "completed";
      setBatchSummary((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          done: prev.done + (isSuccess ? 1 : 0),
          failed: prev.failed + (isSuccess ? 0 : 1),
        };
      });

      if (remainingQueue.length > 0 && !isBatchCancelledRef.current) {
        await runNextBatchItem();
      }
    };

    const initialWorkers = [];
    for (let i = 0; i < Math.min(maxParallel, queueEntries.length); i++) {
      initialWorkers.push(runNextBatchItem());
    }

    await Promise.all(initialWorkers);
  };

  const runSingleJobInBatch = async (entry: DownloadEntry): Promise<"completed" | "cancelled" | "failed"> => {
    if (isBatchCancelledRef.current) return "cancelled";

    // Guard against duplicate execution if entry started running concurrently
    const isAlreadyRunning = jobs.some(
      (j) => (j.url === entry.url || j.id.startsWith(`dl_${entry.id}_`)) && j.status === "running"
    );
    if (isAlreadyRunning) {
      return "completed";
    }

    const jobId = `dl_${entry.id}_${Date.now()}`;
    const audioFormat = entry.audio_format || globalSettings.default_audio_format;
    const useArchive = entry.use_archive !== null ? entry.use_archive : globalSettings.default_use_archive;
    const ignoreErrors = entry.ignore_errors !== null ? entry.ignore_errors : globalSettings.default_ignore_errors;

    const newJob: DownloadJob = {
      id: jobId,
      url: entry.url,
      output_dir: entry.output_dir,
      audio_format: audioFormat,
      use_archive: useArchive,
      archive_path: globalSettings.archive_path,
      ignore_errors: ignoreErrors,
      status: "running",
      progress: 0,
      logs: [
        getYtDlpCommandLine({
          url: entry.url,
          outputDir: entry.output_dir,
          audioFormat,
          useArchive,
          archivePath: globalSettings.archive_path,
          ignoreErrors,
          folderName: entry.name,
        }),
        `🚀 Initializing batch job for: ${entry.name}`,
      ],
      start_time: Date.now(),
      title: entry.name,
    };

    setJobs((prev) => [...prev, newJob]);

    try {
      await invoke("start_download_job", {
        jobId,
        url: newJob.url,
        outputDir: newJob.output_dir,
        audioFormat: newJob.audio_format,
        useArchive: newJob.use_archive,
        archivePath: newJob.archive_path,
        ignoreErrors: newJob.ignore_errors,
        folderName: entry.name,
      });

      return await monitorJobCompletion(jobId, entry);
    } catch (e) {
      setJobs((prev) =>
        prev.map((j) => (j.id === jobId ? { ...j, status: "failed", logs: [...j.logs, `❌ Error: ${e}`] } : j))
      );
      return "failed";
    }
  };

  // Map ALL queued entries to BatchQueueItems for JobConsole Queue tab
  const batchQueueItems = useMemo(() => {
    if (batchQueueEntries.length === 0) return [];
    return batchQueueEntries.map((entry) => {
      const job = jobs.slice().reverse().find((j) => j.id.startsWith(`dl_${entry.id}`));
      let status: "pending" | "running" | "completed" | "failed" | "cancelled" = "pending";
      if (job) {
        if (job.status === "running") status = "running";
        else if (job.status === "completed") status = "completed";
        else if (job.status === "cancelled") status = "cancelled";
        else if (job.status === "failed") status = "failed";
      }
      return { entry, job, status };
    });
  }, [batchQueueEntries, jobs]);

  // Sticky progress calculations
  const isBatchRunning = batchSummary && batchSummary.done + batchSummary.failed < batchSummary.total;

  return (
    <div className="view-container" style={{ display: "flex", flexDirection: "column", height: "100%", flex: 1, minHeight: 0, gap: "12px", overflow: "hidden" }}>
      {/* Top Header Row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <div>
          <h1 style={{ fontSize: "1.3rem", margin: 0 }}>Downloads Management</h1>
          <p className="subtitle" style={{ margin: "2px 0 0 0", fontSize: "0.82rem" }}>
            Persistent, taggable download entries with serial/parallel queue automation and download archives.
          </p>
        </div>

        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          {binaries && (
            <div style={{ display: "flex", gap: "6px", fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: "4px",
                  backgroundColor: binaries.ytdlp_installed ? "rgba(34, 197, 94, 0.15)" : "rgba(239, 68, 68, 0.15)",
                  color: binaries.ytdlp_installed ? "var(--success)" : "var(--danger)",
                  border: `1px solid ${binaries.ytdlp_installed ? "var(--success)" : "var(--danger)"}`,
                }}
                title={binaries.ytdlp_installed ? `yt-dlp version: ${binaries.ytdlp_version}` : "yt-dlp missing"}
              >
                {binaries.ytdlp_installed ? `✓ yt-dlp ${binaries.ytdlp_version || "ready"}` : "✗ yt-dlp missing"}
              </span>
            </div>
          )}

          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShowGlobalSettings(!showGlobalSettings)}
            style={{ padding: "4px 10px", fontSize: "0.8rem" }}
          >
            ⚙ Global Settings
          </button>
        </div>
      </div>

      {/* Global Settings Panel (Collapsible) */}
      <GlobalSettingsPanel
        isOpen={showGlobalSettings}
        settings={globalSettings}
        onSaveSettings={handleSaveGlobalSettings}
        onClose={() => setShowGlobalSettings(false)}
        onReconcileAll={handleReconcileAllPlaylists}
        isReconcilingAll={isReconcilingAll}
      />

      {/* Main Two-Panel Layout */}
      <div style={{ display: "flex", gap: "0px", flex: 1, minHeight: 0 }}>
        {/* LEFT PANEL: Label Filters & Entry Grid (Takes dynamic leftWidth) */}
        <div className="card" style={{ width: `${leftWidth}px`, flexShrink: 0, margin: 0, display: "flex", flexDirection: "column", minHeight: 0, gap: "10px" }}>
          {/* Label Filter Header with Embedded Sort Cue */}
          <LabelFilter
            allLabels={allExistingLabels}
            selectedLabels={selectedLabels}
            filterMode={filterMode}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onToggleLabel={handleToggleLabel}
            onClearFilter={handleClearLabels}
            onToggleMode={setFilterMode}
            onSortChange={(newSortBy, newSortOrder) => {
              setSortBy(newSortBy);
              setSortOrder(newSortOrder);
            }}
          />

          {/* Entry Grid Container */}
          <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", minHeight: 0, marginTop: "4px" }}>
            {filteredEntries.length === 0 ? (
              <div className="no-data" style={{ padding: "40px 10px", textAlign: "center", fontSize: "0.82rem" }}>
                {entries.length === 0
                  ? "No download entries created yet. Click '+ Add Entry' below to begin."
                  : "No download entries match the selected label filter."}
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: "8px" }}>
                {filteredEntries.map((entry) => {
                  const activeJob = jobs.slice().reverse().find((j) => j.id.startsWith(`dl_${entry.id}`));
                  return (
                    <EntryCard
                      key={entry.id}
                      entry={entry}
                      isSelected={selectedEntryId === entry.id}
                      activeJob={activeJob}
                      isRefreshing={refreshingEntryIds.includes(entry.id)}
                      onSelect={() => setSelectedEntryId(entry.id)}
                    />
                  );
                })}
              </div>
            )}
          </div>

          {/* Left Panel Bottom Action Bar */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--border-color)", paddingTop: "8px" }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setIsAddModalOpen(true)}
              style={{ padding: "6px 12px", fontSize: "0.82rem" }}
            >
              + Add Entry
            </button>

            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <select
                value={globalSettings.max_parallel_jobs}
                onChange={(e) =>
                  handleSaveGlobalSettings({
                    ...globalSettings,
                    max_parallel_jobs: parseInt(e.target.value) || 2,
                  })
                }
                style={{ padding: "3px 6px", fontSize: "0.75rem", borderRadius: "4px", height: "30px" }}
                title="Max parallel download jobs"
              >
                <option value={1}>1 Job</option>
                <option value={2}>2 Parallel</option>
                <option value={3}>3 Parallel</option>
                <option value={4}>4 Parallel</option>
              </select>

              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleStartBatchDownload}
                disabled={isBatchRunning || filteredEntries.length === 0}
                style={{ padding: "6px 12px", fontSize: "0.82rem", color: "var(--accent-purple-hover)" }}
              >
                ▶ Download All
              </button>
            </div>
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
          title="Drag to resize entries panel"
        >
          <div
            style={{
              width: "2px",
              height: "40px",
              borderRadius: "1px",
              backgroundColor: "var(--border-color)",
              transition: "background-color 0.2s",
            }}
            className="resizable-indicator"
          />
        </div>

        {/* RIGHT PANEL: Top Half Entry Detail, Bottom Half Job Console */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "12px", minHeight: 0 }}>
          {/* Top Half: Selected Entry Configuration */}
          <div className="card" style={{ margin: 0, padding: "14px 16px", flexShrink: 0 }}>
            <EntryDetail
              entry={selectedEntry}
              globalSettings={globalSettings}
              allExistingLabels={allExistingLabels}
              activeJob={selectedEntryJob}
              isRefreshingEntry={selectedEntry ? refreshingEntryIds.includes(selectedEntry.id) : false}
              isReconciling={selectedEntry ? reconcilingEntryIds.includes(selectedEntry.id) : false}
              onSaveEntry={handleSaveEntry}
              onRefreshMetadata={handleRefreshMetadata}
              onStartDownload={handleStartSingleDownload}
              onCancelDownload={handleCancelJob}
              onReconcileArchive={handleReconcileEntry}
              onDeleteEntry={handleDeleteEntry}
              onDeleteFilesExecuted={handleDeleteFilesExecuted}
            />
          </div>

          {/* Bottom Half: Job Console (Logs & Queue Tabs) */}
          <div className="card" style={{ flex: 1, margin: 0, padding: "12px 16px", display: "flex", flexDirection: "column", minHeight: 0 }}>
            <JobConsole
              activeTab={consoleTab}
              onTabChange={setConsoleTab}
              selectedJobLogs={selectedEntryJob?.logs || []}
              selectedJobTitle={selectedEntry?.name}
              selectedJobId={selectedEntryJob?.id || selectedEntry?.id}
              batchQueueItems={batchQueueItems}
              isBatchRunning={!!isBatchRunning}
              onCancelJob={handleCancelJob}
              onCancelAllBatchJobs={handleCancelAllBatchJobs}
            />
          </div>

        </div>
      </div>

      {/* STICKY DOWNLOAD ALL PROGRESS BAR */}
      {batchSummary && (
        <div
          onClick={() => setConsoleTab("queue")}
          style={{
            position: "sticky",
            bottom: 0,
            left: 0,
            right: 0,
            backgroundColor: "var(--bg-tertiary)",
            border: "1.5px solid var(--accent-purple)",
            borderRadius: "8px",
            padding: "10px 16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",

            boxShadow: "0 -4px 15px rgba(0, 0, 0, 0.4)",
            cursor: "pointer",
            zIndex: 100,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flex: 1 }}>
            <span style={{ fontWeight: 600, fontSize: "0.85rem", color: "var(--accent-purple-hover)" }}>
              {isBatchRunning ? "⚡ Batch Downloading:" : "✅ Batch Finished:"} {batchSummary.done + batchSummary.failed} / {batchSummary.total} entries
            </span>

            <div style={{ flex: 1, maxWidth: "300px" }}>
              <div
                style={{
                  height: "6px",
                  backgroundColor: "var(--bg-surface)",
                  borderRadius: "3px",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${Math.round(((batchSummary.done + batchSummary.failed) / batchSummary.total) * 100)}%`,
                    backgroundColor: "var(--accent-purple)",
                    transition: "width 0.2s ease",
                  }}
                />
              </div>
            </div>

            <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
              ({Math.round(((batchSummary.done + batchSummary.failed) / batchSummary.total) * 100)}%)
            </span>
          </div>

          <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
            <span style={{ fontSize: "0.78rem", color: "var(--success)" }}>🟢 {batchSummary.done} complete</span>
            {batchSummary.failed > 0 && <span style={{ fontSize: "0.78rem", color: "var(--danger)" }}>🔴 {batchSummary.failed} failed</span>}
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", textDecoration: "underline" }}>View Queue ➔</span>
          </div>
        </div>
      )}

      {/* Add Entry Modal */}
      <AddEntryModal
        isOpen={isAddModalOpen}
        globalSettings={globalSettings}
        allExistingLabels={allExistingLabels}
        existingEntries={entries}
        onClose={() => setIsAddModalOpen(false)}
        onAddEntry={handleAddEntrySubmit}
      />

      {/* Delete Entry Confirmation Modal */}
      {deleteConfirmEntryId && (() => {
        const entryToDelete = entries.find(e => e.id === deleteConfirmEntryId);
        const entryName = entryToDelete?.playlist_title || entryToDelete?.name || entryToDelete?.url || "this entry";
        return (
          <ConfirmModal
            title="🗑️ Delete Entry"
            message={`Remove "${entryName}" from the downloads list?\n\nFiles already on disk will NOT be deleted.`}
            confirmText="Delete Entry"
            confirmVariant="danger"
            isExecuting={isDeletingEntry}
            executingText="Deleting..."
            onConfirm={handleConfirmDeleteEntry}
            onCancel={() => setDeleteConfirmEntryId(null)}
          />
        );
      })()}
    </div>
  );
};
