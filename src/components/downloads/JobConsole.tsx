import React, { useRef, useEffect, useState, useLayoutEffect } from "react";
import { DownloadJob, DownloadEntry } from "../../types";
import { ProgressBar } from "../common/ProgressBar";

export interface BatchQueueItem {
  entry: DownloadEntry;
  job?: DownloadJob;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
}

type JobConsoleProps = {
  activeTab: "logs" | "queue";
  onTabChange: (tab: "logs" | "queue") => void;
  selectedJobLogs: string[];
  selectedJobTitle?: string;
  selectedJobId?: string;
  batchQueueItems: BatchQueueItem[];
  isBatchRunning: boolean;
  onCancelJob: (jobId: string) => void;
  onCancelAllBatchJobs: () => void;
};

export const JobConsole: React.FC<JobConsoleProps> = ({
  activeTab,
  onTabChange,
  selectedJobLogs,
  selectedJobTitle,
  selectedJobId,
  batchQueueItems,
  isBatchRunning,
  onCancelJob,
  onCancelAllBatchJobs,
}) => {
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  const isAutoScrollRef = useRef<boolean>(true);
  const [isAutoScroll, setIsAutoScroll] = useState<boolean>(true);

  // When job or entry selection changes, reset to bottom & re-enable auto-scroll
  const prevJobKeyRef = useRef<string | undefined>(selectedJobId || selectedJobTitle);
  useEffect(() => {
    const currentKey = selectedJobId || selectedJobTitle;
    if (prevJobKeyRef.current !== currentKey) {
      prevJobKeyRef.current = currentKey;
      isAutoScrollRef.current = true;
      setIsAutoScroll(true);
      if (logBoxRef.current) {
        logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
      }
    }
  }, [selectedJobId, selectedJobTitle]);

  // When switching to logs tab, scroll to bottom & enable auto-scroll
  const prevActiveTabRef = useRef(activeTab);
  useEffect(() => {
    if (prevActiveTabRef.current !== activeTab) {
      prevActiveTabRef.current = activeTab;
      if (activeTab === "logs") {
        isAutoScrollRef.current = true;
        setIsAutoScroll(true);
        if (logBoxRef.current) {
          logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
        }
      }
    }
  }, [activeTab]);

  // Handle user scroll: if user scrolls up away from bottom, pause auto-scroll.
  // If user scrolls back down to the bottom, resume auto-scroll.
  const handleScroll = () => {
    if (!logBoxRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logBoxRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight <= 45;
    isAutoScrollRef.current = isAtBottom;
    setIsAutoScroll((prev) => (prev !== isAtBottom ? isAtBottom : prev));
  };

  // Only auto-scroll to latest if user is currently at the bottom (or auto-scroll enabled)
  useLayoutEffect(() => {
    if (activeTab === "logs" && logBoxRef.current && isAutoScrollRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [selectedJobLogs, activeTab]);

  const handleScrollToLatest = () => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
      isAutoScrollRef.current = true;
      setIsAutoScroll(true);
    }
  };

  const activeCount = batchQueueItems.filter((i) => i.status === "running").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, flex: 1 }}>
      {/* Console Tab Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid var(--border-color)",
          paddingBottom: "6px",
          marginBottom: "8px",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <button
            type="button"
            onClick={() => {
              if (activeTab === "logs") {
                handleScrollToLatest();
              } else {
                onTabChange("logs");
              }
            }}
            style={{
              background: "none",
              border: "none",
              borderBottom: activeTab === "logs" ? "2px solid var(--accent-purple)" : "2px solid transparent",
              color: activeTab === "logs" ? "var(--text-primary)" : "var(--text-secondary)",
              fontWeight: activeTab === "logs" ? 600 : 400,
              fontSize: "0.82rem",
              padding: "4px 6px",
              cursor: "pointer",
            }}
            title={activeTab === "logs" ? "Click to jump to latest logs" : "Switch to logs"}
          >
            📋 Terminal Logs {selectedJobTitle ? `(${selectedJobTitle})` : ""}
          </button>

          <button
            type="button"
            onClick={() => onTabChange("queue")}
            style={{
              background: "none",
              border: "none",
              borderBottom: activeTab === "queue" ? "2px solid var(--accent-purple)" : "2px solid transparent",
              color: activeTab === "queue" ? "var(--text-primary)" : "var(--text-secondary)",
              fontWeight: activeTab === "queue" ? 600 : 400,
              fontSize: "0.82rem",
              padding: "4px 6px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <span>⚡ Batch Queue ({batchQueueItems.length})</span>
            {activeCount > 0 && (
              <span
                style={{
                  fontSize: "0.68rem",
                  padding: "1px 6px",
                  borderRadius: "10px",
                  backgroundColor: "rgba(138, 92, 246, 0.25)",
                  color: "var(--accent-purple-hover)",
                  fontWeight: 600,
                }}
              >
                {activeCount} active
              </span>
            )}
          </button>

          {/* Jump to latest button right on the tab bar */}
          {activeTab === "logs" && !isAutoScroll && selectedJobLogs.length > 0 && (
            <button
              type="button"
              onClick={handleScrollToLatest}
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
                marginLeft: "4px",
                transition: "all 0.2s ease",
              }}
              title="Click to jump to latest logs and resume auto-scroll"
            >
              <span>⬇ Jump to latest</span>
            </button>
          )}
        </div>

        {/* Cancel All Button in Header if Batch Running */}
        {activeTab === "queue" && isBatchRunning && (
          <button
            type="button"
            className="btn btn-danger"
            onClick={onCancelAllBatchJobs}
            style={{ padding: "3px 10px", fontSize: "0.76rem" }}
          >
            🛑 Cancel All Batch Jobs
          </button>
        )}
      </div>

      {/* Tab Content */}
      {activeTab === "logs" ? (
        <div
          ref={logBoxRef}
          onScroll={handleScroll}
          className="console-log"
          style={{
            flex: 1,
            minHeight: 0,
            height: "100%",
            maxHeight: "none",
            overflowY: "auto",
            fontSize: "0.78rem",
            fontFamily: "var(--font-mono)",
            lineHeight: 1.4,
            padding: "10px",
            backgroundColor: "var(--bg-primary)",
            borderRadius: "6px",
            border: "1px solid var(--border-color)",
          }}
        >
          {selectedJobLogs.length === 0 ? (
            <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
              No execution log available. Select an entry or start a download job to view real-time logs.
            </span>
          ) : (
            selectedJobLogs.join("\n")
          )}
        </div>
      ) : (
        /* Queue Tab: Shows ALL items in the batch queue */
        <div
          style={{
            flex: 1,
            minHeight: 0,
            height: "100%",
            maxHeight: "none",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            paddingRight: "4px",
          }}
        >
          {batchQueueItems.length === 0 ? (
            <div className="no-data" style={{ margin: "auto", fontSize: "0.82rem" }}>
              No batch download queue active. Click "▶ Download All" to queue entries.
            </div>
          ) : (
            batchQueueItems.map((item) => {
              const job = item.job;
              const statusColor =
                item.status === "completed"
                  ? "var(--success)"
                  : item.status === "failed" || item.status === "cancelled"
                  ? "var(--danger)"
                  : item.status === "running"
                  ? "var(--accent-purple-hover)"
                  : "var(--text-muted)";

              return (
                <div
                  key={item.entry.id}
                  style={{
                    padding: "8px 12px",
                    borderRadius: "6px",
                    backgroundColor: "var(--bg-tertiary)",
                    border: "1px solid var(--border-color)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: "0.82rem",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        maxWidth: "280px",
                      }}
                      title={item.entry.name || item.entry.url}
                    >
                      {item.entry.name || item.entry.url}
                    </span>

                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ fontSize: "0.72rem", color: statusColor, fontWeight: 600, fontFamily: "var(--font-mono)", textTransform: "capitalize" }}>
                        {item.status === "running" && job ? `${Math.round(job.progress)}%` : item.status}
                      </span>

                      {item.status === "running" && job && (
                        <button
                          type="button"
                          onClick={() => onCancelJob(job.id)}
                          style={{
                            background: "rgba(239, 68, 68, 0.15)",
                            border: "1px solid var(--danger)",
                            color: "var(--danger)",
                            borderRadius: "4px",
                            cursor: "pointer",
                            padding: "1px 6px",
                            fontSize: "0.7rem",
                          }}
                          title="Cancel Job"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>

                  {item.status === "running" && job && (
                    <ProgressBar progress={job.progress} status="running" height={3} />
                  )}

                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.72rem", color: "var(--text-secondary)" }}>
                    <span>
                      {job?.current_item && job?.total_items
                        ? `Track ${job.current_item}/${job.total_items}`
                        : item.entry.total_songs > 0
                        ? `${item.entry.total_songs} songs`
                        : item.entry.url}
                    </span>
                    <span>{item.entry.labels || ""}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
