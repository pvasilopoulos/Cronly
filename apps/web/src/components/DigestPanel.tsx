'use client';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

interface DigestConfig {
  enabled: boolean;
  hour: number;
}

export function DigestPanel() {
  const { can } = usePermissions();
  const canView = can('settings:read');
  const canManage = can('settings:manage');

  const [cfg, setCfg] = useState<DigestConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canView) return;
    api<DigestConfig>('/settings/digest')
      .then(setCfg)
      .catch(() => setCfg({ enabled: false, hour: 8 }));
  }, [canView]);

  if (!canView) return null;

  async function save(next: DigestConfig) {
    setBusy(true);
    setError(null);
    setOk(false);
    try {
      const saved = await api<DigestConfig>('/settings/digest', { method: 'PUT', body: next });
      setCfg(saved);
      setOk(true);
      setTimeout(() => setOk(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-faint">Daily digest</h2>
      <p className="mb-4 text-xs text-muted">
        A once-a-day summary of the last 24 hours of runs — total, successes, warnings and failures — delivered to
        every member as an in-app notification and push.
      </p>

      {!cfg ? (
        <p className="text-sm text-faint">Loading…</p>
      ) : (
        <div className="flex flex-col gap-4">
          <label className="flex items-center justify-between">
            <span className="text-sm font-medium">Send a daily digest</span>
            <input
              type="checkbox"
              checked={cfg.enabled}
              disabled={!canManage || busy}
              onChange={(e) => save({ ...cfg, enabled: e.target.checked })}
              className="h-4 w-4 accent-accent"
            />
          </label>

          <label className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-muted">Send at (workspace timezone)</span>
            <select
              value={cfg.hour}
              disabled={!canManage || busy || !cfg.enabled}
              onChange={(e) => save({ ...cfg, hour: Number(e.target.value) })}
              className="rounded-lg border border-line bg-surface2 px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-60"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center gap-2 text-xs">
            {ok && <span className="text-ok">Saved.</span>}
            {error && <span className="rounded-lg bg-err/10 px-3 py-1.5 text-err">{error}</span>}
            {!canManage && <span className="text-faint">You need the “Manage settings” permission to change this.</span>}
          </div>
        </div>
      )}
    </section>
  );
}
