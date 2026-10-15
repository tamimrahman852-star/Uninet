'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuthStore } from '@/store/authStore';

export default function VerifyOtpPage() {
  const router = useRouter();
  const { sendOtp, verifyOtp, loading, error, clearError } = useAuthStore();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => clearError, [clearError]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function onSend(event: FormEvent) {
    event.preventDefault();
    if (await sendOtp(email.trim())) {
      setSent(true);
      setCooldown(30);
    }
  }

  async function onVerify(event: FormEvent) {
    event.preventDefault();
    if (await verifyOtp(email.trim(), code.trim())) router.replace('/feed');
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Sign in with a code</h2>
      {!sent ? (
        <form onSubmit={(e) => void onSend(e)} className="space-y-4">
          <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          <Button type="submit" className="w-full" size="lg" loading={loading}>
            Send code
          </Button>
        </form>
      ) : (
        <form onSubmit={(e) => void onVerify(e)} className="space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Enter the code we sent to <strong>{email}</strong>.
          </p>
          <Input
            label="6-digit code"
            inputMode="numeric"
            pattern="\d{6,8}"
            maxLength={8}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            required
            autoComplete="one-time-code"
          />
          <Button type="submit" className="w-full" size="lg" loading={loading}>
            Verify and sign in
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            disabled={cooldown > 0 || loading}
            onClick={() => {
              void sendOtp(email.trim()).then((ok) => ok && setCooldown(30));
            }}
          >
            {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}
      <p className="text-center text-sm">
        <Link href="/login" className="text-brand-600 hover:underline">
          Use your password instead
        </Link>
      </p>
    </div>
  );
}
