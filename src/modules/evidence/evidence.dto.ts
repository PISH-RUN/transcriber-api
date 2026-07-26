import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateEvidenceDto {
  @ApiProperty({ description: 'پروژه‌ای که شواهد به آن اضافه می‌شود' })
  @IsInt()
  project_id: number;

  @ApiProperty({ required: false, description: 'رونویسی مبدأ' })
  @IsOptional()
  @IsInt()
  transcription_id?: number;

  @ApiProperty({
    example: 'decision',
    description: 'کلید نوع شواهد از تاکسونومی همان پروژه',
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(64)
  type: string;

  @ApiProperty({ description: 'متن انتخاب‌شده (نقل‌قول)' })
  @IsNotEmpty()
  @IsString()
  quote: string;

  @ApiProperty({ required: false, description: 'توضیح بازبین' })
  @IsOptional()
  @IsString()
  note?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  segment_index?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  speaker_label?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  start_ms?: number;
}

export class UpdateEvidenceDto {
  @ApiProperty({
    required: false,
    description: 'کلید نوع شواهد از تاکسونومی همان پروژه',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  type?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  quote?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  note?: string | null;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
