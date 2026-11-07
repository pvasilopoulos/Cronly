'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

function ResetForm() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/reset-password', {
        method: 'POST',
        body: { token, password },
        tenant: false,
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reset failed');
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <div className="rounded-2xl border border-line bg-surface p-6 text-sm text-muted shadow-sm">
        This reset link is missing its token.{' '}
        <Link href="/forgot-password" className="text-accent-fg hover:underline">
          Request a new one
        </Link>
        .
      </div>
    );
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <p className="text-sm text-muted">
          Your password has been changed and all existing sessions were signed out.
        </p>
        <Link
          href="/login"
          className="rounded-lg bg-accent py-2.5 text-center font-semibold text-white hover:brightness-110"
        >
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-sm"
    >
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-muted">New password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          autoFocus
          className="rounded-lg border border-line bg-surface2 px-3 py-2 outline-none focus:border-accent"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-muted">Confirm password</span>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          minLength={8}
          className="rounded-lg border border-line bg-surface2 px-3 py-2 outline-none focus:border-accent"
        />
      </label>
      {error && <p className="rounded-lg bg-err/10 px-3 py-2 text-sm text-err">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-accent py-2.5 font-semibold text-white hover:brightness-110 disabled:opacity-60"
      >
        {busy ? 'Saving…' : 'Set new password'}
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-xl font-bold">Choose a new password</h1>
        <Suspense fallback={<div className="text-sm text-muted">Loading…</div>}>
          <ResetForm />
        </Suspense>
      </div>
    </div>
  );
}
