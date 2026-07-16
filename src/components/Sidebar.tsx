import React from "react";

type SidebarProps = {
  currentView: string;
  onViewChange: (view: string) => void;
  hasConfig: boolean;
};

export const Sidebar: React.FC<SidebarProps> = ({ currentView, onViewChange, hasConfig }) => {
  const menuItems = [
    { id: "workspaces", label: "📁 Workspaces", enabled: true },
    { id: "playlists", label: "🎶 Playlist Builder", enabled: hasConfig },
    { id: "sanitizer", label: "🧼 Sanitizer & Cleaner", enabled: true },
    { id: "transcoder", label: "🔄 FLAC Transcoder", enabled: true },
    { id: "settings", label: "⚙️ Settings", enabled: true },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1 className="sidebar-title">
          <span>🎵</span> PlaylistMaker
        </h1>
      </div>
      <ul className="sidebar-menu">
        {menuItems.map((item) => {
          if (!item.enabled) {
            return (
              <li
                key={item.id}
                className="sidebar-item"
                style={{ opacity: 0.4, cursor: "not-allowed" }}
                title="Please load a workspace configuration first"
              >
                {item.label}
              </li>
            );
          }
          return (
            <li
              key={item.id}
              className={`sidebar-item ${currentView === item.id ? "active" : ""}`}
              onClick={() => onViewChange(item.id)}
            >
              {item.label}
            </li>
          );
        })}
      </ul>
      <div className="sidebar-footer">
        <p>Tauri Version 2.0</p>
      </div>
    </aside>
  );
};
