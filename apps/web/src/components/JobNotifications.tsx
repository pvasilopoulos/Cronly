'use client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import useSWR, { mutate as globalMutate } from 'swr';
import { api, fetcher } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import type {
  AlertRule,
  AlertStatus,
  ChannelType,
  NotificationChannel,
  TemplatesPayload,
  TemplateVariable,
} from '@/lib/types';
import { Spinner } from '@/components/ui';

// Per-job notifications. Reuses the tenant's NotificationChannel (destination +
// credentials) and AlertRule (status/threshold + optional custom message), but
// scopes everything to one job and lets you set it all up here — including a
// brand-new Telegram destination (chat id + bot token) and a custom message with
// {{ variables }} and a live preview.

const CHANNEL_TYPES: ChannelType[] = ['TELEGRAM', 'SLACK', 'EMAIL', 'WEBHOOK'];
const ALERT_STATUSES: AlertStatus[] = ['FAILED', 'TIMEOUT', 'DEAD_LETTER', 'WARNING', 'SUCCESS'];
const DEFAULT_STATUSES: AlertStatus[] = ['FAILED', 'TIMEOUT', 'DEAD_LETTER'];

const STATUS_TONE: Record<AlertStatus, string> = {
  FAILED: 'bg-err/15 text-err',
  TIMEOUT: 'bg-err/15 text-err',
  DEAD_LETTER: 'bg-err/15 text-err',
  WARNING: 'bg-warn/15 text-warn',
  SUCCESS: 'bg-ok/15 text-ok',
};

const EVENT_FOR: Record<AlertStatus, string> = {
  FAILED: 'job.failed',
  TIMEOUT: 'job.timeout',
  DEAD_LETTER: 'job.dead_letter',
  WARNING: 'job.warning',
  SUCCESS: 'job.success',
};

interface TypeMeta {
  label: string;
  icon: string;
  targetLabel: string;
  targetPlaceholder: string;
  hasSubject: boolean;
  secretLabel?: string;
  secretPlaceholder?: string;
  secretRequired?: boolean;
  hint?: string;
}
const TYPE_META: Record<ChannelType, TypeMeta> = {
  TELEGRAM: {
    label: 'Telegram',
    icon: '✈',
    targetLabel: 'Chat ID',
    targetPlaceholder: '-1001234567890',
    hasSubject: false,
    secretLabel: 'Bot token',
    secretPlaceholder: '123456789:ABCdef…',
    secretRequired: true,
    hint: 'Create a bot with @BotFather for the token, then get the chat ID from @userinfobot (or the bot’s getUpdates).',
  },
  SLACK: {
    label: 'Slack',
    icon: '#',
    targetLabel: 'Incoming-webhook URL',
    targetPlaceholder: 'https://hooks.slack.com/services/…',
    hasSubject: false,
  },
  EMAIL: {
    label: 'Email',
    icon: '✉',
    targetLabel: 'Email address',
    targetPlaceholder: 'ops@example.com',
    hasSubject: true,
  },
  WEBHOOK: {
    label: 'Webhook',
    icon: '↗',
    targetLabel: 'Webhook URL',
    targetPlaceholder: 'https://example.com/hooks/cron',
    hasSubject: false,
    secretLabel: 'Signing secret (optional)',
    secretPlaceholder: 'HMAC-signs the payload',
  },
};

const labelCls = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-faint';
const inputCls =
  'w-full rounded-lg border border-line bg-surface2 px-3 py-2 text-sm outline-none focus:border-accent';

export function JobNotifications({ jobId }: { jobId: string }) {
  const { can } = usePermissions();
  const canRead = can('alerts:read');
  const canManage = can('alerts:manage');

  const { data: rules, isLoading } = useSWR<AlertRule[]>(canRead ? '/alerts/rules' : null, () =>
    fetcher<AlertRule[]>('/alerts/rules'),
  );
  const { data: channels } = useSWR<NotificationChannel[]>(canRead ? '/alerts/channels' : null, () =>
    fetcher<NotificationChannel[]>('/alerts/channels'),
  );

  const [editing, setEditing] = useState<AlertRule | 'new' | null>(null);

  const jobRules = useMemo(() => (rules ?? []).filter((r) => r.jobId === jobId), [rules, jobId]);

  if (!canRead) return null;

  return (
    <section className="mt-5 rounded-xl border border-line bg-surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">Notifications</h3>
          <p className="mt-0.5 text-xs text-muted">Alerts delivered for this job only.</p>
        </div>
        {canManage && editing === null && (
          <button
            onClick={() => setEditing('new')}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110"
          >
            + Add notification
          </button>
        )}
      </div>

      {isLoading ? (
        <Spinner />
      ) : (
        <>
          {jobRules.length === 0 && editing === null && (
            <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-faint">
              No notifications yet for this job.
            </p>
          )}

          <div className="flex flex-col gap-2">
            {jobRules.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-surface2/50 px-3 py-2"
              >
                <span className="grid h-7 w-7 flex-none place-items-center rounded-md bg-surface2 text-sm">
                  {r.channel ? TYPE_META[r.channel.type].icon : '•'}
                </span>
                <div className="min-w-0">
                  <b className="truncate text-sm">{r.channel?.name ?? 'Channel'}</b>
                  {r.body && (
                    <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent-fg">
                      custom message
                    </span>
                  )}
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
                {canManage && (
                  <div className="ml-auto flex items-center gap-1">
                    <TestRuleButton id={r.id} />
                    <button
                      onClick={() => setEditing(r)}
                      className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-surface2 hover:text-fg"
                    >
                      Edit
                    </button>
                    <DeleteRuleButton id={r.id} />
                  </div>
                )}
              </div>
            ))}
          </div>

          {canManage && editing !== null && (
            <RuleForm
              jobId={jobId}
              rule={editing === 'new' ? null : editing}
              channels={channels ?? []}
              onClose={() => setEditing(null)}
            />
          )}
        </>
      )}
    </section>
  );
}

function TestRuleButton({ id }: { id: string }) {
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'err'>('idle');
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setState('testing');
    setMsg(null);
    try {
      const r = await api<{ ok: boolean; info?: string | null; error?: string }>(
        `/alerts/rules/${id}/test`,
        { method: 'POST' },
      );
      if (r.ok) {
        setState('ok');
        setMsg(r.info || 'sent');
      } else {
        setState('err');
        setMsg(r.error || 'failed');
      }
    } catch (e: any) {
      setState('err');
      setMsg(String(e?.message ?? e));
    }
    // Clear the inline result after a while so the row isn't permanently noisy.
    setTimeout(() => {
      setState('idle');
      setMsg(null);
    }, 8000);
  }

  return (
    <span className="flex items-center gap-1">
      <button
        onClick={run}
        disabled={state === 'testing'}
        className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-surface2 hover:text-fg disabled:opacity-50"
      >
        {state === 'testing' ? 'Testing…' : 'Test'}
      </button>
      {msg && (
        <span
          title={msg}
          className={`max-w-[200px] truncate text-[11px] font-medium ${state === 'ok' ? 'text-ok' : 'text-err'}`}
        >
          {state === 'ok' ? `✓ ${msg}` : `✕ ${msg}`}
        </span>
      )}
    </span>
  );
}

function DeleteRuleButton({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  async function del() {
    if (!confirm('Delete this notification?')) return;
    setBusy(true);
    try {
      await api(`/alerts/rules/${id}`, { method: 'DELETE' });
      globalMutate('/alerts/rules');
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      onClick={del}
      disabled={busy}
      className="rounded-md px-2 py-1 text-xs font-medium text-err hover:bg-err/10 disabled:opacity-50"
    >
      Delete
    </button>
  );
}

function RuleForm({
  jobId,
  rule,
  channels,
  onClose,
}: {
  jobId: string;
  rule: AlertRule | null;
  channels: NotificationChannel[];
  onClose: () => void;
}) {
  const editing = !!rule;
  // Destination: reuse an existing channel, or create a new one inline.
  const [mode, setMode] = useState<'existing' | 'new'>(
    editing || channels.length > 0 ? 'existing' : 'new',
  );
  const [channelId, setChannelId] = useState(rule?.channelId ?? channels[0]?.id ?? '');
  const [newType, setNewType] = useState<ChannelType>('TELEGRAM');
  const [newName, setNewName] = useState('');
  const [target, setTarget] = useState('');
  const [secret, setSecret] = useState('');

  const [statuses, setStatuses] = useState<Set<AlertStatus>>(
    new Set(rule?.onStatuses ?? DEFAULT_STATUSES),
  );
  const [threshold, setThreshold] = useState(rule?.threshold ?? 1);
  const [customize, setCustomize] = useState(!!rule?.body);
  const [subject, setSubject] = useState(rule?.subject ?? '');
  const [body, setBody] = useState(rule?.body ?? '');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The channel type in play drives the destination fields, the editor subject
  // visibility and the preview — whether we're creating a channel or reusing one.
  const activeType: ChannelType =
    mode === 'new' ? newType : channels.find((c) => c.id === channelId)?.type ?? 'TELEGRAM';
  const meta = TYPE_META[activeType];

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
      let useChannelId = channelId;
      if (mode === 'new') {
        if (!target.trim()) throw new Error(`${meta.targetLabel} is required.`);
        if (meta.secretRequired && !secret.trim()) throw new Error(`${meta.secretLabel} is required.`);
        const created = await api<NotificationChannel>('/alerts/channels', {
          method: 'POST',
          body: {
            type: newType,
            name: newName.trim() || `${meta.label} · ${activeType === 'TELEGRAM' ? target : meta.label}`,
            target: target.trim(),
            ...(secret.trim() ? { signingSecret: secret.trim() } : {}),
            enabled: true,
          },
        });
        globalMutate('/alerts/channels');
        useChannelId = created.id;
      }
      if (!useChannelId) throw new Error('Pick or create a destination.');
      if (statuses.size === 0) throw new Error('Pick at least one status.');

      // Blank custom message (or customize off) clears the override server-side.
      const msg = customize && body.trim() ? { subject, body } : { subject: '', body: '' };
      const payload = { channelId: useChannelId, threshold, onStatuses: [...statuses], ...msg };

      if (editing) {
        await api(`/alerts/rules/${rule!.id}`, { method: 'PUT', body: payload });
      } else {
        await api('/alerts/rules', { method: 'POST', body: { ...payload, jobId } });
      }
      globalMutate('/alerts/rules');
      onClose();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-accent/40 bg-surface2/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <b className="text-sm">{editing ? 'Edit notification' : 'New notification'}</b>
        <button onClick={onClose} className="text-xs font-medium text-muted hover:text-fg">
          Cancel
        </button>
      </div>

      <div className="flex flex-col gap-4">
        {/* ── Destination ── */}
        <div>
          <span className={labelCls}>Destination</span>
          <div className="mb-2 flex gap-2">
            <ModeTab active={mode === 'existing'} disabled={channels.length === 0} onClick={() => setMode('existing')}>
              Use existing
            </ModeTab>
            <ModeTab active={mode === 'new'} onClick={() => setMode('new')}>
              + New destination
            </ModeTab>
          </div>

          {mode === 'existing' ? (
            channels.length > 0 ? (
              <select value={channelId} onChange={(e) => setChannelId(e.target.value)} className={inputCls}>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {TYPE_META[c.type].label} · {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-faint">No destinations yet — create one.</p>
            )
          ) : (
            <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3">
              <div>
                <label className={labelCls}>Type</label>
                <div className="flex flex-wrap gap-2">
                  {CHANNEL_TYPES.map((t) => (
                    <button
                      key={t}
                      onClick={() => setNewType(t)}
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        newType === t ? 'bg-accent/15 text-accent-fg' : 'border border-line text-faint hover:border-faint'
                      }`}
                    >
                      {TYPE_META[t].icon} {TYPE_META[t].label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className={labelCls}>Name</label>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={`${meta.label} for this job`}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>{meta.targetLabel}</label>
                <input
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder={meta.targetPlaceholder}
                  className={inputCls}
                />
              </div>
              {meta.secretLabel && (
                <div>
                  <label className={labelCls}>{meta.secretLabel}</label>
                  <input
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder={meta.secretPlaceholder}
                    className={`${inputCls} font-mono`}
                    autoComplete="off"
                  />
                </div>
              )}
              {meta.hint && <p className="text-xs text-faint">{meta.hint}</p>}
            </div>
          )}
        </div>

        {/* ── Statuses ── */}
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

        {/* ── Threshold ── */}
        <div>
          <label className={labelCls}>Threshold</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={100}
              value={threshold}
              onChange={(e) => setThreshold(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
              className={`${inputCls} w-24`}
            />
            <span className="text-xs text-muted">consecutive matching run(s) before alerting</span>
          </div>
        </div>

        {/* ── Custom message ── */}
        <div>
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={customize} onChange={(e) => setCustomize(e.target.checked)} />
            Customize the message for this job
          </label>
          {customize && (
            <MessageEditor
              channelType={activeType}
              hasSubject={meta.hasSubject}
              event={EVENT_FOR[[...statuses][0] ?? 'FAILED']}
              subject={subject}
              body={body}
              onSubject={setSubject}
              onBody={setBody}
            />
          )}
        </div>

        {error && <p className="text-xs text-err">{error}</p>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm font-medium">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy || statuses.size === 0}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
          >
            {busy ? 'Saving…' : editing ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeTab({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
        active ? 'bg-accent text-white' : 'border border-line text-muted hover:text-fg'
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

interface Preview {
  subject: string | null;
  body: string;
  warning: string | null;
}

function MessageEditor({
  channelType,
  hasSubject,
  event,
  subject,
  body,
  onSubject,
  onBody,
}: {
  channelType: ChannelType;
  hasSubject: boolean;
  event: string;
  subject: string;
  body: string;
  onSubject: (v: string) => void;
  onBody: (v: string) => void;
}) {
  // The variable catalog comes from the shared templates payload so the inserter
  // never drifts from what the renderer understands.
  const { data: tpl } = useSWR<TemplatesPayload>('/templates', () => fetcher<TemplatesPayload>('/templates'));
  const [preview, setPreview] = useState<Preview | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const lastFocused = useRef<'subject' | 'body'>('body');

  const variables: TemplateVariable[] = (tpl?.variables ?? []).filter(
    (v) => v.scope === 'all' || v.scope === 'failure',
  );

  // Live preview against the sample context (same endpoint the templates editor
  // uses). Debounced; preview errors are swallowed.
  useEffect(() => {
    const h = setTimeout(async () => {
      try {
        const p = await api<Preview>('/templates/preview', {
          method: 'POST',
          body: { event, channel: channelType, subject: hasSubject ? subject : '', body },
        });
        setPreview(p);
      } catch {
        /* ignore */
      }
    }, 350);
    return () => clearTimeout(h);
  }, [event, channelType, hasSubject, subject, body]);

  function insertVar(key: string) {
    const token = `{{ ${key} }}`;
    if (lastFocused.current === 'subject' && hasSubject) {
      const el = subjectRef.current;
      const pos = el?.selectionStart ?? subject.length;
      onSubject(subject.slice(0, pos) + token + subject.slice(pos));
    } else {
      const el = bodyRef.current;
      const pos = el?.selectionStart ?? body.length;
      onBody(body.slice(0, pos) + token + body.slice(pos));
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-lg border border-line bg-surface p-3">
      {hasSubject && (
        <div>
          <label className={labelCls}>Subject</label>
          <input
            ref={subjectRef}
            value={subject}
            onFocus={() => (lastFocused.current = 'subject')}
            onChange={(e) => onSubject(e.target.value)}
            className={inputCls}
          />
        </div>
      )}
      <div>
        <label className={labelCls}>Message</label>
        <textarea
          ref={bodyRef}
          value={body}
          onFocus={() => (lastFocused.current = 'body')}
          onChange={(e) => onBody(e.target.value)}
          rows={channelType === 'WEBHOOK' ? 7 : 4}
          placeholder="Leave blank to use the workspace template."
          className={`${inputCls} resize-y font-mono text-xs`}
        />
      </div>

      {/* Variable palette */}
      <div>
        <span className="mb-1 block text-[11px] font-medium text-faint">Insert variable</span>
        <div className="flex flex-wrap gap-1">
          {variables.map((v) => (
            <button
              key={v.key}
              onClick={() => insertVar(v.key)}
              title={`${v.label} — e.g. ${v.sample}`}
              className="rounded-md border border-line px-2 py-0.5 font-mono text-[11px] text-muted hover:border-accent hover:text-accent-fg"
            >
              {v.key}
            </button>
          ))}
        </div>
      </div>

      {/* Live preview */}
      <div>
        <span className="mb-1 block text-[11px] font-medium text-faint">Preview</span>
        <div className="rounded-lg border border-line bg-surface2 p-3 text-xs">
          {hasSubject && preview?.subject && <div className="mb-1 font-semibold">{preview.subject}</div>}
          <pre className="whitespace-pre-wrap break-words font-sans text-muted">
            {preview?.body || <span className="text-faint">…</span>}
          </pre>
          {preview?.warning && <p className="mt-2 text-[11px] text-warn">⚠ {preview.warning}</p>}
        </div>
      </div>
    </div>
  );
}
