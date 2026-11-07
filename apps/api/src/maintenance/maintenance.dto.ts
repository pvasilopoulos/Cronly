import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateMaintenanceWindowDto {
  @IsOptional() @IsString() @MaxLength(120) label?: string;
  @IsISO8601() startsAt!: string;
  @IsISO8601() endsAt!: string;
}
