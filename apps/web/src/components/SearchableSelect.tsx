'use client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

export interface ComboOption {
  value: string;
  label: string;
  hint?: string;
}

/** Case-insensitive match that returns a score (lower = better) or -1 for no
 *  match. Exact → prefix → word-start → substring → fuzzy subsequence, so the
 *  most relevant options float to the top as you type. */
function score(label: string, q: string): number {
  const s = label.toLowerCase();
  if (!q) return 0;
  if (s === q) return 0;
  if (s.startsWith(q)) return 1;
  if (s.includes(` ${q}`)) return 2;
  const idx = s.indexOf(q);
  if (idx !== -1) return 3 + idx / 100;
  // fuzzy subsequence: every char of q appears in order
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length ? 50 : -1;
}

/**
 * Accessible, keyboard-driven combobox: type to filter, ↑/↓ to move, Enter to
 * pick, Esc to close, click-away to dismiss. A drop-in smarter replacement for a
 * plain <select> when the list is long enough to want search.
 */
export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Type to search…',
  allowClear = true,
  clearLabel = 'All',
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ComboOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  allowClear?: boolean;
  clearLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const scored = options
      .map((o) => ({ o, s: Math.min(score(o.label, q), o.hint ? score(o.hint, q) + 4 : Infinity) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s);
    return scored.map((x) => x.o);
  }, [options, query]);

  // Clamp the active row whenever the filtered list changes.
  useEffect(() => {
    setActive((a) => Math.max(0, Math.min(a, filtered.length - 1)));
  }, [filtered.length]);

  // Focus the search box when opening; reset query when closing.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  // Click-away to close.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function choose(v: string) {
    onChange(v);
    setOpen(false);
  }

  // Rows = optional "clear" row + filtered options.
  const rows: ({ clear: true } | { clear: false; o: ComboOption })[] = [
    ...(allowClear && !query ? [{ clear: true as const }] : []),
    ...filtered.map((o) => ({ clear: false as const, o })),
  ];

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[active];
      if (row) choose(row.clear ? '' : row.o.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  }

  const triggerCls =
    'flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-surface2 px-3 py-2 text-left text-sm outline-none focus:border-accent disabled:opacity-60';

  return (
    <div ref={rootRef} className="relative">
      <button type="button" disabled={disabled} onClick={() => setOpen((o) => !o)} className={triggerCls}>
        <span className={selected ? '' : 'text-faint'}>{selected ? selected.label : placeholder}</span>
        <span className="flex items-center gap-1">
          {allowClear && selected && (
            <span
              role="button"
              tabIndex={-1}
              aria-label="Clear"
              onClick={(e) => {
                e.stopPropagation();
                choose('');
              }}
              className="rounded px-1 text-faint hover:text-err"
            >
              ✕
            </span>
          )}
          <span className="text-faint">▾</span>
        </span>
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
          <div className="border-b border-line p-1.5">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              className="w-full rounded-md bg-surface2 px-2.5 py-1.5 text-sm outline-none"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
            />
          </div>
          <ul id={listId} role="listbox" className="max-h-60 overflow-y-auto py-1">
            {rows.length === 0 && <li className="px-3 py-2 text-sm text-faint">No matches</li>}
            {rows.map((row, i) => {
              const isActive = i === active;
              const isSel = row.clear ? value === '' : row.o.value === value;
              return (
                <li
                  key={row.clear ? '__clear' : row.o.value}
                  role="option"
                  aria-selected={isSel}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(row.clear ? '' : row.o.value)}
                  className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-sm ${
                    isActive ? 'bg-accent-soft text-accent-fg' : ''
                  }`}
                >
                  <span className={`truncate ${row.clear ? 'text-muted' : ''}`}>
                    {row.clear ? clearLabel : row.o.label}
                    {!row.clear && row.o.hint && (
                      <span className="ml-2 text-xs text-faint">{row.o.hint}</span>
                    )}
                  </span>
                  {isSel && <span className="text-accent">✓</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
