import { ArrayNotEmpty, ArrayMaxSize, IsArray, IsString } from 'class-validator';

export class ReplayManyDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  runIds!: string[];
}
