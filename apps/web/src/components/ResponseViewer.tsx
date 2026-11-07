'use client';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { api, fetcher } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fmtMs, fmtSize } from '@/lib/format';
import type { Run } from '@/lib/types';
import { RunPill } from './ui';

const INLINE_LIMIT = 256 * 1024; // show inline; above this, note streaming/virtualization

/** Extract the charset label from a Content-Type header (defaults to utf-8). */
function charsetFrom(contentType: string | null | undefined): string {
  const m = /charset=([^;]+)/i.exec(contentType ?? '');
  return (m?.[1] ?? 'utf-8').trim().toLowerCase().replace(/["']/g, '');
}

/**
 * Decode raw bytes using the response's declared charset (e.g. windows-1253 for
 * Greek, iso-8859-7, etc.) instead of assuming UTF-8 — otherwise non-UTF-8 text
 * renders as mojibake (). Falls back to UTF-8 for unknown labels.
 */
function decodeBody(buf: ArrayBuffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function ResponseViewer({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { can } = usePermissions();
  const { data: run } = useSWR<Run>(`/runs/${runId}`, () => fetcher<Run>(`/runs/${runId}`));
  const [body, setBody] = useState<string | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const canView = can('responses:read');
  const size = run?.responseSize ?? 0;
  const isJson = (run?.contentType ?? '').includes('json');
  const isLarge = size > INLINE_LIMIT;

  // `raw: true` bypasses the client's error handling, so we must check the
  // status ourselves — otherwise a 404/500 JSON body is rendered as if it were
  // the response. Turn a non-OK status into a friendly message instead.
  async function readResponse(res: Response): Promise<string> {
    if (!res.ok) {
      let msg = `Could not load response (HTTP ${res.status}).`;
      try {
        const j = await res.json();
        if (j?.message) msg = Array.isArray(j.message) ? j.message.join(', ') : String(j.message);
      } catch {
        /* non-JSON error body — keep the generic message */
      }
      throw new Error(msg);
    }
    // Decode with the server-declared charset so Greek/other encodings render.
    const buf = await res.arrayBuffer();
    const charset = charsetFrom(res.headers.get('content-type') ?? run?.contentType);
    return decodeBody(buf, charset);
  }

  useEffect(() => {
    // Auto-load smaller bodies; larger ones load on demand.
    if (!run || !canView || isLarge) return;
    let active = true;
    setLoadingBody(true);
    setError(null);
    api<Response>(`/runs/${runId}/response`, { raw: true })
      .then(readResponse)
      .then((text) => active && setBody(text))
      .catch((e) => active && setError(String(e?.message ?? e)))
      .finally(() => active && setLoadingBody(false));
    return () => {
      active = false;
    };
  }, [run, runId, canView, isLarge]);

  async function loadFull() {
    setLoadingBody(true);
    setError(null);
    try {
      const res = await api<Response>(`/runs/${runId}/response`, { raw: true });
      setBody(await readResponse(res));
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoadingBody(false);
    }
  }

  // Copy the full response exactly as shown (pretty-printed for JSON).
  async function copyBody() {
    if (body == null) return;
    const text = isJson ? prettyJson(body) : body;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy to clipboard (browser blocked it).');
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-xl flex-col border-l border-line bg-surface shadow-2xl">
        <div className="flex items-start justify-between border-b border-line p-5">
          <div>
            <h2 className="text-lg font-semibold">{run?.job?.name ?? 'Execution'}</h2>
            <code className="font-mono text-xs text-muted">#{runId.slice(-8)}</code>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-xl text-faint hover:bg-surface2">
            ×
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
          {run && (
            <div className="grid grid-cols-2 gap-3">
              <Meta k="Status" v={<RunPill status={run.status} />} />
              <Meta k="Duration" v={fmtMs(run.durationMs)} />
              <Meta k="Response size" v={fmtSize(run.responseSize)} />
              <Meta k="Content-Type" v={<span className="font-mono text-xs">{run.contentType ?? '—'}</span>} />
            </div>
          )}

          {run?.error && (
            <p className="rounded-lg bg-err/10 px-3 py-2 text-sm text-err">{run.error}</p>
          )}

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Response</p>

            {!canView ? (
              <div className="rounded-lg border border-line bg-surface2 p-4 text-sm text-muted">
                You don&apos;t have permission to view responses (<code>responses:read</code>).
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-line">
                <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface2 px-3 py-2 text-xs">
                  <span className="rounded bg-accent-soft px-2 py-0.5 font-mono font-semibold text-accent-fg">
                    {run?.contentType ?? 'unknown'}
                  </span>
                  <span className="font-mono text-muted">{fmtSize(run?.responseSize)}</span>
                  <span className="ml-auto text-faint">
                    {isLarge ? '⬇ object storage (streamed)' : '▣ inline (Postgres)'}
                  </span>
                  {body != null && (
                    <button
                      onClick={copyBody}
                      className="rounded border border-line bg-surface px-2 py-0.5 font-medium text-muted hover:border-accent hover:text-fg"
                      title="Copy the full response"
                    >
                      {copied ? '✓ Copied' : '⧉ Copy'}
                    </button>
                  )}
                </div>
                <div className="max-h-80 overflow-auto bg-surface">
                  {error && <p className="p-4 text-sm text-err">{error}</p>}
                  {loadingBody && <p className="p-4 text-sm text-faint">Loading…</p>}
                  {!loadingBody && body == null && isLarge && (
                    <div className="p-4 text-sm text-muted">
                      <p className="mb-3">
                        This response is {fmtSize(size)}. It is streamed from object storage and
                        rendered in chunks so the browser stays responsive.
                      </p>
                      <button
                        onClick={loadFull}
                        className="rounded-lg border border-line bg-surface2 px-3 py-1.5 font-medium hover:border-faint"
                      >
                        Load full response
                      </button>
                    </div>
                  )}
                  {body != null && (
                    <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed">
                      {isJson ? prettyJson(body) : body}
                    </pre>
                  )}
                  {!loadingBody && body == null && !isLarge && run && size === 0 && (
                    <p className="p-4 text-sm text-faint">No response recorded.</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function Meta({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface2 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-faint">{k}</div>
      <div className="mt-1 text-sm font-semibold">{v}</div>
    </div>
  );
}
