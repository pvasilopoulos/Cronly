'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

interface ForgotResponse {
  ok: boolean;
  devLink?: string;
}

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<ForgotResponse>('/auth/forgot-password', {
        method: 'POST',
        body: { email },
        tenant: false,
      });
      setSent(true);
      setDevLink(res.devLink ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-xl font-bold">Reset your password</h1>

        {sent ? (
          <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-sm">
            <p className="text-sm text-muted">
              If an account exists for <span className="font-medium text-fg">{email}</span>, a
              password-reset link has been sent. Check your inbox.
            </p>
            {devLink && (
              <div className="rounded-lg bg-warn/10 p-3 text-xs">
                <p className="mb-1 font-semibold text-warn">Dev mode — no mailer configured:</p>
                <Link href={devLink.replace(/^https?:\/\/[^/]+/, '')} className="break-all font-mono text-accent-fg underline">
                  {devLink}
                </Link>
              </div>
            )}
            <Link href="/login" className="text-center text-sm text-accent-fg hover:underline">
              ← Back to sign in
            </Link>
          </div>
        ) : (
          <form
            onSubmit={submit}
            className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-sm"
          >
            <p className="text-sm text-muted">
              Enter your email and we’ll send you a link to reset your password.
            </p>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-muted">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                className="rounded-lg border border-line bg-surface2 px-3 py-2 outline-none focus:border-accent"
              />
            </label>
            {error && <p className="rounded-lg bg-err/10 px-3 py-2 text-sm text-err">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-accent py-2.5 font-semibold text-white hover:brightness-110 disabled:opacity-60"
            >
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
            <Link href="/login" className="text-center text-xs text-faint hover:text-accent-fg">
              ← Back to sign in
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}
