'use client';
import { useState } from 'react';
import useSWR, { mutate as globalMutate } from 'swr';
import { api, fetcher } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import type { AlertRule, AlertStatus, ChannelType, Job, NotificationChannel } from '@/lib/types';
import { Spinner, EmptyState } from '@/components/ui';
import { SearchableSelect } from '@/components/SearchableSelect';

const CHANNEL_TYPES: ChannelType[] = ['EMAIL', 'SLACK', 'WEBHOOK', 'TELEGRAM'];
const ALERT_STATUSES: AlertStatus[] = ['FAILED', 'TIMEOUT', 'DEAD_LETTER', 'WARNING', 'SUCCESS'];
// New rules preselect the failure statuses only; WARNING/SUCCESS are opt-in to
// avoid turning every clean run into an alert.
const DEFAULT_RULE_STATUSES: AlertStatus[] = ['FAILED', 'TIMEOUT', 'DEAD_LETTER'];
const STATUS_TONE: Record<AlertStatus, string> = {
  FAILED: 'bg-err/15 text-err',
  TIMEOUT: 'bg-err/15 text-err',
  DEAD_LETTER: 'bg-err/15 text-err',
  WARNING: 'bg-warn/15 text-warn',
  SUCCESS: 'bg-ok/15 text-ok',
};

const TYPE_META: Record<ChannelType, { icon: string; label: string; placeholder: string; hint: string }> = {
  EMAIL: { icon: '✉', label: 'Email', placeholder: 'ops@example.com', hint: 'Destination email address.' },
  SLACK: {
    icon: '#',
    label: 'Slack',
    placeholder: 'https://hooks.slack.com/services/…',
    hint: 'Slack incoming-webhook URL.',
  },
  WEBHOOK: {
    icon: '↗',
    label: 'Webhook',
    placeholder: 'https://example.com/hooks/cron',
    hint: 'A JSON POST is sent here on each alert.',
  },
  TELEGRAM: {
    icon: '✈',
    label: 'Telegram',
    placeholder: '-1001234567890',
    hint: 'The chat ID to post to (use @userinfobot or getUpdates to find it).',
  },
};

export default function AlertsPage() {
  const { can } = usePermissions();
  const canManage = can('alerts:manage');
  const { data: channels, isLoading: loadingCh } = useSWR<NotificationChannel[]>('/alerts/channels', () =>
    fetcher<NotificationChannel[]>('/alerts/channels'),
  );
  const { data: rules, isLoading: loadingRules } = useSWR<AlertRule[]>('/alerts/rules', () =>
    fetcher<AlertRule[]>('/alerts/rules'),
  );
  const { data: jobs } = useSWR<Job[]>('/jobs', () => fetcher<Job[]>('/jobs'));

  const [newChannel, setNewChannel] = useState(false);
  const [newRule, setNewRule] = useState(false);

  const jobName = (id: string | null) => (id ? jobs?.find((j) => j.id === id)?.name ?? id : 'All jobs');

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-5">
        <h1 className="text-xl font-bold md:text-2xl">Alerts</h1>
        <p className="text-sm text-muted">Get notified when your jobs fail</p>
      </header>

      {/* ── Channels ── */}
      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-faint">Channels</h2>
          {canManage && (
            <button
              onClick={() => setNewChannel(true)}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:border-faint"
            >
              ＋ Add channel
            </button>
          )}
        </div>
        {loadingCh ? (
          <Spinner />
        ) : !channels || channels.length === 0 ? (
          <EmptyState
            title="No channels"
            hint={canManage ? 'Add an email, Slack, or webhook destination.' : undefined}
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {channels.map((c) => (
              <div key={c.id} className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4">
                <span className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-surface2 text-lg">
                  {TYPE_META[c.type].icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <b className="truncate text-sm">{c.name}</b>
                    <span className="rounded bg-surface2 px-1.5 py-0.5 text-[10px] font-medium text-faint">
                      {TYPE_META[c.type].label}
                    </span>
                    {!c.enabled && (
                      <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-medium text-warn">
                        disabled
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-faint">{c.target}</p>
                </div>
                {canManage && <DeleteButton path={`/alerts/channels/${c.id}`} swrKey="/alerts/channels" />}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Rules ── */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-faint">Rules</h2>
          {canManage && channels && channels.length > 0 && (
            <button
              onClick={() => setNewRule(true)}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:border-faint"
            >
              ＋ Add rule
            </button>
          )}
        </div>
        {loadingRules ? (
          <Spinner />
        ) : !rules || rules.length === 0 ? (
          <EmptyState
            title="No rules"
            hint={
              canManage
                ? channels && channels.length > 0
                  ? 'A rule links a failure condition to a channel.'
                  : 'Add a channel first, then create a rule.'
                : undefined
            }
          />
        ) : (
          <div className="flex flex-col gap-2">
            {rules.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface p-4 text-sm"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="grid h-7 w-7 flex-none place-items-center rounded-md bg-surface2">
                    {r.channel ? TYPE_META[r.channel.type].icon : '•'}
                  </span>
                  <div className="min-w-0">
                    <b className="truncate">{r.channel?.name ?? 'Channel'}</b>
                    <p className="text-xs text-faint">{jobName(r.jobId)}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {r.onStatuses.map((s) => (
                    <span
                      key={s}
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[s] ?? 'bg-err/15 text-err'}`}
                    >
                      {s.replace('_', ' ').toLowerCase()}
                    </span>
                  ))}
                </div>
                <span className="text-xs text-muted">
                  after <b className="text-fg">{r.threshold}</b> in a row
                </span>
                {!r.enabled && (
                  <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-medium text-warn">
                    disabled
                  </span>
                )}
                {canManage && <DeleteButton path={`/alerts/rules/${r.id}`} swrKey="/alerts/rules" />}
              </div>
            ))}
          </div>
        )}
      </section>

      {newChannel && <ChannelEditor onClose={() => setNewChannel(false)} />}
      {newRule && channels && (
        <RuleEditor channels={channels} jobs={jobs ?? []} onClose={() => setNewRule(false)} />
      )}
    </div>
  );
}

function DeleteButton({ path, swrKey }: { path: string; swrKey: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    try {
      await api(path, { method: 'DELETE' });
      globalMutate(swrKey);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }
  if (!confirming)
    return (
      <button
        onClick={() => setConfirming(true)}
        className="flex-none text-xs font-medium text-err hover:underline"
      >
        Delete
      </button>
    );
  return (
    <span className="flex flex-none items-center gap-2 text-xs">
      <button onClick={remove} disabled={busy} className="font-medium text-err hover:underline disabled:opacity-60">
        {busy ? '…' : 'Confirm'}
      </button>
      <button onClick={() => setConfirming(false)} className="font-medium text-muted hover:underline">
        Cancel
      </button>
    </span>
  );
}

function Modal({ title, children, footer, onClose }: {
  title: string;
  children: React.ReactNode;
  footer: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div className="relative flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="border-b border-line p-5">
          <h2 className="text-lg font-semibold">{title}</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        <div className="flex items-center justify-end gap-2 border-t border-line p-4">{footer}</div>
      </div>
    </div>
  );
}

const inputCls =
  'w-full rounded-lg border border-line bg-surface2 px-3 py-2 text-sm outline-none focus:border-accent';
const labelCls = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-faint';

function ChannelEditor({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<ChannelType>('EMAIL');
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = TYPE_META[type];

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api('/alerts/channels', {
        method: 'POST',
        body: {
          type,
          name,
          target,
          // WEBHOOK: optional HMAC secret. TELEGRAM: the bot token (required).
          ...((type === 'WEBHOOK' || type === 'TELEGRAM') && signingSecret ? { signingSecret } : {}),
        },
      });
      globalMutate('/alerts/channels');
      onClose();
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New channel"
      onClose={onClose}
      footer={
        <>
          {error && <span className="mr-auto text-xs text-err">{error}</span>}
          <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm font-medium">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy || !name || !target || (type === 'TELEGRAM' && !signingSecret)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Create'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <span className={labelCls}>Type</span>
          <div className="grid grid-cols-2 gap-2">
            {CHANNEL_TYPES.map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={`rounded-lg border px-3 py-2 text-sm font-medium ${
                  type === t ? 'border-accent bg-accent-soft text-accent-fg' : 'border-line hover:border-faint'
                }`}
              >
                <span className="mr-1">{TYPE_META[t].icon}</span>
                {TYPE_META[t].label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className={labelCls}>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ops team" className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>
            {type === 'EMAIL' ? 'Address' : type === 'TELEGRAM' ? 'Chat ID' : 'URL'}
          </label>
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={meta.placeholder}
            className={`${inputCls} font-mono`}
          />
          <p className="mt-1 text-xs text-faint">{meta.hint}</p>
        </div>
        {type === 'WEBHOOK' && (
          <div>
            <label className={labelCls}>Signing secret (optional)</label>
            <input
              value={signingSecret}
              onChange={(e) => setSigningSecret(e.target.value)}
              placeholder="Used to HMAC-sign the payload"
              className={`${inputCls} font-mono`}
            />
            <p className="mt-1 text-xs text-faint">
              Sent as an <code className="font-mono">x-cronapp-signature</code> header. Write-only.
            </p>
          </div>
        )}
        {type === 'TELEGRAM' && (
          <div>
            <label className={labelCls}>Bot token</label>
            <input
              value={signingSecret}
              onChange={(e) => setSigningSecret(e.target.value)}
              placeholder="123456:ABC-DEF…"
              className={`${inputCls} font-mono`}
            />
            <p className="mt-1 text-xs text-faint">
              From <code className="font-mono">@BotFather</code> when you create the bot. Stored write-only; add the
              bot to your chat first.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function RuleEditor({
  channels,
  jobs,
  onClose,
}: {
  channels: NotificationChannel[];
  jobs: Job[];
  onClose: () => void;
}) {
  const [channelId, setChannelId] = useState(channels[0]?.id ?? '');
  const [jobId, setJobId] = useState<string>(''); // '' → all jobs
  const [threshold, setThreshold] = useState(1);
  const [statuses, setStatuses] = useState<Set<AlertStatus>>(new Set(DEFAULT_RULE_STATUSES));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleStatus(s: AlertStatus) {
    setStatuses((prev) => {
      const n = new Set(prev);
      n.has(s) ? n.delete(s) : n.add(s);
      return n;
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api('/alerts/rules', {
        method: 'POST',
        body: {
          channelId,
          ...(jobId ? { jobId } : {}),
          threshold,
          onStatuses: [...statuses],
        },
      });
      globalMutate('/alerts/rules');
      onClose();
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New rule"
      onClose={onClose}
      footer={
        <>
          {error && <span className="mr-auto text-xs text-err">{error}</span>}
          <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm font-medium">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy || !channelId || statuses.size === 0}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Create'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <label className={labelCls}>Notify via</label>
          <select value={channelId} onChange={(e) => setChannelId(e.target.value)} className={inputCls}>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {TYPE_META[c.type].label} · {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>Applies to</label>
          <SearchableSelect
            value={jobId}
            onChange={setJobId}
            options={jobs.map((j) => ({ value: j.id, label: j.name, hint: j.group || undefined }))}
            placeholder="All jobs"
            searchPlaceholder="Search jobs…"
            clearLabel="All jobs"
          />
        </div>
        <div>
          <span className={labelCls}>On status</span>
          <div className="flex flex-wrap gap-2">
            {ALERT_STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => toggleStatus(s)}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  statuses.has(s) ? STATUS_TONE[s] : 'border border-line text-faint hover:border-faint'
                }`}
              >
                {s.replace('_', ' ').toLowerCase()}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className={labelCls}>Threshold</label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={1}
              max={100}
              value={threshold}
              onChange={(e) => setThreshold(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
              className={`${inputCls} w-24`}
            />
            <span className="text-sm text-muted">consecutive failure(s) before alerting</span>
          </div>
        </div>
      </div>
    </Modal>
  );
}
