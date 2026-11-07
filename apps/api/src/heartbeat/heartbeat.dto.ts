import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class ConfigureHeartbeatDto {
  // How often the job is expected to ping or succeed, in seconds.
  // Min 30s (avoid chatty monitors), max 30d.
  @IsInt() @Min(30) @Max(2_592_000) intervalSec!: number;

  // Extra slack before a late job is considered MISSING. Default 60s.
  @IsOptional() @IsInt() @Min(0) @Max(86_400) graceSec?: number;
}
