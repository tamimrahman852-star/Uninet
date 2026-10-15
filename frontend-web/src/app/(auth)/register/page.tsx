'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuthStore } from '@/store/authStore';

export default function RegisterPage() {
  const router = useRouter();
  const { register, loading, error, clearError } = useAuthStore();
  const [form, setForm] = useState({ full_name: '', username: '', email: '', password: '' });
  const [confirmationSent, setConfirmationSent] = useState(false);

  useEffect(() => clearError, [clearError]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const result = await register({
      email: form.email.trim(),
      password: form.password,
      full_name: form.full_name.trim() || undefined,
      username: form.username.trim().toLowerCase() || undefined,
    });
    if (!result.ok) return;
    if (result.needsConfirmation) setConfirmationSent(true);
    else router.replace('/feed');
  }

  if (confirmationSent) {
    return (
      <div className="space-y-4 text-center">
        <h2 className="text-xl font-semibold">Check your email</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          We sent a confirmation link to <strong>{form.email}</strong>. Open it, then sign in.
        </p>
        <Link href="/login" className="inline-block text-sm text-brand-600 hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
      <h2 className="text-xl font-semibold">Create your account</h2>
      <Input label="Full name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} autoComplete="name" />
      <Input
        label="Username"
        value={form.username}
        onChange={(e) => setForm({ ...form, username: e.target.value })}
        pattern="[A-Za-z0-9_]{3,30}"
        title="3-30 letters, numbers or underscores"
        autoComplete="username"
      />
      <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required autoComplete="email" />
      <Input
        label="Password"
        type="password"
        value={form.password}
        onChange={(e) => setForm({ ...form, password: e.target.value })}
        required
        minLength={10}
        autoComplete="new-password"
      />
      <p className="text-xs text-slate-500">At least 10 characters with a letter and a number.</p>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}
      <Button type="submit" className="w-full" size="lg" loading={loading}>
        Create account
      </Button>
      <p className="text-center text-sm">
        Already have an account?{' '}
        <Link href="/login" className="text-brand-600 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
