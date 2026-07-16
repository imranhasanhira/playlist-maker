import React, { useRef, useState, useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

export type AudioTrack = {
  file_path: String;
  title: String;
  artist: String;
  duration: number;
};

type AudioPlayerProps = {
  activeTrack: AudioTrack | null;
  isPlaying: boolean;
  onPlayPause: (playing: boolean) => void;
};

export const AudioPlayer: React.FC<AudioPlayerProps> = ({
  activeTrack,
  isPlaying,
  onPlayPause,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    if (!audioRef.current) return;

    if (activeTrack) {
      // Convert path to Tauri asset src URL
      const assetUrl = convertFileSrc(String(activeTrack.file_path));
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
  }, [activeTrack]);

  useEffect(() => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.play().catch((e) => console.log("Playback error: ", e));
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

  const formatTime = (secs: number) => {
    if (isNaN(secs)) return "0:00";
    const minutes = Math.floor(secs / 60);
    const seconds = Math.floor(secs % 60);
    return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
  };

  return (
    <div className="bottom-player">
      <audio
        ref={audioRef}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={() => onPlayPause(false)}
      />

      <div className="player-track-info">
        {activeTrack ? (
          <>
            <div className="player-title" title={String(activeTrack.title)}>
              {activeTrack.title || "Unknown Track"}
            </div>
            <div className="player-artist" title={String(activeTrack.artist)}>
              {activeTrack.artist || "Unknown Artist"}
            </div>
          </>
        ) : (
          <div className="player-title text-secondary">No track loaded</div>
        )}
      </div>

      <div className="player-controls">
        <button
          className="player-btn player-btn-play"
          disabled={!activeTrack}
          onClick={() => onPlayPause(!isPlaying)}
        >
          {isPlaying ? "⏸" : "▶"}
        </button>
      </div>

      <div className="player-progress">
        <span className="player-time">{formatTime(currentTime)}</span>
        <input
          type="range"
          className="player-slider"
          min="0"
          max={duration || 100}
          value={currentTime}
          onChange={handleSeek}
          disabled={!activeTrack}
        />
        <span className="player-time">{formatTime(duration || activeTrack?.duration || 0)}</span>
      </div>

      <div className="player-volume">
        <button
          className="player-btn"
          onClick={toggleMute}
          disabled={!activeTrack}
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
          disabled={!activeTrack}
        />
      </div>
    </div>
  );
};
