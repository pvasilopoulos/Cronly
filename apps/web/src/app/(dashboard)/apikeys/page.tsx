'use client';
import { useMemo, useState } from 'react';
import useSWR, { mutate as globalMutate } from 'swr';
import { api, fetcher } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import type { ApiKey, ApiKeyCreated, PermissionDef } from '@/lib/types';
import { Spinner, EmptyState } from '@/components/ui';
import { fmtAgo } from '@/lib/format';

function keyState(k: ApiKey): { label: string; cls: string } {
  if (k.revokedAt) return { label: 'revoked', cls: 'bg-err/15 text-err' };
  if (k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now())
    return { label: 'expired', cls: 'bg-warn/15 text-warn' };
  return { label: 'active', cls: 'bg-ok/15 text-ok' };
}

export default function ApiKeysPage() {
  const { can } = usePermissions();
  const canManage = can('apikeys:manage');
  const { data: keys, isLoading } = useSWR<ApiKey[]>('/api-keys', () => fetcher<ApiKey[]>('/api-keys'));
  const [creating, setCreating] = useState(false);

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold md:text-2xl">API Keys</h1>
          <p className="text-sm text-muted">Programmatic access to the CronApp REST API</p>
        </div>
        {canManage && (
          <button
            onClick={() => setCreating(true)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            ＋ New Key
          </button>
        )}
      </header>

      <div className="mb-4 rounded-xl border border-accent/30 bg-accent-soft/60 p-3 text-sm text-accent-fg">
        🔑 Authenticate requests with{' '}
        <code className="rounded bg-surface2 px-1 py-0.5 font-mono text-[12px]">
          Authorization: Bearer cak_…
        </code>
        . A key carries its own tenant and scopes — no{' '}
        <code className="font-mono">x-tenant-id</code> header needed. Full reference at{' '}
        <a href="/api/docs" target="_blank" rel="noreferrer" className="font-medium underline">
          /api/docs
        </a>
        .
      </div>

      {isLoading ? (
        <Spinner />
      ) : !keys || keys.length === 0 ? (
        <EmptyState
          title="No API keys"
          hint={canManage ? 'Create a scoped key to call the API from your own code.' : undefined}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface2 text-left text-xs uppercase tracking-wide text-faint">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Name</th>
                <th className="px-4 py-2.5 font-semibold">Key</th>
                <th className="px-4 py-2.5 font-semibold">Scopes</th>
                <th className="px-4 py-2.5 font-semibold">Last used</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const st = keyState(k);
                return (
                  <tr key={k.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-3">
                      <span className="font-medium">{k.name}</span>
                      {k.expiresAt && (
                        <span className="block text-[11px] text-faint">
                          expires {fmtAgo(k.expiresAt)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <code className="font-mono text-faint">{k.prefix}…</code>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-faint">{k.scopes.length} scope(s)</span>
                    </td>
                    <td className="px-4 py-3 text-faint">
                      {k.lastUsedAt ? fmtAgo(k.lastUsedAt) : 'never'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${st.cls}`}>
                        {st.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canManage && (
                        <div className="flex justify-end gap-3">
                          {!k.revokedAt && (
                            <ActionButton
                              label="Revoke"
                              confirmLabel="Revoke"
                              className="text-warn"
                              run={() => api(`/api-keys/${k.id}/revoke`, { method: 'POST' })}
                            />
                          )}
                          <ActionButton
                            label="Delete"
                            confirmLabel="Delete"
                            className="text-err"
                            run={() => api(`/api-keys/${k.id}`, { method: 'DELETE' })}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && <KeyEditor onClose={() => setCreating(false)} />}
    </div>
  );
}

function ActionButton({
  label,
  confirmLabel,
  className,
  run,
}: {
  label: string;
  confirmLabel: string;
  className: string;
  run: () => Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      await run();
      globalMutate('/api-keys');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }
  if (!confirming)
    return (
      <button onClick={() => setConfirming(true)} className={`text-xs font-medium hover:underline ${className}`}>
        {label}
      </button>
    );
  return (
    <span className="flex items-center gap-2 text-xs">
      <button onClick={go} disabled={busy} className={`font-medium hover:underline disabled:opacity-60 ${className}`}>
        {busy ? '…' : confirmLabel}
      </button>
      <button onClick={() => setConfirming(false)} className="font-medium text-muted hover:underline">
        Cancel
      </button>
    </span>
  );
}

const EXPIRY_OPTIONS: { label: string; days: number | null }[] = [
  { label: 'Never', days: null },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
];

function KeyEditor({ onClose }: { onClose: () => void }) {
  const { data: perms } = usePermissions();
  // Only offer scopes the current user actually holds — the API rejects the rest.
  const catalog = useMemo(() => perms?.catalog ?? [], [perms]);
  const held = useMemo(() => new Set(perms?.keys ?? []), [perms]);
  const grantable = useMemo(() => catalog.filter((d) => held.has(d.key)), [catalog, held]);
  const byResource = useMemo(() => groupByResource(grantable), [grantable]);

  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expiryDays, setExpiryDays] = useState<number | null>(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [copied, setCopied] = useState(false);

  function toggle(key: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name, scopes: [...selected] };
      if (expiryDays !== null) {
        body.expiresAt = new Date(Date.now() + expiryDays * 86400_000).toISOString();
      }
      const key = await api<ApiKeyCreated>('/api-keys', { method: 'POST', body });
      globalMutate('/api-keys');
      setCreated(key); // switch the modal to the "copy your token" view
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/45" onClick={created ? onClose : undefined} />
      <div className="relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="border-b border-line p-5">
          <h2 className="text-lg font-semibold">{created ? 'Key created' : 'New API key'}</h2>
        </div>

        {created ? (
          <div className="flex flex-col gap-4 p-5">
            <div className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm text-warn">
              ⚠️ Copy this token now — it is shown <b>only once</b> and cannot be retrieved later.
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-line bg-surface2 px-3 py-2 font-mono text-[13px]">
                {created.token}
              </code>
              <button
                onClick={copyToken}
                className="flex-none rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:brightness-110"
              >
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
            <p className="text-xs text-faint">
              Use it as <code className="font-mono">Authorization: Bearer {created.prefix}…</code> with{' '}
              {created.scopes.length} scope(s).
            </p>
            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-5">
              <div className="mb-4">
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-faint">
                  Name
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="CI deploy bot"
                  className="w-full rounded-lg border border-line bg-surface2 px-3 py-2 outline-none focus:border-accent"
                />
              </div>

              <div className="mb-4">
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-faint">
                  Expires
                </label>
                <div className="flex flex-wrap gap-2">
                  {EXPIRY_OPTIONS.map((o) => (
                    <button
                      key={o.label}
                      onClick={() => setExpiryDays(o.days)}
                      className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
                        expiryDays === o.days
                          ? 'border-accent bg-accent-soft text-accent-fg'
                          : 'border-line hover:border-faint'
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-faint">
                    Scopes
                  </span>
                  <span className="text-[11px] text-faint">{selected.size} selected</span>
                </div>
                {grantable.length === 0 ? (
                  <p className="text-sm text-faint">You hold no permissions to grant.</p>
                ) : (
                  Object.entries(byResource).map(([resource, defs]) => (
                    <div key={resource} className="mb-3">
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
                        {resource}
                      </p>
                      <div className="flex flex-col gap-1">
                        {defs.map((d) => (
                          <label
                            key={d.key}
                            className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface2"
                          >
                            <input
                              type="checkbox"
                              checked={selected.has(d.key)}
                              onChange={() => toggle(d.key)}
                              className="h-4 w-4 accent-accent"
                            />
                            <span className="text-sm">{d.label}</span>
                            <code className="ml-auto font-mono text-[10px] text-faint">{d.key}</code>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-line p-4">
              {error ? <span className="text-xs text-err">{error}</span> : <span />}
              <div className="flex gap-2">
                <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm font-medium">
                  Cancel
                </button>
                <button
                  onClick={save}
                  disabled={busy || !name || selected.size === 0}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
                >
                  {busy ? 'Creating…' : 'Create key'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function groupByResource(catalog: PermissionDef[]): Record<string, PermissionDef[]> {
  const out: Record<string, PermissionDef[]> = {};
  for (const d of catalog) (out[d.resource] ??= []).push(d);
  return out;
}
