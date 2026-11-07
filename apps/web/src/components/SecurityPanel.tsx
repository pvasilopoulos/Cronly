'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface TfaStatus {
  enabled: boolean;
  pending: boolean;
}
interface SetupResponse {
  secret: string;
  otpauthUri: string;
}

export function SecurityPanel() {
  const { logout } = useAuth();
  const [status, setStatus] = useState<TfaStatus | null>(null);
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api<TfaStatus>('/auth/2fa', { tenant: false }));
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function startSetup() {
    setBusy(true);
    setError(null);
    try {
      setSetup(await api<SetupResponse>('/auth/2fa/setup', { method: 'POST', tenant: false }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start setup');
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnable(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ backupCodes: string[] }>('/auth/2fa/enable', {
        method: 'POST',
        body: { code: code.trim() },
        tenant: false,
      });
      setBackupCodes(res.backupCodes);
      setSetup(null);
      setCode('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invalid code');
    } finally {
      setBusy(false);
    }
  }

  async function confirmDisable(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/2fa/disable', { method: 'POST', body: { code: code.trim() }, tenant: false });
      setDisabling(false);
      setCode('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Invalid code');
    } finally {
      setBusy(false);
    }
  }

  async function signOutEverywhere() {
    try {
      await api('/auth/logout-all', { method: 'POST', tenant: false });
    } finally {
      logout();
    }
  }

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-faint">Security</h2>

      {/* Two-factor */}
      <div className="mb-5">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Two-factor authentication (TOTP)</p>
            <p className="text-xs text-muted">An authenticator app code is required at every sign-in.</p>
          </div>
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              status?.enabled ? 'bg-ok/15 text-ok' : 'bg-surface2 text-muted'
            }`}
          >
            {status?.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>

        {/* Freshly generated backup codes — shown once. */}
        {backupCodes && (
          <div className="mb-3 rounded-lg border border-line bg-surface2 p-3">
            <p className="mb-2 text-xs font-semibold text-warn">
              Save these backup codes now — they are shown only once.
            </p>
            <div className="grid grid-cols-2 gap-1 font-mono text-sm">
              {backupCodes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            <button
              onClick={() => setBackupCodes(null)}
              className="mt-3 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110"
            >
              I’ve saved them
            </button>
          </div>
        )}

        {/* Enrolment in progress */}
        {setup && (
          <form onSubmit={confirmEnable} className="rounded-lg border border-line bg-surface2 p-3">
            <p className="mb-2 text-xs text-muted">
              Add this key to your authenticator app (Google Authenticator, 1Password, Authy), then
              enter the 6-digit code it shows.
            </p>
            <div className="mb-2">
              <p className="text-[11px] uppercase tracking-wide text-faint">Setup key</p>
              <code className="block break-all rounded bg-surface px-2 py-1 font-mono text-sm">{setup.secret}</code>
            </div>
            <details className="mb-3 text-xs text-faint">
              <summary className="cursor-pointer">otpauth URI</summary>
              <code className="mt-1 block break-all font-mono">{setup.otpauthUri}</code>
            </details>
            <div className="flex items-center gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                className="w-32 rounded-lg border border-line bg-surface px-3 py-2 text-center font-mono tracking-widest outline-none focus:border-accent"
              />
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
              >
                Verify & enable
              </button>
              <button type="button" onClick={() => { setSetup(null); setCode(''); setError(null); }} className="text-xs text-faint hover:text-accent-fg">
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* Disable confirmation */}
        {disabling && (
          <form onSubmit={confirmDisable} className="rounded-lg border border-line bg-surface2 p-3">
            <p className="mb-2 text-xs text-muted">Enter a current code (or a backup code) to turn off 2FA.</p>
            <div className="flex items-center gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                className="w-32 rounded-lg border border-line bg-surface px-3 py-2 text-center font-mono tracking-widest outline-none focus:border-accent"
              />
              <button type="submit" disabled={busy} className="rounded-lg bg-err px-3 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60">
                Disable 2FA
              </button>
              <button type="button" onClick={() => { setDisabling(false); setCode(''); setError(null); }} className="text-xs text-faint hover:text-accent-fg">
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* Primary action */}
        {!setup && !disabling && !backupCodes && (
          status?.enabled ? (
            <button onClick={() => setDisabling(true)} className="rounded-lg border border-line px-3 py-2 text-sm font-medium hover:border-err hover:text-err">
              Disable two-factor
            </button>
          ) : (
            <button onClick={startSetup} disabled={busy} className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60">
              {busy ? 'Starting…' : 'Enable two-factor'}
            </button>
          )
        )}

        {error && <p className="mt-2 rounded-lg bg-err/10 px-3 py-2 text-sm text-err">{error}</p>}
      </div>

      {/* Sessions */}
      <div className="border-t border-line pt-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Active sessions</p>
            <p className="text-xs text-muted">Revoke every refresh session and sign out on all devices.</p>
          </div>
          <button onClick={signOutEverywhere} className="rounded-lg border border-line px-3 py-2 text-sm font-medium hover:border-err hover:text-err">
            Sign out everywhere
          </button>
        </div>
      </div>
    </section>
  );
}
