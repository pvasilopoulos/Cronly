import { IsString, MinLength, Matches } from 'class-validator';

export class CreateSecretDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_.\-]+$/, { message: 'name must match [A-Za-z0-9_.-]' })
  name!: string;

  @IsString()
  @MinLength(1)
  value!: string;
}
