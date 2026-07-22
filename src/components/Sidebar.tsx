import React from "react";

type SidebarProps = {
  currentView: string;
  onViewChange: (view: string) => void;
  hasConfig: boolean;
};

export const Sidebar: React.FC<SidebarProps> = ({ currentView, onViewChange, hasConfig }) => {
  const menuItems = [
    { id: "workspaces", label: "📂 Workspace", enabled: true },
    { id: "library", label: "📁 Library", enabled: hasConfig },
    { id: "playlists", label: "🎶 Playlists", enabled: hasConfig },
    { id: "downloads", label: "📥 Downloads", enabled: true },
    { id: "tools", label: "🛠 Tools", enabled: true },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1 className="sidebar-title">
          <span>💎</span> Diamond Music Manager
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
              className={`sidebar-item ${currentView === item.id || (item.id === "tools" && currentView.startsWith("tools_")) ? "active" : ""}`}
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
