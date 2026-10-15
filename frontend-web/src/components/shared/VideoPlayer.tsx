'use client';

import Hls from 'hls.js';
import { useEffect, useRef, useState } from 'react';

interface VideoPlayerProps {
  src: string;
  poster?: string | null;
  onFirstPlay?: () => void;
}

/** HLS player: hls.js with adaptive bitrate (plus a manual quality picker), native HLS on Safari. */
export function VideoPlayer({ src, poster, onFirstPlay }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const reportedRef = useRef(false);
  const [levels, setLevels] = useState<{ index: number; height: number }[]>([]);
  const [level, setLevel] = useState(-1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    reportedRef.current = false;
    setError(null);
    setLevels([]);
    setLevel(-1);

    if (Hls.isSupported()) {
      const hls = new Hls({ capLevelToPlayerSize: true, maxBufferLength: 30, enableWorker: true });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        setLevels(data.levels.map((l, index) => ({ index, height: l.height })).sort((a, b) => b.height - a.height));
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          setError('This video could not be played.');
          hls.destroy();
        }
      });
      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src; // Safari plays HLS natively
      return () => {
        video.removeAttribute('src');
        video.load();
      };
    }

    setError('Your browser cannot play HLS video.');
    return undefined;
  }, [src]);

  function changeLevel(value: number) {
    setLevel(value);
    if (hlsRef.current) hlsRef.current.currentLevel = value; // -1 = automatic
  }

  return (
    <div className="relative overflow-hidden rounded-xl bg-black">
      <video
        ref={videoRef}
        controls
        playsInline
        poster={poster ?? undefined}
        className="aspect-video w-full"
        onPlay={() => {
          if (!reportedRef.current) {
            reportedRef.current = true;
            onFirstPlay?.();
          }
        }}
      />
      {levels.length > 1 && (
        <select
          value={level}
          onChange={(e) => changeLevel(Number(e.target.value))}
          className="absolute right-2 top-2 rounded bg-black/70 px-2 py-1 text-xs text-white"
          aria-label="Quality"
        >
          <option value={-1}>Auto</option>
          {levels.map((l) => (
            <option key={l.index} value={l.index}>
              {l.height}p
            </option>
          ))}
        </select>
      )}
      {error && <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-4 text-center text-white">{error}</div>}
    </div>
  );
}
