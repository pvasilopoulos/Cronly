'use client';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { api, ApiError, fetcher } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { SmtpSettings, MailProvider } from '@/lib/types';

const inputCls =
  'w-full rounded-lg border border-line bg-surface2 px-3 py-2 text-sm outline-none focus:border-accent';

const PROVIDERS: { key: MailProvider; label: string; blurb: string }[] = [
  { key: 'smtp', label: 'SMTP', blurb: 'Any SMTP server (host, port, credentials).' },
  { key: 'microsoft365', label: 'Microsoft 365', blurb: 'Microsoft Graph, app-only OAuth — no password.' },
  { key: 'gmail', label: 'Gmail / Workspace', blurb: 'Gmail API via a service account — no password.' },
];

/**
 * Instance email delivery, editable only by a super-admin. Supports classic SMTP
 * plus native Microsoft 365 (Graph) and Gmail (service-account) connectors. All
 * secrets are stored encrypted and never returned (write-only).
 */
export function SmtpPanel() {
  const { user } = useAuth();
  const canEdit = !!user?.isSuperAdmin;
  const { data, mutate } = useSWR<SmtpSettings>(canEdit ? '/smtp' : null, () => fetcher<SmtpSettings>('/smtp'));

  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<MailProvider>('smtp');
  const [fromAddr, setFromAddr] = useState('');
  // SMTP
  const [host, setHost] = useState('');
  const [port, setPort] = useState(587);
  const [secure, setSecure] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  // Microsoft 365
  const [msTenantId, setMsTenantId] = useState('');
  const [msClientId, setMsClientId] = useState('');
  const [msClientSecret, setMsClientSecret] = useState('');
  const [clearMsSecret, setClearMsSecret] = useState(false);
  // Gmail
  const [gmailServiceAccount, setGmailServiceAccount] = useState('');
  const [clearGmailKey, setClearGmailKey] = useState(false);

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setProvider(data.provider);
    setFromAddr(data.fromAddr ?? '');
    setHost(data.host ?? '');
    setPort(data.port);
    setSecure(data.secure);
    setUsername(data.username ?? '');
    setPassword('');
    setClearPassword(false);
    setMsTenantId(data.msTenantId ?? '');
    setMsClientId(data.msClientId ?? '');
    setMsClientSecret('');
    setClearMsSecret(false);
    setGmailServiceAccount('');
    setClearGmailKey(false);
  }, [data]);

  useEffect(() => {
    if (user?.email && !testTo) setTestTo(user.email);
  }, [user?.email]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!canEdit) return null;

  // SMTP relay presets (host/port/TLS). Gmail & M365 are separate providers now.
  const SMTP_PRESETS = [
    { label: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, secure: false },
    { label: 'Mailgun', host: 'smtp.mailgun.org', port: 587, secure: false },
    { label: 'Postmark', host: 'smtp.postmarkapp.com', port: 587, secure: false },
  ];

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { enabled, provider, fromAddr: fromAddr || null };
      if (provider === 'smtp') {
        body.host = host || null;
        body.port = port;
        body.secure = secure;
        body.username = username || null;
        if (clearPassword) body.clearPassword = true;
        else if (password) body.password = password;
      } else if (provider === 'microsoft365') {
        body.msTenantId = msTenantId || null;
        body.msClientId = msClientId || null;
        if (clearMsSecret) body.clearMsSecret = true;
        else if (msClientSecret) body.msClientSecret = msClientSecret;
      } else if (provider === 'gmail') {
        if (clearGmailKey) body.clearGmailKey = true;
        else if (gmailServiceAccount.trim()) body.gmailServiceAccount = gmailServiceAccount;
      }
      await api('/smtp', { method: 'PATCH', body });
      await mutate();
      setSavedAt(Date.now());
      setPassword('');
      setMsClientSecret('');
      setGmailServiceAccount('');
      setClearPassword(false);
      setClearMsSecret(false);
      setClearGmailKey(false);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save email settings');
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await api<{ mode: string; provider: string; to: string }>('/smtp/test', {
        method: 'POST',
        body: { to: testTo },
      });
      setTestMsg({
        tone: 'ok',
        text:
          res.mode === 'sent'
            ? `Test email sent to ${res.to} via ${res.provider}.`
            : `Dry-run: composed a test for ${res.to} but email isn’t configured, so nothing was sent.`,
      });
    } catch (e) {
      setTestMsg({ tone: 'err', text: e instanceof ApiError ? e.message : 'Test failed' });
    } finally {
      setTesting(false);
    }
  }

  const status = data?.effectiveConfigured
    ? { tone: 'ok' as const, text: `Active — delivering via ${providerLabel(data.provider)}.` }
    : data?.provider === 'smtp' && data?.envFallback
      ? { tone: 'ok' as const, text: 'Using SMTP_* environment variables.' }
      : { tone: 'warn' as const, text: 'Not configured — emails run in dry-run (composed and logged, not sent).' };

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-faint">Email delivery</h2>
        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-fg">
          Super-admin
        </span>
      </div>
      <p className="mb-3 text-xs text-muted">
        How CronApp sends failure alerts, heartbeat misses and the email job handler. Applies to the whole
        instance. Secrets are stored encrypted and never shown again.
      </p>

      <div
        className={`mb-4 rounded-lg border px-3 py-2 text-xs ${
          status.tone === 'ok' ? 'border-ok/30 bg-ok/10 text-ok' : 'border-warn/30 bg-warn/10 text-warn'
        }`}
      >
        {status.text}
      </div>

      <label className="mb-3 flex cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-surface2/50 px-3 py-2.5">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-accent" />
        <div>
          <span className="text-sm font-medium">Enable instance email delivery</span>
          <p className="text-[11px] text-faint">When off, the instance falls back to SMTP_* env vars (or dry-run).</p>
        </div>
      </label>

      {/* Provider selector */}
      <div className="mb-4">
        <span className="mb-1.5 block text-[11px] font-medium text-faint">Provider</span>
        <div className="grid gap-2 sm:grid-cols-3">
          {PROVIDERS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setProvider(p.key)}
              className={`rounded-lg border px-3 py-2 text-left text-sm ${
                provider === p.key ? 'border-accent bg-accent-soft/40' : 'border-line bg-surface2/50 hover:border-faint'
              }`}
            >
              <span className="font-medium">{p.label}</span>
              <p className="text-[10px] text-faint">{p.blurb}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Shared: From address */}
      <label className="mb-3 flex flex-col gap-1 text-sm">
        <span className="font-medium text-muted">{provider === 'smtp' ? 'From address' : 'Send as (From address)'}</span>
        <input value={fromAddr} onChange={(e) => setFromAddr(e.target.value)} placeholder="cronapp@yourdomain.com" className={inputCls} />
        {provider !== 'smtp' && (
          <span className="text-[11px] text-faint">The mailbox the connector sends as (and impersonates).</span>
        )}
      </label>

      {provider === 'smtp' && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-faint">Quick setup:</span>
            {SMTP_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => { setHost(p.host); setPort(p.port); setSecure(p.secure); setEnabled(true); }}
                className="rounded-full border border-line bg-surface2 px-2.5 py-1 text-[11px] font-medium hover:border-accent"
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              <span className="font-medium text-muted">Host</span>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.yourprovider.com" className={inputCls} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-muted">Port</span>
              <input type="number" value={port} onChange={(e) => setPort(parseInt(e.target.value || '587', 10))} min={1} max={65535} className={inputCls} />
            </label>
            <label className="flex cursor-pointer items-center gap-2.5 self-end rounded-lg border border-line bg-surface2/50 px-3 py-2.5 text-sm">
              <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} className="h-4 w-4 accent-accent" />
              <span>TLS (SSL on connect — port 465)</span>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-muted">Username</span>
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="apikey / user" className={inputCls} autoComplete="off" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-muted">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); if (e.target.value) setClearPassword(false); }}
                placeholder={data?.hasPassword ? '•••••••• (unchanged)' : 'SMTP password'}
                className={inputCls}
                autoComplete="new-password"
                disabled={clearPassword}
              />
              {data?.hasPassword && (
                <label className="flex items-center gap-1.5 text-[11px] text-faint">
                  <input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} className="h-3 w-3 accent-accent" />
                  Remove stored password
                </label>
              )}
            </label>
          </div>
        </>
      )}

      {provider === 'microsoft365' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <p className="text-[11px] text-faint sm:col-span-2">
            Register an app in Azure AD with the <b>Mail.Send</b> application permission (admin-consented), then paste its
            Directory (tenant) ID, Application (client) ID and a client secret.
          </p>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-muted">Tenant ID</span>
            <input value={msTenantId} onChange={(e) => setMsTenantId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-muted">Client ID</span>
            <input value={msClientId} onChange={(e) => setMsClientId(e.target.value)} placeholder="Application (client) ID" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="font-medium text-muted">Client secret</span>
            <input
              type="password"
              value={msClientSecret}
              onChange={(e) => { setMsClientSecret(e.target.value); if (e.target.value) setClearMsSecret(false); }}
              placeholder={data?.hasMsSecret ? '•••••••• (unchanged)' : 'Azure app client secret'}
              className={inputCls}
              autoComplete="new-password"
              disabled={clearMsSecret}
            />
            {data?.hasMsSecret && (
              <label className="flex items-center gap-1.5 text-[11px] text-faint">
                <input type="checkbox" checked={clearMsSecret} onChange={(e) => setClearMsSecret(e.target.checked)} className="h-3 w-3 accent-accent" />
                Remove stored secret
              </label>
            )}
          </label>
        </div>
      )}

      {provider === 'gmail' && (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] text-faint">
            Create a Google Cloud <b>service account</b>, enable the Gmail API, and grant it domain-wide delegation for the
            <code className="mx-1 rounded bg-surface2 px-1">gmail.send</code> scope. Paste its JSON key below; the “Send as”
            mailbox must be a user in your Workspace domain.
          </p>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-muted">Service account JSON</span>
            <textarea
              value={gmailServiceAccount}
              onChange={(e) => { setGmailServiceAccount(e.target.value); if (e.target.value) setClearGmailKey(false); }}
              rows={5}
              placeholder={data?.hasGmailKey ? '•••••••• (stored — paste new JSON to replace)' : '{ "type": "service_account", "client_email": "...", "private_key": "..." }'}
              className={`${inputCls} font-mono text-[11px]`}
              disabled={clearGmailKey}
            />
            {data?.gmailClientEmail && (
              <span className="text-[11px] text-faint">Stored account: {data.gmailClientEmail}</span>
            )}
            {data?.hasGmailKey && (
              <label className="flex items-center gap-1.5 text-[11px] text-faint">
                <input type="checkbox" checked={clearGmailKey} onChange={(e) => setClearGmailKey(e.target.checked)} className="h-3 w-3 accent-accent" />
                Remove stored key
              </label>
            )}
          </label>
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={save}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save email settings'}
        </button>
        {err && <span className="text-sm text-err">{err}</span>}
        {savedAt > 0 && !err && !saving && <span className="text-sm text-ok">Saved</span>}
      </div>

      {/* Send a test email */}
      <div className="mt-5 border-t border-line pt-4">
        <span className="text-xs font-medium text-muted">Send a test email</span>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" className={`${inputCls} max-w-xs`} />
          <button
            type="button"
            disabled={testing || !testTo}
            onClick={sendTest}
            className="rounded-lg border border-line bg-surface2 px-3 py-2 text-sm font-medium hover:border-accent disabled:opacity-50"
          >
            {testing ? 'Sending…' : 'Send test'}
          </button>
        </div>
        {testMsg && <p className={`mt-2 text-xs ${testMsg.tone === 'ok' ? 'text-ok' : 'text-err'}`}>{testMsg.text}</p>}
        <p className="mt-1 text-[11px] text-faint">Uses the currently-saved settings. Save first to test new values.</p>
      </div>
    </section>
  );
}

function providerLabel(p: MailProvider): string {
  return p === 'microsoft365' ? 'Microsoft 365' : p === 'gmail' ? 'Gmail' : 'SMTP';
}
