import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
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
    example: 'نیازمند تأیید',
    description: 'وضعیت بررسی واژه؛ متن آزاد از واژگان خود بازبین',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  status?: string;

  @ApiProperty({ required: false, enum: ['manual', 'import', 'ai'] })
  @IsOptional()
  @IsIn(['manual', 'import', 'ai'])
  origin?: 'manual' | 'import' | 'ai';

  @ApiProperty({ required: false, description: 'اهمیت ۱ تا ۵' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  importance?: number;

  @ApiProperty({ required: false, description: 'اطمینان ۰ تا ۱' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;

  @ApiProperty({ required: false, description: 'نیازمند بازبینی انسانی' })
  @IsOptional()
  @IsBoolean()
  needs_review?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  review_note?: string;

  @ApiProperty({ required: false, description: 'باقی خروجی مدل، برای گم نشدن' })
  @IsOptional()
  @IsObject()
  ai_meta?: Record<string, unknown>;

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

  @ApiProperty({ required: false, description: 'وضعیت بررسی واژه' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  status?: string | null;

  @ApiProperty({ required: false, description: 'اهمیت ۱ تا ۵' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  importance?: number | null;

  @ApiProperty({
    required: false,
    description: 'با بازبینی دستی می‌توان پرچم نیازمند بازبینی را پاک کرد',
  })
  @IsOptional()
  @IsBoolean()
  needs_review?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  review_note?: string | null;
}

/** One row of a structured bulk import (alternative to the Markdown table). */
export class ImportGlossaryTermDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  term: string;

  @ApiProperty({
    description: 'عنوان فارسی دسته یا کلید آن؛ با تاکسونومی پروژه تطبیق می‌شود',
  })
  @IsNotEmpty()
  @IsString()
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

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  status?: string;
}

export class ImportGlossaryDto {
  @ApiProperty({ description: 'پروژه‌ای که واژه‌نامه به آن اضافه می‌شود' })
  @IsInt()
  project_id: number;

  @ApiProperty({
    required: false,
    description:
      'جدول مارک‌داون واژه‌نامه؛ ستون‌ها بر اساس نام سرستون خوانده می‌شوند',
  })
  @IsOptional()
  @IsString()
  markdown?: string;

  @ApiProperty({
    required: false,
    type: [ImportGlossaryTermDto],
    description: 'جایگزین ساختاریافته برای markdown',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportGlossaryTermDto)
  terms?: ImportGlossaryTermDto[];

  @ApiProperty({
    required: false,
    description: 'رونویسی هدف برای اسکن ارجاع‌ها (وقتی scan=transcription)',
  })
  @IsOptional()
  @IsInt()
  transcription_id?: number;

  @ApiProperty({
    required: false,
    enum: ['none', 'transcription', 'project'],
    description:
      'بعد از واردکردن، ارجاع واژه‌ها در متن پیدا شود: هیچ، فقط یک رونویسی، یا همه رونویسی‌های پروژه',
  })
  @IsOptional()
  @IsIn(['none', 'transcription', 'project'])
  scan?: 'none' | 'transcription' | 'project';

  @ApiProperty({
    required: false,
    description: 'دسته‌بندی‌های ناشناخته فایل ساخته شوند',
  })
  @IsOptional()
  @IsBoolean()
  create_missing_categories?: boolean;

  @ApiProperty({
    required: false,
    description: 'فقط پیش‌نمایش؛ هیچ چیزی ذخیره نمی‌شود',
  })
  @IsOptional()
  @IsBoolean()
  dry_run?: boolean;
}

export class ScanGlossaryDto {
  @ApiProperty({ description: 'پروژه‌ای که واژه‌نامه‌اش اسکن می‌شود' })
  @IsInt()
  project_id: number;

  @ApiProperty({
    required: false,
    description: 'اگر داده شود فقط همین رونویسی اسکن می‌شود',
  })
  @IsOptional()
  @IsInt()
  transcription_id?: number;

  @ApiProperty({
    required: false,
    type: [Number],
    description: 'محدود کردن اسکن به چند واژه مشخص',
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  term_ids?: number[];

  @ApiProperty({
    required: false,
    description: 'فقط شمارش؛ ارجاعی ثبت نمی‌شود',
  })
  @IsOptional()
  @IsBoolean()
  dry_run?: boolean;
}
