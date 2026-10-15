import clsx from 'clsx';

interface AvatarProps {
  src?: string | null;
  name?: string | null;
  size?: number;
  online?: boolean;
  className?: string;
}

export function Avatar({ src, name, size = 40, online, className }: AvatarProps) {
  const initials = (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
  return (
    <span className={clsx('relative inline-flex shrink-0', className)} style={{ width: size, height: size }}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name ?? 'avatar'} className="h-full w-full rounded-full object-cover" />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700"
          style={{ fontSize: size * 0.4 }}
        >
          {initials || '?'}
        </span>
      )}
      {online !== undefined && (
        <span
          className={clsx(
            'absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white dark:border-slate-900',
            online ? 'bg-emerald-500' : 'bg-slate-400',
          )}
        />
      )}
    </span>
  );
}
