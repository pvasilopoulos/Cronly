'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { api, ApiError, fetcher } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePermissions } from '@/lib/permissions';
import type { TemplatesPayload, EffectiveTemplate, TemplateVariable } from '@/lib/types';

interface Preview {
  subject: string | null;
  body: string;
  warning: string | null;
}

/**
 * Per-workspace message templates. Admins (alerts:manage) edit the TEXT of every
 * outbound message — in-app/push, email, Slack, webhook — per event, with
 * {{ variable }} placeholders and a live preview rendered against sample data.
 */
export function TemplatesPanel() {
  const { activeTenant } = useAuth();
  const { can } = usePermissions();
  const canEdit = can('alerts:manage');

  const { data, mutate } = useSWR<TemplatesPayload>(
    canEdit && activeTenant ? ['/templates', activeTenant.id] : null,
    ([p]: [string]) => fetcher<TemplatesPayload>(p),
  );

  const [event, setEvent] = useState('job.failed');
  const [channel, setChannel] = useState('INAPP');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastFocused = useRef<'subject' | 'body'>('body');

  const current: EffectiveTemplate | undefined = useMemo(
    () => data?.templates.find((t) => t.event === event && t.channel === channel),
    [data, event, channel],
  );
  const channelMeta = data?.channels.find((c) => c.key === channel);

  // Seed the editor from the effective template whenever the selection changes.
  useEffect(() => {
    if (!current) return;
    setSubject(current.subject ?? '');
    setBody(current.body);
    setEnabled(current.enabled);
    setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, channel, data]);

  // Live preview (debounced) against sample data.
  useEffect(() => {
    if (!canEdit) return;
    const h = setTimeout(async () => {
      try {
        const p = await api<Preview>('/templates/preview', {
          method: 'POST',
          body: { event, channel, subject, body },
        });
        setPreview(p);
      } catch {
        /* ignore preview errors */
      }
    }, 350);
    return () => clearTimeout(h);
  }, [event, channel, subject, body, canEdit]);

  if (!canEdit) return null;

  const variables: TemplateVariable[] = (data?.variables ?? []).filter(
    (v) => v.scope === 'all' || (event === 'heartbeat.missed' ? v.scope === 'heartbeat' : v.scope === 'failure'),
  );

  function insertVar(key: string) {
    const token = `{{ ${key} }}`;
    if (lastFocused.current === 'subject' && channelMeta?.hasSubject) {
      const el = subjectRef.current;
      const pos = el?.selectionStart ?? subject.length;
      setSubject(subject.slice(0, pos) + token + subject.slice(pos));
    } else {
      const el = bodyRef.current;
      const pos = el?.selectionStart ?? body.length;
      setBody(body.slice(0, pos) + token + body.slice(pos));
    }
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await api('/templates', {
        method: 'PUT',
        body: { event, channel, subject: channelMeta?.hasSubject ? subject : undefined, body, enabled },
      });
      await mutate();
      setSavedAt(Date.now());
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save template');
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefault() {
    setResetting(true);
    setErr(null);
    try {
      await api(`/templates/${event}/${channel}`, { method: 'DELETE' });
      await mutate();
      setSavedAt(Date.now());
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not reset template');
    } finally {
      setResetting(false);
    }
  }

  const dirty =
    !!current &&
    (body !== current.body ||
      (channelMeta?.hasSubject ? subject !== (current.subject ?? '') : false) ||
      enabled !== current.enabled);

  const inputCls =
    'w-full rounded-lg border border-line bg-surface2 px-3 py-2 text-sm outline-none focus:border-accent';

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-faint">Message templates</h2>
        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-fg">
          Admin
        </span>
      </div>
      <p className="mb-4 text-xs text-muted">
        Customise the wording of each notification with variables like{' '}
        <code className="rounded bg-surface2 px-1">{'{{ job.name }}'}</code>. Leave a channel untouched to
        use the built-in default.
      </p>

      {!data ? (
        <div className="py-6 text-center text-xs text-faint">Loading templates…</div>
      ) : (
        <>
          {/* Event + channel selectors */}
          <div className="mb-3 flex flex-col gap-2 sm:flex-row">
            <label className="flex-1 text-xs">
              <span className="mb-1 block text-faint">Event</span>
              <select value={event} onChange={(e) => setEvent(e.target.value)} className={inputCls}>
                {data.events.map((ev) => (
                  <option key={ev.key} value={ev.key}>
                    {ev.label} ({ev.severity})
                  </option>
                ))}
              </select>
            </label>
            <div className="flex-1 text-xs">
              <span className="mb-1 block text-faint">Channel</span>
              <div className="flex flex-wrap gap-1">
                {data.channels.map((ch) => (
                  <button
                    key={ch.key}
                    type="button"
                    onClick={() => setChannel(ch.key)}
                    className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
                      channel === ch.key ? 'border-accent bg-accent-soft text-accent-fg' : 'border-line hover:bg-surface2'
                    }`}
                  >
                    {ch.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {channelMeta && <p className="mb-3 text-[11px] text-faint">{channelMeta.note}</p>}

          {/* Status row */}
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            {current?.isCustom ? (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 font-semibold text-accent-fg">Customised</span>
            ) : (
              <span className="rounded-full bg-surface2 px-2 py-0.5 text-muted">Using default</span>
            )}
            <label className="ml-auto flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-3.5 w-3.5 accent-accent" />
              <span className="text-muted">Enabled</span>
            </label>
          </div>

          {/* Variable palette */}
          <div className="mb-2 flex flex-wrap gap-1">
            {variables.map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => insertVar(v.key)}
                title={`${v.label} — e.g. ${v.sample}`}
                className="rounded-md border border-line bg-surface2 px-2 py-1 font-mono text-[10px] text-muted hover:border-accent hover:text-fg"
              >
                {`{{ ${v.key} }}`}
              </button>
            ))}
          </div>

          {/* Editor */}
          {channelMeta?.hasSubject && (
            <label className="mb-2 block text-xs">
              <span className="mb-1 block text-faint">Subject / title</span>
              <input
                ref={subjectRef}
                value={subject}
                onFocus={() => (lastFocused.current = 'subject')}
                onChange={(e) => setSubject(e.target.value)}
                className={inputCls}
              />
            </label>
          )}
          <label className="block text-xs">
            <span className="mb-1 block text-faint">{channelMeta?.json ? 'JSON body' : 'Body'}</span>
            <textarea
              ref={bodyRef}
              value={body}
              onFocus={() => (lastFocused.current = 'body')}
              onChange={(e) => setBody(e.target.value)}
              rows={channelMeta?.json ? 8 : 5}
              className={`${inputCls} font-mono`}
            />
          </label>

          {/* Live preview */}
          <div className="mt-3 rounded-lg border border-line bg-surface2/40 p-3">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-faint">Preview (sample data)</div>
            {preview?.subject != null && preview.subject !== '' && (
              <div className="mb-1 text-sm font-semibold">{preview.subject}</div>
            )}
            <pre className="whitespace-pre-wrap break-words text-xs text-muted">{preview?.body ?? '…'}</pre>
            {preview?.warning && <div className="mt-2 text-[11px] text-err">⚠ {preview.warning}</div>}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={saving || !dirty}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save template'}
            </button>
            {current?.isCustom && (
              <button
                type="button"
                onClick={resetToDefault}
                disabled={resetting}
                className="rounded-lg border border-line px-4 py-2 text-sm font-medium hover:bg-surface2 disabled:opacity-50"
              >
                {resetting ? 'Resetting…' : 'Reset to default'}
              </button>
            )}
            {err && <span className="text-sm text-err">{err}</span>}
            {savedAt > 0 && !err && !saving && !resetting && <span className="text-sm text-ok">Saved</span>}
          </div>
        </>
      )}
    </section>
  );
}
