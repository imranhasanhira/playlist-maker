import React, { useState, useEffect, useCallback } from "react";

export interface UseResizablePanelOptions {
  storageKey?: string;
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  reverse?: boolean;
}

export function useResizablePanel({
  storageKey,
  defaultWidth,
  minWidth = 150,
  maxWidth = 1000,
  reverse = false,
}: UseResizablePanelOptions) {
  const [width, setWidth] = useState<number>(() => {
    if (!storageKey) return defaultWidth;
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? parseInt(saved, 10) : defaultWidth;
    } catch {
      return defaultWidth;
    }
  });

  useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, width.toString());
    } catch {}
  }, [storageKey, width]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const newWidth = reverse ? startWidth - deltaX : startWidth + deltaX;
        if (newWidth >= minWidth && newWidth <= maxWidth) {
          setWidth(newWidth);
        }
      };

      const handleMouseUp = () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [width, minWidth, maxWidth, reverse]
  );

  return { width, setWidth, handleMouseDown };
}
