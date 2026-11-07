import { IsArray, IsBoolean, IsDefined, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdatePrefsDto {
  @IsOptional() @IsArray() @IsString({ each: true }) events?: string[];
  @IsOptional() @IsBoolean() browser?: boolean;
  @IsOptional() @IsString() @MaxLength(5) quietStart?: string | null;
  @IsOptional() @IsString() @MaxLength(5) quietEnd?: string | null;
  @IsOptional() @IsString() @MaxLength(64) quietTz?: string;
}

export class MarkReadDto {
  @IsArray() @IsString({ each: true }) ids!: string[];
}

export class PushSubscribeDto {
  @IsString() @MaxLength(1024) endpoint!: string;
  @IsDefined() @IsObject() keys!: { p256dh: string; auth: string };
  @IsOptional() @IsString() @MaxLength(256) ua?: string;
}

export class PushUnsubscribeDto {
  @IsString() @MaxLength(1024) endpoint!: string;
}
