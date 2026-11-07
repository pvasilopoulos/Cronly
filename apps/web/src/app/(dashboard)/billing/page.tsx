'use client';
import { useMemo, useState } from 'react';
import useSWR, { mutate as globalMutate } from 'swr';
import { api, fetcher } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import type { BillingOverview, BillingPlan, ChangePlanResult, UsageItem } from '@/lib/types';
import { Spinner, EmptyState } from '@/components/ui';

function price(cents: number | null): string {
  if (cents === null) return 'Custom';
  if (cents === 0) return 'Free';
  return `€${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0 })}`;
}

function usagePct(item: UsageItem): number | null {
  if (item.limit < 0 || item.used == null) return null; // unlimited or uncounted
  if (item.limit === 0) return 100;
  return Math.min(100, Math.round((item.used / item.limit) * 100));
}

export default function BillingPage() {
  const { can } = usePermissions();
  const { data, isLoading } = useSWR<BillingOverview>('/billing', () => fetcher<BillingOverview>('/billing'));
  const [pending, setPending] = useState<BillingPlan | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const canManage = can('billing:manage');

  if (isLoading) return <Spinner />;
  if (!data) return <EmptyState title="Billing unavailable" hint="Could not load plan information." />;

  const current = data.plans.find((p) => p.key === data.plan);
  const featureSet = new Set(data.features);

  async function confirmChange(plan: BillingPlan) {
    setNotice(null);
    try {
      const res = await api<ChangePlanResult>('/billing/change-plan', { method: 'POST', body: { plan: plan.key } });
      if (!res.applied && res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
        return;
      }
      // Local driver applied immediately. Refresh billing + the caller's
      // permissions so any newly-unlocked gated features appear at once.
      await globalMutate('/billing');
      await globalMutate((key) => typeof key === 'string' && key.startsWith('/me/permissions'));
      const dir = res.direction === 'downgrade' ? 'Downgraded' : 'Upgraded';
      const unlocked = plan.featureLabels.filter((_, i) => !featureSet.has(plan.features[i]));
      setNotice({
        tone: 'ok',
        text:
          `${dir} to ${plan.label}.` +
          (res.direction !== 'downgrade' && unlocked.length
            ? ` Unlocked: ${unlocked.join(', ')}.`
            : ''),
      });
    } catch (err: any) {
      setNotice({ tone: 'err', text: String(err?.message ?? err) });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-5">
        <h1 className="text-xl font-bold md:text-2xl">Billing &amp; Plan</h1>
        <p className="text-sm text-muted">Your plan, usage this month, and self-serve upgrades</p>
      </header>

      {notice && (
        <div
          className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
            notice.tone === 'ok' ? 'border-ok/30 bg-ok/10 text-ok' : 'border-err/30 bg-err/10 text-err'
          }`}
        >
          {notice.text}
        </div>
      )}

      {/* Current plan + driver */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-faint">Current plan</div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="text-lg font-bold">{current?.label ?? data.plan}</span>
            <span className="text-sm text-muted">{current ? price(current.priceCents) : ''}{current && current.priceCents ? '/mo' : ''}</span>
          </div>
        </div>
        <div className="text-right text-xs text-muted">
          <div>Billing mode: <span className="font-medium text-fg">{data.driver.label}</span></div>
          <div>{data.driver.immediate ? 'Plan changes apply immediately.' : 'Plan changes go through checkout.'}</div>
        </div>
      </div>

      {/* Usage this month */}
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold">Usage this period</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-xl border border-line bg-surface p-4">
            <div className="text-xs uppercase tracking-wide text-faint">Runs this month</div>
            <div className="mt-1 text-2xl font-bold tabular-nums">{data.usage.runsThisMonth.toLocaleString()}</div>
            <div className="mt-0.5 text-[11px] text-faint">
              since {new Date(data.usage.periodStart).toLocaleDateString()}
            </div>
          </div>
          {data.usage.quota.map((item) => {
            const pct = usagePct(item);
            const unlimited = item.limit < 0;
            return (
              <div key={item.key} className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="uppercase tracking-wide text-faint">{item.label}</span>
                  <span className="font-mono text-muted">
                    {item.used ?? '—'}{unlimited ? ' / ∞' : ` / ${item.limit}`}
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface2">
                  {pct == null ? (
                    <div className="h-full w-full bg-ok/30" />
                  ) : (
                    <div
                      className={`h-full rounded-full ${pct >= 100 ? 'bg-err' : pct >= 80 ? 'bg-warn' : 'bg-accent'}`}
                      style={{ width: `${pct}%` }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Plan catalog */}
      <section>
        <h2 className="mb-2 text-sm font-semibold">Plans</h2>
        {!canManage && (
          <p className="mb-3 rounded-lg border border-line bg-surface2 px-3 py-2 text-xs text-muted">
            You can view billing but not change the plan. This needs the <code>billing:manage</code> permission
            (held by the Owner role).
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {data.plans.map((plan) => {
            const isCurrent = plan.key === data.plan;
            const isUpgrade = plan.rank > data.planRank;
            return (
              <div
                key={plan.key}
                className={`flex flex-col rounded-xl border bg-surface p-4 ${
                  isCurrent ? 'border-accent ring-1 ring-accent' : 'border-line'
                }`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{plan.label}</h3>
                  {isCurrent && (
                    <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent-fg">
                      Current
                    </span>
                  )}
                </div>
                <div className="mt-1 text-2xl font-bold">
                  {price(plan.priceCents)}
                  {plan.priceCents ? <span className="text-sm font-normal text-faint">/mo</span> : null}
                </div>
                <p className="mt-1 text-xs text-muted">{plan.blurb}</p>

                <ul className="mt-3 flex-1 space-y-1 text-xs">
                  <li className="text-muted">
                    <span className="font-mono text-fg">{plan.quota.maxJobs < 0 ? '∞' : plan.quota.maxJobs}</span> jobs ·{' '}
                    <span className="font-mono text-fg">{plan.quota.maxMembers < 0 ? '∞' : plan.quota.maxMembers}</span> seats
                  </li>
                  {plan.featureLabels.length === 0 ? (
                    <li className="text-faint">Core scheduling</li>
                  ) : (
                    plan.featureLabels.map((f) => (
                      <li key={f} className="flex items-center gap-1.5 text-muted">
                        <span className="text-ok">✓</span> {f}
                      </li>
                    ))
                  )}
                </ul>

                <button
                  disabled={isCurrent || !canManage}
                  onClick={() => setPending(plan)}
                  className={`mt-4 rounded-lg px-3 py-2 text-sm font-semibold ${
                    isCurrent
                      ? 'cursor-default border border-line text-faint'
                      : isUpgrade
                        ? 'bg-accent text-white hover:brightness-110 disabled:opacity-50'
                        : 'border border-line text-muted hover:border-faint disabled:opacity-50'
                  }`}
                >
                  {isCurrent ? 'Current plan' : isUpgrade ? 'Upgrade' : 'Downgrade'}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {pending && (
        <ConfirmPlan
          plan={pending}
          current={current?.label ?? data.plan}
          isUpgrade={pending.rank > data.planRank}
          onCancel={() => setPending(null)}
          onConfirm={() => confirmChange(pending)}
        />
      )}
    </div>
  );
}

function ConfirmPlan({
  plan,
  current,
  isUpgrade,
  onCancel,
  onConfirm,
}: {
  plan: BillingPlan;
  current: string;
  isUpgrade: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/45" onClick={onCancel} />
      <div className="relative w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-2xl">
        <h2 className="text-lg font-semibold">{isUpgrade ? 'Upgrade' : 'Downgrade'} to {plan.label}?</h2>
        <p className="mt-1 text-sm text-muted">
          Moving from <b className="text-fg">{current}</b> to <b className="text-fg">{plan.label}</b> ({price(plan.priceCents)}
          {plan.priceCents ? '/mo' : ''}).
        </p>
        {isUpgrade ? (
          <p className="mt-3 rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok">
            Gated features for this plan unlock immediately after upgrading.
          </p>
        ) : (
          <p className="mt-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
            Downgrading removes features above the {plan.label} plan and tightens quotas.
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-lg border border-line px-4 py-2 text-sm font-medium">Cancel</button>
          <button
            onClick={() => { setBusy(true); onConfirm(); }}
            disabled={busy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
          >
            {busy ? 'Applying…' : isUpgrade ? 'Upgrade' : 'Downgrade'}
          </button>
        </div>
      </div>
    </div>
  );
}
