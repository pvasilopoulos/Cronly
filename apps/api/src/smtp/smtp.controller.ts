import { Body, Controller, ForbiddenException, Get, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../auth/jwt.strategy';
import { SmtpService } from './smtp.service';

class UpdateSmtpDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsIn(['smtp', 'microsoft365', 'gmail']) provider?: string;
  // SMTP
  @IsOptional() @IsString() @MaxLength(255) host?: string;
  @IsOptional() @IsInt() @Min(1) @Max(65535) port?: number;
  @IsOptional() @IsBoolean() secure?: boolean;
  @IsOptional() @IsString() @MaxLength(255) username?: string;
  @IsOptional() @IsString() @MaxLength(255) fromAddr?: string;
  @IsOptional() @IsString() @MaxLength(512) password?: string;
  @IsOptional() @IsBoolean() clearPassword?: boolean;
  // Microsoft 365
  @IsOptional() @IsString() @MaxLength(100) msTenantId?: string;
  @IsOptional() @IsString() @MaxLength(100) msClientId?: string;
  @IsOptional() @IsString() @MaxLength(512) msClientSecret?: string;
  @IsOptional() @IsBoolean() clearMsSecret?: boolean;
  // Gmail — full service-account JSON (parsed server-side).
  @IsOptional() @IsString() @MaxLength(8000) gmailServiceAccount?: string;
  @IsOptional() @IsBoolean() clearGmailKey?: boolean;
}

class TestSmtpDto {
  @IsEmail() to!: string;
}

/**
 * Instance SMTP settings — super-admin only (infrastructure config, and the
 * fields reveal the mail host/user). There is no tenant here, so the gate is on
 * the authenticated user, like branding.
 */
@ApiTags('SMTP')
@Controller('smtp')
export class SmtpController {
  constructor(private readonly svc: SmtpService) {}

  private assertAdmin(user: AuthUser) {
    if (!user?.isSuperAdmin) {
      throw new ForbiddenException('Only a platform super-admin can manage SMTP settings');
    }
  }

  @Get()
  get(@CurrentUser() user: AuthUser) {
    this.assertAdmin(user);
    return this.svc.get();
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateSmtpDto) {
    this.assertAdmin(user);
    return this.svc.update(dto);
  }

  @Post('test')
  test(@CurrentUser() user: AuthUser, @Body() dto: TestSmtpDto) {
    this.assertAdmin(user);
    return this.svc.sendTest(dto.to);
  }
}
