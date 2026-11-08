import { Body, Controller, Get, Headers, Ip, Post, Req } from '@nestjs/common';
import { IsEmail, IsString, Length, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { Public, CurrentUser } from './decorators';
import type { AuthUser } from './jwt.strategy';
import { RateLimit } from '../common/rate-limit.guard';

class LoginDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(6) password!: string;
}

class MfaLoginDto {
  @IsString() mfaToken!: string;
  @IsString() @Length(6, 9) code!: string; // 6-digit TOTP or xxxx-xxxx backup
}

class RefreshDto {
  @IsString() refreshToken!: string;
}

class ForgotPasswordDto {
  @IsEmail() email!: string;
}

class ResetPasswordDto {
  @IsString() token!: string;
  @IsString() @MinLength(8) password!: string;
}

class ChangePasswordDto {
  @IsString() currentPassword!: string;
  @IsString() @MinLength(8) newPassword!: string;
}

class CodeDto {
  @IsString() @Length(6, 9) code!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private ctx(req: Request, ua?: string, ip?: string) {
    return { userAgent: ua, ip: ip ?? req.ip };
  }

  // ── Login ──
  @Public()
  @RateLimit({ limit: 20, windowMs: 60_000, name: 'login' })
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request, @Headers('user-agent') ua?: string, @Ip() ip?: string) {
    return this.auth.login(dto.email, dto.password, this.ctx(req, ua, ip));
  }

  @Public()
  @RateLimit({ limit: 20, windowMs: 60_000, name: 'login-mfa' })
  @Post('login/mfa')
  loginMfa(@Body() dto: MfaLoginDto, @Req() req: Request, @Headers('user-agent') ua?: string, @Ip() ip?: string) {
    return this.auth.loginMfa(dto.mfaToken, dto.code, this.ctx(req, ua, ip));
  }

  @Public()
  @Post('refresh')
  refresh(@Body() dto: RefreshDto, @Req() req: Request, @Headers('user-agent') ua?: string, @Ip() ip?: string) {
    return this.auth.refresh(dto.refreshToken, this.ctx(req, ua, ip));
  }

  // ── Session invalidation ──
  @Public()
  @Post('logout')
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @Post('logout-all')
  logoutAll(@CurrentUser() user: AuthUser) {
    return this.auth.logoutAll(user.userId);
  }

  // ── Password reset ──
  @Public()
  @RateLimit({ limit: 5, windowMs: 60_000, name: 'forgot-password' })
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.email);
  }

  @Public()
  @RateLimit({ limit: 10, windowMs: 60_000, name: 'reset-password' })
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.token, dto.password);
  }

  // ── Change password (authenticated: current password required) ──
  @RateLimit({ limit: 10, windowMs: 60_000, name: 'change-password' })
  @Post('change-password')
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.userId, dto.currentPassword, dto.newPassword);
  }

  // ── Two-factor (TOTP) ── (all require an authenticated session)
  @Get('2fa')
  twoFactorStatus(@CurrentUser() user: AuthUser) {
    return this.auth.twoFactorStatus(user.userId);
  }

  @Post('2fa/setup')
  setup2fa(@CurrentUser() user: AuthUser) {
    return this.auth.setupTwoFactor(user.userId);
  }

  @Post('2fa/enable')
  enable2fa(@CurrentUser() user: AuthUser, @Body() dto: CodeDto) {
    return this.auth.enableTwoFactor(user.userId, dto.code);
  }

  @Post('2fa/disable')
  disable2fa(@CurrentUser() user: AuthUser, @Body() dto: CodeDto) {
    return this.auth.disableTwoFactor(user.userId, dto.code);
  }
}
