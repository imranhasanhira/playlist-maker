import React from "react";
import { MainConfig, PlaylistConfig, PlaylistSummaryItem, YearSplitConfig } from "../../types";

export const addCustomMerge = (currentMerges: [number, number][] = [], newRange: [number, number]): [number, number][] => {
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

export const removeCustomMerge = (currentMerges: [number, number][] = [], target: [number, number]): [number, number][] => {
  const tStart = Math.min(target[0], target[1]);
  const tEnd = Math.max(target[0], target[1]);
  return currentMerges.filter(([s, e]) => {
    const curStart = Math.min(s, e);
    const curEnd = Math.max(s, e);
    return !(curStart === tStart && curEnd === tEnd);
  });
};

export interface YearSplitConfigEditorProps {
  activePlaylist: PlaylistConfig;
  config: MainConfig;
  selectedPlaylistIndex: number | null;
  selectedBucketKey: string;
  summaries: PlaylistSummaryItem[];
  isRefreshingSingle: boolean;
  yearAnalysisProgress: {
    current: number;
    total: number;
    percent: number;
    message: string;
  } | null;
  onSelectBucketKey: (key: string) => void;
  onLoadPreview: (force?: boolean, bucketKey?: string) => void;
  onUpdateYearSplit: (updater: (cur: YearSplitConfig) => YearSplitConfig, refreshSummaries?: boolean) => void;
}

export const YearSplitConfigEditor: React.FC<YearSplitConfigEditorProps> = ({
  activePlaylist,
  config,
  selectedPlaylistIndex,
  selectedBucketKey,
  summaries,
  isRefreshingSingle,
  yearAnalysisProgress,
  onSelectBucketKey,
  onLoadPreview,
  onUpdateYearSplit,
}) => {
  if (!activePlaylist.year_split?.enabled) return null;

  const handleMergeBuckets = (startA: number, endA: number, startB: number, endB: number) => {
    const newStart = Math.min(startA, startB);
    const newEnd = Math.max(endA, endB);
    onUpdateYearSplit((cur) => {
      const updatedMerges = addCustomMerge(cur.custom_merges || [], [newStart, newEnd]);
      return { ...cur, custom_merges: updatedMerges };
    }, false);
  };

  const handleUnmergeCustomBucket = (start: number, end: number) => {
    onUpdateYearSplit((cur) => {
      const updatedMerges = removeCustomMerge(cur.custom_merges || [], [start, end]);
      return { ...cur, custom_merges: updatedMerges };
    }, false);
  };

  const summary = summaries.find((s) => s.index === selectedPlaylistIndex);
  const buckets = summary?.buckets || [];
  const maxLimit = config.maxTracksPerPlaylist ?? 400;

  return (
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
              onSelectBucketKey("all");
              onLoadPreview(true, "all");
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
          if (isRefreshingSingle && buckets.length === 0) {
            return (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  padding: "10px",
                  fontSize: "0.76rem",
                  color: "var(--text-secondary)",
                  background: "var(--card-bg-subtle, rgba(128,128,128,0.06))",
                  borderRadius: "6px",
                  border: "1px solid var(--border-color)",
                }}
              >
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
                        const newKey = isSelected ? "all" : b.key;
                        onSelectBucketKey(newKey);
                        onLoadPreview(false, newKey);
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
                      <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0, flex: 1 }}>
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

                        {/* Column 3: Split Decades / Half-Decades / Max-Track Buckets */}
                        {b.bucket_type === "10y" && b.start_year !== null ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => {
                              onUpdateYearSplit((cur) => {
                                const split5 = Array.from(new Set([...(cur.split_5y || []), b.start_year!]));
                                return { ...cur, split_5y: split5 };
                              }, true);
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
                              <rect x="3" y="3" width="8" height="18" rx="1.5" />
                              <rect x="13" y="3" width="8" height="18" rx="1.5" />
                            </svg>
                          </button>
                        ) : b.bucket_type === "5y" && b.start_year !== null ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => {
                              onUpdateYearSplit((cur) => {
                                const split1 = Array.from(new Set([...(cur.split_1y || []), b.start_year!]));
                                return { ...cur, split_1y: split1 };
                              }, true);
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
                              <line x1="8" y1="6" x2="21" y2="6" />
                              <line x1="8" y1="12" x2="21" y2="12" />
                              <line x1="8" y1="18" x2="21" y2="18" />
                              <circle cx="4" cy="6" r="1.5" fill="currentColor" />
                              <circle cx="4" cy="12" r="1.5" fill="currentColor" />
                              <circle cx="4" cy="18" r="1.5" fill="currentColor" />
                            </svg>
                          </button>
                        ) : isSingleYear && b.track_count > 0 ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => {
                              const yr = b.start_year!;
                              const partsToSplit = Math.max(2, Math.ceil(b.track_count / maxLimit));
                              onUpdateYearSplit((cur) => {
                                const splitSingleYears = { ...(cur.split_single_years || {}) };
                                splitSingleYears[yr] = partsToSplit;
                                return { ...cur, split_single_years: splitSingleYears };
                              }, true);
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
                              <rect x="3" y="3" width="8" height="18" rx="1.5" />
                              <rect x="13" y="3" width="8" height="18" rx="1.5" />
                            </svg>
                          </button>
                        ) : isSingleUnknown && b.track_count > 0 ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => {
                              const partsToSplit = Math.max(2, Math.ceil(b.track_count / maxLimit));
                              onUpdateYearSplit((cur) => ({ ...cur, split_unknown_parts: partsToSplit }), true);
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
                              <rect x="3" y="3" width="8" height="18" rx="1.5" />
                              <rect x="13" y="3" width="8" height="18" rx="1.5" />
                            </svg>
                          </button>
                        ) : isSplitUnknown ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => {
                              onUpdateYearSplit((cur) => ({ ...cur, include_unknown: !cur.include_unknown }), true);
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
                              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                            </svg>
                          </button>
                        ) : b.bucket_type === "5y" && b.parent_key && b.start_year !== null ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => {
                              const decade = Math.floor(b.start_year! / 10) * 10;
                              onUpdateYearSplit((cur) => {
                                const split5 = (cur.split_5y || []).filter((d) => d !== decade);
                                const split1 = (cur.split_1y || []).filter((h) => Math.floor(h / 10) * 10 !== decade);
                                const splitSingleYears = { ...(cur.split_single_years || {}) };
                                for (let y = decade; y <= decade + 9; y++) {
                                  delete splitSingleYears[y];
                                  delete splitSingleYears[String(y)];
                                }
                                return { ...cur, split_5y: split5, split_1y: split1, split_single_years: splitSingleYears };
                              }, true);
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
                              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                            </svg>
                          </button>
                        ) : b.bucket_type === "1y" && b.parent_key && b.start_year !== null ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => {
                              const yr = b.start_year!;
                              const decade = Math.floor(yr / 10) * 10;
                              const half = yr % 10 < 5 ? decade : decade + 5;
                              onUpdateYearSplit((cur) => {
                                const split1 = (cur.split_1y || []).filter((h) => h !== half);
                                const splitSingleYears = { ...(cur.split_single_years || {}) };
                                for (let y = half; y <= half + 4; y++) {
                                  delete splitSingleYears[y];
                                  delete splitSingleYears[String(y)];
                                }
                                return { ...cur, split_1y: split1, split_single_years: splitSingleYears };
                              }, true);
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
                              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                            </svg>
                          </button>
                        ) : isSplitSingleYear && b.start_year !== null ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => {
                              const yr = b.start_year!;
                              onUpdateYearSplit((cur) => {
                                const splitSingleYears = { ...(cur.split_single_years || {}) };
                                delete splitSingleYears[yr];
                                delete splitSingleYears[String(yr)];
                                return { ...cur, split_single_years: splitSingleYears };
                              }, true);
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
                              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                            </svg>
                          </button>
                        ) : isSplitUnknown ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => {
                              onUpdateYearSplit((cur) => {
                                const copy = { ...cur };
                                delete copy.split_unknown_parts;
                                return copy;
                              }, true);
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
                              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                            </svg>
                          </button>
                        ) : isSingleUnknown ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => {
                              onUpdateYearSplit((cur) => ({ ...cur, include_unknown: !cur.include_unknown }), true);
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
  );
};
