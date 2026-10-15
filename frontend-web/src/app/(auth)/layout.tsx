import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 via-white to-pink-50 p-4 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-xl dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-extrabold tracking-tight text-brand-600">Uninet</h1>
          <p className="mt-1 text-sm text-slate-500">Social · Chat · Shop · Watch · AI</p>
        </div>
        {children}
      </div>
    </div>
  );
}
