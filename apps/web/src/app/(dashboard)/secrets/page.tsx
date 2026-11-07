'use client';
import { useState } from 'react';
import useSWR, { mutate as globalMutate } from 'swr';
import { api, fetcher } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import type { Secret } from '@/lib/types';
import { Spinner, EmptyState } from '@/components/ui';
import { fmtAgo } from '@/lib/format';

const NAME_RE = /^[A-Za-z0-9_.\-]+$/;

export default function SecretsPage() {
  const { can } = usePermissions();
  const { data: secrets, isLoading } = useSWR<Secret[]>('/secrets', () => fetcher<Secret[]>('/secrets'));
  const [editing, setEditing] = useState<Secret | null>(null);
  const [creating, setCreating] = useState(false);
  const canManage = can('secrets:manage');

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold md:text-2xl">Secrets</h1>
          <p className="text-sm text-muted">Encrypted credentials for your jobs</p>
        </div>
        {canManage && (
          <button
            onClick={() => setCreating(true)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            ＋ New Secret
          </button>
        )}
      </header>

      <div className="mb-4 rounded-xl border border-accent/30 bg-accent-soft/60 p-3 text-sm text-accent-fg">
        🔐 Values are encrypted at rest (AES-256-GCM) and never leave the server in plaintext — not
        even here. Reference a secret from a job payload as{' '}
        <code className="rounded bg-surface2 px-1 py-0.5 font-mono text-[12px]">
          {'{{secret:NAME}}'}
        </code>
        ; the worker injects it only at run time.
      </div>

      {isLoading ? (
        <Spinner />
      ) : !secrets || secrets.length === 0 ? (
        <EmptyState
          title="No secrets yet"
          hint={canManage ? 'Create one to reference it from job headers or bodies.' : undefined}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface2 text-left text-xs uppercase tracking-wide text-faint">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Name</th>
                <th className="px-4 py-2.5 font-semibold">Value</th>
                <th className="px-4 py-2.5 font-semibold">Updated</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {secrets.map((s) => (
                <tr key={s.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-3">
                    <code className="font-mono text-[13px] font-medium">{s.name}</code>
                  </td>
                  <td className="px-4 py-3 font-mono text-faint">{s.hint ?? '••••'}</td>
                  <td className="px-4 py-3 text-faint">{fmtAgo(s.updatedAt)}</td>
                  <td className="px-4 py-3 text-right">
                    {canManage && (
                      <div className="flex justify-end gap-3">
                        <button
                          onClick={() => setEditing(s)}
                          className="text-xs font-medium text-accent-fg hover:underline"
                        >
                          Rotate
                        </button>
                        <DeleteButton name={s.name} />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(editing || creating) && (
        <SecretEditor
          secret={editing}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

function DeleteButton({ name }: { name: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    try {
      await api(`/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
      globalMutate('/secrets');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }
  if (!confirming)
    return (
      <button onClick={() => setConfirming(true)} className="text-xs font-medium text-err hover:underline">
        Delete
      </button>
    );
  return (
    <span className="flex items-center gap-2 text-xs">
      <span className="text-faint">Sure?</span>
      <button onClick={remove} disabled={busy} className="font-medium text-err hover:underline disabled:opacity-60">
        {busy ? '…' : 'Yes'}
      </button>
      <button onClick={() => setConfirming(false)} className="font-medium text-muted hover:underline">
        No
      </button>
    </span>
  );
}

function SecretEditor({ secret, onClose }: { secret: Secret | null; onClose: () => void }) {
  const rotating = !!secret;
  const [name, setName] = useState(secret?.name ?? '');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameValid = NAME_RE.test(name);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api('/secrets', { method: 'POST', body: { name, value } });
      globalMutate('/secrets');
      onClose();
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="border-b border-line p-5">
          <h2 className="text-lg font-semibold">{rotating ? `Rotate “${secret!.name}”` : 'New secret'}</h2>
        </div>
        <div className="flex flex-col gap-3 p-5">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-faint">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={rotating}
              placeholder="STRIPE_API_KEY"
              className="w-full rounded-lg border border-line bg-surface2 px-3 py-2 font-mono text-sm outline-none focus:border-accent disabled:opacity-60"
            />
            {name && !nameValid && (
              <p className="mt-1 text-xs text-err">Letters, digits, and . _ - only.</p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-faint">
              Value
            </label>
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={rotating ? 'Enter a new value…' : 'Paste the secret value…'}
              rows={3}
              className="w-full resize-none rounded-lg border border-line bg-surface2 px-3 py-2 font-mono text-sm outline-none focus:border-accent"
            />
            <p className="mt-1 text-xs text-faint">
              Encrypted immediately. Once saved it cannot be read back — only rotated or deleted.
            </p>
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
              disabled={busy || !nameValid || value.length === 0}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
            >
              {busy ? 'Saving…' : rotating ? 'Rotate' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
