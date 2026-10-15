'use client';

import { useEffect, useRef, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { displayName, type Story } from '@/utils/types';

interface StoryBarProps {
  stories: Story[];
  onCreate: (file: File, caption: string) => Promise<void>;
}

/** Horizontal story tray with a full-screen viewer (auto-advances every 5 seconds). */
export function StoryBar({ stories, onCreate }: StoryBarProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (viewing === null) return;
    const timer = setTimeout(() => setViewing((i) => (i !== null && i + 1 < stories.length ? i + 1 : null)), 5000);
    return () => clearTimeout(timer);
  }, [viewing, stories.length]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    const caption = window.prompt('Add a caption (optional)') ?? '';
    setUploading(true);
    try {
      await onCreate(file, caption.trim());
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const current = viewing !== null ? stories[viewing] : null;

  return (
    <>
      <div className="flex gap-3 overflow-x-auto pb-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="flex w-20 shrink-0 flex-col items-center gap-1 text-xs"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-dashed border-brand-400 text-2xl text-brand-500">
            {uploading ? '…' : '+'}
          </span>
          Your story
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
        {stories.map((story, index) => (
          <button key={story.id} type="button" onClick={() => setViewing(index)} className="flex w-20 shrink-0 flex-col items-center gap-1 text-xs">
            <span className="rounded-full bg-gradient-to-tr from-brand-500 to-pink-500 p-0.5">
              <span className="block rounded-full bg-white p-0.5 dark:bg-slate-950">
                <Avatar src={story.author?.avatar_url ?? story.media_url} name={displayName(story.author)} size={56} />
              </span>
            </span>
            <span className="w-full truncate text-center">{displayName(story.author)}</span>
          </button>
        ))}
      </div>

      {current && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black" role="dialog" aria-modal="true">
          <div className="absolute inset-x-4 top-3 flex gap-1">
            {stories.map((s, i) => (
              <span key={s.id} className={`h-1 flex-1 rounded ${viewing !== null && i <= viewing ? 'bg-white' : 'bg-white/30'}`} />
            ))}
          </div>
          <button type="button" aria-label="Previous" className="absolute inset-y-0 left-0 w-1/3" onClick={() => setViewing((i) => (i !== null && i > 0 ? i - 1 : i))} />
          <button type="button" aria-label="Next" className="absolute inset-y-0 right-0 w-1/3" onClick={() => setViewing((i) => (i !== null && i + 1 < stories.length ? i + 1 : null))} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={current.media_url} alt={current.caption ?? 'story'} className="max-h-full max-w-full object-contain" />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 p-4 text-white">
            <p className="font-semibold">{displayName(current.author)}</p>
            {current.caption && <p className="text-sm">{current.caption}</p>}
          </div>
          <button type="button" onClick={() => setViewing(null)} className="absolute right-4 top-8 text-2xl text-white" aria-label="Close story">
            ✕
          </button>
        </div>
      )}
    </>
  );
}
