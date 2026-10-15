'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuthStore } from '@/store/authStore';

export default function LoginPage() {
  const router = useRouter();
  const { login, loading, error, clearError, session, hydrated } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (hydrated && session) router.replace('/feed');
  }, [hydrated, session, router]);

  useEffect(() => clearError, [clearError]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (await login(email.trim(), password)) router.replace('/feed');
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
      <h2 className="text-xl font-semibold">Welcome back</h2>
      <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
      <Input label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}
      <Button type="submit" className="w-full" size="lg" loading={loading}>
        Sign in
      </Button>
      <div className="flex justify-between text-sm">
        <Link href="/verify-otp" className="text-brand-600 hover:underline">
          Sign in with a code
        </Link>
        <Link href="/register" className="text-brand-600 hover:underline">
          Create an account
        </Link>
      </div>
    </form>
  );
}
