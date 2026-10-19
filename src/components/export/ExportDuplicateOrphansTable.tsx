import React from "react";
import { ExportDuplicateOrphanItem } from "../../types";
import { formatSize } from "../../utils/formatters";
import { ExportSortField } from "./ExportPlaylistDiffTable";

export interface ExportDuplicateOrphansTableProps {
  items: ExportDuplicateOrphanItem[];
  visibleLimit: number;
  selectedItemPaths: Set<string>;
  onToggleSelectAll: (items: ExportDuplicateOrphanItem[]) => void;
  onToggleSelectItem: (id: string, index: number, isShift: boolean, list: ExportDuplicateOrphanItem[]) => void;
  onToggleSort: (field: ExportSortField) => void;
  renderSortIndicator: (field: ExportSortField) => React.ReactNode;
  onDeleteDuplicateOrphans: (all: boolean, item?: ExportDuplicateOrphanItem) => void;
  isApplyingAction: boolean;
  searchQuery: string;
}

export const ExportDuplicateOrphansTable: React.FC<ExportDuplicateOrphansTableProps> = ({
  items,
  visibleLimit,
  selectedItemPaths,
  onToggleSelectAll,
  onToggleSelectItem,
  onToggleSort,
  renderSortIndicator,
  onDeleteDuplicateOrphans,
  isApplyingAction,
  searchQuery,
}) => {
  if (items.length === 0) {
    return (
      <div className="no-data">
        {searchQuery
          ? "No matching duplicate orphan files found."
          : "✅ No duplicate orphan files found! All orphan files on destination are unique."}
      </div>
    );
  }

  return (
    <>
      <table style={{ tableLayout: "fixed", width: "100%" }}>
        <thead>
          <tr>
            <th style={{ width: "36px", textAlign: "center" }}>
              <input
                type="checkbox"
                checked={items.length > 0 && items.every((item) => selectedItemPaths.has(item.relative_path))}
                onChange={() => onToggleSelectAll(items)}
                style={{ cursor: "pointer" }}
              />
            </th>
            <th
              style={{ width: "120px", cursor: "pointer", userSelect: "none" }}
              onClick={() => onToggleSort("status")}
              title="Click to sort by Match Type"
            >
              <div style={{ display: "inline-flex", alignItems: "center" }}>
                <span>Match Tier</span>
                {renderSortIndicator("status")}
              </div>
            </th>
            <th
              style={{ width: "38%", cursor: "pointer", userSelect: "none" }}
              onClick={() => onToggleSort("source")}
              title="Click to sort by Destination Duplicate Path"
            >
              <div style={{ display: "inline-flex", alignItems: "center" }}>
                <span>Duplicate File on USB (Orphan)</span>
                {renderSortIndicator("source")}
              </div>
            </th>
            <th
              style={{ width: "38%", cursor: "pointer", userSelect: "none" }}
              onClick={() => onToggleSort("dest")}
              title="Click to sort by Matched Active Track"
            >
              <div style={{ display: "inline-flex", alignItems: "center" }}>
                <span>Matches Active Track (Kept)</span>
                {renderSortIndicator("dest")}
              </div>
            </th>
            <th
              style={{ width: "85px", textAlign: "right", cursor: "pointer", userSelect: "none" }}
              onClick={() => onToggleSort("size")}
              title="Click to sort by File Size"
            >
              <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end" }}>
                <span>Size</span>
                {renderSortIndicator("size")}
              </div>
            </th>
            <th style={{ width: "75px", textAlign: "center" }}>
              <span>Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.slice(0, visibleLimit).map((item, idx) => {
            const isSelected = selectedItemPaths.has(item.relative_path);
            const tierColor =
              item.match_tier === "exact_hash"
                ? "var(--success)"
                : item.match_tier === "youtube_id"
                ? "var(--accent-purple)"
                : item.match_tier === "acoustic"
                ? "var(--accent-blue)"
                : "var(--warning)";
            const tierBg =
              item.match_tier === "exact_hash"
                ? "rgba(34, 197, 94, 0.15)"
                : item.match_tier === "youtube_id"
                ? "rgba(168, 85, 247, 0.15)"
                : item.match_tier === "acoustic"
                ? "rgba(59, 130, 246, 0.15)"
                : "rgba(234, 179, 8, 0.15)";
            const tierLabel =
              item.match_tier === "exact_hash"
                ? "EXACT HASH"
                : item.match_tier === "youtube_id"
                ? "YOUTUBE ID"
                : item.match_tier === "acoustic"
                ? "ACOUSTIC"
                : "METADATA";

            return (
              <tr
                key={idx}
                className={isSelected ? "selected" : undefined}
                data-selected={isSelected}
                title={`Orphan: ${item.file_path}\nDuplicates: ${item.matched_file_path}\nReason: ${item.match_reason}`}
                onClick={(e) => onToggleSelectItem(item.relative_path, idx, e.shiftKey, items)}
                style={{ cursor: "pointer", userSelect: "none" }}
              >
                <td style={{ textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={(e) =>
                      onToggleSelectItem(
                        item.relative_path,
                        idx,
                        (e.nativeEvent as MouseEvent).shiftKey,
                        items
                      )
                    }
                    style={{ cursor: "pointer" }}
                  />
                </td>
                <td>
                  <span
                    className="badge"
                    style={{
                      backgroundColor: tierBg,
                      color: tierColor,
                      border: `1px solid ${tierColor}`,
                      padding: "2px 6px",
                      borderRadius: "4px",
                      fontSize: "0.70rem",
                      fontWeight: 600,
                    }}
                    title={item.match_reason}
                  >
                    {tierLabel}
                  </span>
                </td>
                <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.file_path}>
                  <div
                    style={{
                      color: "var(--danger)",
                      textDecoration: "line-through",
                      opacity: 0.85,
                      fontSize: "0.82rem",
                    }}
                  >
                    {item.relative_path}
                  </div>
                </td>
                <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.matched_file_path}>
                  <div style={{ color: "var(--text-primary)", fontWeight: 500, fontSize: "0.82rem" }}>
                    {item.matched_dest_relative_path}
                  </div>
                  <div className="text-secondary" style={{ fontSize: "0.72rem", opacity: 0.8 }}>
                    ↳ {item.match_reason}
                  </div>
                </td>
                <td style={{ fontFamily: "var(--font-mono)", textAlign: "right", fontSize: "0.78rem" }}>
                  {formatSize(item.size_bytes)}
                </td>
                <td style={{ textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                  <button
                    className="btn btn-secondary"
                    disabled={isApplyingAction}
                    onClick={() => onDeleteDuplicateOrphans(false, item)}
                    style={{
                      padding: "2px 6px",
                      fontSize: "0.70rem",
                      color: "var(--danger)",
                      borderColor: "var(--danger)",
                    }}
                    title={`Permanently delete redundant duplicate copy "${item.relative_path}" from USB`}
                  >
                    🗑 Delete
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {items.length > visibleLimit && (
        <div
          className="text-secondary"
          style={{
            textAlign: "center",
            padding: "8px",
            fontSize: "0.75rem",
            fontFamily: "var(--font-mono)",
          }}
        >
          Showing {visibleLimit} of {items.length} duplicate orphan files (Scroll down to load more)
        </div>
      )}
    </>
  );
};
