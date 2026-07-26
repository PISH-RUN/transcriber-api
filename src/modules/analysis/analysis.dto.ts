import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AnalysisFormat } from './analysis.entity';

export class CreateAnalysisDto {
  @ApiProperty({ description: 'رونویسی‌ای که این تحلیل برای آن است' })
  @IsInt()
  transcription_id: number;

  @ApiProperty({ example: 'شناسنامه ویس' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  title: string;

  @ApiProperty({
    required: false,
    description: 'کلید نوع تحلیل از تاکسونومی همان پروژه',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  kind?: string;

  @ApiProperty({ required: false, description: 'توضیح تحلیل و روش تولید آن' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    enum: AnalysisFormat,
    default: AnalysisFormat.MARKDOWN,
    description: 'قالب متن تحلیل برای رندر',
  })
  @IsEnum(AnalysisFormat)
  format: AnalysisFormat;

  @ApiProperty({ description: 'متن تحلیل' })
  @IsNotEmpty()
  @IsString()
  content: string;

  @ApiProperty({ required: false, example: 'Gemini 2.5 Pro' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  source?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}

export class UpdateAnalysisDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  kind?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiProperty({ required: false, enum: AnalysisFormat })
  @IsOptional()
  @IsEnum(AnalysisFormat)
  format?: AnalysisFormat;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  source?: string | null;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}
