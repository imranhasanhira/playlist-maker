import React, { useState } from "react";

type SortByOption = "name" | "created" | "updated";
type SortOrder = "asc" | "desc";

type LabelFilterProps = {
  allLabels: string[];
  selectedLabels: string[];
  filterMode: "and" | "or";
  sortBy: SortByOption;
  sortOrder: SortOrder;
  onToggleLabel: (label: string, isMulti: boolean) => void;
  onClearFilter: () => void;
  onToggleMode: (mode: "and" | "or") => void;
  onSortChange: (sortBy: SortByOption, sortOrder: SortOrder) => void;
};

export const LabelFilter: React.FC<LabelFilterProps> = ({
  allLabels,
  selectedLabels,
  filterMode,
  sortBy,
  sortOrder,
  onToggleLabel,
  onClearFilter,
  onToggleMode,
  onSortChange,
}) => {
  const [showSortMenu, setShowSortMenu] = useState(false);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span
          style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.5px" }}
          title="Click a label to select exclusively. Hold Cmd/Ctrl to select multiple."
        >
          Filter by Labels
        </span>

        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          {/* Sort Popover Button beside AND/OR switch */}
          <div style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => setShowSortMenu(!showSortMenu)}
              style={{
                padding: "1px 7px",
                fontSize: "0.68rem",
                fontWeight: 600,
                borderRadius: "10px",
                border: "1px solid var(--border-color)",
                backgroundColor: showSortMenu ? "var(--bg-surface)" : "var(--bg-tertiary)",
                color: "var(--accent-purple-hover)",
                cursor: "pointer",
                transition: "all 0.15s ease",
                display: "flex",
                alignItems: "center",
                gap: "3px",
                userSelect: "none",
              }}
              title="Click to select sort option"
            >
              <span>
                {sortBy === "updated"
                  ? `Updated ${sortOrder === "desc" ? "↓" : "↑"}`
                  : sortBy === "created"
                  ? `Added ${sortOrder === "desc" ? "↓" : "↑"}`
                  : `Name ${sortOrder === "asc" ? "↑" : "↓"}`}
              </span>
              <span style={{ fontSize: "0.55rem", opacity: 0.7 }}>▼</span>
            </button>

            {showSortMenu && (
              <>
                <div
                  style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }}
                  onClick={() => setShowSortMenu(false)}
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
                    minWidth: "95px",
                  }}
                >
                  {/* Item 1: Updated */}
                  <button
                    type="button"
                    onClick={() => {
                      if (sortBy === "updated") {
                        onSortChange("updated", sortOrder === "asc" ? "desc" : "asc");
                      } else {
                        onSortChange("updated", "desc");
                      }
                      setShowSortMenu(false);
                    }}
                    style={{
                      padding: "4px 8px",
                      fontSize: "0.72rem",
                      borderRadius: "6px",
                      border: "none",
                      backgroundColor: sortBy === "updated" ? "rgba(138, 92, 246, 0.15)" : "transparent",
                      color: sortBy === "updated" ? "var(--accent-purple-hover)" : "var(--text-primary)",
                      fontWeight: sortBy === "updated" ? 600 : 400,
                      cursor: "pointer",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <span>Updated</span>
                    <span>{sortBy === "updated" ? (sortOrder === "desc" ? "↓" : "↑") : "↓"}</span>
                  </button>

                  {/* Item 2: Added */}
                  <button
                    type="button"
                    onClick={() => {
                      if (sortBy === "created") {
                        onSortChange("created", sortOrder === "asc" ? "desc" : "asc");
                      } else {
                        onSortChange("created", "desc");
                      }
                      setShowSortMenu(false);
                    }}
                    style={{
                      padding: "4px 8px",
                      fontSize: "0.72rem",
                      borderRadius: "6px",
                      border: "none",
                      backgroundColor: sortBy === "created" ? "rgba(138, 92, 246, 0.15)" : "transparent",
                      color: sortBy === "created" ? "var(--accent-purple-hover)" : "var(--text-primary)",
                      fontWeight: sortBy === "created" ? 600 : 400,
                      cursor: "pointer",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <span>Added</span>
                    <span>{sortBy === "created" ? (sortOrder === "desc" ? "↓" : "↑") : "↓"}</span>
                  </button>

                  {/* Item 3: Name */}
                  <button
                    type="button"
                    onClick={() => {
                      if (sortBy === "name") {
                        onSortChange("name", sortOrder === "asc" ? "desc" : "asc");
                      } else {
                        onSortChange("name", "asc");
                      }
                      setShowSortMenu(false);
                    }}
                    style={{
                      padding: "4px 8px",
                      fontSize: "0.72rem",
                      borderRadius: "6px",
                      border: "none",
                      backgroundColor: sortBy === "name" ? "rgba(138, 92, 246, 0.15)" : "transparent",
                      color: sortBy === "name" ? "var(--accent-purple-hover)" : "var(--text-primary)",
                      fontWeight: sortBy === "name" ? 600 : 400,
                      cursor: "pointer",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <span>Name</span>
                    <span>{sortBy === "name" ? (sortOrder === "asc" ? "↑" : "↓") : "↑"}</span>
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Tiny AND / OR Segmented Toggle */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              backgroundColor: "var(--bg-primary)",
              borderRadius: "12px",
              padding: "2px",
              border: "1px solid var(--border-color)",
              fontSize: "0.68rem",
              fontFamily: "var(--font-mono)",
            }}
            title="Match ALL selected labels (AND) or ANY selected label (OR)"
          >
            <button
              type="button"
              onClick={() => onToggleMode("and")}
              style={{
                padding: "1px 6px",
                borderRadius: "10px",
                border: "none",
                backgroundColor: filterMode === "and" ? "var(--accent-purple)" : "transparent",
                color: filterMode === "and" ? "#fff" : "var(--text-muted)",
                cursor: "pointer",
                fontWeight: filterMode === "and" ? 600 : 400,
                fontSize: "0.68rem",
                transition: "all 0.15s ease",
              }}
            >
              AND
            </button>
            <button
              type="button"
              onClick={() => onToggleMode("or")}
              style={{
                padding: "1px 6px",
                borderRadius: "10px",
                border: "none",
                backgroundColor: filterMode === "or" ? "var(--accent-purple)" : "transparent",
                color: filterMode === "or" ? "#fff" : "var(--text-muted)",
                cursor: "pointer",
                fontWeight: filterMode === "or" ? 600 : 400,
                fontSize: "0.68rem",
                transition: "all 0.15s ease",
              }}
            >
              OR
            </button>
          </div>
        </div>
      </div>

      {/* Label Pills Scrollable Row */}
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
        {/* All Pill */}
        <button
          type="button"
          onClick={onClearFilter}
          style={{
            padding: "3px 10px",
            borderRadius: "14px",
            fontSize: "0.75rem",
            fontWeight: selectedLabels.length === 0 ? 600 : 400,
            border: selectedLabels.length === 0 ? "1px solid var(--accent-purple)" : "1px solid var(--border-color)",
            backgroundColor: selectedLabels.length === 0 ? "rgba(138, 92, 246, 0.2)" : "var(--bg-tertiary)",
            color: selectedLabels.length === 0 ? "var(--accent-purple-hover)" : "var(--text-secondary)",
            cursor: "pointer",
            transition: "all 0.15s ease",
          }}
          title="Show all entries regardless of labels"
        >
          All
        </button>

        {allLabels.map((label) => {
          const isSelected = selectedLabels.includes(label);
          return (
            <button
              key={label}
              type="button"
              onClick={(e) => onToggleLabel(label, e.metaKey || e.ctrlKey)}
              title="Click to select exclusively. Hold Cmd/Ctrl for multi-select."
              style={{
                padding: "3px 10px",
                borderRadius: "14px",
                fontSize: "0.75rem",
                fontWeight: isSelected ? 600 : 400,
                border: isSelected ? "1px solid var(--accent-purple)" : "1px solid var(--border-color)",
                backgroundColor: isSelected ? "rgba(138, 92, 246, 0.25)" : "var(--bg-tertiary)",
                color: isSelected ? "var(--text-primary)" : "var(--text-secondary)",
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
};
