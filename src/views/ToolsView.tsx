import React, { useState } from "react";
import { SanitizerView } from "./SanitizerView";
import { TranscoderView } from "./TranscoderView";

type ToolsViewProps = {
  formats: string;
  stripPhrases: string[];
  setStripPhrases: (phrases: string[]) => void;
  addBackgroundTask: (id: string, name: string, taskPromise: Promise<any>) => void;
};

export const ToolsView: React.FC<ToolsViewProps> = ({
  formats,
  stripPhrases,
  setStripPhrases,
  addBackgroundTask,
}) => {
  const [subView, setSubView] = useState<"sanitizer" | "transcoder">("sanitizer");

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", overflow: "hidden" }}>
      {/* Sub-Sidebar */}
      <div
        style={{
          width: "220px",
          backgroundColor: "var(--bg-secondary)",
          borderRight: "1px solid var(--border-color)",
          padding: "24px 16px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "8px" }}>
          Utility Tools
        </div>
        
        <div
          onClick={() => setSubView("sanitizer")}
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            cursor: "pointer",
            backgroundColor: subView === "sanitizer" ? "var(--bg-tertiary)" : "transparent",
            color: subView === "sanitizer" ? "var(--text-primary)" : "var(--text-secondary)",
            fontWeight: subView === "sanitizer" ? 600 : 400,
            display: "flex",
            alignItems: "center",
            gap: "8px",
            transition: "all 0.2s",
          }}
        >
          🧼 Sanitizer & Cleaner
        </div>

        <div
          onClick={() => setSubView("transcoder")}
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            cursor: "pointer",
            backgroundColor: subView === "transcoder" ? "var(--bg-tertiary)" : "transparent",
            color: subView === "transcoder" ? "var(--text-primary)" : "var(--text-secondary)",
            fontWeight: subView === "transcoder" ? 600 : 400,
            display: "flex",
            alignItems: "center",
            gap: "8px",
            transition: "all 0.2s",
          }}
        >
          🔄 FLAC Transcoder
        </div>
      </div>

      {/* Sub-View Content */}
      <div style={{ flex: 1, overflowY: "auto", minWidth: 0 }}>
        {subView === "sanitizer" && (
          <SanitizerView
            formats={formats}
            stripPhrases={stripPhrases}
            setStripPhrases={setStripPhrases}
            addBackgroundTask={addBackgroundTask}
          />
        )}
        {subView === "transcoder" && (
          <TranscoderView addBackgroundTask={addBackgroundTask} />
        )}
      </div>
    </div>
  );
};
