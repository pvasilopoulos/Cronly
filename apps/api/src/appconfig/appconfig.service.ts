import { BadRequestException, Injectable } from '@nestjs/common';
import { jsonArray } from '@cronapp/database';
import { PrismaService } from '../prisma/prisma.service';

/** The single AppConfig row id — there is only ever one. */
const SINGLETON_ID = 'app';
const DEFAULTS = { name: 'CronApp', icon: '◷' } as const;

/** Cap the stored logo data URL. ~700 KB of base64 ≈ a 0.5 MB image — plenty. */
const MAX_LOGO_CHARS = 700_000;
/** Only self-contained image data URLs are accepted (no remote URLs). */
const LOGO_DATA_URL = /^data:image\/(png|jpe?g|webp|gif|svg\+xml);/i;

export interface AppConfigView {
  name: string;
  icon: string;
  logo: string | null;
  logoScale: number;
  favicon: string | null;
  mobileNav: string[];
}

export interface AppConfigPatch {
  name?: string;
  icon?: string;
  /** A data: image URL to set, or '' / null to clear back to the glyph icon. */
  logo?: string | null;
  /** Brand-mark display size (px); clamped to a sensible range. */
  logoScale?: number;
  /** A data: image URL to set as the tab favicon, or '' / null to clear it. */
  favicon?: string | null;
  /** Ordered nav hrefs shown in the mobile/tablet footer bar. */
  mobileNav?: string[];
}

const DEFAULT_LOGO_SCALE = 32;
const MIN_LOGO_SCALE = 16;
const MAX_LOGO_SCALE = 96;

/**
 * Instance-wide branding (app name, icon, optional custom logo). The row carries
 * no tenantId and is not RLS-scoped, so a plain client query is safe. Reads fall
 * back to sensible defaults if the row is somehow missing.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<AppConfigView> {
    const row = await this.prisma.client.appConfig.findUnique({ where: { id: SINGLETON_ID } });
    return {
      name: row?.name ?? DEFAULTS.name,
      icon: row?.icon ?? DEFAULTS.icon,
      logo: row?.logo ?? null,
      logoScale: row?.logoScale ?? DEFAULT_LOGO_SCALE,
      favicon: row?.favicon ?? null,
      mobileNav: jsonArray(row?.mobileNav),
    };
  }

  /** Upsert the singleton. Blank name/icon revert to default; blank logo clears it. */
  async update(patch: AppConfigPatch): Promise<AppConfigView> {
    const data: {
      name?: string;
      icon?: string;
      logo?: string | null;
      logoScale?: number;
      favicon?: string | null;
      mobileNav?: string[];
    } = {};
    if (patch.name !== undefined) data.name = patch.name.trim() || DEFAULTS.name;
    if (patch.icon !== undefined) data.icon = patch.icon.trim() || DEFAULTS.icon;
    if (patch.logo !== undefined) data.logo = this.normalizeLogo(patch.logo);
    if (patch.favicon !== undefined) data.favicon = this.normalizeLogo(patch.favicon);
    if (patch.logoScale !== undefined) {
      data.logoScale = Math.min(MAX_LOGO_SCALE, Math.max(MIN_LOGO_SCALE, Math.round(patch.logoScale)));
    }
    if (patch.mobileNav !== undefined) data.mobileNav = this.normalizeMobileNav(patch.mobileNav);

    const row = await this.prisma.client.appConfig.upsert({
      where: { id: SINGLETON_ID },
      update: data,
      create: { id: SINGLETON_ID, ...DEFAULTS, ...data },
    });
    return {
      name: row.name,
      icon: row.icon,
      logo: row.logo ?? null,
      logoScale: row.logoScale ?? DEFAULT_LOGO_SCALE,
      favicon: row.favicon ?? null,
      mobileNav: jsonArray(row.mobileNav),
    };
  }

  /** Keep only well-formed, de-duplicated route hrefs (e.g. "/jobs"), capped. */
  private normalizeMobileNav(raw: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const h of raw) {
      const href = typeof h === 'string' ? h.trim() : '';
      if (!/^\/[a-z0-9/-]{1,40}$/i.test(href) || seen.has(href)) continue;
      seen.add(href);
      out.push(href);
      if (out.length >= 6) break; // a footer bar fits ~5 items comfortably
    }
    return out;
  }

  /** Validate an incoming logo: a bounded image data URL, or null to clear. */
  private normalizeLogo(raw: string | null): string | null {
    const value = (raw ?? '').trim();
    if (!value) return null;
    if (!LOGO_DATA_URL.test(value)) {
      throw new BadRequestException('Logo must be an image file (PNG, JPEG, WebP, GIF or SVG).');
    }
    if (value.length > MAX_LOGO_CHARS) {
      throw new BadRequestException('Logo is too large — use an image under ~0.5 MB.');
    }
    return value;
  }
}
