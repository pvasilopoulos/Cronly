import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const OVERLAP_POLICIES = ['ALLOW', 'SKIP', 'QUEUE'] as const;

export class CreateJobDto {
  @IsString() @MinLength(2) name!: string;
  @IsString() handler!: string;
  @IsString() cronExpr!: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsObject() payload?: Record<string, unknown>;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsString() @MaxLength(40) group?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10) maxRetries?: number;
  @IsOptional() @IsInt() @Min(1000) @Max(600000) timeoutMs?: number;
  @IsOptional() @IsString() concurrencyKey?: string;
  @IsOptional() @IsIn(OVERLAP_POLICIES) overlapPolicy?: (typeof OVERLAP_POLICIES)[number];
  @IsOptional() @IsBoolean() missedAlertEnabled?: boolean;

  // Optional human context.
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsString() @MaxLength(500) runbookUrl?: string;

  // Optional schedule window (ISO-8601); '' / null clears.
  @IsOptional() @IsISO8601() startsAt?: string | null;
  @IsOptional() @IsISO8601() endsAt?: string | null;

  // When set, a failure alert rule for this job is created against this channel.
  @IsOptional() @IsString() alertChannelId?: string;

  // Create the job paused (enabled=false) instead of active.
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class UpdateJobDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsString() cronExpr?: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsObject() payload?: Record<string, unknown>;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsString() @MaxLength(40) group?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10) maxRetries?: number;
  @IsOptional() @IsInt() @Min(1000) @Max(600000) timeoutMs?: number;
  @IsOptional() @IsString() concurrencyKey?: string;
  @IsOptional() @IsIn(OVERLAP_POLICIES) overlapPolicy?: (typeof OVERLAP_POLICIES)[number];
  @IsOptional() @IsBoolean() missedAlertEnabled?: boolean;
  @IsOptional() @IsBoolean() enabled?: boolean;

  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsString() @MaxLength(500) runbookUrl?: string;
  // Pass an ISO string to set, or '' / null to clear the window boundary.
  @IsOptional() @IsString() startsAt?: string | null;
  @IsOptional() @IsString() endsAt?: string | null;
}
