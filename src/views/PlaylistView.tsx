import React, { useState, useEffect, useMemo, useRef, useLayoutEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MainConfig, AudioTrack, TrackPreview, PlaylistSummaryItem } from "../types";
import { ResolvedTracksPanel } from "../components/ResolvedTracksPanel";
import { ConfirmModal } from "../components/common/ConfirmModal";
import { DuplicateAnalysisModal } from "../components/DuplicateAnalysisModal";

export type { TrackPreview };

type PlaylistViewProps = {
  configPath: string;
  config: MainConfig | null;
  setConfig: (config: MainConfig | null) => void;
  formats: string;
  onPlayTrack: (track: AudioTrack, queue: AudioTrack[], playlistName: string) => void;
  onPlayQueue?: (queue: AudioTrack[], playlistName: string, shuffle?: boolean) => void;
  relativeToConfig: boolean;
  addBackgroundTask?: (id: string, name: string, taskPromise: Promise<any>) => void;
};

export const PlaylistView: React.FC<PlaylistViewProps> = ({
  configPath,
  config,
  setConfig,
  formats,
  onPlayTrack,
  onPlayQueue,
  relativeToConfig,
  addBackgroundTask,
}) => {
  const [selectedPlaylistIndex, setSelectedPlaylistIndex] = useState<number | null>(null);
  const [selectedBucketKey, setSelectedBucketKey] = useState<string>("all");
  const [previews, setPreviews] = useState<TrackPreview[]>([]);
  const [previewError, setPreviewError] = useState<string>("");
  const [isLoadingPreview, setIsLoadingPreview] = useState<boolean>(false);
  const [generationLogs, setGenerationLogs] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [showLogsModal, setShowLogsModal] = useState<boolean>(false);
  const [dupModalTarget, setDupModalTarget] = useState<{
    open: boolean;
    playlistIndex: number | null;
    playlistName?: string;
  }>({ open: false, playlistIndex: null });
  const compilationLogsRef = useRef<HTMLDivElement | null>(null);
  const isCompilationAutoScrollRef = useRef<boolean>(true);
  const [isCompilationAutoScroll, setIsCompilationAutoScroll] = useState<boolean>(true);

  const handleCompilationLogsScroll = () => {
    if (!compilationLogsRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = compilationLogsRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight <= 45;
    isCompilationAutoScrollRef.current = isAtBottom;
    setIsCompilationAutoScroll((prev) => (prev !== isAtBottom ? isAtBottom : prev));
  };

  const handleCompilationScrollToLatest = () => {
    if (compilationLogsRef.current) {
      compilationLogsRef.current.scrollTop = compilationLogsRef.current.scrollHeight;
      isCompilationAutoScrollRef.current = true;
      setIsCompilationAutoScroll(true);
    }
  };

  useLayoutEffect(() => {
    if (showLogsModal && compilationLogsRef.current && isCompilationAutoScrollRef.current) {
      compilationLogsRef.current.scrollTop = compilationLogsRef.current.scrollHeight;
    }
  }, [generationLogs, showLogsModal]);

  // Full scan summaries for sidebar refresh & track counting
  const [summaries, setSummaries] = useState<PlaylistSummaryItem[]>([]);
  const [isScanningSummary, setIsScanningSummary] = useState<boolean>(false);

  const [isConfirmingDelete, setIsConfirmingDelete] = useState<boolean>(false);
  const [deleteSourceTarget, setDeleteSourceTarget] = useState<{ index: number; path: string } | null>(null);
  const [deleteExclusionTarget, setDeleteExclusionTarget] = useState<{ index: number; path: string } | null>(null);

  // Helper to add a custom merge span to custom_merges list
  const addCustomMerge = (currentMerges: [number, number][] = [], newRange: [number, number]): [number, number][] => {
    const merged: [number, number][] = [];
    let start = Math.min(newRange[0], newRange[1]);
    let end = Math.max(newRange[0], newRange[1]);

    for (const [s, e] of currentMerges) {
      const curStart = Math.min(s, e);
      const curEnd = Math.max(s, e);
      if (Math.max(start, curStart) <= Math.min(end, curEnd)) {
        start = Math.min(start, curStart);
        end = Math.max(end, curEnd);
      } else {
        merged.push([curStart, curEnd]);
      }
    }
    merged.push([start, end]);
    merged.sort((a, b) => a[0] - b[0]);
    return merged;
  };

  // Helper to remove a custom merge span
  const removeCustomMerge = (currentMerges: [number, number][] = [], target: [number, number]): [number, number][] => {
    const tStart = Math.min(target[0], target[1]);
    const tEnd = Math.max(target[0], target[1]);
    return currentMerges.filter(([s, e]) => {
      const curStart = Math.min(s, e);
      const curEnd = Math.max(s, e);
      return !(curStart === tStart && curEnd === tEnd);
    });
  };
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("pl_sidebar_width");
      return saved ? parseInt(saved, 10) : 380;
    } catch (e) {
      return 380;
    }
  });
  const [configWidth, setConfigWidth] = useState<number>(360);
  const [isReordering, setIsReordering] = useState<boolean>(false);
  const [previewsCache, setPreviewsCache] = useState<Record<string, TrackPreview[]>>({});
  const [appendTrackCount, setAppendTrackCount] = useState<boolean>(true);

  // Sorting state for playlist tiles (Config Order vs Name display sort)
  type PlSortBy = "config" | "name";
  type PlSortOrder = "asc" | "desc";
  const [plSortBy, setPlSortBy] = useState<PlSortBy>("config");
  const [plSortOrder, setPlSortOrder] = useState<PlSortOrder>("asc");
  const [showPlSortMenu, setShowPlSortMenu] = useState<boolean>(false);
  const [pinYearSplitAtTop, setPinYearSplitAtTop] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("pl_pin_year_split");
      return saved !== null ? JSON.parse(saved) : true;
    } catch (e) {
      return true;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("pl_pin_year_split", JSON.stringify(pinYearSplitAtTop));
    } catch (e) {}
  }, [pinYearSplitAtTop]);

  useEffect(() => {
    try {
      localStorage.setItem("pl_sidebar_width", sidebarWidth.toString());
    } catch (e) {}
  }, [sidebarWidth]);

  const sortedPlaylistsWithIndex = useMemo(() => {
    if (!config) return [];
    let indexed = config.playlists.map((pl, originalIdx) => ({ pl, originalIdx }));
    if (plSortBy !== "config") {
      indexed = [...indexed].sort((a, b) => {
        const result = a.pl.name.toLowerCase().localeCompare(b.pl.name.toLowerCase());
        return plSortOrder === "asc" ? result : -result;
      });
    }

    if (pinYearSplitAtTop) {
      const yearSplitList: typeof indexed = [];
      const regularList: typeof indexed = [];
      for (const item of indexed) {
        if (item.pl.year_split?.enabled) {
          yearSplitList.push(item);
        } else {
          regularList.push(item);
        }
      }
      return [...yearSplitList, ...regularList];
    }

    return indexed;
  }, [config, plSortBy, plSortOrder, pinYearSplitAtTop]);

  const handleSaveSortedOrderToConfig = () => {
    if (!config) return;
    const newPlaylists = sortedPlaylistsWithIndex.map(({ pl }) => pl);
    setConfig({
      ...config,
      playlists: newPlaylists,
    });
    setPlSortBy("config");
    setShowPlSortMenu(false);
  };

  // Resizing mouse drag handlers
  const handleSidebarMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const newWidth = startWidth + deltaX;
      if (newWidth > 180 && newWidth < 800) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleConfigMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = configWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const newWidth = startWidth + deltaX;
      if (newWidth > 250 && newWidth < 800) {
        setConfigWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const activePlaylist = config && selectedPlaylistIndex !== null && config.playlists[selectedPlaylistIndex] ? config.playlists[selectedPlaylistIndex] : null;

  const rulesFingerprint = activePlaylist ? JSON.stringify({
    sources: activePlaylist.sources,
    exclusions: activePlaylist.exclusions,
    rules: (activePlaylist as any).rules,
    sort_by: (activePlaylist as any).sort_by,
    limit: (activePlaylist as any).limit,
    sourceDir: config?.sourceDir,
    relativeToConfig,
  }) : "";

  const invalidateCacheFor = (idx: number | null) => {
    if (idx === null) return;
    setPreviewsCache((prev) => {
      const copy = { ...prev };
      Object.keys(copy).forEach((k) => {
        if (k.startsWith(`${idx}_`)) {
          delete copy[k];
        }
      });
      return copy;
    });
  };

  const [yearAnalysisProgress, setYearAnalysisProgress] = useState<{
    current: number;
    total: number;
    percent: number;
    message: string;
  } | null>(null);

  const [isRefreshingSingle, setIsRefreshingSingle] = useState<boolean>(false);
  const runningAnalysisRef = useRef<number | null>(null);
  const selectedPlaylistIndexRef = useRef<number | null>(selectedPlaylistIndex);
  selectedPlaylistIndexRef.current = selectedPlaylistIndex;

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let unlistenGen: (() => void) | null = null;
    const setupListener = async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<any>("task-progress", (event) => {
          if (event.payload.task_id?.startsWith("year_analysis_")) {
            const { index, total, message, status } = event.payload;
            if (status === "completed") {
              setYearAnalysisProgress(null);
            } else if (index === 0 && total === 100 && message === "Resolving playlist files...") {
              setYearAnalysisProgress({ current: 0, total: 0, percent: 0, message });
            } else {
              const current = Math.min(index + 1, total);
              const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
              setYearAnalysisProgress({ current, total, percent, message: message || "" });
            }
          }
        });

        unlistenGen = await listen<string>("playlist-generation-log", (event) => {
          setGenerationLogs((prev) => [...prev, event.payload]);
        });
      } catch (e) {}
    };
    setupListener();

    const handleTaskCancelled = (e: Event) => {
      const customEvent = e as CustomEvent<{ taskId?: string }>;
      const tid = customEvent.detail?.taskId;
      if (tid && tid.startsWith("year_analysis_")) {
        runningAnalysisRef.current = null;
        setIsRefreshingSingle(false);
        setYearAnalysisProgress(null);
      }
    };
    window.addEventListener("bg-task-cancelled", handleTaskCancelled);

    return () => {
      if (unlisten) unlisten();
      if (unlistenGen) unlistenGen();
      window.removeEventListener("bg-task-cancelled", handleTaskCancelled);
    };
  }, []);

  const fetchSummaries = async (configOverrideParam?: MainConfig | null) => {
    if (!configPath) return;
    const activeCfg = configOverrideParam !== undefined ? configOverrideParam : config;
    setIsScanningSummary(true);
    try {
      const result = await invoke<PlaylistSummaryItem[]>("get_playlists_summary", {
        taskId: null,
        configPath,
        configOverride: activeCfg || null,
        sourceDirOverride: null,
        formats,
      });
      setSummaries((prev) => {
        return result.map((newItem) => {
          const prevItem = prev.find((p) => p.index === newItem.index && p.name === newItem.name);
          if (
            prevItem &&
            newItem.year_split_enabled &&
            newItem.buckets.length === 0 &&
            prevItem.buckets.length > 0
          ) {
            return {
              ...newItem,
              buckets: prevItem.buckets,
              warning_exceeds_max: prevItem.warning_exceeds_max,
            };
          }
          return newItem;
        });
      });
      // Also refresh active playlist preview and buckets if a playlist is selected
      if (selectedPlaylistIndexRef.current !== null) {
        invalidateCacheFor(selectedPlaylistIndexRef.current);
        loadPreview(true, undefined, activeCfg, true);
      }
    } catch (e) {
      console.warn("Failed to fetch playlist summaries:", e);
    } finally {
      setIsScanningSummary(false);
    }
  };

  const fetchSinglePlaylistSummary = async (
    idx: number,
    configOverrideParam?: MainConfig | null,
    showProgress = true
  ) => {
    if (!configPath) return;
    const activeCfg = configOverrideParam !== undefined ? configOverrideParam : config;
    const pl = activeCfg?.playlists?.[idx];
    const isYearSplit = pl?.year_split?.enabled ?? false;

    if (isYearSplit && showProgress) {
      if (runningAnalysisRef.current === idx) {
        return;
      }
      runningAnalysisRef.current = idx;
      setIsRefreshingSingle(true);
      setYearAnalysisProgress({
        current: 0,
        total: 0,
        percent: 0,
        message: "Resolving playlist files...",
      });
    }
    const taskId = isYearSplit && showProgress ? `year_analysis_${idx}` : undefined;
    try {
      const promise = invoke<PlaylistSummaryItem>("get_single_playlist_summary", {
        taskId,
        configPath,
        configOverride: activeCfg || null,
        sourceDirOverride: null,
        formats,
        playlistIndex: idx,
      });
      if (isYearSplit && showProgress && addBackgroundTask && taskId) {
        const plName = pl?.name || `Playlist #${idx + 1}`;
        addBackgroundTask(taskId, `Analyzing Year Distribution: ${plName}`, promise);
      }
      const single = await promise;
      setSummaries((prev) => {
        const copy = [...prev];
        const existingIdx = copy.findIndex((s) => s.index === idx);
        if (existingIdx !== -1) {
          copy[existingIdx] = single;
        } else {
          copy.push(single);
        }
        return copy;
      });
      // Once year analysis finishes, metadata cache is populated in memory; refresh track preview silently
      invalidateCacheFor(idx);
      if (selectedPlaylistIndexRef.current === idx) {
        loadPreview(true, undefined, activeCfg, true);
      }
    } catch (e) {
      console.warn("Failed to fetch single playlist summary:", e);
    } finally {
      if (isYearSplit && showProgress) {
        if (runningAnalysisRef.current === idx) {
          runningAnalysisRef.current = null;
        }
        setIsRefreshingSingle(false);
        setYearAnalysisProgress(null);
      }
    }
  };

  useEffect(() => {
    if (configPath) {
      fetchSummaries();
    }
  }, [configPath, config?.playlists?.length]);

  useEffect(() => {
    setIsConfirmingDelete(false);
    setSelectedBucketKey("all");
    if (activePlaylist && selectedPlaylistIndex !== null) {
      loadPreview(false, "all");
      // If active playlist is configured with year split and buckets are not yet prepared, prepare them immediately from config
      if (activePlaylist.year_split?.enabled) {
        const summary = summaries.find((s) => s.index === selectedPlaylistIndex);
        if (!summary || summary.buckets.length === 0) {
          fetchSinglePlaylistSummary(selectedPlaylistIndex);
        }
      }
    } else {
      setPreviews([]);
    }
  }, [selectedPlaylistIndex, rulesFingerprint]);

  const formatPathTail = (pathStr: string) => {
    if (!pathStr) return "";
    const normalized = pathStr.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length <= 3) return pathStr;
    return "…/" + parts.slice(-3).join('/');
  };

  const loadPreview = async (
    forceRefresh = false,
    bucketKeyOverride?: string,
    configOverrideParam?: MainConfig | null,
    silent = false
  ) => {
    const activeCfg = configOverrideParam !== undefined ? configOverrideParam : config;
    const plIdx = selectedPlaylistIndexRef.current;
    if (!configPath || !activeCfg || plIdx === null || !activeCfg.playlists[plIdx]) return;

    const targetBucket = bucketKeyOverride !== undefined ? bucketKeyOverride : selectedBucketKey;
    const cacheKey = `${plIdx}_${targetBucket}`;

    if (!forceRefresh && previewsCache[cacheKey]) {
      setPreviews(previewsCache[cacheKey]);
      setPreviewError("");
      return;
    }

    if (!silent) {
      setIsLoadingPreview(true);
    }
    setPreviewError("");
    try {
      const isAllBucket = targetBucket === "all";
      const result = await invoke<TrackPreview[]>("preview_playlist_tracks", {
        configPath,
        configOverride: activeCfg,
        sourceDirOverride: null,
        playlistIndex: plIdx,
        formats,
        bucketKey: isAllBucket ? null : targetBucket,
        probeUncached: isAllBucket ? false : true,
      });
      if (selectedPlaylistIndexRef.current === plIdx) {
        setPreviews(result);
      }
      setPreviewsCache((prev) => ({ ...prev, [cacheKey]: result }));
      if (!silent) {
        setIsLoadingPreview(false);
      }

      // If viewing "all" tracks and some tracks had uncached metadata (duration === 0),
      // hydrate metadata silently in the background if year analysis isn't already probing them
      if (
        isAllBucket &&
        result.some((t) => t.duration === 0) &&
        runningAnalysisRef.current !== plIdx
      ) {
        invoke<TrackPreview[]>("preview_playlist_tracks", {
          configPath,
          configOverride: activeCfg,
          sourceDirOverride: null,
          playlistIndex: plIdx,
          formats,
          bucketKey: null,
          probeUncached: true,
        })
          .then((hydrated) => {
            setPreviewsCache((prev) => ({ ...prev, [cacheKey]: hydrated }));
            if (selectedPlaylistIndexRef.current === plIdx) {
              setPreviews(hydrated);
            }
          })
          .catch(() => {});
      }
    } catch (e) {
      if (selectedPlaylistIndexRef.current === plIdx) {
        setPreviews([]);
        setPreviewError(String(e));
      }
    } finally {
      if (!silent) {
        setIsLoadingPreview(false);
      }
    }
  };

  const handleAddPlaylist = async () => {
    if (!config) return;

    // Open folder picker first
    let selectedFolders: string[] = [];
    try {
      selectedFolders = await invoke<string[]>("select_directories", {
        title: "Select Source Folder(s) for New Playlist",
      });
    } catch (e) {
      console.warn("Folder picker closed or failed:", e);
    }

    // Auto generate sequential playlist name: "New Playlist", "New Playlist - 02", "New Playlist - 03"
    const existingNames = new Set(config.playlists.map((p) => p.name.trim().toLowerCase()));
    let baseName = "New Playlist";
    let playlistName = baseName;
    let counter = 2;

    while (existingNames.has(playlistName.toLowerCase())) {
      const pad = counter < 10 ? `0${counter}` : `${counter}`;
      playlistName = `${baseName} - ${pad}`;
      counter++;
    }

    const newPlaylists = [...config.playlists];
    newPlaylists.push({
      name: playlistName,
      sources: selectedFolders,
      exclusions: [],
    });

    setConfig({
      ...config,
      playlists: newPlaylists,
    });
    setSelectedPlaylistIndex(newPlaylists.length - 1);
  };

  const handleDeletePlaylist = () => {
    setIsConfirmingDelete(true);
  };

  const executeDeletePlaylist = () => {
    if (!config || activePlaylist === null || selectedPlaylistIndex === null) return;
    const deletedIndex = selectedPlaylistIndex;
    const newPlaylists = config.playlists.filter((_, idx) => idx !== deletedIndex);
    invalidateCacheFor(deletedIndex);
    setConfig({
      ...config,
      playlists: newPlaylists,
    });
    setSelectedPlaylistIndex(null);
    setIsConfirmingDelete(false);
  };

  const handleUpdateName = (name: string) => {
    if (!config || activePlaylist === null || selectedPlaylistIndex === null) return;
    const newPlaylists = [...config.playlists];
    newPlaylists[selectedPlaylistIndex].name = name;
    setConfig({
      ...config,
      playlists: newPlaylists,
    });
  };

  const handleMergeBuckets = (startA: number, endA: number, startB: number, endB: number) => {
    if (!config || selectedPlaylistIndex === null) return;
    const newStart = Math.min(startA, startB);
    const newEnd = Math.max(endA, endB);

    const newPlaylists = [...config.playlists];
    const cur = newPlaylists[selectedPlaylistIndex].year_split || {
      enabled: true,
      min_tracks: 10,
      include_unknown: false,
    };
    const updatedMerges = addCustomMerge(cur.custom_merges || [], [newStart, newEnd]);
    newPlaylists[selectedPlaylistIndex] = {
      ...newPlaylists[selectedPlaylistIndex],
      year_split: {
        ...cur,
        custom_merges: updatedMerges,
      },
    };
    const updatedConfig = { ...config, playlists: newPlaylists };
    setConfig(updatedConfig);
    invalidateCacheFor(selectedPlaylistIndex);
    fetchSinglePlaylistSummary(selectedPlaylistIndex, updatedConfig, false);
  };

  const handleUnmergeCustomBucket = (start: number, end: number) => {
    if (!config || selectedPlaylistIndex === null) return;
    const newPlaylists = [...config.playlists];
    const cur = newPlaylists[selectedPlaylistIndex].year_split!;
    const updatedMerges = removeCustomMerge(cur.custom_merges || [], [start, end]);
    newPlaylists[selectedPlaylistIndex] = {
      ...newPlaylists[selectedPlaylistIndex],
      year_split: {
        ...cur,
        custom_merges: updatedMerges,
      },
    };
    const updatedConfig = { ...config, playlists: newPlaylists };
    setConfig(updatedConfig);
    invalidateCacheFor(selectedPlaylistIndex);
    fetchSinglePlaylistSummary(selectedPlaylistIndex, updatedConfig, false);
  };

  const selectAndAddSource = async () => {
    if (!config || activePlaylist === null || selectedPlaylistIndex === null) return;
    try {
      const selected = await invoke<string[]>("select_directories", {
        title: "Add Source Folder(s)",
      });
      if (selected && selected.length > 0) {
        const newPlaylists = [...config.playlists];
        const currentSources = [...newPlaylists[selectedPlaylistIndex].sources];
        const updatedSources = Array.from(new Set([...currentSources, ...selected]));
        newPlaylists[selectedPlaylistIndex].sources = updatedSources;
        setConfig({
          ...config,
          playlists: newPlaylists,
        });
        invalidateCacheFor(selectedPlaylistIndex);
      }
    } catch (e) {
      alert("Error picking folder: " + e);
    }
  };

  const handleUpdateSourceOnDoubleClick = async (srcIdx: number) => {
    if (!config || activePlaylist === null || selectedPlaylistIndex === null) return;
    try {
      const selected = await invoke<string[]>("select_directories", {
        title: "Update Source Folder",
      });
      if (selected && selected.length > 0) {
        const newPlaylists = [...config.playlists];
        const currentSources = [...newPlaylists[selectedPlaylistIndex].sources];
        currentSources.splice(srcIdx, 1, ...selected);
        const updatedSources = Array.from(new Set(currentSources));
        newPlaylists[selectedPlaylistIndex].sources = updatedSources;
        setConfig({
          ...config,
          playlists: newPlaylists,
        });
        invalidateCacheFor(selectedPlaylistIndex);
      }
    } catch (e) {
      alert("Error picking folder: " + e);
    }
  };

  const removeSource = (srcIdx: number) => {
    if (!config || activePlaylist === null || selectedPlaylistIndex === null) return;
    const newPlaylists = [...config.playlists];
    const newSources = newPlaylists[selectedPlaylistIndex].sources.filter((_, idx) => idx !== srcIdx);
    newPlaylists[selectedPlaylistIndex].sources = newSources;
    setConfig({
      ...config,
      playlists: newPlaylists,
    });
    invalidateCacheFor(selectedPlaylistIndex);
  };

  const moveSourceItem = (fromIdx: number, direction: "up" | "down") => {
    if (!config || selectedPlaylistIndex === null) return;
    const toIdx = direction === "up" ? fromIdx - 1 : fromIdx + 1;
    const sources = [...config.playlists[selectedPlaylistIndex].sources];
    if (toIdx < 0 || toIdx >= sources.length) return;

    const newPlaylists = [...config.playlists];
    const [moved] = sources.splice(fromIdx, 1);
    sources.splice(toIdx, 0, moved);
    newPlaylists[selectedPlaylistIndex].sources = sources;

    setConfig({ ...config, playlists: newPlaylists });
    invalidateCacheFor(selectedPlaylistIndex);
  };

  const selectAndAddExclusion = async () => {
    if (!config || activePlaylist === null || selectedPlaylistIndex === null) return;
    try {
      const selected = await invoke<string[]>("select_directories", {
        title: "Add Exclusion Folder(s)",
      });
      if (selected && selected.length > 0) {
        const newPlaylists = [...config.playlists];
        const currentExclusions = newPlaylists[selectedPlaylistIndex].exclusions || [];
        const updatedExclusions = Array.from(new Set([...currentExclusions, ...selected]));
        newPlaylists[selectedPlaylistIndex].exclusions = updatedExclusions;
        setConfig({
          ...config,
          playlists: newPlaylists,
        });
        invalidateCacheFor(selectedPlaylistIndex);
      }
    } catch (e) {
      alert("Error picking folder: " + e);
    }
  };

  const handleUpdateExclusionOnDoubleClick = async (exIdx: number) => {
    if (!config || activePlaylist === null || selectedPlaylistIndex === null) return;
    try {
      const selected = await invoke<string[]>("select_directories", {
        title: "Update Exclusion Folder",
      });
      if (selected && selected.length > 0) {
        const newPlaylists = [...config.playlists];
        const currentExclusions = [...(newPlaylists[selectedPlaylistIndex].exclusions || [])];
        currentExclusions.splice(exIdx, 1, ...selected);
        const updatedExclusions = Array.from(new Set(currentExclusions));
        newPlaylists[selectedPlaylistIndex].exclusions = updatedExclusions;
        setConfig({
          ...config,
          playlists: newPlaylists,
        });
        invalidateCacheFor(selectedPlaylistIndex);
      }
    } catch (e) {
      alert("Error picking folder: " + e);
    }
  };

  const removeExclusion = (exIdx: number) => {
    if (!config || activePlaylist === null || selectedPlaylistIndex === null) return;
    const newPlaylists = [...config.playlists];
    const currentExclusions = newPlaylists[selectedPlaylistIndex].exclusions || [];
    const newExclusions = currentExclusions.filter((_, idx) => idx !== exIdx);
    newPlaylists[selectedPlaylistIndex].exclusions = newExclusions;
    setConfig({
      ...config,
      playlists: newPlaylists,
    });
    invalidateCacheFor(selectedPlaylistIndex);
  };

  const moveExclusionItem = (fromIdx: number, direction: "up" | "down") => {
    if (!config || selectedPlaylistIndex === null) return;
    const toIdx = direction === "up" ? fromIdx - 1 : fromIdx + 1;
    const exclusions = [...(config.playlists[selectedPlaylistIndex].exclusions || [])];
    if (toIdx < 0 || toIdx >= exclusions.length) return;

    const newPlaylists = [...config.playlists];
    const [moved] = exclusions.splice(fromIdx, 1);
    exclusions.splice(toIdx, 0, moved);
    newPlaylists[selectedPlaylistIndex].exclusions = exclusions;

    setConfig({ ...config, playlists: newPlaylists });
    invalidateCacheFor(selectedPlaylistIndex);
  };

  const movePlaylistItem = (fromIdx: number, direction: "up" | "down") => {
    if (!config) return;
    const toIdx = direction === "up" ? fromIdx - 1 : fromIdx + 1;
    if (toIdx < 0 || toIdx >= config.playlists.length) return;

    const newPlaylists = [...config.playlists];
    const [moved] = newPlaylists.splice(fromIdx, 1);
    newPlaylists.splice(toIdx, 0, moved);

    let newSelectedIndex: number | null = selectedPlaylistIndex;
    if (selectedPlaylistIndex === fromIdx) {
      newSelectedIndex = toIdx;
    } else if (
      selectedPlaylistIndex !== null &&
      selectedPlaylistIndex > fromIdx &&
      selectedPlaylistIndex <= toIdx
    ) {
      newSelectedIndex = selectedPlaylistIndex - 1;
    } else if (
      selectedPlaylistIndex !== null &&
      selectedPlaylistIndex < fromIdx &&
      selectedPlaylistIndex >= toIdx
    ) {
      newSelectedIndex = selectedPlaylistIndex + 1;
    }

    setConfig({ ...config, playlists: newPlaylists });
    setSelectedPlaylistIndex(newSelectedIndex);
  };

  const handleGeneratePlaylists = async () => {
    if (!configPath) return;
    setIsGenerating(true);
    setShowLogsModal(true);
    isCompilationAutoScrollRef.current = true;
    setIsCompilationAutoScroll(true);
    setGenerationLogs([]);
    try {
      const logs = await invoke<string[]>("generate_all_playlists", {
        configPath,
        sourceDirOverride: null,
        targetDirOverride: null,
        relativeToConfig,
        formats,
        appendTrackCount,
      });
      if (logs && logs.length > 0) {
        setGenerationLogs(logs);
      }
    } catch (e) {
      setGenerationLogs((prev) => [...prev, `❌ ERROR: ${e}`]);
    } finally {
      setIsGenerating(false);
    }
  };

  if (!config) {
    return (
      <div className="view-container">
        <h1>Playlist Builder</h1>
        <p className="no-data">Please load a workspace configuration file in the Workspaces tab.</p>
      </div>
    );
  }

  return (
    <div className="view-container" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div className="flex justify-between align-center" style={{ marginBottom: "4px" }}>
        <div>
          <h1 style={{ fontSize: "1.4rem", margin: 0 }}>Playlist Builder</h1>
          <p className="subtitle" style={{ margin: 0, fontSize: "0.82rem" }}>Visually build, customize, and preview your playlist directories.</p>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            className="btn btn-secondary"
            onClick={() =>
              setDupModalTarget({
                open: true,
                playlistIndex: null,
              })
            }
            style={{
              width: "36px",
              height: "36px",
              padding: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "6px",
            }}
            title="Analyze duplicate songs across all playlists and workspace folders"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
          <button
            className={`btn ${isReordering ? "btn-primary" : "btn-secondary"}`}
            onClick={() => {
              if (!isReordering) {
                // When enabling reorder mode -> reset sorting to config order
                setPlSortBy("config");
              }
              setIsReordering(!isReordering);
            }}
            style={{ padding: "8px 14px", fontSize: "0.85rem" }}
            title="Toggle item reorder mode"
          >
            {isReordering ? "Done Reordering" : "⇅ Reorder Mode"}
          </button>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "0.82rem",
              color: "var(--text-secondary)",
              cursor: "pointer",
              userSelect: "none",
              padding: "0 6px",
            }}
            title="Append track count in (xx) to the playlist filename, e.g. Rock Classics - 2012 - p01 (450).m3u"
          >
            <input
              type="checkbox"
              checked={appendTrackCount}
              onChange={(e) => setAppendTrackCount(e.target.checked)}
              style={{ accentColor: "var(--accent-purple)", cursor: "pointer" }}
            />
            <span>Include count (xx)</span>
          </label>
          <button
            className="btn btn-primary"
            onClick={handleGeneratePlaylists}
            disabled={isGenerating}
            style={{ padding: "8px 16px", fontSize: "0.85rem" }}
          >
            {isGenerating ? "Compiling..." : "⚡ Generate Playlists (.m3u)"}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: "0", flex: 1, minHeight: 0 }}>
        {/* Playlist selection sidebar */}
        <div className="card" style={{ width: `${sidebarWidth}px`, flexShrink: 0, margin: 0, display: "flex", flexDirection: "column", minHeight: 0, gap: "10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border-color)", paddingBottom: "10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ fontSize: "1rem", fontWeight: 700, color: "var(--text-primary)" }}>
                Playlists {config ? `(${config.playlists.length})` : ""}
              </div>
              <button
                type="button"
                onClick={() => fetchSummaries()}
                disabled={isScanningSummary}
                style={{
                  padding: "3px 6px",
                  borderRadius: "6px",
                  border: "1px solid var(--border-color)",
                  backgroundColor: "var(--bg-tertiary)",
                  color: "var(--accent-purple-hover)",
                  cursor: isScanningSummary ? "wait" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.78rem",
                  lineHeight: 1,
                  transition: "all 0.15s ease",
                }}
                title={isScanningSummary ? "Scanning library tracks..." : "Full scan & refresh track counts"}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    animation: isScanningSummary ? "spin 1s linear infinite" : "none",
                  }}
                >
                  <path d="M23 4v6h-6" />
                  <path d="M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              </button>
            </div>

            {/* Small sort and pin year-split buttons right top */}
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <button
                type="button"
                onClick={() => setPinYearSplitAtTop((prev) => !prev)}
                style={{
                  padding: "2px 5px",
                  borderRadius: "6px",
                  border: pinYearSplitAtTop ? "1px solid var(--accent-purple)" : "1px solid var(--border-color)",
                  backgroundColor: pinYearSplitAtTop ? "rgba(138, 92, 246, 0.16)" : "var(--bg-tertiary)",
                  color: pinYearSplitAtTop ? "var(--accent-purple)" : "var(--text-secondary)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "2px",
                  fontSize: "0.68rem",
                  lineHeight: 1,
                  transition: "all 0.15s ease",
                }}
                title={pinYearSplitAtTop ? "Year-split playlists pinned at top (Active - click to disable)" : "Pin year-split playlists at top"}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="16" y1="2" x2="16" y2="6"></line>
                  <line x1="8" y1="2" x2="8" y2="6"></line>
                  <line x1="3" y1="10" x2="21" y2="10"></line>
                </svg>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5"></line>
                  <polyline points="5 12 12 5 19 12"></polyline>
                </svg>
              </button>

              <div style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => setShowPlSortMenu(!showPlSortMenu)}
                style={{
                  padding: "1px 7px",
                  fontSize: "0.68rem",
                  fontWeight: 600,
                  borderRadius: "10px",
                  border: "1px solid var(--border-color)",
                  backgroundColor: showPlSortMenu ? "var(--bg-surface)" : "var(--bg-tertiary)",
                  color: "var(--accent-purple-hover)",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                  display: "flex",
                  alignItems: "center",
                  gap: "3px",
                  userSelect: "none",
                }}
                title="Sort playlists display"
              >
                <span>
                  {plSortBy === "config"
                    ? "Order"
                    : `Name ${plSortOrder === "asc" ? "↑" : "↓"}`}
                </span>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </button>

              {showPlSortMenu && (
                <>
                  <div
                    style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }}
                    onClick={() => setShowPlSortMenu(false)}
                  />
                  <div
                    style={{
                      position: "absolute",
                      top: "calc(100% + 4px)",
                      right: 0,
                      zIndex: 1000,
                      backgroundColor: "var(--bg-secondary)",
                      border: "1px solid var(--border-color)",
                      borderRadius: "8px",
                      boxShadow: "var(--shadow-md)",
                      padding: "4px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "2px",
                      minWidth: "105px",
                    }}
                  >
                    {/* Item 1: Config Order */}
                    <button
                      type="button"
                      onClick={() => {
                        setPlSortBy("config");
                        setShowPlSortMenu(false);
                      }}
                      style={{
                        padding: "4px 8px",
                        fontSize: "0.72rem",
                        borderRadius: "6px",
                        border: "none",
                        backgroundColor: plSortBy === "config" ? "rgba(138, 92, 246, 0.15)" : "transparent",
                        color: plSortBy === "config" ? "var(--accent-purple-hover)" : "var(--text-primary)",
                        fontWeight: plSortBy === "config" ? 600 : 400,
                        cursor: "pointer",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      <span>Config Order</span>
                      <span>{plSortBy === "config" ? "✓" : ""}</span>
                    </button>

                    {/* Item 2: Name */}
                    <button
                      type="button"
                      onClick={() => {
                        if (plSortBy === "name") {
                          setPlSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
                        } else {
                          setPlSortBy("name");
                          setPlSortOrder("asc");
                        }
                        setShowPlSortMenu(false);
                      }}
                      style={{
                        padding: "4px 8px",
                        fontSize: "0.72rem",
                        borderRadius: "6px",
                        border: "none",
                        backgroundColor: plSortBy === "name" ? "rgba(138, 92, 246, 0.15)" : "transparent",
                        color: plSortBy === "name" ? "var(--accent-purple-hover)" : "var(--text-primary)",
                        fontWeight: plSortBy === "name" ? 600 : 400,
                        cursor: "pointer",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      <span>Name</span>
                      <span>{plSortBy === "name" ? (plSortOrder === "asc" ? "↑" : "↓") : "↑"}</span>
                    </button>

                    {/* Action: Save current named order to config */}
                    {plSortBy === "name" && (
                      <>
                        <div style={{ height: "1px", backgroundColor: "var(--border-color)", margin: "3px 0" }} />
                        <button
                          type="button"
                          onClick={handleSaveSortedOrderToConfig}
                          style={{
                            padding: "4px 8px",
                            fontSize: "0.7rem",
                            borderRadius: "6px",
                            border: "1px solid var(--accent-purple)",
                            backgroundColor: "rgba(138, 92, 246, 0.18)",
                            color: "var(--accent-purple-hover)",
                            fontWeight: 600,
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: "4px",
                            whiteSpace: "nowrap",
                          }}
                          title="Save this sorted order permanently into the configuration file"
                        >
                          💾 Save Order to Config
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", margin: "2px 0 6px 0", minHeight: 0 }}>
            {!config || config.playlists.length === 0 ? (
              <div className="no-data" style={{ padding: "30px 10px", textAlign: "center", fontSize: "0.82rem" }}>
                No playlists created yet. Click '+ Add Playlist' below to begin.
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "8px" }}>
                {sortedPlaylistsWithIndex.map(({ pl, originalIdx }) => {
                  const idx = originalIdx;
                  const isSelected = selectedPlaylistIndex === idx;
                  const summary = summaries.find((s) => s.index === idx);
                  const trackCount = summary ? summary.total_tracks : previewsCache[`${idx}_all`]?.length;
                  const isYearSplit = pl.year_split?.enabled;
                  const activeBucketsCount = summary ? summary.buckets.filter((b) => b.key !== "unknown" || pl.year_split?.include_unknown).length : 0;
                  const maxLimit = config.maxTracksPerPlaylist ?? 400;
                  const exceedsMax = summary ? summary.warning_exceeds_max : (trackCount !== undefined && trackCount > maxLimit);

                  return (
                    <div
                      key={idx}
                      onClick={() => setSelectedPlaylistIndex(idx)}
                      style={{
                        padding: "10px 12px",
                        borderRadius: "8px",
                        border: isSelected
                          ? "1.5px solid var(--accent-purple)"
                          : exceedsMax
                          ? "1px solid rgba(245, 158, 11, 0.5)"
                          : "1px solid var(--border-color)",
                        backgroundColor: isSelected
                          ? "rgba(138, 92, 246, 0.12)"
                          : exceedsMax
                          ? "rgba(245, 158, 11, 0.05)"
                          : "var(--bg-tertiary)",
                        boxShadow: isSelected ? "0 0 8px rgba(138, 92, 246, 0.2)" : "none",
                        cursor: "pointer",
                        display: "flex",
                        flexDirection: "column",
                        gap: "6px",
                        transition: "all 0.15s ease",
                        userSelect: "none",
                        width: "100%",
                        boxSizing: "border-box",
                      }}
                    >
                      {/* Row 1: Playlist Name FULL WIDTH */}
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: "0.88rem",
                          color: "var(--text-primary)",
                          width: "100%",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          lineHeight: 1.3,
                        }}
                        title={pl.name}
                      >
                        {pl.name}
                      </div>

                      {/* Row 2: Badges (Exclusions, Year Split, Limit, Warning) - Note: x sources pill removed as requested */}
                      <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", alignItems: "center" }}>
                        {isYearSplit && (
                          <span
                            style={{
                              fontSize: "0.66rem",
                              padding: "1px 6px",
                              borderRadius: "4px",
                              backgroundColor: "rgba(138, 92, 246, 0.15)",
                              color: "var(--accent-purple-hover)",
                              border: "1px solid rgba(138, 92, 246, 0.3)",
                              fontWeight: 600,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "3px",
                            }}
                            title="Yearly Auto-Split active"
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                              <line x1="16" y1="2" x2="16" y2="6"></line>
                              <line x1="8" y1="2" x2="8" y2="6"></line>
                              <line x1="3" y1="10" x2="21" y2="10"></line>
                            </svg>
                            {activeBucketsCount > 0 ? `${activeBucketsCount} splits` : "Auto-Year"}
                          </span>
                        )}

                        {exceedsMax && (
                          <span
                            style={{
                              fontSize: "0.66rem",
                              padding: "1px 6px",
                              borderRadius: "4px",
                              backgroundColor: "rgba(245, 158, 11, 0.15)",
                              color: "var(--warning)",
                              border: "1px solid rgba(245, 158, 11, 0.35)",
                              fontWeight: 600,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "3px",
                            }}
                            title={`Exceeds max track threshold (${maxLimit} max)`}
                          >
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                              <line x1="12" y1="9" x2="12" y2="13"></line>
                              <line x1="12" y1="17" x2="12.01" y2="17"></line>
                            </svg>
                            &gt;{maxLimit}
                          </span>
                        )}
                      </div>

                      {/* Row 3: Track Count or Reorder Buttons */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", marginTop: "2px" }}>
                        <span style={{ fontSize: "0.74rem", color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", gap: "3px" }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M9 18V5l12-2v13"></path>
                            <circle cx="6" cy="18" r="3"></circle>
                            <circle cx="18" cy="16" r="3"></circle>
                          </svg>
                          {trackCount !== undefined ? `${trackCount} tracks` : "—"}
                        </span>

                        {isReordering && (
                          <div style={{ display: "flex", gap: "2px" }} onClick={(e) => e.stopPropagation()}>
                            <button
                              className="btn btn-secondary"
                              onClick={() => movePlaylistItem(idx, "up")}
                              disabled={idx === 0}
                              style={{ padding: "3px 5px", fontSize: "0.65rem", lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}
                              title="Move playlist up"
                            >
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="18 15 12 9 6 15"></polyline>
                              </svg>
                            </button>
                            <button
                              className="btn btn-secondary"
                              onClick={() => movePlaylistItem(idx, "down")}
                              disabled={idx === config.playlists.length - 1}
                              style={{ padding: "3px 5px", fontSize: "0.65rem", lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}
                              title="Move playlist down"
                            >
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="6 9 12 15 18 9"></polyline>
                              </svg>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <button 
            className="btn btn-secondary" 
            onClick={handleAddPlaylist} 
            style={{ 
              width: "100%", 
              marginTop: "auto", 
              flexShrink: 0,
              padding: "8px 12px",
              fontSize: "0.82rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px"
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: "inline-block" }}>
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            Add Playlist
          </button>
        </div>

        {/* Resizable separator handle 1 */}
        <div
          onMouseDown={handleSidebarMouseDown}
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
          title="Drag to resize sidebar"
        >
          <div style={{
            width: "2px",
            height: "40px",
            borderRadius: "1px",
            backgroundColor: "var(--border-color)",
            transition: "background-color 0.2s"
          }} className="resizable-indicator" />
        </div>

        {/* Playlist properties and preview */}
        <div style={{ flex: 1, display: "flex", flexDirection: "row", gap: "0", minWidth: 0, alignItems: "stretch" }}>
          {activePlaylist ? (
            <>
              {/* Properties card */}
              <div className="card" style={{ width: `${configWidth}px`, flexShrink: 0, margin: 0, display: "flex", flexDirection: "column", overflowY: "auto" }}>
                <div className="card-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>Playlist Configuration</span>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        if (selectedPlaylistIndex !== null && activePlaylist) {
                          setDupModalTarget({
                            open: true,
                            playlistIndex: selectedPlaylistIndex,
                            playlistName: activePlaylist.name,
                          });
                        }
                      }}
                      style={{
                        width: "28px",
                        height: "28px",
                        padding: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: "6px",
                      }}
                      title={`Analyze duplicate songs in "${activePlaylist.name}" prioritized by its SOURCES order`}
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        if (selectedPlaylistIndex !== null) {
                          fetchSinglePlaylistSummary(selectedPlaylistIndex);
                          loadPreview(true, selectedBucketKey);
                        }
                      }}
                      disabled={isRefreshingSingle}
                      style={{
                        width: "28px",
                        height: "28px",
                        padding: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: "6px",
                      }}
                      title="Refresh track counts and year buckets for this playlist"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{
                          animation: isRefreshingSingle ? "spin 1s linear infinite" : "none",
                        }}
                      >
                        <path d="M23 4v6h-6" />
                        <path d="M1 20v-6h6" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                      </svg>
                    </button>
                    <button 
                      type="button"
                      className="btn btn-danger" 
                      onClick={handleDeletePlaylist}
                      style={{
                        width: "28px",
                        height: "28px",
                        padding: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: "6px",
                      }}
                      title={`Delete playlist "${activePlaylist.name}"`}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        <line x1="10" y1="11" x2="10" y2="17"></line>
                        <line x1="14" y1="11" x2="14" y2="17"></line>
                      </svg>
                    </button>
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Playlist Name</label>
                  <input
                    type="text"
                    value={activePlaylist.name}
                    onChange={(e) => handleUpdateName(e.target.value)}
                  />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label" style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Sources</span>
                      <span className="text-success" style={{ cursor: "pointer" }} onClick={selectAndAddSource}>
                        + Add Folder
                      </span>
                    </label>
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                       {activePlaylist.sources.map((src, srcIdx) => (
                         <div
                           className="form-row"
                           key={srcIdx}
                           onDoubleClick={() => handleUpdateSourceOnDoubleClick(srcIdx)}
                           title={`Double-click to edit:\n${src}`}
                           style={{
                             display: "flex",
                             alignItems: "center",
                             gap: "6px",
                           }}
                         >
                           <div
                             style={{
                               flex: 1,
                               fontSize: "0.82rem",
                               fontFamily: "var(--font-mono)",
                               overflow: "hidden",
                               textOverflow: "ellipsis",
                               whiteSpace: "nowrap",
                               padding: "6px 8px",
                               backgroundColor: "var(--bg-primary)",
                               borderRadius: "4px",
                               border: "1px solid var(--border-color)",
                               cursor: "pointer"
                             }}
                           >
                             {formatPathTail(src)}
                           </div>
                           {isReordering && (
                             <div style={{ display: "flex", gap: "2px" }}>
                               <button
                                 className="btn btn-secondary"
                                 onClick={() => moveSourceItem(srcIdx, "up")}
                                 disabled={srcIdx === 0}
                                 style={{ padding: "4px 6px", fontSize: "0.65rem", lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}
                                 title="Move up"
                               >
                                 <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                   <polyline points="18 15 12 9 6 15"></polyline>
                                 </svg>
                               </button>
                               <button
                                 className="btn btn-secondary"
                                 onClick={() => moveSourceItem(srcIdx, "down")}
                                 disabled={srcIdx === activePlaylist.sources.length - 1}
                                 style={{ padding: "4px 6px", fontSize: "0.65rem", lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}
                                 title="Move down"
                               >
                                 <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                   <polyline points="6 9 12 15 18 9"></polyline>
                                 </svg>
                               </button>
                             </div>
                           )}
                           <button 
                             className="btn btn-secondary" 
                             onClick={() => setDeleteSourceTarget({ index: srcIdx, path: src })}
                             style={{ padding: "6px", display: "flex", alignItems: "center", justifyContent: "center" }}
                             title="Remove Source Folder"
                           >
                             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                               <polyline points="3 6 5 6 21 6"></polyline>
                               <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                             </svg>
                           </button>
                         </div>
                       ))}
                      {activePlaylist.sources.length === 0 && (
                        <p className="no-data" style={{ padding: "8px" }}>No source paths. Add one above.</p>
                      )}
                    </div>
                  </div>

                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label" style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Exclusions</span>
                      <span className="text-warning" style={{ cursor: "pointer" }} onClick={selectAndAddExclusion}>
                        + Add Folder
                      </span>
                    </label>
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                       {(activePlaylist.exclusions || []).map((ex, exIdx) => (
                         <div
                           className="form-row"
                           key={exIdx}
                           onDoubleClick={() => handleUpdateExclusionOnDoubleClick(exIdx)}
                           title={`Double-click to edit:\n${ex}`}
                           style={{
                             display: "flex",
                             alignItems: "center",
                             gap: "6px",
                           }}
                         >
                           <div
                             style={{
                               flex: 1,
                               fontSize: "0.82rem",
                               fontFamily: "var(--font-mono)",
                               overflow: "hidden",
                               textOverflow: "ellipsis",
                               whiteSpace: "nowrap",
                               padding: "6px 8px",
                               backgroundColor: "var(--bg-primary)",
                               borderRadius: "4px",
                               border: "1px solid var(--border-color)",
                               cursor: "pointer"
                             }}
                           >
                             {formatPathTail(ex)}
                           </div>
                           {isReordering && (
                             <div style={{ display: "flex", gap: "2px" }}>
                               <button
                                 className="btn btn-secondary"
                                 onClick={() => moveExclusionItem(exIdx, "up")}
                                 disabled={exIdx === 0}
                                 style={{ padding: "4px 6px", fontSize: "0.65rem", lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}
                                 title="Move up"
                               >
                                 <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                   <polyline points="18 15 12 9 6 15"></polyline>
                                 </svg>
                               </button>
                               <button
                                 className="btn btn-secondary"
                                 onClick={() => moveExclusionItem(exIdx, "down")}
                                 disabled={exIdx === (activePlaylist.exclusions || []).length - 1}
                                 style={{ padding: "4px 6px", fontSize: "0.65rem", lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}
                                 title="Move down"
                               >
                                 <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                   <polyline points="6 9 12 15 18 9"></polyline>
                                 </svg>
                               </button>
                             </div>
                           )}
                           <button 
                             className="btn btn-secondary" 
                             onClick={() => setDeleteExclusionTarget({ index: exIdx, path: ex })}
                             style={{ padding: "6px", display: "flex", alignItems: "center", justifyContent: "center" }}
                             title="Remove Exclusion Folder"
                           >
                             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                               <polyline points="3 6 5 6 21 6"></polyline>
                               <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                             </svg>
                           </button>
                         </div>
                       ))}
                      {(activePlaylist.exclusions || []).length === 0 && (
                        <p className="no-data" style={{ padding: "8px" }}>No exclusions defined.</p>
                      )}
                    </div>
                  </div>

                  {/* Year Filter & Auto-Split Section */}
                  <div
                    style={{
                      border: "1px solid var(--border-color)",
                      borderRadius: "8px",
                      padding: "12px",
                      backgroundColor: "var(--bg-tertiary)",
                      display: "flex",
                      flexDirection: "column",
                      gap: "10px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div
                        style={{ fontWeight: 600, fontSize: "0.88rem", color: "var(--text-primary)", cursor: "default" }}
                        title="Automatically group tracks into era & yearly playlists"
                      >
                        Yearly Auto-Split Filter
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        {activePlaylist.year_split?.enabled && (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => {
                              if (selectedPlaylistIndex !== null) {
                                fetchSinglePlaylistSummary(selectedPlaylistIndex);
                              }
                            }}
                            disabled={isRefreshingSingle}
                            style={{
                              width: "22px",
                              height: "22px",
                              padding: 0,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              borderRadius: "4px",
                              cursor: isRefreshingSingle ? "not-allowed" : "pointer",
                              opacity: isRefreshingSingle ? 0.6 : 1,
                              backgroundColor: "var(--bg-secondary)",
                              color: "var(--text-primary)",
                              border: "1px solid var(--border-color)",
                            }}
                            title={isRefreshingSingle ? "Analyzing year distribution..." : "Analyze year distribution"}
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              style={isRefreshingSingle ? { animation: "spin 1s linear infinite" } : undefined}
                            >
                              <path d="M23 4v6h-6" />
                              <path d="M1 20v-6h6" />
                              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                            </svg>
                          </button>
                        )}
                        <input
                          type="checkbox"
                          checked={activePlaylist.year_split?.enabled || false}
                          onChange={(e) => {
                            if (!config || selectedPlaylistIndex === null) return;
                            const newPlaylists = [...config.playlists];
                            const cur = newPlaylists[selectedPlaylistIndex].year_split || {
                              enabled: false,
                              min_tracks: 10,
                              include_unknown: false,
                              split_5y: [],
                              split_1y: [],
                            };
                            const isEnabling = e.target.checked;
                            newPlaylists[selectedPlaylistIndex] = {
                              ...newPlaylists[selectedPlaylistIndex],
                              year_split: {
                                ...cur,
                                enabled: isEnabling,
                              },
                            };
                            const updatedConfig = { ...config, playlists: newPlaylists };
                            setConfig(updatedConfig);
                            invalidateCacheFor(selectedPlaylistIndex);
                            if (isEnabling) {
                              fetchSinglePlaylistSummary(selectedPlaylistIndex, updatedConfig);
                            } else {
                              setSelectedBucketKey("all");
                            }
                          }}
                          style={{ cursor: "pointer", width: "16px", height: "16px" }}
                          title="Toggle Yearly Auto-Split"
                        />
                      </div>
                    </div>

                    {activePlaylist.year_split?.enabled && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "4px" }}>

                        {/* Buckets List */}
                        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span style={{ fontSize: "0.76rem", fontWeight: 600, color: "var(--text-secondary)" }}>
                              Active Era &amp; Year Buckets:
                            </span>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              onClick={() => {
                                setSelectedBucketKey("all");
                                loadPreview(true, "all");
                              }}
                              style={{
                                padding: "2px 7px",
                                fontSize: "0.68rem",
                                backgroundColor: selectedBucketKey === "all" ? "var(--accent-purple)" : undefined,
                                color: selectedBucketKey === "all" ? "#fff" : undefined,
                              }}
                            >
                              Show All Tracks
                            </button>
                          </div>

                          {(() => {
                            const summary = summaries.find((s) => s.index === selectedPlaylistIndex);
                            const buckets = summary?.buckets || [];
                            const maxLimit = config.maxTracksPerPlaylist ?? 400;

                            if (isRefreshingSingle && buckets.length === 0) {
                              return (
                                <div style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "10px", fontSize: "0.76rem", color: "var(--text-secondary)", background: "var(--card-bg-subtle, rgba(128,128,128,0.06))", borderRadius: "6px", border: "1px solid var(--border-color)" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                    <svg
                                      width="12"
                                      height="12"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2.2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      style={{ animation: "spin 1s linear infinite", flexShrink: 0 }}
                                    >
                                      <path d="M23 4v6h-6" />
                                      <path d="M1 20v-6h6" />
                                      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                                    </svg>
                                    <span style={{ fontWeight: 500, color: "var(--text-primary)" }}>
                                      Analyzing year distribution... {yearAnalysisProgress ? `${yearAnalysisProgress.current} / ${yearAnalysisProgress.total} (${yearAnalysisProgress.percent}%)` : ""}
                                    </span>
                                  </div>
                                  {yearAnalysisProgress && (
                                    <div style={{ width: "100%", background: "var(--border-color)", borderRadius: "4px", height: "4px", overflow: "hidden" }}>
                                      <div style={{ width: `${yearAnalysisProgress.percent}%`, height: "100%", background: "var(--accent-purple)", transition: "width 0.15s ease" }} />
                                    </div>
                                  )}
                                  {yearAnalysisProgress?.message && (
                                    <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={yearAnalysisProgress.message}>
                                      {yearAnalysisProgress.message}
                                    </div>
                                  )}
                                </div>
                              );
                            }

                            if (buckets.length === 0) {
                              return (
                                <p className="no-data" style={{ padding: "6px", fontSize: "0.75rem" }}>
                                  No year buckets generated.
                                </p>
                              );
                            }

                            return (
                              <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                                {isRefreshingSingle && (
                                  <div style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "6px 8px", fontSize: "0.72rem", color: "var(--text-secondary)", background: "var(--card-bg-subtle, rgba(128,128,128,0.06))", borderRadius: "5px", marginBottom: "4px", border: "1px solid var(--border-color)" }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                      <svg
                                        width="11"
                                        height="11"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2.2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        style={{ animation: "spin 1s linear infinite", flexShrink: 0 }}
                                      >
                                        <path d="M23 4v6h-6" />
                                        <path d="M1 20v-6h6" />
                                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                                      </svg>
                                      <span>Refreshing year distribution... {yearAnalysisProgress ? `${yearAnalysisProgress.current} / ${yearAnalysisProgress.total} (${yearAnalysisProgress.percent}%)` : ""}</span>
                                    </div>
                                    {yearAnalysisProgress && (
                                      <div style={{ width: "100%", background: "var(--border-color)", borderRadius: "3px", height: "3px", overflow: "hidden" }}>
                                        <div style={{ width: `${yearAnalysisProgress.percent}%`, height: "100%", background: "var(--accent-purple)", transition: "width 0.15s ease" }} />
                                      </div>
                                    )}
                                  </div>
                                )}
                                {(() => {
                                  const yearBuckets = buckets.filter((x) => x.bucket_type !== "unknown" && x.bucket_type !== "unknown_split" && x.bucket_type !== "1y_split" && x.start_year !== null && x.end_year !== null);

                                  return buckets.map((b) => {
                                    const isSelected = selectedBucketKey === b.key;
                                    const exceedsMax = b.track_count > maxLimit;
                                    const minLimit = activePlaylist.year_split?.min_tracks ?? config.minTracksPerYearPlaylist ?? 10;
                                    const isUnknown = b.bucket_type === "unknown" || b.bucket_type === "unknown_split";
                                    const isSplitUnknown = b.bucket_type === "unknown_split";
                                    const isSingleUnknown = b.bucket_type === "unknown";
                                    const isSplitSingleYear = b.bucket_type === "1y_split";
                                    const isSingleYear = (b.bucket_type === "1y" || (b.bucket_type === "custom" && b.start_year !== null && b.start_year === b.end_year)) && b.start_year !== null;
                                    const isBelowMin = !isUnknown && !isSplitSingleYear && (b.below_min_tracks ?? (b.track_count < minLimit));
                                    const yearIdx = !isUnknown && !isSplitSingleYear && b.start_year !== null ? yearBuckets.findIndex((x) => x.key === b.key) : -1;
                                    const canMergeUp = yearIdx > 0;
                                    const canMergeDown = yearIdx !== -1 && yearIdx < yearBuckets.length - 1;
                                    const prevBucket = canMergeUp ? yearBuckets[yearIdx - 1] : null;
                                    const nextBucket = canMergeDown ? yearBuckets[yearIdx + 1] : null;

                                    return (
                                      <div
                                        key={b.key}
                                        onClick={() => {
                                          setSelectedBucketKey(b.key);
                                          loadPreview(false, b.key);
                                        }}
                                        style={{
                                          display: "flex",
                                          alignItems: "center",
                                          justifyContent: "space-between",
                                          padding: "5px 8px",
                                          borderRadius: "6px",
                                          border: isSelected
                                            ? "1px solid var(--accent-purple)"
                                            : exceedsMax
                                            ? "1px solid rgba(245, 158, 11, 0.4)"
                                            : isBelowMin
                                            ? "1px solid rgba(245, 158, 11, 0.25)"
                                            : "1px solid var(--border-color)",
                                          backgroundColor: isSelected
                                            ? "rgba(138, 92, 246, 0.12)"
                                            : isUnknown
                                            ? "rgba(150, 150, 150, 0.08)"
                                            : "var(--bg-primary)",
                                          gap: "6px",
                                          cursor: "pointer",
                                        }}
                                      >
                                        <div
                                          style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0, flex: 1 }}
                                        >
                                          <span
                                            style={{
                                              fontSize: "0.78rem",
                                              fontWeight: 600,
                                              fontFamily: "var(--font-mono)",
                                              color: isUnknown ? "var(--text-secondary)" : "var(--text-primary)",
                                              width: "115px",
                                              flexShrink: 0,
                                              overflow: "hidden",
                                              textOverflow: "ellipsis",
                                              whiteSpace: "nowrap",
                                            }}
                                          >
                                            {b.label}
                                          </span>
                                          <span
                                            style={{
                                              fontSize: "0.68rem",
                                              padding: "1px 6px",
                                              borderRadius: "10px",
                                              backgroundColor: exceedsMax
                                                ? "rgba(245, 158, 11, 0.18)"
                                                : isBelowMin
                                                ? "rgba(245, 158, 11, 0.1)"
                                                : "var(--bg-surface)",
                                              color: exceedsMax || isBelowMin ? "var(--warning)" : "var(--text-secondary)",
                                              fontWeight: exceedsMax || isBelowMin ? 600 : 400,
                                              border: `1px solid ${
                                                exceedsMax
                                                  ? "rgba(245, 158, 11, 0.4)"
                                                  : isBelowMin
                                                  ? "rgba(245, 158, 11, 0.3)"
                                                  : "var(--border-color)"
                                              }`,
                                              whiteSpace: "nowrap",
                                              flexShrink: 0,
                                              display: "inline-flex",
                                              alignItems: "center",
                                              gap: "3px",
                                            }}
                                            title={
                                              exceedsMax
                                                ? `${b.track_count} tracks (Exceeds maximum limit of ${maxLimit})`
                                                : isBelowMin
                                                ? `${b.track_count} tracks (Below minimum limit of ${minLimit})`
                                                : `${b.track_count} tracks`
                                            }
                                          >
                                            {(isBelowMin || exceedsMax) && (
                                              <svg
                                                width="9"
                                                height="9"
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="2.5"
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                style={{ flexShrink: 0 }}
                                              >
                                                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                                                <line x1="12" y1="9" x2="12" y2="13"></line>
                                                <line x1="12" y1="17" x2="12.01" y2="17"></line>
                                              </svg>
                                            )}
                                            <span>
                                              {b.track_count} {b.track_count === 1 ? "track" : "tracks"}
                                            </span>
                                          </span>
                                          {isUnknown && (
                                            <span style={{ fontSize: "0.65rem", color: "var(--text-secondary)", fontStyle: "italic", whiteSpace: "nowrap" }}>
                                              ({activePlaylist.year_split?.include_unknown ? "included" : "ignored"})
                                            </span>
                                          )}
                                        </div>

                                        {/* Action buttons: 4 fixed columns (Merge Up, Merge Down, Split, Unmerge/Toggle) */}
                                        <div
                                          style={{
                                            display: "grid",
                                            gridTemplateColumns: "repeat(4, 22px)",
                                            gap: "3px",
                                            flexShrink: 0,
                                            alignItems: "center",
                                          }}
                                          onClick={(e) => e.stopPropagation()}
                                        >
                                          {/* Column 1: Merge Up */}
                                          {!isUnknown && canMergeUp && prevBucket ? (
                                            <button
                                              type="button"
                                              className="btn btn-secondary"
                                              onClick={() => {
                                                handleMergeBuckets(prevBucket.start_year!, prevBucket.end_year!, b.start_year!, b.end_year!);
                                              }}
                                              style={{
                                                width: "22px",
                                                height: "22px",
                                                padding: 0,
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                borderRadius: "4px",
                                              }}
                                              title={`Merge up with ${prevBucket.label} (${Math.min(prevBucket.start_year!, b.start_year!)}-${Math.max(prevBucket.end_year!, b.end_year!)})`}
                                            >
                                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                <line x1="12" y1="19" x2="12" y2="5"></line>
                                                <polyline points="5 12 12 5 19 12"></polyline>
                                              </svg>
                                            </button>
                                          ) : (
                                            <div style={{ width: "22px", height: "22px" }} />
                                          )}

                                          {/* Column 2: Merge Down */}
                                          {!isUnknown && canMergeDown && nextBucket ? (
                                            <button
                                              type="button"
                                              className="btn btn-secondary"
                                              onClick={() => {
                                                handleMergeBuckets(b.start_year!, b.end_year!, nextBucket.start_year!, nextBucket.end_year!);
                                              }}
                                              style={{
                                                width: "22px",
                                                height: "22px",
                                                padding: 0,
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                borderRadius: "4px",
                                              }}
                                              title={`Merge down with ${nextBucket.label} (${Math.min(b.start_year!, nextBucket.start_year!)}-${Math.max(b.end_year!, nextBucket.end_year!)})`}
                                            >
                                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                <line x1="12" y1="5" x2="12" y2="19"></line>
                                                <polyline points="19 12 12 19 5 12"></polyline>
                                              </svg>
                                            </button>
                                          ) : (
                                            <div style={{ width: "22px", height: "22px" }} />
                                          )}

                                          {/* Column 3: Split (10y to 5y, 5y to 1y, or Unknown into equal parts) */}
                                          {b.bucket_type === "10y" && b.start_year !== null ? (
                                            <button
                                              type="button"
                                              className="btn btn-secondary"
                                              onClick={() => {
                                                if (!config || selectedPlaylistIndex === null) return;
                                                const newPlaylists = [...config.playlists];
                                                const cur = newPlaylists[selectedPlaylistIndex].year_split!;
                                                const split5 = Array.from(new Set([...(cur.split_5y || []), b.start_year!]));
                                                newPlaylists[selectedPlaylistIndex] = {
                                                  ...newPlaylists[selectedPlaylistIndex],
                                                  year_split: { ...cur, split_5y: split5 },
                                                };
                                                const updatedConfig = { ...config, playlists: newPlaylists };
                                                setConfig(updatedConfig);
                                                invalidateCacheFor(selectedPlaylistIndex);
                                                fetchSinglePlaylistSummary(selectedPlaylistIndex, updatedConfig, true);
                                              }}
                                              style={{
                                                width: "22px",
                                                height: "22px",
                                                padding: 0,
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                borderRadius: "4px",
                                              }}
                                              title={`Split ${b.label} into two 5-year half-decades`}
                                            >
                                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                                <rect x="3" y="3" width="8" height="18" rx="1.5"/>
                                                <rect x="13" y="3" width="8" height="18" rx="1.5"/>
                                              </svg>
                                            </button>
                                          ) : b.bucket_type === "5y" && b.start_year !== null ? (
                                            <button
                                              type="button"
                                              className="btn btn-secondary"
                                              onClick={() => {
                                                if (!config || selectedPlaylistIndex === null) return;
                                                const newPlaylists = [...config.playlists];
                                                const cur = newPlaylists[selectedPlaylistIndex].year_split!;
                                                const split1 = Array.from(new Set([...(cur.split_1y || []), b.start_year!]));
                                                newPlaylists[selectedPlaylistIndex] = {
                                                  ...newPlaylists[selectedPlaylistIndex],
                                                  year_split: { ...cur, split_1y: split1 },
                                                };
                                                const updatedConfig = { ...config, playlists: newPlaylists };
                                                setConfig(updatedConfig);
                                                invalidateCacheFor(selectedPlaylistIndex);
                                                fetchSinglePlaylistSummary(selectedPlaylistIndex, updatedConfig, true);
                                              }}
                                              style={{
                                                width: "22px",
                                                height: "22px",
                                                padding: 0,
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                borderRadius: "4px",
                                              }}
                                              title={`Split ${b.label} into individual 1-year playlists`}
                                            >
                                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                                <line x1="8" y1="6" x2="21" y2="6"/>
                                                <line x1="8" y1="12" x2="21" y2="12"/>
                                                <line x1="8" y1="18" x2="21" y2="18"/>
                                                <circle cx="4" cy="6" r="1.5" fill="currentColor"/>
                                                <circle cx="4" cy="12" r="1.5" fill="currentColor"/>
                                                <circle cx="4" cy="18" r="1.5" fill="currentColor"/>
                                              </svg>
                                            </button>
                                          ) : isSingleYear && b.track_count > 0 ? (
                                            <button
                                              type="button"
                                              className="btn btn-secondary"
                                              onClick={() => {
                                                if (!config || selectedPlaylistIndex === null || b.start_year === null) return;
                                                const yr = b.start_year;
                                                const newPlaylists = [...config.playlists];
                                                const cur = newPlaylists[selectedPlaylistIndex].year_split!;
                                                const partsToSplit = Math.max(2, Math.ceil(b.track_count / maxLimit));
                                                const splitSingleYears = { ...(cur.split_single_years || {}) };
                                                splitSingleYears[yr] = partsToSplit;
                                                newPlaylists[selectedPlaylistIndex] = {
                                                  ...newPlaylists[selectedPlaylistIndex],
                                                  year_split: {
                                                    ...cur,
                                                    split_single_years: splitSingleYears,
                                                  },
                                                };
                                                const updatedConfig = { ...config, playlists: newPlaylists };
                                                setConfig(updatedConfig);
                                                invalidateCacheFor(selectedPlaylistIndex);
                                                fetchSinglePlaylistSummary(selectedPlaylistIndex, updatedConfig, true);
                                              }}
                                              style={{
                                                width: "22px",
                                                height: "22px",
                                                padding: 0,
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                borderRadius: "4px",
                                              }}
                                              title={`Split ${b.label} into ${Math.max(2, Math.ceil(b.track_count / maxLimit))} equal buckets (max ${maxLimit} tracks each)`}
                                            >
                                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                                <rect x="3" y="3" width="8" height="18" rx="1.5"/>
                                                <rect x="13" y="3" width="8" height="18" rx="1.5"/>
                                              </svg>
                                            </button>
                                          ) : isSingleUnknown && b.track_count > 0 ? (
                                            <button
                                              type="button"
                                              className="btn btn-secondary"
                                              onClick={() => {
                                                if (!config || selectedPlaylistIndex === null) return;
                                                const newPlaylists = [...config.playlists];
                                                const cur = newPlaylists[selectedPlaylistIndex].year_split!;
                                                const partsToSplit = Math.max(2, Math.ceil(b.track_count / maxLimit));
                                                newPlaylists[selectedPlaylistIndex] = {
                                                  ...newPlaylists[selectedPlaylistIndex],
                                                  year_split: {
                                                    ...cur,
                                                    split_unknown_parts: partsToSplit,
                                                  },
                                                };
                                                const updatedConfig = { ...config, playlists: newPlaylists };
                                                setConfig(updatedConfig);
                                                invalidateCacheFor(selectedPlaylistIndex);
                                                fetchSinglePlaylistSummary(selectedPlaylistIndex, updatedConfig, true);
                                              }}
                                              style={{
                                                width: "22px",
                                                height: "22px",
                                                padding: 0,
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                borderRadius: "4px",
                                              }}
                                              title={`Split unknown tracks into ${Math.max(2, Math.ceil(b.track_count / maxLimit))} equal buckets (max ${maxLimit} tracks each)`}
                                            >
                                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                                <rect x="3" y="3" width="8" height="18" rx="1.5"/>
                                                <rect x="13" y="3" width="8" height="18" rx="1.5"/>
                                              </svg>
                                            </button>
                                          ) : isSplitUnknown ? (
                                            <button
                                              type="button"
                                              className="btn btn-secondary"
                                              onClick={() => {
                                                if (!config || selectedPlaylistIndex === null) return;
                                                const newPlaylists = [...config.playlists];
                                                const cur = newPlaylists[selectedPlaylistIndex].year_split!;
                                                newPlaylists[selectedPlaylistIndex] = {
                                                  ...newPlaylists[selectedPlaylistIndex],
                                                  year_split: {
                                                    ...cur,
                                                    include_unknown: !cur.include_unknown,
                                                  },
                                                };
                                                const updatedConfig = { ...config, playlists: newPlaylists };
                                                setConfig(updatedConfig);
                                                invalidateCacheFor(selectedPlaylistIndex);
                                                fetchSinglePlaylistSummary(selectedPlaylistIndex, updatedConfig, true);
                                              }}
                                              style={{
                                                width: "22px",
                                                height: "22px",
                                                padding: 0,
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                borderRadius: "4px",
                                              }}
                                              title={activePlaylist.year_split?.include_unknown ? "Ignore untagged songs" : "Include untagged songs as Unknown playlist"}
                                            >
                                              {activePlaylist.year_split?.include_unknown ? (
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                  <line x1="18" y1="6" x2="6" y2="18"></line>
                                                  <line x1="6" y1="6" x2="18" y2="18"></line>
                                                </svg>
                                              ) : (
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                  <polyline points="20 6 9 17 4 12"></polyline>
                                                </svg>
                                              )}
                                            </button>
                                          ) : (
                                            <div style={{ width: "22px", height: "22px" }} />
                                          )}

                                          {/* Column 4: Unmerge / Revert to Parent / Unknown Toggle / Unknown Merge-Back */}
                                          {b.bucket_type === "custom" && b.start_year !== null && b.end_year !== null ? (
                                            <button
                                              type="button"
                                              className="btn btn-secondary"
                                              onClick={() => handleUnmergeCustomBucket(b.start_year!, b.end_year!)}
                                              style={{
                                                width: "22px",
                                                height: "22px",
                                                padding: 0,
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                borderRadius: "4px",
                                              }}
                                              title={`Unmerge ${b.label} back to separate buckets`}
                                            >
                                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                                                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                                              </svg>
                                            </button>
                                          ) : b.bucket_type === "5y" && b.parent_key && b.start_year !== null ? (
                                            <button
                                              type="button"
                                              className="btn btn-secondary"
                                              onClick={() => {
                                                if (!config || selectedPlaylistIndex === null) return;
                                                const decade = Math.floor(b.start_year! / 10) * 10;
                                                const newPlaylists = [...config.playlists];
                                                const cur = newPlaylists[selectedPlaylistIndex].year_split!;
                                                const split5 = (cur.split_5y || []).filter((d) => d !== decade);
                                                const split1 = (cur.split_1y || []).filter((h) => Math.floor(h / 10) * 10 !== decade);
                                                const splitSingleYears = { ...(cur.split_single_years || {}) };
                                                for (let y = decade; y <= decade + 9; y++) {
                                                  delete splitSingleYears[y];
                                                  delete splitSingleYears[String(y)];
                                                }
                                                newPlaylists[selectedPlaylistIndex] = {
                                                  ...newPlaylists[selectedPlaylistIndex],
                                                  year_split: { ...cur, split_5y: split5, split_1y: split1, split_single_years: splitSingleYears },
                                                };
                                                const updatedConfig = { ...config, playlists: newPlaylists };
                                                setConfig(updatedConfig);
                                                invalidateCacheFor(selectedPlaylistIndex);
                                                fetchSinglePlaylistSummary(selectedPlaylistIndex, updatedConfig, true);
                                              }}
                                              style={{
                                                width: "22px",
                                                height: "22px",
                                                padding: 0,
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                borderRadius: "4px",
                                              }}
                                              title={`Merge back to ${b.parent_key}`}
                                            >
                                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                                                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                                              </svg>
                                            </button>
                                          ) : b.bucket_type === "1y" && b.parent_key && b.start_year !== null ? (
                                            <button
                                              type="button"
                                              className="btn btn-secondary"
                                              onClick={() => {
                                                if (!config || selectedPlaylistIndex === null) return;
                                                const yr = b.start_year!;
                                                const decade = Math.floor(yr / 10) * 10;
                                                const half = (yr % 10) < 5 ? decade : decade + 5;
                                                const newPlaylists = [...config.playlists];
                                                const cur = newPlaylists[selectedPlaylistIndex].year_split!;
                                                const split1 = (cur.split_1y || []).filter((h) => h !== half);
                                                const splitSingleYears = { ...(cur.split_single_years || {}) };
                                                for (let y = half; y <= half + 4; y++) {
                                                  delete splitSingleYears[y];
                                                  delete splitSingleYears[String(y)];
                                                }
                                                newPlaylists[selectedPlaylistIndex] = {
                                                  ...newPlaylists[selectedPlaylistIndex],
                                                  year_split: { ...cur, split_1y: split1, split_single_years: splitSingleYears },
                                                };
                                                const updatedConfig = { ...config, playlists: newPlaylists };
                                                setConfig(updatedConfig);
                                                invalidateCacheFor(selectedPlaylistIndex);
                                                fetchSinglePlaylistSummary(selectedPlaylistIndex, updatedConfig, true);
                                              }}
                                              style={{
                                                width: "22px",
                                                height: "22px",
                                                padding: 0,
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                borderRadius: "4px",
                                              }}
                                              title={`Merge back to ${b.parent_key}`}
                                            >
                                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                                                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                                              </svg>
                                            </button>
                                          ) : isSplitSingleYear && b.start_year !== null ? (
                                            <button
                                              type="button"
                                              className="btn btn-secondary"
                                              onClick={() => {
                                                if (!config || selectedPlaylistIndex === null || b.start_year === null) return;
                                                const yr = b.start_year;
                                                const newPlaylists = [...config.playlists];
                                                const cur = { ...newPlaylists[selectedPlaylistIndex].year_split! };
                                                const splitSingleYears = { ...(cur.split_single_years || {}) };
                                                delete splitSingleYears[yr];
                                                delete splitSingleYears[String(yr)];
                                                newPlaylists[selectedPlaylistIndex] = {
                                                  ...newPlaylists[selectedPlaylistIndex],
                                                  year_split: {
                                                    ...cur,
                                                    split_single_years: splitSingleYears,
                                                  },
                                                };
                                                const updatedConfig = { ...config, playlists: newPlaylists };
                                                setConfig(updatedConfig);
                                                invalidateCacheFor(selectedPlaylistIndex);
                                                fetchSinglePlaylistSummary(selectedPlaylistIndex, updatedConfig, true);
                                              }}
                                              style={{
                                                width: "22px",
                                                height: "22px",
                                                padding: 0,
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                borderRadius: "4px",
                                              }}
                                              title={`Merge back to single ${b.start_year} bucket`}
                                            >
                                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                                                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                                              </svg>
                                            </button>
                                          ) : isSplitUnknown ? (
                                            <button
                                              type="button"
                                              className="btn btn-secondary"
                                              onClick={() => {
                                                if (!config || selectedPlaylistIndex === null) return;
                                                const newPlaylists = [...config.playlists];
                                                const cur = { ...newPlaylists[selectedPlaylistIndex].year_split! };
                                                delete cur.split_unknown_parts;
                                                newPlaylists[selectedPlaylistIndex] = {
                                                  ...newPlaylists[selectedPlaylistIndex],
                                                  year_split: cur,
                                                };
                                                const updatedConfig = { ...config, playlists: newPlaylists };
                                                setConfig(updatedConfig);
                                                invalidateCacheFor(selectedPlaylistIndex);
                                                fetchSinglePlaylistSummary(selectedPlaylistIndex, updatedConfig, true);
                                              }}
                                              style={{
                                                width: "22px",
                                                height: "22px",
                                                padding: 0,
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                borderRadius: "4px",
                                              }}
                                              title="Merge back to single Unknown Year bucket"
                                            >
                                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                                                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                                              </svg>
                                            </button>
                                          ) : isSingleUnknown ? (
                                            <button
                                              type="button"
                                              className="btn btn-secondary"
                                              onClick={() => {
                                                if (!config || selectedPlaylistIndex === null) return;
                                                const newPlaylists = [...config.playlists];
                                                const cur = newPlaylists[selectedPlaylistIndex].year_split!;
                                                newPlaylists[selectedPlaylistIndex] = {
                                                  ...newPlaylists[selectedPlaylistIndex],
                                                  year_split: {
                                                    ...cur,
                                                    include_unknown: !cur.include_unknown,
                                                  },
                                                };
                                                const updatedConfig = { ...config, playlists: newPlaylists };
                                                setConfig(updatedConfig);
                                                invalidateCacheFor(selectedPlaylistIndex);
                                                fetchSinglePlaylistSummary(selectedPlaylistIndex, updatedConfig, true);
                                              }}
                                              style={{
                                                width: "22px",
                                                height: "22px",
                                                padding: 0,
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                                borderRadius: "4px",
                                              }}
                                              title={activePlaylist.year_split?.include_unknown ? "Ignore untagged songs" : "Include untagged songs as Unknown playlist"}
                                            >
                                              {activePlaylist.year_split?.include_unknown ? (
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                  <line x1="18" y1="6" x2="6" y2="18"></line>
                                                  <line x1="6" y1="6" x2="18" y2="18"></line>
                                                </svg>
                                              ) : (
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                  <polyline points="20 6 9 17 4 12"></polyline>
                                                </svg>
                                              )}
                                            </button>
                                          ) : (
                                            <div style={{ width: "22px", height: "22px" }} />
                                          )}
                                        </div>
                                      </div>
                                    );
                                  });
                                })()}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Resizable separator handle 2 */}
              <div
                onMouseDown={handleConfigMouseDown}
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
                title="Drag to resize configuration panel"
              >
                <div style={{
                  width: "2px",
                  height: "40px",
                  borderRadius: "1px",
                  backgroundColor: "var(--border-color)",
                  transition: "background-color 0.2s"
                }} className="resizable-indicator" />
              </div>

              {/* Preview card */}
              <ResolvedTracksPanel
                previews={previews}
                isLoadingPreview={isLoadingPreview}
                previewError={previewError}
                loadPreview={() => loadPreview(true)}
                onPlayTrack={(track, queue, name) => onPlayTrack && onPlayTrack(track, queue, name)}
                onPlayAll={() => {
                  if (onPlayQueue && previews.length > 0) {
                    const audioTracks: AudioTrack[] = previews.map((t) => ({
                      file_path: t.file_path,
                      title: t.title,
                      artist: t.artist,
                      duration: t.duration,
                    }));
                    const playlistName = activePlaylist ? activePlaylist.name : "Playlist";
                    onPlayQueue(audioTracks, playlistName, false);
                  }
                }}
                emptyMessage="Select a playlist from the sidebar to preview resolved tracks."
                contextName={activePlaylist ? (selectedBucketKey !== "all" ? `${activePlaylist.name} - ${selectedBucketKey}` : activePlaylist.name) : "Playlist"}
                title={
                  activePlaylist
                    ? selectedBucketKey !== "all"
                      ? `${activePlaylist.name} [${selectedBucketKey}] (${previews.length})`
                      : `Resolved Tracks: ${activePlaylist.name} (${previews.length})`
                    : "Resolved Tracks"
                }
              />
            </>
          ) : (
            <div className="card" style={{ flex: 1, margin: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <p className="no-data">Select a playlist from the sidebar or click "+ Add Playlist" to configure rules and preview tracks.</p>
            </div>
          )}
        </div>
      </div>

      {/* Compilation logs modal */}
      {showLogsModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(0, 0, 0, 0.75)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1000
        }}>
          <div className="card" style={{ width: "650px", maxHeight: "80%", display: "flex", flexDirection: "column", margin: 0, padding: "24px" }}>
            <div className="card-title" style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <span>Playlist Compiler Logs</span>
                {!isCompilationAutoScroll && generationLogs.length > 0 && (
                  <button
                    type="button"
                    onClick={handleCompilationScrollToLatest}
                    style={{
                      backgroundColor: "rgba(138, 92, 246, 0.15)",
                      color: "var(--accent-purple-hover)",
                      border: "1px solid var(--accent-purple)",
                      borderRadius: "14px",
                      padding: "2px 10px",
                      fontSize: "0.74rem",
                      fontWeight: 600,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: "4px",
                      transition: "all 0.2s ease",
                    }}
                    title="Click to jump to latest logs and resume auto-scroll"
                  >
                    <span>⬇ Jump to latest</span>
                  </button>
                )}
              </div>
              <button
                className="btn btn-secondary"
                onClick={() => setShowLogsModal(false)}
                disabled={isGenerating}
                style={{ padding: "6px 12px", fontSize: "0.85rem" }}
              >
                Close Logs
              </button>
            </div>
            <div
              ref={compilationLogsRef}
              onScroll={handleCompilationLogsScroll}
              className="console-log"
              style={{ flex: 1, minHeight: "300px", maxHeight: "400px", overflowY: "auto", marginTop: "16px" }}
            >
              {generationLogs.join("\n")}
            </div>
          </div>
        </div>
      )}

      {/* Delete Playlist Confirmation Modal */}
      {isConfirmingDelete && activePlaylist && (
        <ConfirmModal
          title="⚠️ Confirm Delete Playlist"
          message={`Are you sure you want to remove playlist "${activePlaylist.name}" from this workspace config?`}
          confirmText="🗑 Delete Playlist"
          confirmVariant="danger"
          onConfirm={executeDeletePlaylist}
          onCancel={() => setIsConfirmingDelete(false)}
        />
      )}

      {/* Delete Source Confirmation Modal */}
      {deleteSourceTarget && activePlaylist && (
        <ConfirmModal
          title="⚠️ Confirm Remove Source"
          message={`Are you sure you want to remove source folder "${deleteSourceTarget.path}" from playlist "${activePlaylist.name}"?`}
          confirmText="🗑 Remove Source"
          confirmVariant="danger"
          onConfirm={() => {
            removeSource(deleteSourceTarget.index);
            setDeleteSourceTarget(null);
          }}
          onCancel={() => setDeleteSourceTarget(null)}
        />
      )}

      {/* Delete Exclusion Confirmation Modal */}
      {deleteExclusionTarget && activePlaylist && (
        <ConfirmModal
          title="⚠️ Confirm Remove Exclusion"
          message={`Are you sure you want to remove exclusion folder "${deleteExclusionTarget.path}" from playlist "${activePlaylist.name}"?`}
          confirmText="🗑 Remove Exclusion"
          confirmVariant="danger"
          onConfirm={() => {
            removeExclusion(deleteExclusionTarget.index);
            setDeleteExclusionTarget(null);
          }}
          onCancel={() => setDeleteExclusionTarget(null)}
        />
      )}

      {/* Duplicate Songs Analysis Modal (Per-Playlist or Global) */}
      <DuplicateAnalysisModal
        isOpen={dupModalTarget.open}
        onClose={() => setDupModalTarget((prev) => ({ ...prev, open: false }))}
        configPath={configPath}
        playlistIndex={dupModalTarget.playlistIndex}
        playlistName={dupModalTarget.playlistName}
        formats={formats}
        onPlayTrack={onPlayTrack}
      />
    </div>
  );
};
