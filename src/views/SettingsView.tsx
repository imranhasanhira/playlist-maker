import React from "react";

type SettingsViewProps = {
  formats: string;
  setFormats: (formats: string) => void;
};

export const SettingsView: React.FC<SettingsViewProps> = ({ formats, setFormats }) => {
  return (
    <div className="view-container">
      <h1>Settings & Preferences</h1>
      <p className="subtitle">Configure default extensions, transcoding rules, and personalization options.</p>

      <div className="card">
        <div className="card-title">Supported Audio Formats</div>
        
        <div className="form-group">
          <label className="form-label">Allowed Audio Extensions (comma-separated)</label>
          <input
            type="text"
            value={formats}
            onChange={(e) => setFormats(e.target.value)}
            placeholder="e.g. mp3,aac,ogg,wma,alac,m4a,wav,flac"
          />
          <p className="text-secondary" style={{ fontSize: "0.8rem", marginTop: "8px" }}>
            The playlist maker and sanitizer will only include/scan files that match these extensions.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Sanitizer Rules (Standard)</div>
        <p className="text-secondary" style={{ marginBottom: "12px", fontSize: "0.9rem" }}>
          The sanitizer will automatically run the following cleanup passes:
        </p>
        <ul style={{ listStyle: "circle", paddingLeft: "20px", display: "flex", flexDirection: "column", gap: "6px", fontSize: "0.9rem" }}>
          <li>Strip distribution domains (e.g. <code>music.com.bd</code>)</li>
          <li>Remove release indicators (e.g. <code>HQ, HD, Full Video, Lyrical</code>)</li>
          <li>Strip video resolution tags (e.g. <code>1080p, 720p</code>)</li>
          <li>Clean separator characters (convert duplicate pipes/spaces to standard dividers)</li>
          <li>Remove leading digits and track numbering</li>
          <li>Remove hidden system files</li>
        </ul>
      </div>
    </div>
  );
};
