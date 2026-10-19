export const formatSize = (bytes: number): string => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

export const formatDuration = (secs: number): string => {
  const minutes = Math.floor(secs / 60);
  const seconds = secs % 60;
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
};

export const formatSpeed = (bytesPerSec: number): string => {
  if (bytesPerSec <= 0) return "0 MB/s";
  const k = 1024;
  const sizes = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
  return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

export const formatEta = (
  seconds: number | null | undefined,
  options?: { verbose?: boolean }
): string => {
  if (seconds === null || seconds === undefined || isNaN(seconds) || seconds < 0) {
    return options?.verbose ? "Estimating ETA..." : "0s";
  }
  if (seconds === 0) return options?.verbose ? "Complete" : "0s";
  if (options?.verbose && seconds < 1) return "Almost done (< 1s)";
  if (options?.verbose && seconds < 5) return "< 5s remaining";
  if (seconds < 60) {
    const s = Math.round(seconds);
    return options?.verbose ? `~${s}s remaining` : `${s}s`;
  }
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) {
    if (options?.verbose) {
      return s > 0 ? `~${m}m ${s}s remaining` : `~${m}m remaining`;
    }
    return `${m}m ${s}s`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (options?.verbose) {
    return remM > 0 ? `~${h}h ${remM}m remaining` : `~${h}h remaining`;
  }
  return `${h}h ${remM}m`;
};

export const cleanDisplayPath = (path: string): string => {
  let p = path.replace(/\\/g, "/");
  p = p.replace(/^(\.\.\/|\.\/)+/, "");
  return p;
};
