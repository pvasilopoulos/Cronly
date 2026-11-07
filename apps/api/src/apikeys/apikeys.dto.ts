import { ArrayNotEmpty, IsArray, IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateApiKeyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  /** Permission keys this key may exercise. Must be a subset of the creator's. */
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  scopes!: string[];

  /** Optional ISO-8601 expiry. Omit for a non-expiring key. */
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
