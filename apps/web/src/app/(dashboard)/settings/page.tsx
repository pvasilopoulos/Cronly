'use client';
import useSWR from 'swr';
import { useAuth } from '@/lib/auth';
import { usePermissions } from '@/lib/permissions';
import { fetcher } from '@/lib/api';
import type { TenantUsage, UsageItem } from '@/lib/types';
import { Spinner } from '@/components/ui';
import { SecurityPanel } from '@/components/SecurityPanel';
import { EntitlementsPanel } from '@/components/EntitlementsPanel';
import { EffectivePermissions } from '@/components/EffectivePermissions';
import { BrandingPanel } from '@/components/BrandingPanel';
import { SmtpPanel } from '@/components/SmtpPanel';
import { MobileNavPanel } from '@/components/MobileNavPanel';
import { NotificationPrefPanel } from '@/components/NotificationPrefPanel';
import { TemplatesPanel } from '@/components/TemplatesPanel';
import { MaintenancePanel } from '@/components/MaintenancePanel';
import { DigestPanel } from '@/components/DigestPanel';

function UsageBar({ item }: { item: UsageItem }) {
  const unlimited = item.limit < 0;
  const used = item.used ?? 0;
  const pct = unlimited || item.limit === 0 ? 0 : Math.min(100, Math.round((used / item.limit) * 100));
  const atCap = !unlimited && used >= item.limit;
  const near = !unlimited && pct >= 80;
  const tone = atCap ? 'bg-err' : near ? 'bg-warn' : 'bg-accent';

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="font-medium">{item.label}</span>
        <span className={atCap ? 'font-semibold text-err' : 'text-muted'}>
          {used}
          {unlimited ? ' / ∞' : ` / ${item.limit}`}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface2">
        {unlimited ? (
          <div className="h-full w-full bg-surface2" />
        ) : (
          <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${pct}%` }} />
        )}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { activeTenant } = useAuth();
  const { data, loading } = usePermissions();
  const { data: usage } = useSWR<TenantUsage>(activeTenant ? `/usage?t=${activeTenant.id}` : null, () =>
    fetcher<TenantUsage>('/usage'),
  );

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-5">
        <h1 className="text-xl font-bold md:text-2xl">Settings</h1>
        <p className="text-sm text-muted">Workspace configuration</p>
      </header>

      {loading || !data ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-4">
          <section className="rounded-xl border border-line bg-surface p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-faint">Workspace</h2>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-faint">Name</dt>
                <dd className="font-medium">{activeTenant?.name}</dd>
              </div>
              <div>
                <dt className="text-xs text-faint">Plan</dt>
                <dd className="font-medium">{activeTenant?.plan}</dd>
              </div>
            </dl>
          </section>

          <section className="rounded-xl border border-line bg-surface p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-faint">Plan usage</h2>
              {usage && <span className="text-xs text-muted">{usage.plan} limits</span>}
            </div>
            {!usage ? (
              <Spinner />
            ) : (
              <div className="flex flex-col gap-4">
                {usage.items.map((item) => (
                  <UsageBar key={item.key} item={item} />
                ))}
                <p className="text-xs text-faint">
                  Reaching a cap blocks new resources until you remove some or upgrade your plan.
                  Concurrent runs are throttled automatically — extra executions queue and run as
                  slots free up.
                </p>
              </div>
            )}
          </section>

          <SecurityPanel />

          <NotificationPrefPanel />

          <DigestPanel />

          <MaintenancePanel />

          <TemplatesPanel />

          <BrandingPanel />

          <MobileNavPanel />

          <SmtpPanel />

          <EntitlementsPanel />

          <EffectivePermissions data={data} />
        </div>
      )}
    </div>
  );
}
