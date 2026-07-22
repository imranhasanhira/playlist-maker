import React, { useRef, useState, useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AudioTrack } from "../types";
import { formatDuration } from "../utils/formatters";

export type { AudioTrack };

type AudioPlayerProps = {
  queue: AudioTrack[];
  currentTrackIndex: number;
  onTrackIndexChange: (idx: number) => void;
  isPlaying: boolean;
  onPlayPause: (playing: boolean) => void;
  playlistName?: string;
  onClose: () => void;
};

export const AudioPlayer: React.FC<AudioPlayerProps> = ({
  queue,
  currentTrackIndex,
  onTrackIndexChange,
  isPlaying,
  onPlayPause,
  playlistName,
  onClose,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [playerError, setPlayerError] = useState<string>("");
  const [isLoopSingle, setIsLoopSingle] = useState<boolean>(false);
  const [isShuffle, setIsShuffle] = useState<boolean>(false);
  const [history, setHistory] = useState<number[]>([]);

  const activeTrack = queue[currentTrackIndex] || null;

  // Clear history when the play queue changes
  useEffect(() => {
    setHistory([]);
  }, [queue]);

  useEffect(() => {
    if (!audioRef.current) return;
    setPlayerError("");

    if (activeTrack) {
      const assetUrl = convertFileSrc(String(activeTrack.file_path));
      console.log("Loading audio source URL:", assetUrl, "for file:", activeTrack.file_path);
      audioRef.current.src = assetUrl;
      audioRef.current.load();
      if (isPlaying) {
        audioRef.current.play().catch((e) => console.log("Playback error: ", e));
      }
    } else {
      audioRef.current.pause();
      audioRef.current.src = "";
      setCurrentTime(0);
      setDuration(0);
    }
  }, [activeTrack?.file_path]);

  useEffect(() => {
    if (!audioRef.current) return;
    if (isPlaying) {
      if (audioRef.current.src) {
        audioRef.current.play().catch((e) => console.log("Playback error: ", e));
      }
    } else {
      audioRef.current.pause();
    }
  }, [isPlaying]);

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (audioRef.current) {
      audioRef.current.currentTime = val;
      setCurrentTime(val);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (audioRef.current) {
      audioRef.current.volume = val;
      audioRef.current.muted = val === 0;
      setMuted(val === 0);
    }
  };

  const toggleMute = () => {
    if (audioRef.current) {
      const nextMuted = !muted;
      audioRef.current.muted = nextMuted;
      setMuted(nextMuted);
    }
  };



  const handleNext = () => {
    if (isLoopSingle) {
      // If loop is enabled, next will just restart the same track
      if (audioRef.current) {
        audioRef.current.currentTime = 0;
        audioRef.current.play().catch((e) => console.log("Loop playback error: ", e));
      }
    } else if (isShuffle) {
      if (queue.length > 1) {
        let nextIdx = currentTrackIndex;
        while (nextIdx === currentTrackIndex) {
          nextIdx = Math.floor(Math.random() * queue.length);
        }
        setHistory((prev) => [...prev, currentTrackIndex]);
        onTrackIndexChange(nextIdx);
      }
    } else {
      if (currentTrackIndex + 1 < queue.length) {
        setHistory((prev) => [...prev, currentTrackIndex]);
        onTrackIndexChange(currentTrackIndex + 1);
      } else {
        onPlayPause(false);
      }
    }
  };

  const handlePrev = () => {
    if (history.length > 0) {
      const prevIdx = history[history.length - 1];
      setHistory((prev) => prev.slice(0, -1));
      onTrackIndexChange(prevIdx);
    } else if (currentTrackIndex > 0) {
      onTrackIndexChange(currentTrackIndex - 1);
    }
  };

  const getToggleStyle = (enabled: boolean) => ({
    color: enabled ? "#ffffff" : "var(--text-secondary)",
    backgroundColor: enabled ? "var(--accent-purple)" : "rgba(255, 255, 255, 0.05)",
    border: enabled ? "1px solid var(--accent-purple)" : "1px solid var(--border-color)",
    borderRadius: "8px",
    padding: "6px 10px",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: enabled ? "0 0 12px rgba(138, 92, 246, 0.45)" : "none",
    transition: "all 0.2s ease",
    transform: enabled ? "scale(1.05)" : "scale(1)",
  });

  const getMediaNavStyle = (disabled: boolean) => ({
    color: "var(--text-primary)",
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    border: "1px solid var(--border-color)",
    borderRadius: "50%",
    width: "36px",
    height: "36px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.35 : 1,
    transition: "all 0.2s ease",
  });

  if (!activeTrack) {
    return null;
  }

  const isPrevDisabled = history.length === 0 && currentTrackIndex === 0;
  const isNextDisabled = !isShuffle && currentTrackIndex === queue.length - 1;

  return (
    <div className="bottom-player">
      <audio
        ref={audioRef}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleNext}
        onError={() => {
          const err = audioRef.current?.error;
          let msg = "Playback failed";
          if (err) {
            switch (err.code) {
              case err.MEDIA_ERR_ABORTED:
                msg = "Playback aborted";
                break;
              case err.MEDIA_ERR_NETWORK:
                msg = "Network error loading audio";
                break;
              case err.MEDIA_ERR_DECODE:
                msg = "Audio format decoding failed";
                break;
              case err.MEDIA_ERR_SRC_NOT_SUPPORTED:
                msg = "Blocked: File path or format not supported";
                break;
            }
          }
          setPlayerError(msg);
        }}
      />

      <div className="player-track-info" style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
        {playlistName && (
          <div className="playlist-cue" style={{ 
            fontSize: "0.68rem", 
            color: "var(--accent-purple)", 
            fontWeight: 700, 
            textTransform: "uppercase", 
            letterSpacing: "1px",
            marginBottom: "4px"
          }}>
            💎 {playlistName}
          </div>
        )}
        {playerError ? (
          <div className="player-title" style={{ color: "var(--danger)", fontSize: "0.85rem" }} title={String(activeTrack.file_path)}>
            ⚠️ {playerError}
          </div>
        ) : (
          <>
            <div className="player-title" title={String(activeTrack.title)}>
              {activeTrack.title || "Unknown Track"}
            </div>
            <div className="player-artist" title={String(activeTrack.artist)}>
              {activeTrack.artist || "Unknown Artist"}
            </div>
          </>
        )}
      </div>

      <div className="player-controls" style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        {queue.length > 1 && (
          <button
            onClick={handlePrev}
            disabled={isPrevDisabled}
            style={getMediaNavStyle(isPrevDisabled)}
            className="player-nav-btn"
            title="Previous Track"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z"/>
            </svg>
          </button>
        )}
        <button
          className="player-btn player-btn-play"
          onClick={() => onPlayPause(!isPlaying)}
          style={{ cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          {isPlaying ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ transform: "translateX(1px)" }}>
              <path d="M8 5v14l11-7z"/>
            </svg>
          )}
        </button>
        {queue.length > 1 && (
          <button
            onClick={handleNext}
            disabled={isNextDisabled}
            style={getMediaNavStyle(isNextDisabled)}
            className="player-nav-btn"
            title="Next Track"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 6h2v12h-2V6zm-10.5 0l8.5 6-8.5 6V6z"/>
            </svg>
          </button>
        )}
        {queue.length > 1 && (
          <button
            className="player-btn"
            onClick={() => setIsShuffle(!isShuffle)}
            style={getToggleStyle(isShuffle)}
            title={isShuffle ? "Shuffle Playback Enabled" : "Shuffle Playback Disabled"}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.38 10.17l-1.42 1.41 3.17 3.17L14.5 20H20v-5.5l-2.04 2.04-3.08-3.37z"/>
            </svg>
          </button>
        )}
        <button
          className="player-btn"
          onClick={() => setIsLoopSingle(!isLoopSingle)}
          style={getToggleStyle(isLoopSingle)}
          title={isLoopSingle ? "Loop Single Song Enabled" : "Loop Single Song Disabled"}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>
          </svg>
        </button>
      </div>

      <div className="player-progress">
        <span className="player-time">{formatDuration(Math.floor(currentTime))}</span>
        <input
          type="range"
          className="player-slider"
          min="0"
          max={duration || 100}
          value={currentTime}
          onChange={handleSeek}
        />
        <span className="player-time">{formatDuration(Math.floor(duration || (activeTrack ? activeTrack.duration : 0) || 0))}</span>
      </div>

      <div className="player-volume">
        <button
          className="player-btn"
          onClick={toggleMute}
          style={{ cursor: "pointer" }}
        >
          {muted || volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}
        </button>
        <input
          type="range"
          className="player-volume-slider"
          min="0"
          max="1"
          step="0.05"
          value={muted ? 0 : volume}
          onChange={handleVolumeChange}
        />
      </div>

      <button
        className="player-btn"
        onClick={onClose}
        style={{
          marginLeft: "24px",
          color: "var(--danger)",
          fontSize: "1.4rem",
          fontWeight: 700,
          cursor: "pointer",
          border: "none",
          background: "transparent",
        }}
        title="Close & Hide Player"
      >
        ×
      </button>
    </div>
  );
};
