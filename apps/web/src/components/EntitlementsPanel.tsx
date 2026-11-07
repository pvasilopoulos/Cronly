'use client';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { api, fetcher, ApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { useAuth } from '@/lib/auth';
import type { Entitlements } from '@/lib/types';
import { Spinner, Toggle } from '@/components/ui';
import { mutate as globalMutate } from 'swr';

const QUOTA_ORDER = ['maxJobs', 'maxMembers', 'maxChannels', 'maxConcurrency'] as const;

function fmtDefault(n: number): string {
  return n < 0 ? 'Unlimited' : String(n);
}

/**
 * Per-tenant entitlements editor: override plan limits and toggle features.
 * Visible only to principals holding entitlements:read; editable only with
 * entitlements:manage. Workspaces without the permission never see it, and the
 * plain usage bars on the page remain the read-only view of consumption.
 */
export function EntitlementsPanel() {
  const { activeTenant } = useAuth();
  const { can } = usePermissions();
  const canRead = can('entitlements:read');
  const canManage = can('entitlements:manage');

  const { data, mutate } = useSWR<Entitlements>(
    canRead && activeTenant ? `/entitlements?t=${activeTenant.id}` : null,
    () => fetcher<Entitlements>('/entitlements'),
    { revalidateOnFocus: false },
  );

  // Local draft state, seeded from the server view.
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [features, setFeatures] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  useEffect(() => {
    if (!data) return;
    const l: Record<string, string> = {};
    for (const k of QUOTA_ORDER) {
      l[k] = k in data.overrides ? String(data.overrides[k]) : '';
    }
    setLimits(l);
    setFeatures(data.features);
  }, [data]);

  if (!canRead) return null;
  if (!data) {
    return (
      <section className="rounded-xl border border-line bg-surface p-5">
        <Spinner />
      </section>
    );
  }

  const dirty =
    QUOTA_ORDER.some((k) => (limits[k] ?? '') !== (k in data.overrides ? String(data.overrides[k]) : '')) ||
    features.slice().sort().join(',') !== data.features.slice().sort().join(',');

  function toggleFeature(key: string) {
    setFeatures((f) => (f.includes(key) ? f.filter((x) => x !== key) : [...f, key]));
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      // Empty input clears the override (null); otherwise send the integer.
      const quotas: Record<string, number | null> = {};
      for (const k of QUOTA_ORDER) {
        const raw = (limits[k] ?? '').trim();
        if (raw === '') {
          quotas[k] = null;
        } else {
          const n = Number(raw);
          if (!Number.isInteger(n) || n < -1) throw new ApiError(400, `${k}: enter an integer ≥ -1 (-1 = unlimited)`);
          quotas[k] = n;
        }
      }
      const next = await api<Entitlements>('/entitlements', {
        method: 'PATCH',
        body: { quotas, features },
      });
      await mutate(next, { revalidate: false });
      // Limits and features both change what the console shows elsewhere.
      if (activeTenant) {
        globalMutate(`/usage?t=${activeTenant.id}`);
        globalMutate(`/me/permissions?t=${activeTenant.id}`);
      }
      setSavedAt(Date.now());
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    if (!data) return;
    const l: Record<string, string> = {};
    for (const k of QUOTA_ORDER) l[k] = k in data.overrides ? String(data.overrides[k]) : '';
    setLimits(l);
    setFeatures(data.features);
    setErr(null);
  }

  const inputCls =
    'w-28 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-sm outline-none focus:border-accent disabled:opacity-60';

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-faint">Entitlements</h2>
        <span className="text-xs text-muted">{data.plan} plan</span>
      </div>
      <p className="mb-4 text-xs text-muted">
        {canManage
          ? 'Override the plan limits and toggle features for this workspace. Leave a limit blank to use the plan default; -1 means unlimited.'
          : 'Plan limits and features for this workspace (read-only).'}
      </p>

      {/* ── Limits ── */}
      <h3 className="mb-2 text-xs font-semibold text-fg">Limits</h3>
      <div className="mb-5 flex flex-col divide-y divide-line rounded-lg border border-line">
        {QUOTA_ORDER.map((k) => {
          const def = data.planDefaults[k];
          const overridden = k in data.overrides;
          return (
            <div key={k} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium capitalize">{data.quotaLabels[k] ?? k}</div>
                <div className="text-xs text-faint">
                  Plan default: {fmtDefault(def)}
                  {overridden && <span className="ml-2 text-accent">overridden</span>}
                </div>
              </div>
              {canManage ? (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step={1}
                    min={-1}
                    value={limits[k] ?? ''}
                    placeholder={fmtDefault(def)}
                    onChange={(e) => setLimits((s) => ({ ...s, [k]: e.target.value }))}
                    className={inputCls}
                  />
                  {(limits[k] ?? '') !== '' && (
                    <button
                      type="button"
                      onClick={() => setLimits((s) => ({ ...s, [k]: '' }))}
                      className="rounded px-1.5 py-1 text-xs text-faint hover:text-err"
                      title="Reset to plan default"
                    >
                      reset
                    </button>
                  )}
                </div>
              ) : (
                <span className="text-sm font-medium">{fmtDefault(data.quota[k])}</span>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Features ── */}
      <h3 className="mb-2 text-xs font-semibold text-fg">Features</h3>
      <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {data.availableFeatures.map((f) => {
          const on = features.includes(f.key);
          const planDefault = data.planFeatures.includes(f.key);
          return (
            <div key={f.key} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium">{f.label}</div>
                <div className="text-xs text-faint">
                  <code className="font-mono">{f.key}</code>
                  {planDefault && <span className="ml-2 text-muted">included in plan</span>}
                </div>
              </div>
              {canManage ? (
                <Toggle on={on} onClick={() => toggleFeature(f.key)} />
              ) : (
                <span className={`text-xs font-semibold ${on ? 'text-ok' : 'text-faint'}`}>
                  {on ? 'on' : 'off'}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {canManage && (
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={save}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          {dirty && !saving && (
            <button type="button" onClick={reset} className="text-sm text-muted hover:text-fg">
              Discard
            </button>
          )}
          {err && <span className="text-sm text-err">{err}</span>}
          {!dirty && savedAt > 0 && !err && <span className="text-sm text-ok">Saved</span>}
        </div>
      )}
    </section>
  );
}
