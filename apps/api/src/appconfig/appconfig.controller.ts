import { Body, Controller, ForbiddenException, Get, Patch } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, Public } from '../auth/decorators';
import type { AuthUser } from '../auth/jwt.strategy';
import { AppConfigService } from './appconfig.service';

class UpdateAppConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  name?: string;

  /** A short glyph or emoji. 16 chars allows multi-codepoint (ZWJ) emoji. */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  icon?: string;

  /**
   * Optional custom logo as an image data: URL, or '' to clear it. The service
   * validates the media type and size; the bound here is a coarse guard rail.
   */
  @IsOptional()
  @IsString()
  @MaxLength(750_000)
  logo?: string;

  /** Brand-mark display size in px for the console shell (clamped server-side). */
  @IsOptional()
  @IsInt()
  @Min(16)
  @Max(96)
  logoScale?: number;

  /** Custom browser-tab favicon as an image data: URL, or '' to clear it. */
  @IsOptional()
  @IsString()
  @MaxLength(400_000)
  favicon?: string;

  /** Ordered nav hrefs for the mobile/tablet footer bar (e.g. ["/jobs","/runs"]). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  mobileNav?: string[];
}

/**
 * Instance branding. Reading is public — the sign-in screen and the console
 * shell render the app name/icon before (and without) a tenant context. Writing
 * is restricted to a verified platform super-admin; there is no tenant here, so
 * the check is on the authenticated user, not a tenant permission.
 */
@ApiTags('App config')
@Controller('app-config')
export class AppConfigController {
  constructor(private readonly svc: AppConfigService) {}

  @Public()
  @Get()
  get() {
    return this.svc.get();
  }

  @Patch()
  async update(@CurrentUser() user: AuthUser, @Body() dto: UpdateAppConfigDto) {
    if (!user?.isSuperAdmin) {
      throw new ForbiddenException('Only a platform super-admin can change branding');
    }
    return this.svc.update({
      name: dto.name,
      icon: dto.icon,
      logo: dto.logo,
      logoScale: dto.logoScale,
      favicon: dto.favicon,
      mobileNav: dto.mobileNav,
    });
  }
}
