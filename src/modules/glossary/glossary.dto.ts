import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class GlossaryMentionInputDto {
  @ApiProperty({ description: 'رونویسی‌ای که واژه از آن انتخاب شده' })
  @IsInt()
  transcription_id: number;

  @ApiProperty({ required: false, description: 'شماره خط (نوبت گوینده)' })
  @IsOptional()
  @IsInt()
  segment_index?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  start_offset?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  end_offset?: number;

  @ApiProperty({ required: false, description: 'متن دقیقی که انتخاب شده' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  surface?: string;

  @ApiProperty({ required: false, description: 'متن اطراف برای نمایش' })
  @IsOptional()
  @IsString()
  context?: string;

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

export class CreateGlossaryTermDto {
  @ApiProperty({ description: 'پروژه‌ای که این واژه‌نامه به آن تعلق دارد' })
  @IsInt()
  project_id: number;

  @ApiProperty({ example: 'قطران' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  term: string;

  @ApiProperty({
    example: 'company',
    description: 'کلید دسته‌بندی از تاکسونومی همان پروژه',
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(64)
  category: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    required: false,
    type: GlossaryMentionInputDto,
    description:
      'اگر واژه از دل یک متن انتخاب شده، همان انتخاب به‌عنوان اولین ارجاع ثبت می‌شود',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => GlossaryMentionInputDto)
  mention?: GlossaryMentionInputDto;
}

export class UpdateGlossaryTermDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  term?: string;

  @ApiProperty({
    required: false,
    description: 'کلید دسته‌بندی از تاکسونومی همان پروژه',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  category?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string | null;
}
