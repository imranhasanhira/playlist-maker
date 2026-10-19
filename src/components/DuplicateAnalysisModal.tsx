import React, { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AudioTrack,
  DeleteDuplicatesResult,
  DuplicateAnalysisProgressPayload,
  DuplicateAnalysisReport,
  DuplicateCleanupGroup,
  DuplicateGroup,
  DuplicateTrackEntry,
  PruneCacheReport,
} from "../types";
import { formatSize, formatEta } from "../utils/formatters";
import { ConfirmModal } from "./common/ConfirmModal";
import {
  WinnerCriterion,
  DEFAULT_WINNER_CRITERIA,
  WinnerCriteriaEditor,
} from "./duplicate/WinnerCriteriaEditor";
import { DuplicateGroupRows } from "./duplicate/DuplicateGroupRows";
export type { WinnerCriterion };

const getFormatQualityRank = (ext: string): number => {
  switch (ext.toLowerCase()) {
    case "flac": return 100;
    case "wav":
    case "alac": return 90;
    case "m4a":
    case "aac":
    case "opus": return 80;
    case "mp3": return 70;
    case "ogg": return 60;
    case "wma": return 50;
    default: return 10;
  }
};

const recalculateGroupWinners = (
  groups: DuplicateGroup[],
  criteria: WinnerCriterion[]
): { updatedGroups: DuplicateGroup[]; redundantCount: number; redundantBytes: number } => {
  const activeCriteria = criteria.filter((c) => c.enabled);
  let redundantCount = 0;
  let redundantBytes = 0;

  const updatedGroups = groups.map((group) => {
    if (group.tracks.length <= 1) {
      return group;
    }

    const validDurs = group.tracks.map((t) => t.duration).filter((d) => d > 0);
    const minDur = validDurs.length > 0 ? Math.min(...validDurs) : 0;

    const sorted = [...group.tracks].sort((a, b) => {
      for (const crit of activeCriteria) {
        switch (crit.id) {
          case "clean_duration": {
            const aHasAd = minDur > 30 && a.duration >= minDur + 5;
            const bHasAd = minDur > 30 && b.duration >= minDur + 5;
            if (aHasAd !== bHasAd) {
              return aHasAd ? 1 : -1;
            }
            break;
          }
          case "format_quality": {
            const rankA = getFormatQualityRank(a.format_ext);
            const rankB = getFormatQualityRank(b.format_ext);
            if (rankA !== rankB) {
              return rankB - rankA;
            }
            break;
          }
          case "bitrate": {
            if (a.bitrate_kbps !== b.bitrate_kbps) {
              return b.bitrate_kbps - a.bitrate_kbps;
            }
            break;
          }
          case "source_priority": {
            if (a.source_index !== b.source_index) {
              return a.source_index - b.source_index;
            }
            break;
          }
          case "file_size": {
            if (a.size_bytes !== b.size_bytes) {
              return b.size_bytes - a.size_bytes;
            }
            break;
          }
        }
      }
      return a.file_path.localeCompare(b.file_path);
    });

    const winner = sorted[0];
    const second = sorted[1];

    let winnerReason = "Selected winner";
    for (const crit of activeCriteria) {
      if (crit.id === "clean_duration") {
        const aHasAd = minDur > 30 && winner.duration >= minDur + 5;
        const bHasAd = minDur > 30 && second.duration >= minDur + 5;
        if (!aHasAd && bHasAd) {
          winnerReason = "Clean duration (no intro/outro sponsor ad)";
          break;
        }
      }
      if (crit.id === "format_quality") {
        const rankA = getFormatQualityRank(winner.format_ext);
        const rankB = getFormatQualityRank(second.format_ext);
        if (rankA > rankB) {
          winnerReason = `Superior format (.${winner.format_ext.toUpperCase()} > .${second.format_ext.toUpperCase()})`;
          break;
        }
      }
      if (crit.id === "bitrate") {
        if (winner.bitrate_kbps > second.bitrate_kbps) {
          winnerReason = `Higher bitrate (${winner.bitrate_kbps} kbps vs ${second.bitrate_kbps} kbps)`;
          break;
        }
      }
      if (crit.id === "source_priority") {
        if (winner.source_index < second.source_index) {
          winnerReason = `Source #${winner.source_index + 1} Priority (${winner.source_folder})`;
          break;
        }
      }
      if (crit.id === "file_size") {
        if (winner.size_bytes > second.size_bytes) {
          winnerReason = `Larger file size (${formatSize(winner.size_bytes)} vs ${formatSize(second.size_bytes)})`;
          break;
        }
      }
    }

    const finalTracks = sorted.map((t, idx) => {
      const isWinner = idx === 0;
      if (!isWinner) {
        redundantCount += 1;
        redundantBytes += t.size_bytes;
      }
      return {
        ...t,
        is_winner: isWinner,
        winner_reason: isWinner
          ? winnerReason
          : t.source_folder
          ? `Source #${t.source_index + 1}`
          : "Alternative duplicate",
      };
    });

    return {
      ...group,
      tracks: finalTracks,
    };
  });

  return { updatedGroups, redundantCount, redundantBytes };
};

type DuplicateAnalysisModalProps = {
  isOpen: boolean;
  onClose: () => void;
  configPath: string;
  playlistIndex: number | null; // null = Global across all playlists & workspace
  playlistName?: string;
  formats: string;
  onPlayTrack: (track: AudioTrack, queue: AudioTrack[], playlistName: string) => void;
};

export const DuplicateAnalysisModal: React.FC<DuplicateAnalysisModalProps> = ({
  isOpen,
  onClose,
  configPath,
  playlistIndex,
  playlistName,
  formats,
  onPlayTrack,
}) => {
  const [report, setReport] = useState<DuplicateAnalysisReport | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [analysisProgress, setAnalysisProgress] = useState<DuplicateAnalysisProgressPayload | null>(null);
  const [error, setError] = useState<string>("");
  const [computeAcoustic, setComputeAcoustic] = useState<boolean>(true);
  const [maxAcousticSecs, setMaxAcousticSecs] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("max_acoustic_secs");
      return saved ? Math.max(20, Math.min(120, parseInt(saved, 10))) : 60;
    } catch (e) {
      return 60;
    }
  });
  const [searchQuery, setSearchQuery] = useState<string>("");
  const ALL_TIER_KEYS = useMemo(() => ["exact_hash", "youtube_id", "acoustic", "metadata"], []);
  const [selectedTiers, setSelectedTiers] = useState<Set<string>>(
    () => new Set(["exact_hash", "youtube_id", "acoustic", "metadata"])
  );
  const [sortBy, setSortBy] = useState<string>(() => {
    try {
      return localStorage.getItem("dedup_sort_by") || "tier_exact";
    } catch (e) {
      return "tier_exact";
    }
  });
  const [sortAsc, setSortAsc] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("dedup_sort_asc");
      return saved !== null ? saved === "true" : true;
    } catch (e) {
      return true;
    }
  });
  const [pruneStatus, setPruneStatus] = useState<string>("");
  const [isPruning, setIsPruning] = useState<boolean>(false);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [actionStatus, setActionStatus] = useState<string>("");
  const [showRulesConfig, setShowRulesConfig] = useState<boolean>(false);
  const [winnerCriteria, setWinnerCriteria] = useState<WinnerCriterion[]>(() => {
    try {
      const saved = localStorage.getItem("dedup_winner_rules");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const existingIds = new Set(parsed.map((p: WinnerCriterion) => p.id));
          const missing = DEFAULT_WINNER_CRITERIA.filter((d) => !existingIds.has(d.id));
          return [...parsed, ...missing];
        }
      }
    } catch (e) {
      console.warn("Failed to load dedup winner rules from storage:", e);
    }
    return DEFAULT_WINNER_CRITERIA;
  });
  const [pageSize, setPageSize] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("dedup_page_size");
      return saved ? parseInt(saved, 10) : 50;
    } catch (e) {
      return 50;
    }
  });
  const [currentPage, setCurrentPage] = useState<number>(1);
  const tableContainerRef = React.useRef<HTMLDivElement>(null);
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    confirmText: string;
    onConfirm: () => void;
  } | null>(null);
  const [excludedTrackPaths, setExcludedTrackPaths] = useState<Set<string>>(new Set());
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());

  const handleToggleExcludeTrack = (filePath: string) => {
    setExcludedTrackPaths((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  };

  const handleToggleSelectGroup = (groupId: string) => {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const handleDetachTrack = (group: DuplicateGroup, track: DuplicateTrackEntry) => {
    const fileName = track.file_path.split(/[/\\]/).pop() || track.title;
    const savedScrollTop = tableContainerRef.current?.scrollTop;

    setReport((prev) => {
      if (!prev) return null;
      const groupToUpdate = prev.duplicate_groups.find((g) => g.group_id === group.group_id);
      if (!groupToUpdate) return prev;

      const remainingTracks = groupToUpdate.tracks.filter((t) => t.file_path !== track.file_path);
      if (remainingTracks.length <= 1) {
        setSelectedGroupIds((s) => {
          const next = new Set(s);
          next.delete(group.group_id);
          return next;
        });
        // Group dissolved because only 1 or 0 tracks remain
        const newGroups = prev.duplicate_groups.filter((g) => g.group_id !== group.group_id);
        const lostRedundant = Math.max(0, groupToUpdate.tracks.length - 1);
        const lostBytes = groupToUpdate.tracks.filter((t) => !t.is_winner).reduce((sum, t) => sum + t.size_bytes, 0);
        return {
          ...prev,
          duplicate_groups: newGroups,
          redundant_files_count: Math.max(0, prev.redundant_files_count - lostRedundant),
          redundant_bytes: Math.max(0, prev.redundant_bytes - lostBytes),
        };
      }

      // If the detached track was the winner, promote the first remaining track as winner
      if (track.is_winner && remainingTracks.length > 0) {
        remainingTracks[0].is_winner = true;
        remainingTracks[0].winner_reason = "Promoted as kept winner after detachment";
      }

      const updatedGroups = prev.duplicate_groups.map((g) => {
        if (g.group_id !== group.group_id) return g;
        return {
          ...g,
          tracks: remainingTracks,
        };
      });

      const lostBytes = track.is_winner ? 0 : track.size_bytes;
      return {
        ...prev,
        duplicate_groups: updatedGroups,
        redundant_files_count: Math.max(0, prev.redundant_files_count - (track.is_winner ? 0 : 1)),
        redundant_bytes: Math.max(0, prev.redundant_bytes - lostBytes),
      };
    });
    setActionStatus(`Detached "${fileName}" from duplicate group. It is now kept and preserved.`);

    if (savedScrollTop !== undefined && savedScrollTop > 0) {
      requestAnimationFrame(() => {
        if (tableContainerRef.current) {
          tableContainerRef.current.scrollTop = savedScrollTop;
        }
      });
    }
  };

  const handleMakeWinner = (group: DuplicateGroup, track: DuplicateTrackEntry) => {
    const savedScrollTop = tableContainerRef.current?.scrollTop;
    setReport((prev) => {
      if (!prev) return null;
      const updatedGroups = prev.duplicate_groups.map((g) => {
        if (g.group_id !== group.group_id) return g;
        const updatedTracks = g.tracks.map((t) => ({
          ...t,
          is_winner: t.file_path === track.file_path,
          winner_reason: t.file_path === track.file_path ? "User selected as preferred winner" : "Alternative duplicate",
        }));
        updatedTracks.sort((a, b) => (b.is_winner ? 1 : 0) - (a.is_winner ? 1 : 0));
        return {
          ...g,
          tracks: updatedTracks,
        };
      });
      return {
        ...prev,
        duplicate_groups: updatedGroups,
      };
    });
    const fileName = track.file_path.split(/[/\\]/).pop() || track.title;
    setActionStatus(`Set "${fileName}" as the KEPT winner for this duplicate group.`);

    if (savedScrollTop !== undefined && savedScrollTop > 0) {
      requestAnimationFrame(() => {
        if (tableContainerRef.current) {
          tableContainerRef.current.scrollTop = savedScrollTop;
        }
      });
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let isMounted = true;

    listen<DuplicateAnalysisProgressPayload>(
      "duplicate-analysis-progress",
      (event) => {
        if (isMounted) {
          setAnalysisProgress((prev) => {
            const isStageChange = Boolean(prev && prev.stage !== event.payload.stage);
            const currentFile = event.payload.current_file
              ? event.payload.current_file
              : isStageChange || event.payload.phase === "done"
              ? undefined
              : prev?.current_file;
            return {
              ...event.payload,
              current_file: currentFile,
            };
          });
        }
      }
    ).then((u) => {
      if (isMounted) {
        unlisten = u;
      } else {
        u();
      }
    }).catch((e) => {
      console.error("Failed to attach duplicate progress listener:", e);
    });

    return () => {
      isMounted = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      invoke("cancel_any_task", { taskId: "duplicate_analysis" }).catch(() => {});
    }
  }, [isOpen]);

  const handleClose = () => {
    if (isLoading) {
      invoke("cancel_any_task", { taskId: "duplicate_analysis" }).catch(() => {});
    }
    onClose();
  };

  const runAnalysis = async (acousticOverride?: boolean, maxSecsOverride?: number) => {
    if (!configPath) return;
    setIsLoading(true);
    setError("");
    setPruneStatus("");
    setAnalysisProgress(null);
    try {
      const useAcoustic = acousticOverride !== undefined ? acousticOverride : computeAcoustic;
      const maxSecs = maxSecsOverride !== undefined ? maxSecsOverride : maxAcousticSecs;
      const res = await invoke<DuplicateAnalysisReport>("analyze_playlist_duplicates", {
        taskId: "duplicate_analysis",
        configPath,
        sourceDirOverride: null,
        playlistIndex: playlistIndex,
        formats,
        computeAcoustic: useAcoustic,
        maxAcousticSeconds: maxSecs,
        winnerCriteria: winnerCriteria.filter((c) => c.enabled).map((c) => c.id),
      });
      setReport(res);
      setSelectedGroupIds(new Set(res.duplicate_groups.map((g) => g.group_id)));
      setCurrentPage(1);
      if (tableContainerRef.current) {
        tableContainerRef.current.scrollTop = 0;
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && configPath) {
      runAnalysis();
    }
  }, [isOpen, configPath, playlistIndex]);

  const handleToggleCriterion = (id: string) => {
    setWinnerCriteria((prev) => {
      const updated = prev.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c));
      try {
        localStorage.setItem("dedup_winner_rules", JSON.stringify(updated));
      } catch (e) {}
      if (report) {
        const { updatedGroups, redundantCount, redundantBytes } = recalculateGroupWinners(
          report.duplicate_groups,
          updated
        );
        setReport({
          ...report,
          duplicate_groups: updatedGroups,
          redundant_files_count: redundantCount,
          redundant_bytes: redundantBytes,
        });
      }
      return updated;
    });
  };

  const handleMoveCriterion = (index: number, direction: "up" | "down") => {
    setWinnerCriteria((prev) => {
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= prev.length) return prev;
      const copy = [...prev];
      const [moved] = copy.splice(index, 1);
      copy.splice(targetIndex, 0, moved);
      try {
        localStorage.setItem("dedup_winner_rules", JSON.stringify(copy));
      } catch (e) {}
      if (report) {
        const { updatedGroups, redundantCount, redundantBytes } = recalculateGroupWinners(
          report.duplicate_groups,
          copy
        );
        setReport({
          ...report,
          duplicate_groups: updatedGroups,
          redundant_files_count: redundantCount,
          redundant_bytes: redundantBytes,
        });
      }
      return copy;
    });
  };

  const handleResetCriteria = () => {
    setWinnerCriteria(DEFAULT_WINNER_CRITERIA);
    try {
      localStorage.setItem("dedup_winner_rules", JSON.stringify(DEFAULT_WINNER_CRITERIA));
    } catch (e) {}
    if (report) {
      const { updatedGroups, redundantCount, redundantBytes } = recalculateGroupWinners(
        report.duplicate_groups,
        DEFAULT_WINNER_CRITERIA
      );
      setReport({
        ...report,
        duplicate_groups: updatedGroups,
        redundant_files_count: redundantCount,
        redundant_bytes: redundantBytes,
      });
    }
  };

  const handlePruneCache = async (clearAll = false) => {
    setIsPruning(true);
    setPruneStatus("");
    try {
      const res = await invoke<PruneCacheReport>("prune_fingerprint_cache", {
        clearAll,
      });
      if (clearAll) {
        setPruneStatus(`Cleared ${res.pruned_count} cached fingerprints.`);
      } else {
        setPruneStatus(
          `Pruned ${res.pruned_count} stale entries (${res.remaining_count} active entries remain).`
        );
      }
      runAnalysis();
    } catch (e) {
      setPruneStatus(`Cache prune error: ${e}`);
    } finally {
      setIsPruning(false);
    }
  };

  const handleRevealInFinder = async (filePath: string) => {
    try {
      await invoke("reveal_in_finder", { filePath });
    } catch (e) {
      alert("Error revealing file: " + e);
    }
  };


  const handleKeepThisAndDeleteOthers = async (group: DuplicateGroup, keepTrack: DuplicateTrackEntry) => {
    if (isDeleting) return;
    const otherTracks = group.tracks.filter(
      (t) => t.file_path !== keepTrack.file_path && !excludedTrackPaths.has(t.file_path)
    );
    if (otherTracks.length === 0) {
      alert("The other tracks in this group are marked as kept. Uncheck 'Keep' if you wish to delete them.");
      return;
    }

    const fileName = keepTrack.file_path.split(/[/\\]/).pop() || keepTrack.title;
    const otherFilesList = otherTracks
      .map((t) => `• ${t.file_path.split(/[/\\]/).pop() || t.title} (${formatSize(t.size_bytes)})`)
      .join("\n");
    const otherBytes = otherTracks.reduce((sum, t) => sum + t.size_bytes, 0);

    const confirmMsg = `Keep this track and permanently delete the other ${otherTracks.length} duplicate copy(ies) from disk?\n\nKEPT:\n• ${fileName}\n\nDELETE FROM DISK (${formatSize(otherBytes)} freed):\n${otherFilesList}`;
    setConfirmModal({
      title: "🗑️ Keep Selected & Delete Others",
      message: confirmMsg,
      confirmText: `Delete ${otherTracks.length} Files`,
      onConfirm: async () => {
        setConfirmModal(null);
        setIsDeleting(true);
        setActionStatus("");
        try {
          const filePaths = otherTracks.map((t) => t.file_path);
          const groupYtId =
            keepTrack.youtube_id || otherTracks.find((t) => t.youtube_id)?.youtube_id || null;
          const cleanupGroups: DuplicateCleanupGroup[] = [
            {
              kept_file_path: keepTrack.file_path,
              files_to_delete: filePaths,
              youtube_id: groupYtId,
            },
          ];
          const res = await invoke<DeleteDuplicatesResult>("delete_duplicate_files", {
            filePaths,
            cleanupGroups,
          });

          if (res.errors.length > 0) {
            alert(`Failed to delete some files:\n\n${res.errors.join("\n")}`);
          }

          let statusMsg = `Kept "${fileName}" and deleted ${res.deleted_count} duplicate file(s) (${formatSize(res.freed_bytes)} freed).`;
          if (res.tags_transferred_count && res.tags_transferred_count > 0) {
            statusMsg += ` Preserved YouTube ID to kept file tags.`;
          }
          setActionStatus(statusMsg);

          const savedScrollTop = tableContainerRef.current?.scrollTop;
          // Immediately remove this group from the report view
          setReport((prev) => {
            if (!prev) return null;
            const remainingGroups = prev.duplicate_groups.filter((g) => g.group_id !== group.group_id);
            return {
              ...prev,
              duplicate_groups: remainingGroups,
              redundant_files_count: Math.max(0, prev.redundant_files_count - otherTracks.length),
              redundant_bytes: Math.max(0, prev.redundant_bytes - otherBytes),
            };
          });
          setSelectedGroupIds((prev) => {
            const next = new Set(prev);
            next.delete(group.group_id);
            return next;
          });

          if (savedScrollTop !== undefined && savedScrollTop > 0) {
            requestAnimationFrame(() => {
              if (tableContainerRef.current) {
                tableContainerRef.current.scrollTop = savedScrollTop;
              }
            });
          }
        } catch (e) {
          alert(`Error deleting duplicate files: ${e}`);
        } finally {
          setIsDeleting(false);
        }
      },
    });
  };

  const handlePlayGroupTrack = (group: DuplicateGroup, entry: DuplicateTrackEntry) => {
    const queue: AudioTrack[] = group.tracks.map((t) => ({
      file_path: t.file_path,
      title: `${t.title} [${t.is_winner ? "KEPT" : "SKIPPED"} • ${t.format_ext}]`,
      artist: t.artist || t.source_folder,
      duration: t.duration,
    }));
    const target: AudioTrack = {
      file_path: entry.file_path,
      title: `${entry.title} [${entry.is_winner ? "KEPT" : "SKIPPED"} • ${entry.format_ext}]`,
      artist: entry.artist || entry.source_folder,
      duration: entry.duration,
    };
    onPlayTrack(target, queue, `Duplicates: ${group.canonical_title}`);
  };

  const tierCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: 0,
      exact_hash: 0,
      youtube_id: 0,
      acoustic: 0,
      metadata: 0,
    };
    if (!report) return counts;
    counts.all = report.duplicate_groups.length;
    for (const g of report.duplicate_groups) {
      if (g.match_tier in counts) {
        counts[g.match_tier]++;
      }
    }
    return counts;
  }, [report]);

  const isAllTiersSelected = useMemo(() => {
    return ALL_TIER_KEYS.every((t) => selectedTiers.has(t));
  }, [ALL_TIER_KEYS, selectedTiers]);

  const handleToggleTier = (tierKey: string) => {
    if (tierKey === "all") {
      setSelectedTiers(new Set(ALL_TIER_KEYS));
      return;
    }

    setSelectedTiers((prev) => {
      // If currently all are selected, clicking one isolates that specific tier
      if (ALL_TIER_KEYS.every((t) => prev.has(t))) {
        return new Set([tierKey]);
      }

      const next = new Set(prev);
      if (next.has(tierKey)) {
        next.delete(tierKey);
        // If none remain, revert back to all
        if (next.size === 0) {
          return new Set(ALL_TIER_KEYS);
        }
      } else {
        next.add(tierKey);
      }
      return next;
    });
  };

  const TIER_PRIORITIES: Record<string, Record<string, number>> = {
    tier_exact: { exact_hash: 1, youtube_id: 2, acoustic: 3, metadata: 4 },
    tier_youtube: { youtube_id: 1, acoustic: 2, exact_hash: 3, metadata: 4 },
    tier_acoustic: { acoustic: 1, youtube_id: 2, exact_hash: 3, metadata: 4 },
    tier_metadata: { metadata: 1, youtube_id: 2, acoustic: 3, exact_hash: 4 },
  };

  const filteredGroups = useMemo(() => {
    if (!report) return [];
    const q = searchQuery.trim().toLowerCase();

    // 1. Filter by selected tiers and search query
    const filtered = report.duplicate_groups.filter((g) => {
      if (!selectedTiers.has(g.match_tier)) {
        return false;
      }
      if (!q) return true;
      if (
        g.canonical_title.toLowerCase().includes(q) ||
        g.canonical_artist.toLowerCase().includes(q) ||
        g.match_label.toLowerCase().includes(q)
      ) {
        return true;
      }
      return g.tracks.some(
        (t) =>
          t.relative_path.toLowerCase().includes(q) ||
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          t.source_folder.toLowerCase().includes(q)
      );
    });

    // 2. Sort groups
    filtered.sort((a, b) => {
      let cmp = 0;
      if (sortBy in TIER_PRIORITIES) {
        const priorities = TIER_PRIORITIES[sortBy];
        const rankA = priorities[a.match_tier] ?? 99;
        const rankB = priorities[b.match_tier] ?? 99;
        cmp = rankA - rankB;
        if (cmp === 0) {
          cmp = b.confidence - a.confidence || a.canonical_title.localeCompare(b.canonical_title);
        }
      } else {
        switch (sortBy) {
          case "redundant_bytes": {
            const bytesA = a.tracks.filter((t) => !t.is_winner).reduce((s, t) => s + t.size_bytes, 0);
            const bytesB = b.tracks.filter((t) => !t.is_winner).reduce((s, t) => s + t.size_bytes, 0);
            cmp = bytesB - bytesA; // naturally highest bytes first
            break;
          }
          case "versions_count": {
            cmp = b.tracks.length - a.tracks.length; // naturally most versions first
            break;
          }
          case "confidence": {
            cmp = b.confidence - a.confidence; // naturally highest confidence first
            break;
          }
          case "title": {
            cmp = a.canonical_title.localeCompare(b.canonical_title);
            break;
          }
          case "artist": {
            cmp = a.canonical_artist.localeCompare(b.canonical_artist);
            break;
          }
          default:
            cmp = 0;
        }
      }

      return sortAsc ? cmp : -cmp;
    });

    return filtered;
  }, [report, searchQuery, selectedTiers, sortBy, sortAsc]);

  useEffect(() => {
    setCurrentPage(1);
    if (tableContainerRef.current) {
      tableContainerRef.current.scrollTop = 0;
    }
  }, [searchQuery, selectedTiers, sortBy, sortAsc]);

  const totalGroups = filteredGroups.length;
  const totalPages = pageSize === -1 ? 1 : Math.max(1, Math.ceil(totalGroups / pageSize));
  const safePage = Math.min(currentPage, totalPages);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [totalPages, currentPage]);

  const displayedGroups = useMemo(() => {
    if (pageSize === -1) return filteredGroups;
    const start = (safePage - 1) * pageSize;
    return filteredGroups.slice(start, start + pageSize);
  }, [filteredGroups, safePage, pageSize]);

  const filteredGroupIds = useMemo(() => {
    return filteredGroups.map((g) => g.group_id);
  }, [filteredGroups]);

  const isAllFilteredSelected = useMemo(() => {
    if (filteredGroupIds.length === 0) return false;
    return filteredGroupIds.every((id) => selectedGroupIds.has(id));
  }, [filteredGroupIds, selectedGroupIds]);

  const isSomeFilteredSelected = useMemo(() => {
    if (filteredGroupIds.length === 0) return false;
    const count = filteredGroupIds.filter((id) => selectedGroupIds.has(id)).length;
    return count > 0 && count < filteredGroupIds.length;
  }, [filteredGroupIds, selectedGroupIds]);

  const handleToggleSelectAllFiltered = () => {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (isAllFilteredSelected) {
        for (const id of filteredGroupIds) {
          next.delete(id);
        }
      } else {
        for (const id of filteredGroupIds) {
          next.add(id);
        }
      }
      return next;
    });
  };

  const handlePageChange = (newPage: number) => {
    const clamped = Math.max(1, Math.min(newPage, totalPages));
    setCurrentPage(clamped);
    if (tableContainerRef.current) {
      tableContainerRef.current.scrollTop = 0;
    }
  };

  const handlePageSizeChange = (newSize: number) => {
    setPageSize(newSize);
    setCurrentPage(1);
    try {
      localStorage.setItem("dedup_page_size", String(newSize));
    } catch (e) {}
    if (tableContainerRef.current) {
      tableContainerRef.current.scrollTop = 0;
    }
  };

  const currentTabSelectedGroupCount = useMemo(() => {
    return filteredGroups.filter((g) => selectedGroupIds.has(g.group_id)).length;
  }, [filteredGroups, selectedGroupIds]);

  const {
    currentTabSelectedRedundantCount,
    currentTabSelectedRedundantBytes,
    currentTabSelectedGroupsWithRedundantCount,
  } = useMemo(() => {
    let count = 0;
    let bytes = 0;
    let groupsCount = 0;

    for (const group of filteredGroups) {
      if (!selectedGroupIds.has(group.group_id)) continue;
      let groupHasRedundant = false;
      for (const track of group.tracks) {
        if (!track.is_winner && !excludedTrackPaths.has(track.file_path)) {
          count++;
          bytes += track.size_bytes;
          groupHasRedundant = true;
        }
      }
      if (groupHasRedundant) {
        groupsCount++;
      }
    }

    return {
      currentTabSelectedRedundantCount: count,
      currentTabSelectedRedundantBytes: bytes,
      currentTabSelectedGroupsWithRedundantCount: groupsCount,
    };
  }, [filteredGroups, selectedGroupIds, excludedTrackPaths]);

  const handleFixSelectedGroups = async () => {
    if (!report || isDeleting) return;

    const toDelete: string[] = [];
    const cleanupGroups: DuplicateCleanupGroup[] = [];
    const affectedGroupIds: string[] = [];
    let totalBytes = 0;

    for (const group of filteredGroups) {
      if (!selectedGroupIds.has(group.group_id)) continue;

      const groupToDelete: string[] = [];
      let keptTrack: DuplicateTrackEntry | undefined = group.tracks.find(
        (t) => t.is_winner && !excludedTrackPaths.has(t.file_path)
      );
      if (!keptTrack) {
        keptTrack = group.tracks.find((t) => excludedTrackPaths.has(t.file_path));
      }
      if (!keptTrack) {
        keptTrack = group.tracks.find((t) => t.is_winner);
      }

      for (const track of group.tracks) {
        if (!track.is_winner && !excludedTrackPaths.has(track.file_path)) {
          groupToDelete.push(track.file_path);
          toDelete.push(track.file_path);
          totalBytes += track.size_bytes;
        }
      }

      if (groupToDelete.length > 0) {
        const groupYtId =
          group.tracks.find((t) => t.youtube_id)?.youtube_id || null;
        cleanupGroups.push({
          kept_file_path: keptTrack ? keptTrack.file_path : null,
          files_to_delete: groupToDelete,
          youtube_id: groupYtId,
        });
        affectedGroupIds.push(group.group_id);
      }
    }

    if (toDelete.length === 0) {
      alert("No redundant duplicate files are currently marked for deletion in the selected groups.");
      return;
    }

    const isAllInView = currentTabSelectedGroupCount >= filteredGroups.length && filteredGroups.length > 0;
    const confirmMsg = isAllInView
      ? `Permanently delete all ${toDelete.length} redundant duplicate copies (${formatSize(totalBytes)}) from disk across all ${cleanupGroups.length} duplicate groups in this view?\n\nThe kept winner of each group will be preserved (and any missing YouTube ID tag will be transferred to it). This operation cannot be undone.`
      : `Permanently delete ${toDelete.length} redundant duplicate copies (${formatSize(totalBytes)}) from disk across the ${cleanupGroups.length} selected duplicate groups in this view?\n\nThe kept winner of each group will be preserved (and any missing YouTube ID tag will be transferred to it). This operation cannot be undone.`;

    setConfirmModal({
      title: isAllInView ? "🗑️ Delete All Redundant Copies in View" : "🗑️ Fix Selected Duplicate Groups",
      message: confirmMsg,
      confirmText: `Delete ${toDelete.length} Files`,
      onConfirm: async () => {
        setConfirmModal(null);
        setIsDeleting(true);
        setActionStatus("");
        try {
          const res = await invoke<DeleteDuplicatesResult>("delete_duplicate_files", {
            filePaths: toDelete,
            cleanupGroups,
          });

          if (res.errors.length > 0) {
            alert(
              `Deleted ${res.deleted_count} duplicate files (${formatSize(res.freed_bytes)} freed), but encountered ${res.failed_count} errors:\n\n${res.errors.slice(0, 5).join("\n")}`
            );
          }

          let statusMsg = `Fixed ${cleanupGroups.length} group(s): deleted ${res.deleted_count} duplicate file(s) and freed ${formatSize(res.freed_bytes)} of disk space.`;
          if (res.tags_transferred_count && res.tags_transferred_count > 0) {
            statusMsg += ` Preserved YouTube ID to ${res.tags_transferred_count} kept file tags.`;
          }
          setActionStatus(statusMsg);

          const savedScrollTop = tableContainerRef.current?.scrollTop;
          const affectedSet = new Set(affectedGroupIds);
          const deletedSet = new Set(toDelete);

          setReport((prev) => {
            if (!prev) return null;
            const updatedGroups: DuplicateGroup[] = [];
            for (const g of prev.duplicate_groups) {
              if (!affectedSet.has(g.group_id)) {
                updatedGroups.push(g);
                continue;
              }
              const remaining = g.tracks.filter((t) => !deletedSet.has(t.file_path));
              if (remaining.length > 1) {
                updatedGroups.push({ ...g, tracks: remaining });
              }
            }
            return {
              ...prev,
              duplicate_groups: updatedGroups,
              redundant_files_count: Math.max(0, prev.redundant_files_count - res.deleted_count),
              redundant_bytes: Math.max(0, prev.redundant_bytes - res.freed_bytes),
            };
          });

          setSelectedGroupIds((prev) => {
            const next = new Set(prev);
            for (const id of affectedGroupIds) {
              next.delete(id);
            }
            return next;
          });

          if (savedScrollTop !== undefined && savedScrollTop > 0) {
            requestAnimationFrame(() => {
              if (tableContainerRef.current) {
                tableContainerRef.current.scrollTop = savedScrollTop;
              }
            });
          }
        } catch (e) {
          alert(`Error deleting duplicates: ${e}`);
        } finally {
          setIsDeleting(false);
        }
      },
    });
  };

  const renderPaginationBar = (position: "top" | "bottom") => {
    if (totalGroups === 0) return null;

    if (position === "top") {
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "0 2px 2px 2px",
            fontSize: "0.78rem",
            color: "var(--text-secondary)",
            flexWrap: "wrap",
            flexShrink: 0,
          }}
        >
          {/* Master Checkbox */}
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              cursor: "pointer",
              userSelect: "none",
              fontWeight: 600,
              fontSize: "0.76rem",
              color: "var(--text-primary)",
              padding: "2px 7px",
              borderRadius: "5px",
              backgroundColor: "var(--bg-secondary)",
              border: "1px solid var(--border-color)",
            }}
            title={isAllFilteredSelected ? "Deselect all visible duplicate groups" : "Select all visible duplicate groups"}
          >
            <input
              type="checkbox"
              checked={isAllFilteredSelected}
              ref={(el) => {
                if (el) el.indeterminate = isSomeFilteredSelected;
              }}
              onChange={handleToggleSelectAllFiltered}
              style={{
                cursor: "pointer",
                width: "14px",
                height: "14px",
                accentColor: "var(--accent-purple)",
                margin: 0,
              }}
            />
            <span>
              {currentTabSelectedGroupCount >= totalGroups && totalGroups > 0
                ? `All ${totalGroups} selected`
                : `${currentTabSelectedGroupCount} of ${totalGroups} selected`}
            </span>
          </label>

          {/* Fix Selected Button */}
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleFixSelectedGroups}
            disabled={isDeleting || currentTabSelectedRedundantCount === 0}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "2px 10px",
              fontSize: "0.76rem",
              fontWeight: 600,
              backgroundColor: currentTabSelectedRedundantCount > 0 ? "rgba(239, 68, 68, 0.18)" : "var(--bg-secondary)",
              color: currentTabSelectedRedundantCount > 0 ? "#f87171" : "var(--text-muted)",
              border: `1px solid ${currentTabSelectedRedundantCount > 0 ? "rgba(239, 68, 68, 0.5)" : "var(--border-color)"}`,
              borderRadius: "6px",
              height: "24px",
              cursor: currentTabSelectedRedundantCount > 0 && !isDeleting ? "pointer" : "not-allowed",
              whiteSpace: "nowrap",
            }}
            title={
              currentTabSelectedRedundantCount > 0
                ? currentTabSelectedGroupCount >= totalGroups && totalGroups > 0
                  ? `Fix all ${totalGroups} duplicate groups in this view: permanently delete redundant duplicate copies from disk and preserve the kept winner`
                  : `Fix ${currentTabSelectedGroupsWithRedundantCount} selected duplicate groups in this view: permanently delete redundant duplicate copies from disk and preserve the kept winner`
                : `No redundant duplicate files in selected groups of this view`
            }
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
            <span>
              {currentTabSelectedGroupCount >= totalGroups && totalGroups > 0
                ? `Fix All (${currentTabSelectedRedundantCount} dups • ${formatSize(currentTabSelectedRedundantBytes)})`
                : `Fix Selected (${currentTabSelectedGroupsWithRedundantCount} groups • ${currentTabSelectedRedundantCount} dups • ${formatSize(currentTabSelectedRedundantBytes)})`}
            </span>
          </button>
        </div>
      );
    }

    const startIdx = pageSize === -1 ? 1 : (safePage - 1) * pageSize + 1;
    const endIdx = pageSize === -1 ? totalGroups : Math.min(safePage * pageSize, totalGroups);

    return (
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "6px 2px 0 2px",
          fontSize: "0.78rem",
          color: "var(--text-secondary)",
          flexWrap: "wrap",
          gap: "8px",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <span>
            Showing groups <strong>{startIdx}–{endIdx}</strong> of <strong>{totalGroups}</strong>
          </span>
          <span style={{ color: "var(--text-muted)" }}>•</span>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <span style={{ fontSize: "0.74rem" }}>Page size:</span>
            {[25, 50, 100, 250, -1].map((size) => (
              <button
                key={size}
                type="button"
                className={`btn ${pageSize === size ? "btn-primary" : "btn-secondary"}`}
                onClick={() => handlePageSizeChange(size)}
                style={{
                  padding: "1px 7px",
                  fontSize: "0.72rem",
                  borderRadius: "4px",
                  fontWeight: pageSize === size ? 700 : 500,
                  height: "22px",
                  lineHeight: 1,
                }}
              >
                {size === -1 ? "All" : size}
              </button>
            ))}
          </div>
        </div>

        {totalPages > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => handlePageChange(1)}
              disabled={safePage <= 1}
              style={{ padding: "2px 7px", fontSize: "0.72rem", height: "24px" }}
              title="First Page"
            >
              ⏮
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => handlePageChange(safePage - 1)}
              disabled={safePage <= 1}
              style={{ padding: "2px 8px", fontSize: "0.72rem", height: "24px" }}
              title="Previous Page"
            >
              ◀ Prev
            </button>

            <span style={{ padding: "0 6px", fontWeight: 600, color: "var(--text-primary)", fontSize: "0.76rem" }}>
              Page {safePage} of {totalPages}
            </span>

            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => handlePageChange(safePage + 1)}
              disabled={safePage >= totalPages}
              style={{ padding: "2px 8px", fontSize: "0.72rem", height: "24px" }}
              title="Next Page"
            >
              Next ▶
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => handlePageChange(totalPages)}
              disabled={safePage >= totalPages}
              style={{ padding: "2px 7px", fontSize: "0.72rem", height: "24px" }}
              title="Last Page"
            >
              ⏭
            </button>
          </div>
        )}
      </div>
    );
  };


  if (!isOpen) return null;


  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: "74px",
        backgroundColor: "rgba(0, 0, 0, 0.78)",
        backdropFilter: "blur(5px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1100,
        padding: "20px",
      }}
      onClick={handleClose}
    >
      <div
        className="card"
        style={{
          width: "min(1560px, 96vw)",
          maxWidth: "96vw",
          height: "calc(100vh - 100px)",
          maxHeight: "92vh",
          margin: 0,
          padding: "18px 22px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          overflow: "hidden",
          boxShadow: "0 20px 50px rgba(0,0,0,0.6)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: "1px solid var(--border-color)",
            paddingBottom: "12px",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <h2 style={{ margin: 0, fontSize: "1.2rem", display: "flex", alignItems: "center", gap: "8px" }}>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ color: "var(--accent-purple)" }}
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span>Duplicate Songs Analysis</span>
              </h2>
              <span
                style={{
                  fontSize: "0.75rem",
                  padding: "2px 8px",
                  borderRadius: "12px",
                  backgroundColor: "rgba(138, 92, 246, 0.15)",
                  color: "var(--accent-purple-hover)",
                  border: "1px solid rgba(138, 92, 246, 0.35)",
                  fontWeight: 600,
                }}
              >
                {playlistIndex !== null
                  ? `Playlist: ${playlistName || `#${playlistIndex + 1}`}`
                  : "Global (All Playlists & Workspace)"}
              </span>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                backgroundColor: "var(--bg-tertiary)",
                border: "1px solid var(--border-color)",
                borderRadius: "6px",
                padding: "3px 6px",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: "0.78rem",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  userSelect: "none",
                  padding: "1px 4px",
                }}
                title="Progressive Acoustic Scan: Detects duplicates even with intro/outro ads, transcoding differences, or duration offsets"
              >
                <input
                  type="checkbox"
                  checked={computeAcoustic}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setComputeAcoustic(next);
                    runAnalysis(next, maxAcousticSecs);
                  }}
                  style={{ cursor: "pointer", accentColor: "var(--accent-purple)" }}
                />
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 18v-6a9 9 0 0 1 18 0v6"></path>
                  <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path>
                </svg>
                <span>Acoustic</span>
              </label>

              {computeAcoustic && (
                <div style={{ display: "flex", alignItems: "center", borderLeft: "1px solid var(--border-color)", paddingLeft: "6px" }}>
                  <select
                    value={maxAcousticSecs}
                    onChange={(e) => {
                      const next = parseInt(e.target.value, 10);
                      setMaxAcousticSecs(next);
                      try {
                        localStorage.setItem("max_acoustic_secs", String(next));
                      } catch {}
                      runAnalysis(computeAcoustic, next);
                    }}
                    style={{
                      fontSize: "0.74rem",
                      padding: "2px 6px",
                      borderRadius: "4px",
                      backgroundColor: "var(--bg-surface)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-color)",
                      cursor: "pointer",
                      outline: "none",
                    }}
                    title="Progressive Verification Depth: If the intro matches, progressively verifies subsequent seconds up to this maximum duration to eliminate false positives."
                  >
                    <option value={20}>Progressive: up to 20s (Fast)</option>
                    <option value={40}>Progressive: up to 40s</option>
                    <option value={60}>Progressive: up to 60s (Recommended)</option>
                    <option value={90}>Progressive: up to 90s (Deep)</option>
                    <option value={120}>Progressive: up to 120s (Full 2m)</option>
                  </select>
                </div>
              )}
            </div>

            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => handlePruneCache(false)}
              disabled={isLoading || isPruning}
              style={{
                width: "30px",
                height: "30px",
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "6px",
              }}
              title="Prune Stale Cache (cleans deleted files from fingerprint cache)"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z"/>
                <path d="m5 2 5 5"/>
                <path d="M2 13h15"/>
                <path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z"/>
              </svg>
            </button>

            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => runAnalysis()}
              disabled={isLoading || isDeleting}
              style={{
                width: "30px",
                height: "30px",
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "6px",
              }}
              title="Rescan duplicates"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={isLoading ? { animation: "spin 1s linear infinite" } : undefined}
              >
                <path d="M23 4v6h-6" />
                <path d="M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>

            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleClose}
              style={{
                width: "30px",
                height: "30px",
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "6px",
              }}
              title="Close duplicate analysis"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>

        {/* Summary Metrics Bar */}
        {report && !isLoading && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "10px" }}>
            <div
              style={{
                backgroundColor: "var(--bg-tertiary)",
                border: "1px solid var(--border-color)",
                borderRadius: "8px",
                padding: "8px 12px",
              }}
            >
              <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600 }}>
                Scanned Tracks
              </div>
              <div style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--text-primary)", marginTop: "2px" }}>
                {report.total_scanned_files} files
              </div>
            </div>

            <div
              style={{
                backgroundColor: "var(--bg-tertiary)",
                border: "1px solid var(--border-color)",
                borderRadius: "8px",
                padding: "8px 12px",
              }}
            >
              <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600 }}>
                Duplicate Songs
              </div>
              <div
                style={{
                  fontSize: "1.05rem",
                  fontWeight: 700,
                  color: report.duplicate_groups.length > 0 ? "var(--warning)" : "var(--success)",
                  marginTop: "2px",
                }}
              >
                {report.duplicate_groups.length} groups
              </div>
            </div>

            <div
              style={{
                backgroundColor: "var(--bg-tertiary)",
                border: "1px solid var(--border-color)",
                borderRadius: "8px",
                padding: "8px 12px",
              }}
            >
              <div>
                <span style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600 }}>
                  Skipped Redundant Copies
                </span>
              </div>
              <div style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--text-primary)", marginTop: "2px" }}>
                {report.redundant_files_count} files ({formatSize(report.redundant_bytes)})
              </div>
            </div>

            <div
              style={{
                backgroundColor: "var(--bg-tertiary)",
                border: "1px solid var(--border-color)",
                borderRadius: "8px",
                padding: "8px 12px",
              }}
              title="SQLite fingerprint cache entries (automatically skips deleted files)"
            >
              <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600 }}>
                Fingerprint Cache
              </div>
              <div style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--accent-purple-hover)", marginTop: "2px" }}>
                {report.cache_total_entries} cached
                {report.cache_stale_pruned > 0 ? ` (${report.cache_stale_pruned} pruned)` : ""}
              </div>
            </div>
          </div>
        )}

        {actionStatus && (
          <div
            style={{
              fontSize: "0.78rem",
              padding: "6px 12px",
              borderRadius: "6px",
              backgroundColor: "rgba(34, 197, 94, 0.12)",
              border: "1px solid rgba(34, 197, 94, 0.3)",
              color: "var(--success)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>{actionStatus}</span>
            <button
              type="button"
              onClick={() => setActionStatus("")}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-secondary)",
                cursor: "pointer",
                padding: "0 4px",
                fontSize: "0.85rem",
                lineHeight: 1,
              }}
              title="Dismiss notification"
            >
              ✕
            </button>
          </div>
        )}

        {pruneStatus && (
          <div
            style={{
              fontSize: "0.78rem",
              padding: "6px 12px",
              borderRadius: "6px",
              backgroundColor: "rgba(34, 197, 94, 0.12)",
              border: "1px solid rgba(34, 197, 94, 0.3)",
              color: "var(--success)",
            }}
          >
            {pruneStatus}
          </div>
        )}

        {/* Filter & Sort Bar */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {/* Multi-Select Match Analysis Filter Tabs */}
          <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
            {[
              {
                key: "all",
                label: "All",
                title: "Show all duplicate groups regardless of matching analysis",
                count: tierCounts.all,
                isActive: isAllTiersSelected,
                icon: (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                    <polyline points="2 17 12 22 22 17"></polyline>
                    <polyline points="2 12 12 17 22 12"></polyline>
                  </svg>
                ),
                activeBg: "var(--accent-purple-glow)",
                activeColor: "var(--accent-purple)",
                activeBorder: "var(--accent-purple)",
              },
              {
                key: "exact_hash",
                label: "Exact Audio",
                title: "Exact Audio: Identical decoded audio stream hash (100% byte identical)",
                count: tierCounts.exact_hash,
                isActive: selectedTiers.has("exact_hash") && !isAllTiersSelected,
                icon: (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="4" y1="9" x2="20" y2="9"></line>
                    <line x1="4" y1="15" x2="20" y2="15"></line>
                    <line x1="10" y1="3" x2="8" y2="21"></line>
                    <line x1="16" y1="3" x2="14" y2="21"></line>
                  </svg>
                ),
                activeBg: "rgba(34, 197, 94, 0.16)",
                activeColor: "var(--success)",
                activeBorder: "rgba(34, 197, 94, 0.4)",
              },
              {
                key: "youtube_id",
                label: "Same YT ID",
                title: "Same YouTube ID: Video ID embedded in metadata tags or filename",
                count: tierCounts.youtube_id,
                isActive: selectedTiers.has("youtube_id") && !isAllTiersSelected,
                icon: (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="4" width="20" height="16" rx="2.18" ry="2.18"></rect>
                    <polygon points="10 8 16 12 10 16 10 8" fill="currentColor"></polygon>
                  </svg>
                ),
                activeBg: "rgba(239, 68, 68, 0.16)",
                activeColor: "#f87171",
                activeBorder: "rgba(239, 68, 68, 0.4)",
              },
              {
                key: "acoustic",
                label: "Acoustic",
                title: "Acoustic / Ad Offset: Sliding spectral fingerprint match (detects intro/outro ads)",
                count: tierCounts.acoustic,
                isActive: selectedTiers.has("acoustic") && !isAllTiersSelected,
                icon: (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 18v-6a9 9 0 0 1 18 0v6"></path>
                    <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path>
                  </svg>
                ),
                activeBg: "rgba(138, 92, 246, 0.18)",
                activeColor: "var(--accent-purple-hover)",
                activeBorder: "rgba(138, 92, 246, 0.4)",
              },
              {
                key: "metadata",
                label: "Metadata",
                title: "Title & Artist: Normalized alphanumeric tag match",
                count: tierCounts.metadata,
                isActive: selectedTiers.has("metadata") && !isAllTiersSelected,
                icon: (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
                    <line x1="7" y1="7" x2="7.01" y2="7"></line>
                  </svg>
                ),
                activeBg: "rgba(245, 158, 11, 0.16)",
                activeColor: "var(--warning)",
                activeBorder: "rgba(245, 158, 11, 0.4)",
              },
            ].map((tab) => {
              const isSelected = tab.isActive;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => handleToggleTier(tab.key)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                    padding: "3px 8px",
                    borderRadius: "6px",
                    fontSize: "0.74rem",
                    fontWeight: isSelected ? 700 : 500,
                    backgroundColor: isSelected ? tab.activeBg : "var(--bg-secondary)",
                    color: isSelected ? tab.activeColor : "var(--text-secondary)",
                    border: `1px solid ${isSelected ? tab.activeBorder : "var(--border-color)"}`,
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                    whiteSpace: "nowrap",
                    height: "28px",
                  }}
                  title={tab.title}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                  <span
                    style={{
                      fontSize: "0.68rem",
                      padding: "1px 5px",
                      borderRadius: "999px",
                      backgroundColor: isSelected ? "rgba(0,0,0,0.2)" : "var(--bg-tertiary)",
                      color: isSelected ? "inherit" : "var(--text-muted)",
                      fontWeight: 700,
                      lineHeight: 1,
                    }}
                  >
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Right side: Sort Controls, Winner Rules, Search Filter */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            {/* Sort Selector */}
            <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
              <span style={{ fontSize: "0.74rem", color: "var(--text-secondary)", fontWeight: 600 }}>
                Sort:
              </span>
              <select
                value={sortBy}
                onChange={(e) => {
                  setSortBy(e.target.value);
                  try {
                    localStorage.setItem("dedup_sort_by", e.target.value);
                  } catch (err) {}
                }}
                style={{
                  fontSize: "0.74rem",
                  padding: "3px 8px",
                  borderRadius: "6px",
                  backgroundColor: "var(--bg-secondary)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-color)",
                  cursor: "pointer",
                  height: "28px",
                  outline: "none",
                }}
                title="Sort duplicate groups by match analysis type or metrics"
              >
                <optgroup label="Matching Analysis">
                  <option value="tier_exact">Exact Audio First</option>
                  <option value="tier_youtube">Same YouTube ID First</option>
                  <option value="tier_acoustic">Acoustic Match First</option>
                  <option value="tier_metadata">Metadata Match First</option>
                </optgroup>
                <optgroup label="Metrics & Information">
                  <option value="redundant_bytes">Wasted Disk Space (High → Low)</option>
                  <option value="versions_count">Duplicate Versions (Most Copies)</option>
                  <option value="confidence">Confidence Score</option>
                  <option value="title">Song Title (A → Z)</option>
                  <option value="artist">Artist Name (A → Z)</option>
                </optgroup>
              </select>

              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setSortAsc((prev) => {
                    const next = !prev;
                    try {
                      localStorage.setItem("dedup_sort_asc", String(next));
                    } catch (err) {}
                    return next;
                  });
                }}
                style={{
                  fontSize: "0.74rem",
                  padding: "0 8px",
                  height: "28px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "3px",
                  borderRadius: "6px",
                }}
                title={`Sort direction: ${sortAsc ? "Ascending (default)" : "Descending (reversed)"}. Click to toggle.`}
              >
                <span>{sortAsc ? "▲ Asc" : "▼ Desc"}</span>
              </button>
            </div>

            <button
              type="button"
              className={`btn ${showRulesConfig ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setShowRulesConfig((prev) => !prev)}
              style={{
                fontSize: "0.74rem",
                padding: "4px 9px",
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                borderRadius: "6px",
                whiteSpace: "nowrap",
                height: "28px",
              }}
              title="Configure priority rules for choosing which file is kept as the winner (🏆 KEPT)"
            >
              <span>⚙️ Winner Rules</span>
              <span style={{ fontSize: "0.68rem", opacity: 0.85 }}>({winnerCriteria.filter((c) => c.enabled).length})</span>
              <span style={{ fontSize: "0.68rem" }}>{showRulesConfig ? "▲" : "▼"}</span>
            </button>

            <div style={{ width: "200px" }}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="🔍 Search tracks..."
                style={{ padding: "4px 9px", fontSize: "0.76rem", width: "100%", height: "28px" }}
              />
            </div>
          </div>
        </div>

        {/* Expandable Winner Selection Rules Accordion */}
        <WinnerCriteriaEditor
          showRulesConfig={showRulesConfig}
          winnerCriteria={winnerCriteria}
          onToggleCriterion={handleToggleCriterion}
          onMoveCriterion={handleMoveCriterion}
          onResetCriteria={handleResetCriteria}
        />

        {/* Main Content Area */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            overflow: "hidden",
          }}
        >
          {isLoading ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "30px 20px",
              }}
            >
              <div
                style={{
                  width: "600px",
                  maxWidth: "94vw",
                  backgroundColor: "var(--bg-secondary)",
                  border: "1px solid var(--border-color)",
                  borderRadius: "14px",
                  padding: "24px 28px",
                  boxShadow: "var(--shadow-md)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "16px",
                  boxSizing: "border-box",
                }}
              >
                {/* Header row */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", minHeight: "42px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        width: "38px",
                        height: "38px",
                        borderRadius: "10px",
                        backgroundColor: "var(--accent-purple-glow)",
                        border: "1px solid var(--border-color)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "var(--accent-purple)",
                        flexShrink: 0,
                      }}
                    >
                      <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ animation: "spin 1.2s linear infinite" }}
                      >
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                      </svg>
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        style={{
                          fontSize: "0.95rem",
                          fontWeight: 600,
                          color: "var(--text-primary)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {analysisProgress?.phase_label || analysisProgress?.stage_label || "Analyzing tracks..."}
                      </div>
                    </div>
                  </div>

                  {/* Percentage counter */}
                  <div style={{ textAlign: "right", flexShrink: 0, minWidth: "64px" }}>
                    <div
                      style={{
                        fontSize: "1.5rem",
                        fontWeight: 700,
                        color: "var(--accent-purple)",
                        fontVariantNumeric: "tabular-nums",
                        lineHeight: 1,
                      }}
                    >
                      {(analysisProgress?.progress ?? 0).toFixed(0)}%
                    </div>
                  </div>
                </div>

                {/* 3-Stage Step Progress Stepper */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px" }}>
                  {[
                    { num: 1, title: "1. Tags & Hashes" },
                    { num: 2, title: "2. Acoustic Verify" },
                    { num: 3, title: "3. Clustering" },
                  ].map((step) => {
                    const currentStage = analysisProgress?.stage ?? 1;
                    const isDone = currentStage > step.num || analysisProgress?.phase === "done";
                    const isActive = currentStage === step.num && analysisProgress?.phase !== "done";
                    const isPending = currentStage < step.num;

                    return (
                      <div
                        key={step.num}
                        style={{
                          padding: "7px 10px",
                          borderRadius: "8px",
                          backgroundColor: isActive
                            ? "rgba(139, 92, 246, 0.12)"
                            : isDone
                            ? "rgba(34, 197, 94, 0.08)"
                            : "var(--bg-tertiary)",
                          border: `1px solid ${
                            isActive
                              ? "var(--accent-purple)"
                              : isDone
                              ? "rgba(34, 197, 94, 0.35)"
                              : "var(--border-color)"
                          }`,
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          transition: "all 0.25s ease",
                        }}
                      >
                        <span
                          style={{
                            width: "18px",
                            height: "18px",
                            borderRadius: "50%",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "0.68rem",
                            fontWeight: 700,
                            backgroundColor: isDone
                              ? "var(--success)"
                              : isActive
                              ? "var(--accent-purple)"
                              : "var(--bg-surface)",
                            color: isDone || isActive ? "#fff" : "var(--text-secondary)",
                            border: isPending ? "1px solid var(--border-color)" : "none",
                            flexShrink: 0,
                          }}
                        >
                          {isDone ? "✓" : step.num}
                        </span>
                        <span
                          style={{
                            fontSize: "0.75rem",
                            fontWeight: 600,
                            color: isActive
                              ? "var(--accent-purple)"
                              : isDone
                              ? "var(--success)"
                              : "var(--text-secondary)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {step.title}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* Progress bar container */}
                <div
                  style={{
                    width: "100%",
                    height: "10px",
                    backgroundColor: "var(--bg-surface)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "999px",
                    overflow: "hidden",
                    position: "relative",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.max(2, Math.min(100, analysisProgress?.progress ?? 0))}%`,
                      height: "100%",
                      background: "linear-gradient(90deg, var(--accent-indigo), var(--accent-purple))",
                      borderRadius: "999px",
                      transition: "width 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                    }}
                  />
                </div>

                {/* Current item being processed */}
                <div
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--text-secondary)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    backgroundColor: "var(--bg-surface)",
                    padding: "6px 10px",
                    borderRadius: "6px",
                    border: "1px solid var(--border-color)",
                    minHeight: "30px",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                  title={analysisProgress?.current_file || analysisProgress?.phase_label || "Processing..."}
                >
                  <span style={{ flexShrink: 0 }}>🎵</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {analysisProgress?.current_file
                      ? analysisProgress.current_file
                      : analysisProgress?.phase_label || "Processing tracks..."}
                  </span>
                </div>

                {/* Stats & ETA row */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "nowrap",
                    gap: "8px",
                    height: "28px",
                    fontSize: "0.8rem",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", color: "var(--text-secondary)", minWidth: 0, overflow: "hidden" }}>
                    <span style={{ fontWeight: 600, color: "var(--text-primary)", whiteSpace: "nowrap" }}>
                      {analysisProgress
                        ? `${analysisProgress.current} / ${analysisProgress.total} tracks`
                        : "Counting tracks..."}
                    </span>
                    {analysisProgress && analysisProgress.speed > 0 && (
                      <span
                        style={{
                          backgroundColor: "var(--bg-tertiary)",
                          border: "1px solid var(--border-color)",
                          padding: "2px 8px",
                          borderRadius: "4px",
                          fontSize: "0.75rem",
                          color: "var(--text-secondary)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        ⚡ {analysisProgress.speed.toFixed(1)} files/sec
                      </span>
                    )}
                  </div>

                  {/* Human ETA badge */}
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      backgroundColor: "var(--accent-purple-glow)",
                      border: "1px solid var(--border-color)",
                      color: "var(--accent-purple)",
                      padding: "3px 10px",
                      borderRadius: "6px",
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span>⏱</span>
                    <span>{formatEta(analysisProgress?.eta_secs, { verbose: true })}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : error ? (
            <div className="no-data" style={{ color: "var(--danger)" }}>
              Error analyzing duplicates: {error}
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="no-data" style={{ padding: "48px 20px" }}>
              {report && report.duplicate_groups.length === 0
                ? "✅ No duplicate songs detected in this scope!"
                : "No duplicate groups match your current filter."}
            </div>
          ) : (
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              {/* Top Pagination Bar */}
              {renderPaginationBar("top")}

              {/* Single Unified Table for All Duplicate Groups */}
              <div
                ref={tableContainerRef}
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: "auto",
                  overflowX: "auto",
                  border: "1px solid var(--border-color)",
                  borderRadius: "8px",
                  backgroundColor: "var(--bg-tertiary)",
                }}
              >
                <table
                  style={{
                    width: "100%",
                    tableLayout: "fixed",
                    borderCollapse: "collapse",
                    fontSize: "0.8rem",
                  }}
                >
                  <colgroup>
                    <col style={{ width: "36px" }} />
                    <col style={{ width: "135px" }} />
                    <col /> {/* File Name / Title expands */}
                    <col style={{ width: "170px" }} />
                    <col style={{ width: "135px" }} />
                    <col style={{ width: "70px" }} />
                    <col style={{ width: "80px" }} />
                    <col style={{ width: "125px" }} />
                  </colgroup>
                  <thead
                    style={{
                      position: "sticky",
                      top: 0,
                      zIndex: 10,
                      backgroundColor: "var(--bg-surface)",
                      borderBottom: "1px solid var(--border-color)",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
                    }}
                  >
                    <tr
                      style={{
                        color: "var(--text-secondary)",
                        fontSize: "0.68rem",
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                      }}
                    >
                      <th style={{ width: "36px", padding: "8px 6px", textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={isAllFilteredSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = isSomeFilteredSelected;
                          }}
                          onChange={handleToggleSelectAllFiltered}
                          style={{
                            cursor: "pointer",
                            width: "14px",
                            height: "14px",
                            accentColor: "var(--accent-purple)",
                            margin: 0,
                          }}
                          title={isAllFilteredSelected ? "Deselect all visible duplicate groups" : "Select all visible duplicate groups"}
                        />
                      </th>
                      <th style={{ width: "135px", padding: "8px 8px", textAlign: "left" }}>Status</th>
                      <th style={{ padding: "8px 8px", textAlign: "left" }}>File Name</th>
                      <th style={{ width: "170px", padding: "8px 8px", textAlign: "left" }}>Source Folder</th>
                      <th style={{ width: "135px", padding: "8px 8px", textAlign: "right" }}>Format</th>
                      <th style={{ width: "70px", padding: "8px 8px", textAlign: "right" }}>Duration</th>
                      <th style={{ width: "80px", padding: "8px 8px", textAlign: "right" }}>Size</th>
                      <th style={{ width: "125px", padding: "8px 8px", textAlign: "center" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedGroups.map((group, gIdx) => {
                      const groupNumber = (pageSize === -1 ? 0 : (safePage - 1) * pageSize) + gIdx + 1;
                      const isGroupSelected = selectedGroupIds.has(group.group_id);

                      return (
                        <DuplicateGroupRows
                          key={group.group_id}
                          group={group}
                          gIdx={gIdx}
                          groupNumber={groupNumber}
                          isGroupSelected={isGroupSelected}
                          onToggleSelectGroup={handleToggleSelectGroup}
                          excludedTrackPaths={excludedTrackPaths}
                          onToggleExcludeTrack={handleToggleExcludeTrack}
                          onPlayGroupTrack={handlePlayGroupTrack}
                          onMakeWinner={handleMakeWinner}
                          onDetachTrack={handleDetachTrack}
                          onKeepThisAndDeleteOthers={handleKeepThisAndDeleteOthers}
                          onRevealInFinder={handleRevealInFinder}
                          isDeleting={isDeleting}
                          playlistIndex={playlistIndex}
                        />
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Bottom Pagination Bar */}
              {renderPaginationBar("bottom")}
            </div>
          )}
        </div>
      </div>

      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          message={confirmModal.message}
          confirmText={confirmModal.confirmText}
          confirmVariant="danger"
          isExecuting={isDeleting}
          executingText="Deleting duplicate files..."
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      )}
    </div>
  );
};
