'use client';
import { useMemo, useState } from 'react';
import type { MyPermissions, PermissionDef } from '@/lib/types';

const RESOURCE_LABELS: Record<string, string> = {
  jobs: 'Jobs',
  runs: 'Executions',
  responses: 'Responses',
  secrets: 'Secrets',
  alerts: 'Alerting',
  members: 'Members',
  roles: 'Roles',
  settings: 'Settings',
  apikeys: 'API keys',
  billing: 'Billing',
  audit: 'Audit log',
  entitlements: 'Entitlements',
};

/**
 * Detailed, grouped view of the signed-in principal's effective permissions.
 * Every catalog permission is shown under its resource with its human label and
 * description, marked granted or not, so it reads as a capability matrix rather
 * than a wall of raw keys. Feature-gated permissions the plan does not enable
 * are called out as locked.
 */
export function EffectivePermissions({ data }: { data: MyPermissions }) {
  const [showAll, setShowAll] = useState(false);
  const held = useMemo(() => new Set(data.keys), [data.keys]);
  const features = useMemo(() => new Set(data.features), [data.features]);

  const groups = useMemo(() => {
    const byResource = new Map<string, PermissionDef[]>();
    for (const p of data.catalog) {
      const arr = byResource.get(p.resource) ?? [];
      arr.push(p);
      byResource.set(p.resource, arr);
    }
    return [...byResource.entries()]
      .map(([resource, perms]) => ({
        resource,
        label: RESOURCE_LABELS[resource] ?? resource,
        perms: perms.slice().sort((a, b) => a.action.localeCompare(b.action)),
        granted: perms.filter((p) => held.has(p.key)).length,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [data.catalog, held]);

  const totalGranted = held.size;
  const totalPerms = data.catalog.length;

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-faint">
          Your effective permissions
        </h2>
        <span className="rounded-full bg-surface2 px-2.5 py-0.5 text-xs font-medium text-muted">
          {totalGranted} / {totalPerms} granted
        </span>
      </div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-xs text-muted">
          What you can do here, after roles, per-user overrides and plan gating.
        </p>
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="flex-none text-xs font-medium text-accent hover:underline"
        >
          {showAll ? 'Only granted' : 'Show all'}
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {groups.map((g) => {
          const rows = showAll ? g.perms : g.perms.filter((p) => held.has(p.key));
          if (rows.length === 0) return null;
          return (
            <div key={g.resource} className="rounded-lg border border-line bg-surface2/40 p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">{g.label}</h3>
                <span className="text-[11px] text-faint">
                  {g.granted}/{g.perms.length}
                </span>
              </div>
              <ul className="flex flex-col gap-1.5">
                {rows.map((p) => {
                  const has = held.has(p.key);
                  const locked = !!p.requiresFeature && !features.has(p.requiresFeature);
                  return (
                    <li key={p.key} className="flex items-start gap-2">
                      <span
                        className={`mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold ${
                          has ? 'bg-ok/20 text-ok' : 'bg-surface2 text-faint'
                        }`}
                        aria-label={has ? 'granted' : 'not granted'}
                      >
                        {has ? '✓' : '·'}
                      </span>
                      <span className="min-w-0">
                        <span className={`text-sm ${has ? 'text-fg' : 'text-muted'}`}>{p.label}</span>
                        {locked && (
                          <span className="ml-1.5 rounded bg-warn/15 px-1 py-0.5 text-[10px] font-medium text-warn">
                            needs {p.requiresFeature}
                          </span>
                        )}
                        <span className="block text-[11px] leading-tight text-faint">{p.description}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
