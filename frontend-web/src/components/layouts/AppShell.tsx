'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { useAuthStore } from '@/store/authStore';
import { cartCount, useCartStore } from '@/store/cartStore';
import { useChatStore } from '@/store/chatStore';
import { chatClient } from '@/utils/chatClient';

const NAV = [
  { href: '/feed', label: 'Feed', icon: '🏠' },
  { href: '/chat', label: 'Chat', icon: '💬' },
  { href: '/marketplace', label: 'Shop', icon: '🛍️' },
  { href: '/watch', label: 'Watch', icon: '▶️' },
  { href: '/ai', label: 'AI', icon: '✨' },
] as const;

/** Authenticated page frame: top bar, bottom tabs on mobile, redirect to /login when signed out. */
export function AppShell({ children, fullHeight = false }: { children: ReactNode; fullHeight?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const { session, profile, hydrated, logout, loadProfile } = useAuthStore();
  const cartItems = useCartStore((s) => s.items);
  const setCartOpen = useCartStore((s) => s.setOpen);
  const unread = useChatStore((s) => Object.values(s.peers).reduce((n, p) => n + p.unread, 0));

  useEffect(() => {
    if (hydrated && !session) router.replace('/login');
  }, [hydrated, session, router]);

  useEffect(() => {
    if (session && !profile) void loadProfile();
  }, [session, profile, loadProfile]);

  if (!hydrated || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center text-brand-600">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const count = cartCount(cartItems);
  const name = profile?.full_name ?? profile?.username ?? session.user.email;

  return (
    <div className={clsx('flex flex-col bg-slate-50 dark:bg-slate-950', fullHeight ? 'h-screen' : 'min-h-screen')}>
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link href="/feed" className="text-xl font-extrabold tracking-tight text-brand-600">
            Uninet
          </Link>
          <nav className="hidden flex-1 items-center gap-1 md:flex">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={clsx(
                  'relative rounded-lg px-3 py-2 text-sm font-medium transition',
                  pathname.startsWith(item.href)
                    ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                )}
              >
                {item.label}
                {item.href === '/chat' && unread > 0 && (
                  <span className="ml-1 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white">{unread}</span>
                )}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 md:ml-0">
            <button
              type="button"
              onClick={() => setCartOpen(true)}
              className="relative rounded-lg p-2 text-lg hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label="Open cart"
            >
              🛒
              {count > 0 && (
                <span className="absolute -right-1 -top-1 rounded-full bg-brand-600 px-1.5 text-[10px] font-bold text-white">{count}</span>
              )}
            </button>
            <Avatar src={profile?.avatar_url} name={name} size={32} />
            <Button variant="ghost" size="sm" onClick={() => {
                chatClient.stop();
                useChatStore.getState().reset();
                void logout().then(() => router.replace('/login'));
              }}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className={clsx('mx-auto w-full max-w-6xl flex-1 px-4 pb-20 pt-4 md:pb-6', fullHeight && 'min-h-0 overflow-hidden')}>{children}</main>

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 md:hidden">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={clsx(
              'relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium',
              pathname.startsWith(item.href) ? 'text-brand-600' : 'text-slate-500',
            )}
          >
            <span className="text-lg leading-none">{item.icon}</span>
            {item.label}
            {item.href === '/chat' && unread > 0 && (
              <span className="absolute right-4 top-1 rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">{unread}</span>
            )}
          </Link>
        ))}
      </nav>
    </div>
  );
}
