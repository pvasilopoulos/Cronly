import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const CHANNEL_TYPES = ['EMAIL', 'SLACK', 'WEBHOOK', 'TELEGRAM'] as const;
export const ALERT_STATUSES = ['FAILED', 'TIMEOUT', 'DEAD_LETTER', 'WARNING', 'SUCCESS'] as const;

export class CreateChannelDto {
  @IsIn(CHANNEL_TYPES) type!: (typeof CHANNEL_TYPES)[number];
  @IsString() @MinLength(1) name!: string;
  @IsString() @MinLength(1) target!: string; // email / Slack webhook / webhook URL
  @IsOptional() @IsString() signingSecret?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class CreateRuleDto {
  @IsString() channelId!: string;
  @IsOptional() @IsString() jobId?: string; // omit → applies to all jobs
  @IsOptional() @IsInt() @Min(1) @Max(100) threshold?: number;
  @IsOptional() @IsArray() @IsIn(ALERT_STATUSES, { each: true })
  onStatuses?: (typeof ALERT_STATUSES)[number][];
  @IsOptional() @IsBoolean() enabled?: boolean;
  // Minimum seconds between notifications for this rule (0 = no throttle).
  @IsOptional() @IsInt() @Min(0) @Max(2592000) muteSec?: number;
  // Optional per-rule message override (blank → workspace template → default).
  @IsOptional() @IsString() @MaxLength(400) subject?: string;
  @IsOptional() @IsString() @MaxLength(8000) body?: string;
}

// Partial update of an existing rule (used by the per-job notifications editor).
export class UpdateRuleDto {
  @IsOptional() @IsString() channelId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) threshold?: number;
  @IsOptional() @IsArray() @IsIn(ALERT_STATUSES, { each: true })
  onStatuses?: (typeof ALERT_STATUSES)[number][];
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(2592000) muteSec?: number;
  @IsOptional() @IsString() @MaxLength(400) subject?: string;
  @IsOptional() @IsString() @MaxLength(8000) body?: string;
}
