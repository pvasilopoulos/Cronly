import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

const EVENTS = ['job.failed', 'job.timeout', 'job.dead_letter', 'job.warning', 'job.success', 'heartbeat.missed'];
const CHANNELS = ['INAPP', 'EMAIL', 'SLACK', 'WEBHOOK', 'TELEGRAM'];

export class UpsertTemplateDto {
  @IsIn(EVENTS) event!: string;
  @IsIn(CHANNELS) channel!: string;
  @IsOptional() @IsString() @MaxLength(400) subject?: string | null;
  @IsString() @MaxLength(8000) body!: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class PreviewTemplateDto {
  @IsIn(EVENTS) event!: string;
  @IsIn(CHANNELS) channel!: string;
  @IsOptional() @IsString() @MaxLength(400) subject?: string | null;
  @IsString() @MaxLength(8000) body!: string;
}
