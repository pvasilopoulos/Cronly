'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { useAppConfig, BrandMark } from '@/lib/appConfig';
import { ApiError } from '@/lib/api';

export default function LoginPage() {
  const { login, completeMfa, user, ready } = useAuth();
  const { config } = useAppConfig();
  const router = useRouter();
  const [email, setEmail] = useState('petros@acme.gr');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // When set, the password step passed and a TOTP code is required.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');

  useEffect(() => {
    if (ready && user) router.replace('/jobs');
  }, [ready, user, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await login(email, password);
      if (res.status === 'mfa') {
        setMfaToken(res.mfaToken);
      } else {
        router.replace('/jobs');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(e: React.FormEvent) {
    e.preventDefault();
    if (!mfaToken) return;
    setBusy(true);
    setError(null);
    try {
      await completeMfa(mfaToken, code.trim());
      router.replace('/jobs');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <BrandMark config={config} size="h-10 w-10" rounded="rounded-xl" textClass="text-lg" />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold leading-none">{config.name}</h1>
            <p className="text-xs text-faint">Console</p>
          </div>
        </div>

        {!mfaToken ? (
          <form
            onSubmit={submit}
            className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-sm"
          >
            <h2 className="text-lg font-semibold">Sign in</h2>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-muted">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="rounded-lg border border-line bg-surface2 px-3 py-2 outline-none focus:border-accent"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-muted">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="rounded-lg border border-line bg-surface2 px-3 py-2 outline-none focus:border-accent"
              />
            </label>

            {error && <p className="rounded-lg bg-err/10 px-3 py-2 text-sm text-err">{error}</p>}

            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-accent py-2.5 font-semibold text-white hover:brightness-110 disabled:opacity-60"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>

            <div className="flex items-center justify-between text-xs text-faint">
              <Link href="/forgot-password" className="hover:text-accent-fg">
                Forgot password?
              </Link>
              <span>Demo: petros@acme.gr / petros1234</span>
            </div>
          </form>
        ) : (
          <form
            onSubmit={submitMfa}
            className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-sm"
          >
            <h2 className="text-lg font-semibold">Two-factor authentication</h2>
            <p className="text-sm text-muted">
              Enter the 6-digit code from your authenticator app, or a backup code.
            </p>

            <input
              autoFocus
              inputMode="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              required
              className="rounded-lg border border-line bg-surface2 px-3 py-2 text-center font-mono text-lg tracking-widest outline-none focus:border-accent"
            />

            {error && <p className="rounded-lg bg-err/10 px-3 py-2 text-sm text-err">{error}</p>}

            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-accent py-2.5 font-semibold text-white hover:brightness-110 disabled:opacity-60"
            >
              {busy ? 'Verifying…' : 'Verify'}
            </button>

            <button
              type="button"
              onClick={() => {
                setMfaToken(null);
                setCode('');
                setError(null);
              }}
              className="text-center text-xs text-faint hover:text-accent-fg"
            >
              ← Back to sign in
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
