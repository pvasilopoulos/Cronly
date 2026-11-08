import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateDigestDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  // Hour of day (0–23), in the tenant's timezone, at which the digest is sent.
  @IsOptional() @IsInt() @Min(0) @Max(23) hour?: number;
}
