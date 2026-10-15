import Link from 'next/link';
import { timeAgo, type Video } from '@/utils/types';

function formatDuration(seconds: number | null): string {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function VideoCard({ video, compact = false }: { video: Video; compact?: boolean }) {
  return (
    <Link href={`/watch?v=${video.id}`} className={compact ? 'flex gap-3' : 'block'}>
      <div className={`relative overflow-hidden rounded-lg bg-slate-200 dark:bg-slate-800 ${compact ? 'aspect-video w-40 shrink-0' : 'aspect-video w-full'}`}>
        {video.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={video.thumbnail_url} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-3xl text-slate-400">▶</div>
        )}
        {video.duration_seconds ? (
          <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1.5 py-0.5 text-xs font-medium text-white">
            {formatDuration(video.duration_seconds)}
          </span>
        ) : null}
      </div>
      <div className={compact ? 'min-w-0' : 'mt-2'}>
        <h3 className="line-clamp-2 text-sm font-semibold">{video.title}</h3>
        <p className="text-xs text-slate-500">
          {video.view_count.toLocaleString()} views · {timeAgo(video.created_at)}
        </p>
      </div>
    </Link>
  );
}
