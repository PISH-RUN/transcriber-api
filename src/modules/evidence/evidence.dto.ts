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
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Fixed vocabularies from the evidence-extraction prompt. Unlike `type`, these
 * are not per-project taxonomy: they describe the *shape* of a statement, which
 * is the same in every project, so they are validated as an enum.
 */
export const EVIDENCE_SCOPES = [
  'organizational_current_state',
  'project_governance',
  'product_requirement',
  'stakeholder_expectation',
  'historical_context',
] as const;

export const AGREEMENT_STATUSES = [
  'single_speaker_claim',
  'proposal',
  'tentative_agreement',
  'confirmed_agreement',
  'disputed',
  'not_applicable',
] as const;

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

  @ApiProperty({
    required: false,
    example: 'گستره صادرات',
    description: 'عنوان کوتاه شاهد',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

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

  @ApiProperty({
    required: false,
    description: 'وضعیت اعتبارسنجی؛ متن آزاد از واژگان خود بازبین',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  verification?: string;

  @ApiProperty({ required: false, description: 'اولین خط بازه' })
  @IsOptional()
  @IsInt()
  segment_index?: number;

  @ApiProperty({
    required: false,
    description: 'آخرین خط، وقتی شاهد چند نوبت گوینده را پوشش می‌دهد',
  })
  @IsOptional()
  @IsInt()
  end_segment_index?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  speaker_label?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  start_ms?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  end_ms?: number;

  @ApiProperty({
    required: false,
    description:
      'اگر false باشد یعنی متن در رونویسی پیدا نشده و ارجاعش دستی لازم است',
  })
  @IsOptional()
  @IsBoolean()
  anchored?: boolean;

  // --- analytical metadata (mostly filled by AI extraction) ----------------

  @ApiProperty({
    required: false,
    description: 'خلاصه بی‌طرف ادعا، به‌عنوان گفته گوینده نه واقعیت تأییدشده',
  })
  @IsOptional()
  @IsString()
  claim_summary?: string;

  @ApiProperty({ required: false, description: 'اهمیت ۳ تا ۵' })
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

  @ApiProperty({
    required: false,
    description:
      'normal | internal | sensitive_personnel | sensitive_financial | sensitive_legal | sensitive_commercial',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  sensitivity?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  requires_validation?: boolean;

  @ApiProperty({
    required: false,
    type: [String],
    description: 'document | system_data | another_interview | …',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  validation_methods?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  comparison_potential?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  quoted_from_another_person?: boolean;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  referenced_people?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  contains_interviewer_text?: boolean;

  @ApiProperty({
    required: false,
    enum: EVIDENCE_SCOPES,
    description:
      'این شاهد برای چه کاری است: وضع موجود، حاکمیت پروژه، نیاز محصول، …',
  })
  @IsOptional()
  @IsIn(EVIDENCE_SCOPES)
  evidence_scope?: string;

  @ApiProperty({
    required: false,
    enum: AGREEMENT_STATUSES,
    description: 'میزان توافق شرکت‌کنندگان روی این گفته',
  })
  @IsOptional()
  @IsIn(AGREEMENT_STATUSES)
  agreement_status?: string;

  @ApiProperty({
    required: false,
    description: 'مثال فرضی است، نه گزارشی از وضع واقعی سازمان',
  })
  @IsOptional()
  @IsBoolean()
  is_hypothetical_example?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  follow_up_required?: boolean;

  @ApiProperty({ required: false, description: 'اقدام بعدی مشخص' })
  @IsOptional()
  @IsString()
  follow_up_action?: string;

  @ApiProperty({
    required: false,
    type: [Number],
    description: 'واژه‌های دیکشنری که این شاهد درباره‌شان است',
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  term_ids?: number[];

  @ApiProperty({ required: false, enum: ['manual', 'import', 'ai'] })
  @IsOptional()
  @IsIn(['manual', 'import', 'ai'])
  origin?: 'manual' | 'import' | 'ai';

  @ApiProperty({ required: false, description: 'باقی خروجی مدل، برای گم نشدن' })
  @IsOptional()
  @IsObject()
  ai_meta?: Record<string, unknown>;
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
  @MaxLength(255)
  title?: string | null;

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

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  verification?: string | null;

  @ApiProperty({
    required: false,
    description: 'جای‌گذاری دستی شاهدی که خودکار پیدا نشده بود',
  })
  @IsOptional()
  @IsInt()
  segment_index?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  end_segment_index?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  anchored?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  claim_summary?: string | null;

  @ApiProperty({ required: false, description: 'اهمیت ۱ تا ۵' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  importance?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  sensitivity?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  requires_validation?: boolean;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  validation_methods?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  comparison_potential?: string | null;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  referenced_people?: string[];

  @ApiProperty({
    required: false,
    type: [Number],
    description: 'جایگزینی کامل واژه‌های مرتبط',
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  term_ids?: number[];

  @ApiProperty({ required: false, enum: EVIDENCE_SCOPES })
  @IsOptional()
  @IsIn(EVIDENCE_SCOPES)
  evidence_scope?: string | null;

  @ApiProperty({ required: false, enum: AGREEMENT_STATUSES })
  @IsOptional()
  @IsIn(AGREEMENT_STATUSES)
  agreement_status?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  is_hypothetical_example?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  follow_up_required?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  follow_up_action?: string | null;
}

export class ImportEvidenceDto {
  @ApiProperty({ description: 'پروژه‌ای که شواهد به آن اضافه می‌شود' })
  @IsInt()
  project_id: number;

  @ApiProperty({
    required: false,
    description:
      'رونویسی مبدأ؛ برای لنگرگذاری خودکار نقل‌قول‌ها روی خطوط لازم است',
  })
  @IsOptional()
  @IsInt()
  transcription_id?: number;

  @ApiProperty({
    description: 'سند مارک‌داون سبد شواهد؛ هر شاهد یک بلوک «### شاهد …»',
  })
  @IsNotEmpty()
  @IsString()
  markdown: string;

  @ApiProperty({
    required: false,
    description: 'فقط پیش‌نمایش؛ هیچ چیزی ذخیره نمی‌شود',
  })
  @IsOptional()
  @IsBoolean()
  dry_run?: boolean;
}
