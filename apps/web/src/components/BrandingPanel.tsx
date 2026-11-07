'use client';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAppConfig, BrandMark } from '@/lib/appConfig';
import type { AppConfig } from '@/lib/types';

// A few tasteful glyphs/emoji an operator can pick in one click.
const ICON_SUGGESTIONS = ['◷', '⏱', '⚡', '🚀', '🛰', '📡', '🔔', '⚙️', '🧭', '📅'];

// Downscale target and hard cap for the stored data URL (server caps at ~700 KB).
const MAX_LOGO_HEIGHT = 96;
const MAX_LOGO_CHARS = 600_000;

/** Turn a chosen image file into a bounded data: URL. SVGs are kept vector; raster
 *  images are drawn onto a canvas at a small height and re-encoded as PNG. */
async function fileToLogoDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image file.');

  if (file.type === 'image/svg+xml') {
    const text = await file.text();
    const url = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
    if (url.length > MAX_LOGO_CHARS) throw new Error('That SVG is too large — try a simpler file.');
    return url;
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('Could not load that image.'));
    i.src = dataUrl;
  });

  const scale = Math.min(1, MAX_LOGO_HEIGHT / (img.height || MAX_LOGO_HEIGHT));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Image processing is not available in this browser.');
  ctx.drawImage(img, 0, 0, w, h);
  const out = canvas.toDataURL('image/png');
  if (out.length > MAX_LOGO_CHARS) throw new Error('Image is too large even after resizing.');
  return out;
}

/**
 * Platform branding (app name, icon, custom logo), editable only by a super-admin.
 * Changes take effect everywhere the shell reads the branding as soon as they're
 * saved. Non-super-admins never see this panel.
 */
export function BrandingPanel() {
  const { user } = useAuth();
  const { config, refresh } = useAppConfig();
  const fileRef = useRef<HTMLInputElement>(null);
  const faviconRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(config.name);
  const [icon, setIcon] = useState(config.icon);
  const [logo, setLogo] = useState<string | null>(config.logo ?? null);
  const [logoScale, setLogoScale] = useState<number>(config.logoScale ?? 32);
  const [favicon, setFavicon] = useState<string | null>(config.favicon ?? null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  // Reseed the draft whenever the live branding changes (e.g. after a save).
  useEffect(() => {
    setName(config.name);
    setIcon(config.icon);
    setLogo(config.logo ?? null);
    setLogoScale(config.logoScale ?? 32);
    setFavicon(config.favicon ?? null);
  }, [config.name, config.icon, config.logo, config.logoScale, config.favicon]);

  if (!user?.isSuperAdmin) return null;

  const trimmedName = name.trim();
  const trimmedIcon = icon.trim();
  const dirty =
    trimmedName !== config.name ||
    trimmedIcon !== config.icon ||
    (logo ?? null) !== (config.logo ?? null) ||
    logoScale !== (config.logoScale ?? 32) ||
    (favicon ?? null) !== (config.favicon ?? null);
  const nameTooLong = trimmedName.length > 40;
  const iconTooLong = trimmedIcon.length > 16;

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    setErr(null);
    try {
      setLogo(await fileToLogoDataUrl(file));
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Could not process that image.');
    }
  }

  async function onPickFavicon(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setErr(null);
    try {
      setFavicon(await fileToLogoDataUrl(file));
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Could not process that image.');
    }
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const next = await api<AppConfig>('/app-config', {
        method: 'PATCH',
        // Send the raw draft; blank name/icon revert to default, '' logo/favicon clears it.
        body: { name, icon, logo: logo ?? '', logoScale, favicon: favicon ?? '' },
      });
      refresh();
      setName(next.name);
      setIcon(next.icon);
      setLogo(next.logo ?? null);
      setLogoScale(next.logoScale ?? 32);
      setFavicon(next.favicon ?? null);
      setSavedAt(Date.now());
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save branding');
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setName(config.name);
    setIcon(config.icon);
    setLogo(config.logo ?? null);
    setLogoScale(config.logoScale ?? 32);
    setFavicon(config.favicon ?? null);
    setErr(null);
  }

  const previewConfig: AppConfig = {
    name: trimmedName || 'CronApp',
    icon: trimmedIcon || '◷',
    logo,
    logoScale,
    favicon,
  };
  const inputCls =
    'w-full rounded-lg border border-line bg-surface2 px-3 py-2 text-sm outline-none focus:border-accent';

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-faint">Branding</h2>
        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-fg">
          Super-admin
        </span>
      </div>
      <p className="mb-4 text-xs text-muted">
        Set the application name, icon and logo shown in the console and on the sign-in screen. Applies
        to the whole instance, for every workspace.
      </p>

      {/* ── Live preview (reflects the configured brand-mark size) ── */}
      <div className="mb-4 flex flex-col items-center gap-2 rounded-lg border border-line bg-surface2/50 p-4 text-center">
        <BrandMark config={previewConfig} scalePx={logoScale} textClass="text-xl" />
        <div className="min-w-0">
          <b className="block truncate text-[15px] leading-tight">{previewConfig.name}</b>
          <span className="block text-[11px] text-faint">Console · live preview</span>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">App name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="CronApp"
            maxLength={60}
            className={inputCls}
          />
          {nameTooLong && <span className="text-xs text-err">Keep the name to 40 characters or fewer.</span>}
        </label>

        {/* ── Custom logo ── */}
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Logo</span>
          <div className="flex items-center gap-3 rounded-lg border border-line bg-surface2/50 p-3">
            <BrandMark config={previewConfig} size="h-10 w-10" textClass="text-lg" />
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                onChange={onPickFile}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="rounded-lg border border-line bg-surface2 px-3 py-1.5 text-sm font-medium hover:border-accent"
              >
                {logo ? 'Replace logo' : 'Upload logo'}
              </button>
              {logo && (
                <button
                  type="button"
                  onClick={() => setLogo(null)}
                  className="text-sm text-muted hover:text-err"
                >
                  Remove
                </button>
              )}
            </div>
          </div>
          <span className="text-xs text-faint">
            PNG, JPEG, WebP, GIF or SVG. Large images are resized automatically. Falls back to the glyph
            icon when no logo is set.
          </span>
        </div>

        {/* ── Brand-mark size ── */}
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">
            Icon size <span className="text-faint">({logoScale}px)</span>
          </span>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={16}
              max={96}
              step={2}
              value={logoScale}
              onChange={(e) => setLogoScale(Number(e.target.value))}
              className="h-2 flex-1 cursor-pointer accent-accent"
            />
            <button
              type="button"
              onClick={() => setLogoScale(32)}
              className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:border-accent"
            >
              Reset
            </button>
          </div>
          <span className="text-xs text-faint">Size of the logo/icon shown at the top of the sidebar.</span>
        </div>

        {/* ── Favicon (browser-tab icon) ── */}
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Favicon</span>
          <div className="flex items-center gap-3 rounded-lg border border-line bg-surface2/50 p-3">
            {favicon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={favicon} alt="Favicon preview" className="h-8 w-8 flex-none rounded border border-line bg-surface object-contain" />
            ) : (
              <span className="grid h-8 w-8 flex-none place-items-center rounded border border-line bg-surface2 text-faint">?</span>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={faviconRef}
                type="file"
                accept="image/png,image/x-icon,image/vnd.microsoft.icon,image/svg+xml,image/webp"
                onChange={onPickFavicon}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => faviconRef.current?.click()}
                className="rounded-lg border border-line bg-surface2 px-3 py-1.5 text-sm font-medium hover:border-accent"
              >
                {favicon ? 'Replace favicon' : 'Upload favicon'}
              </button>
              {favicon && (
                <button type="button" onClick={() => setFavicon(null)} className="text-sm text-muted hover:text-err">
                  Remove
                </button>
              )}
            </div>
          </div>
          <span className="text-xs text-faint">
            The browser-tab icon. A small square PNG or SVG works best; applies as soon as you save.
          </span>
        </div>

        {/* ── Glyph icon (fallback when no logo) ── */}
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Icon {logo && <span className="text-faint">(used when no logo)</span>}</span>
          <div className="flex items-center gap-2">
            <input
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder="◷"
              maxLength={16}
              className="w-20 rounded-lg border border-line bg-surface2 px-3 py-2 text-center text-lg outline-none focus:border-accent"
            />
            <div className="flex flex-wrap gap-1">
              {ICON_SUGGESTIONS.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setIcon(g)}
                  className={`grid h-8 w-8 place-items-center rounded-md border text-base hover:border-accent ${
                    trimmedIcon === g ? 'border-accent bg-accent-soft' : 'border-line bg-surface2'
                  }`}
                  title={`Use ${g}`}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>
          {iconTooLong && <span className="text-xs text-err">Icon must be 16 characters or fewer.</span>}
          <span className="text-xs text-faint">A single emoji or short glyph works best.</span>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          disabled={!dirty || saving || nameTooLong || iconTooLong}
          onClick={save}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save branding'}
        </button>
        {dirty && !saving && (
          <button type="button" onClick={reset} className="text-sm text-muted hover:text-fg">
            Discard
          </button>
        )}
        {err && <span className="text-sm text-err">{err}</span>}
        {!dirty && savedAt > 0 && !err && <span className="text-sm text-ok">Saved</span>}
      </div>
    </section>
  );
}
