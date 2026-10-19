import React from "react";
import { ExportPlaylistDiffItem } from "../../types";
import { formatSize } from "../../utils/formatters";

export type ExportSortField = "status" | "source" | "dest" | "size";

export interface ExportPlaylistDiffTableProps {
  items: ExportPlaylistDiffItem[];
  visibleLimit: number;
  selectedItemPaths: Set<string>;
  onToggleSelectAll: (items: ExportPlaylistDiffItem[]) => void;
  onToggleSelectItem: (id: string, index: number, isShift: boolean, list: ExportPlaylistDiffItem[]) => void;
  onToggleSort: (field: ExportSortField) => void;
  renderSortIndicator: (field: ExportSortField) => React.ReactNode;
  onApplyPlaylists: (mode: "single", item: ExportPlaylistDiffItem) => void;
  onDeleteOrphanPlaylists: (all: boolean, item?: ExportPlaylistDiffItem) => void;
  isApplyingAction: boolean;
  searchQuery: string;
}

export const ExportPlaylistDiffTable: React.FC<ExportPlaylistDiffTableProps> = ({
  items,
  visibleLimit,
  selectedItemPaths,
  onToggleSelectAll,
  onToggleSelectItem,
  onToggleSort,
  renderSortIndicator,
  onApplyPlaylists,
  onDeleteOrphanPlaylists,
  isApplyingAction,
  searchQuery,
}) => {
  if (items.length === 0) {
    return (
      <div className="no-data">
        {searchQuery ? "No matching playlists found." : "No playlists found in config target directory."}
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
                checked={items.length > 0 && items.every((item) => selectedItemPaths.has(item.filename))}
                onChange={() => onToggleSelectAll(items)}
                style={{ cursor: "pointer" }}
              />
            </th>
            <th
              style={{ width: "110px", cursor: "pointer", userSelect: "none" }}
              onClick={() => onToggleSort("status")}
              title="Click to sort by Status"
            >
              <div style={{ display: "inline-flex", alignItems: "center" }}>
                <span>Status</span>
                {renderSortIndicator("status")}
              </div>
            </th>
            <th
              style={{ width: "30%", cursor: "pointer", userSelect: "none" }}
              onClick={() => onToggleSort("source")}
              title="Click to sort by Playlist Name"
            >
              <div style={{ display: "inline-flex", alignItems: "center" }}>
                <span>Playlist Filename</span>
                {renderSortIndicator("source")}
              </div>
            </th>
            <th style={{ width: "105px", textAlign: "center" }}>
              <span>Source Tracks</span>
            </th>
            <th style={{ width: "105px", textAlign: "center" }}>
              <span>Dest Tracks</span>
            </th>
            <th style={{ width: "24%" }}>
              <span>Diff Summary</span>
            </th>
            <th
              style={{ width: "80px", textAlign: "right", cursor: "pointer", userSelect: "none" }}
              onClick={() => onToggleSort("size")}
              title="Click to sort by File Size"
            >
              <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end" }}>
                <span>Size</span>
                {renderSortIndicator("size")}
              </div>
            </th>
            <th style={{ width: "95px", textAlign: "center" }}>
              <span>Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.slice(0, visibleLimit).map((item, idx) => {
            const isSelected = selectedItemPaths.has(item.filename);
            return (
              <tr
                key={idx}
                className={isSelected ? "selected" : undefined}
                data-selected={isSelected}
                title={item.source_path || item.dest_path}
                onClick={(e) => onToggleSelectItem(item.filename, idx, e.shiftKey, items)}
                style={{ cursor: "pointer", userSelect: "none" }}
              >
                <td style={{ textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={(e) =>
                      onToggleSelectItem(
                        item.filename,
                        idx,
                        (e.nativeEvent as MouseEvent).shiftKey,
                        items
                      )
                    }
                    style={{ cursor: "pointer" }}
                  />
                </td>
                <td>
                  {item.status === "New" && (
                    <span
                      className="badge"
                      style={{
                        backgroundColor: "rgba(34, 197, 94, 0.15)",
                        color: "var(--success)",
                        border: "1px solid var(--success)",
                        padding: "2px 6px",
                        borderRadius: "4px",
                        fontSize: "0.72rem",
                        fontWeight: 600,
                      }}
                    >
                      🟢 NEW
                    </span>
                  )}
                  {item.status === "Modified" && (
                    <span
                      className="badge"
                      style={{
                        backgroundColor: "rgba(245, 158, 11, 0.15)",
                        color: "var(--warning)",
                        border: "1px solid var(--warning)",
                        padding: "2px 6px",
                        borderRadius: "4px",
                        fontSize: "0.72rem",
                        fontWeight: 600,
                      }}
                    >
                      🟠 MODIFIED
                    </span>
                  )}
                  {item.status === "UpToDate" && (
                    <span
                      className="badge"
                      style={{
                        backgroundColor: "var(--bg-tertiary)",
                        color: "var(--text-muted)",
                        border: "1px solid var(--border-color)",
                        padding: "2px 6px",
                        borderRadius: "4px",
                        fontSize: "0.72rem",
                      }}
                    >
                      ⚪ IN SYNC
                    </span>
                  )}
                  {item.status === "Orphan" && (
                    <span
                      className="badge"
                      style={{
                        backgroundColor: "rgba(239, 68, 68, 0.15)",
                        color: "var(--danger)",
                        border: "1px solid var(--danger)",
                        padding: "2px 6px",
                        borderRadius: "4px",
                        fontSize: "0.72rem",
                        fontWeight: 600,
                      }}
                    >
                      🔴 ORPHAN
                    </span>
                  )}
                </td>
                <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: "0.85rem",
                      color: item.status === "Orphan" ? "var(--danger)" : "var(--text-primary)",
                    }}
                  >
                    {item.filename}
                  </div>
                  <div className="text-secondary" style={{ fontSize: "0.72rem", fontFamily: "var(--font-mono)", opacity: 0.8 }}>
                    {item.name}
                  </div>
                </td>
                <td style={{ textAlign: "center", fontFamily: "var(--font-mono)", fontSize: "0.82rem" }}>
                  {item.status === "Orphan" ? (
                    <span style={{ opacity: 0.4 }}>—</span>
                  ) : (
                    <span style={{ color: "var(--accent-purple)", fontWeight: 600 }}>
                      {item.track_count_source}
                    </span>
                  )}
                </td>
                <td style={{ textAlign: "center", fontFamily: "var(--font-mono)", fontSize: "0.82rem" }}>
                  {item.status === "New" ? (
                    <span style={{ opacity: 0.4 }}>—</span>
                  ) : (
                    <span
                      style={{
                        color: item.status === "Orphan" ? "var(--danger)" : "var(--text-secondary)",
                        fontWeight: 600,
                      }}
                    >
                      {item.track_count_dest}
                    </span>
                  )}
                </td>
                <td style={{ fontSize: "0.8rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <span
                    style={{
                      color:
                        item.status === "New"
                          ? "var(--success)"
                          : item.status === "Modified"
                          ? "var(--warning)"
                          : item.status === "Orphan"
                          ? "var(--danger)"
                          : "var(--text-secondary)",
                    }}
                  >
                    {item.diff_summary}
                  </span>
                </td>
                <td style={{ fontFamily: "var(--font-mono)", textAlign: "right", fontSize: "0.78rem" }}>
                  {formatSize(item.size_bytes)}
                </td>
                <td style={{ textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                  {item.status === "New" && (
                    <button
                      className="btn btn-primary"
                      disabled={isApplyingAction}
                      onClick={() => onApplyPlaylists("single", item)}
                      style={{
                        padding: "2px 8px",
                        fontSize: "0.72rem",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "3px",
                        backgroundColor: "var(--success)",
                        borderColor: "var(--success)",
                        color: "#000",
                        fontWeight: 600,
                      }}
                      title="Copy this playlist to USB"
                    >
                      ⚡ Copy
                    </button>
                  )}
                  {item.status === "Modified" && (
                    <button
                      className="btn btn-primary"
                      disabled={isApplyingAction}
                      onClick={() => onApplyPlaylists("single", item)}
                      style={{
                        padding: "2px 8px",
                        fontSize: "0.72rem",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "3px",
                        backgroundColor: "var(--warning)",
                        borderColor: "var(--warning)",
                        color: "#000",
                        fontWeight: 600,
                      }}
                      title="Overwrite this playlist on USB with latest order and tracks"
                    >
                      ⚡ Overwrite
                    </button>
                  )}
                  {item.status === "Orphan" && (
                    <button
                      className="btn btn-secondary"
                      disabled={isApplyingAction}
                      onClick={() => onDeleteOrphanPlaylists(false, item)}
                      style={{
                        padding: "2px 8px",
                        fontSize: "0.72rem",
                        color: "var(--danger)",
                        borderColor: "var(--danger)",
                        fontWeight: 600,
                      }}
                      title="Delete this orphan playlist from USB destination"
                    >
                      🗑 Delete
                    </button>
                  )}
                  {item.status === "UpToDate" && (
                    <span className="text-secondary" style={{ fontSize: "0.75rem" }}>
                      ✓ In Sync
                    </span>
                  )}
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
          Showing {visibleLimit} of {items.length} playlists (Scroll down to load more)
        </div>
      )}
    </>
  );
};
