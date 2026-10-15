'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/layouts/AppShell';
import { VideoCard } from '@/components/shared/VideoCard';
import { VideoPlayer } from '@/components/shared/VideoPlayer';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';
import { useAuthStore } from '@/store/authStore';
import { ApiError, apiFetch } from '@/utils/api';
import { displayName, timeAgo, type Video, type VideoComment } from '@/utils/types';

const PARALLEL_CHUNKS = 3;
const CHUNK_RETRIES = 3;

interface UploadInit {
  upload_id: string;
  video_id: string;
  chunk_size: number;
  total_chunks: number;
}

/** Resumable chunked upload: asks the server which chunks it already has, then sends the rest in parallel. */
async function uploadVideo(file: File, title: string, description: string, onProgress: (fraction: number) => void): Promise<string> {
  const init = await apiFetch<UploadInit>('/api/v1/media/uploads', {
    method: 'POST',
    body: { title, description, filename: file.name, size_bytes: file.size, content_type: file.type || 'video/mp4' },
  });
  const done = new Set<number>();
  const pending = Array.from({ length: init.total_chunks }, (_, i) => i);
  let completedBytes = 0;

  async function sendChunk(index: number): Promise<void> {
    const start = index * init.chunk_size;
    const blob = file.slice(start, Math.min(start + init.chunk_size, file.size));
    for (let attempt = 1; ; attempt++) {
      try {
        await apiFetch(`/api/v1/media/uploads/${init.upload_id}/chunks/${index}`, {
          method: 'PUT',
          rawBody: blob,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
        done.add(index);
        completedBytes += blob.size;
        onProgress(completedBytes / file.size);
        return;
      } catch (err) {
        const retryable = !(err instanceof ApiError) || err.status >= 500 || err.status === 429;
        if (!retryable || attempt >= CHUNK_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      const index = pending.shift();
      if (index === undefined) return;
      await sendChunk(index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(PARALLEL_CHUNKS, init.total_chunks) }, () => worker()));
  await apiFetch(`/api/v1/media/uploads/${init.upload_id}/complete`, { method: 'POST' });
  return init.video_id;
}

function UploadPanel({ onUploaded }: { onUploaded: (videoId: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);

  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => {
      void apiFetch<{ video: Video }>(`/api/v1/media/videos/${processing}`)
        .then(({ video }) => {
          if (video.status === 'ready') {
            setProcessing(null);
            setFile(null);
            setTitle('');
            setDescription('');
            setProgress(null);
            onUploaded(video.id);
          } else if (video.status === 'failed') {
            setProcessing(null);
            setProgress(null);
            setError('Processing failed. Please try another file.');
          }
        })
        .catch(() => undefined);
    }, 4000);
    return () => clearInterval(timer);
  }, [processing, onUploaded]);

  async function start() {
    if (!file || !title.trim()) return;
    setError(null);
    setProgress(0);
    try {
      const videoId = await uploadVideo(file, title.trim(), description.trim(), setProgress);
      setProcessing(videoId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed. Please try again.');
      setProgress(null);
    }
  }

  const busy = progress !== null;
  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="font-semibold">Upload a video</h2>
      <input
        type="file"
        accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.mkv,.webm,.m4v"
        disabled={busy}
        onChange={(e) => {
          const picked = e.target.files?.[0] ?? null;
          setFile(picked);
          if (picked && !title) setTitle(picked.name.replace(/\.[^.]+$/, ''));
        }}
        className="block w-full text-sm"
      />
      <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={150} disabled={busy} />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description"
        rows={2}
        maxLength={5000}
        disabled={busy}
        className="w-full rounded-lg border border-slate-300 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-900"
      />
      {progress !== null && (
        <div>
          <div className="h-2 overflow-hidden rounded bg-slate-200">
            <div className="h-full bg-brand-600 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {processing ? 'Upload complete. Processing into multiple qualities…' : `Uploading ${Math.round(progress * 100)}%`}
          </p>
        </div>
      )}
      {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <Button onClick={() => void start()} disabled={!file || !title.trim() || busy} loading={busy && !processing}>
        Upload
      </Button>
    </section>
  );
}

function VideoView({ videoId, onChanged }: { videoId: string; onChanged: () => void }) {
  const router = useRouter();
  const userId = useAuthStore((s) => s.session?.user.id);
  const [video, setVideo] = useState<Video | null>(null);
  const [liked, setLiked] = useState(false);
  const [comments, setComments] = useState<VideoComment[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      apiFetch<{ video: Video; liked_by_me: boolean }>(`/api/v1/media/videos/${videoId}`),
      apiFetch<{ items: VideoComment[] }>(`/api/v1/media/videos/${videoId}/comments`),
    ])
      .then(([v, c]) => {
        if (cancelled) return;
        setVideo(v.video);
        setLiked(v.liked_by_me);
        setComments(c.items);
      })
      .catch(() => !cancelled && setError('This video is not available.'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  async function toggleLike() {
    if (!video) return;
    const next = !liked;
    setLiked(next);
    setVideo({ ...video, like_count: Math.max(0, video.like_count + (next ? 1 : -1)) });
    try {
      await apiFetch(`/api/v1/media/videos/${video.id}/like`, { method: next ? 'POST' : 'DELETE' });
    } catch {
      setLiked(!next);
      setVideo(video);
    }
  }

  async function postComment() {
    const body = draft.trim();
    if (!body) return;
    try {
      const { comment } = await apiFetch<{ comment: VideoComment }>(`/api/v1/media/videos/${videoId}/comments`, { method: 'POST', body: { body } });
      setComments((prev) => [{ ...comment, author: null }, ...prev]);
      setDraft('');
    } catch {
      setError('Could not post your comment.');
    }
  }

  async function removeVideo() {
    if (!video || !window.confirm('Delete this video permanently?')) return;
    await apiFetch(`/api/v1/media/videos/${video.id}`, { method: 'DELETE' });
    onChanged();
    router.replace('/watch');
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16 text-brand-600">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }
  if (!video || error === 'This video is not available.') return <p className="py-16 text-center text-slate-500">This video is not available.</p>;

  return (
    <div className="space-y-4">
      {video.hls_url ? (
        <VideoPlayer
          src={video.hls_url}
          poster={video.thumbnail_url}
          onFirstPlay={() => void apiFetch(`/api/v1/media/videos/${video.id}/view`, { method: 'POST' }).catch(() => undefined)}
        />
      ) : (
        <div className="flex aspect-video items-center justify-center rounded-xl bg-slate-900 text-white">
          {video.status === 'ready' ? 'Streaming is not configured' : 'This video is still processing…'}
        </div>
      )}
      <div>
        <h1 className="text-xl font-bold">{video.title}</h1>
        <p className="text-sm text-slate-500">
          {video.view_count.toLocaleString()} views · {timeAgo(video.created_at)}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant={liked ? 'primary' : 'secondary'} size="sm" onClick={() => void toggleLike()}>
            👍 {video.like_count}
          </Button>
          {userId === video.user_id && (
            <Button variant="danger" size="sm" onClick={() => void removeVideo()}>
              Delete
            </Button>
          )}
        </div>
        {video.description && <p className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-100 p-3 text-sm dark:bg-slate-800">{video.description}</p>}
      </div>

      <section className="space-y-3">
        <h2 className="font-semibold">{comments.length} comments</h2>
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void postComment()}
            maxLength={2000}
            placeholder="Add a comment…"
            className="h-10 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
          <Button onClick={() => void postComment()} disabled={!draft.trim()}>
            Comment
          </Button>
        </div>
        {error && error !== 'This video is not available.' && <p className="text-sm text-red-600">{error}</p>}
        {comments.map((comment) => (
          <div key={comment.id} className="flex gap-3">
            <Avatar src={comment.author?.avatar_url} name={displayName(comment.author)} size={32} />
            <div>
              <p className="text-sm font-semibold">
                {displayName(comment.author)} <span className="font-normal text-slate-400">{timeAgo(comment.created_at)}</span>
              </p>
              <p className="whitespace-pre-wrap break-words text-sm">{comment.body}</p>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function WatchContent() {
  const router = useRouter();
  const params = useSearchParams();
  const videoId = params.get('v');
  const [videos, setVideos] = useState<Video[]>([]);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [reload, setReload] = useState(0);
  const lastRequest = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++lastRequest.current;
    setLoading(true);
    try {
      const data = await apiFetch<{ items: Video[] }>('/api/v1/media/videos', { query: { q: query, page_size: 36 } });
      if (requestId === lastRequest.current) setVideos(data.items);
    } finally {
      if (requestId === lastRequest.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load().catch(() => setLoading(false));
  }, [load, reload]);

  return (
    <AppShell>
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-4">
          {videoId ? (
            <VideoView videoId={videoId} onChanged={() => setReload((n) => n + 1)} />
          ) : (
            <>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  setQuery(q.trim());
                }}
              >
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search videos"
                  className="h-10 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
                />
                <Button type="submit">Search</Button>
                <Button variant="secondary" onClick={() => setShowUpload((v) => !v)}>
                  {showUpload ? 'Close' : 'Upload'}
                </Button>
              </form>
              {showUpload && (
                <UploadPanel
                  onUploaded={(id) => {
                    setShowUpload(false);
                    setReload((n) => n + 1);
                    router.push(`/watch?v=${id}`);
                  }}
                />
              )}
              {loading ? (
                <div className="flex justify-center py-16 text-brand-600">
                  <Spinner className="h-8 w-8" />
                </div>
              ) : videos.length === 0 ? (
                <p className="py-16 text-center text-slate-500">No videos yet. Upload the first one!</p>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {videos.map((video) => (
                    <VideoCard key={video.id} video={video} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {videoId && (
          <aside className="space-y-3">
            <h2 className="font-semibold">More videos</h2>
            {videos
              .filter((v) => v.id !== videoId)
              .slice(0, 12)
              .map((video) => (
                <VideoCard key={video.id} video={video} compact />
              ))}
          </aside>
        )}
      </div>
    </AppShell>
  );
}

export default function WatchPage() {
  return (
    <Suspense fallback={null}>
      <WatchContent />
    </Suspense>
  );
}
