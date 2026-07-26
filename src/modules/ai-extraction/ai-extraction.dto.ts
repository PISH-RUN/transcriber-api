import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class StartExtractionDto {
  @ApiProperty({ description: 'رونویسی‌ای که تحلیل می‌شود' })
  @IsInt()
  transcription_id: number;

  @ApiProperty({
    required: false,
    type: [String],
    example: ['SPEAKER_00'],
    description:
      'اگر داده شود، همین‌جا روی رونویسی ذخیره می‌شود و در استخراج به‌کار می‌رود',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  interviewer_speaker_ids?: string[];
}

export class CandidateDecisionDto {
  @ApiProperty({ description: 'شماره کاندید در همین اجرا' })
  @IsInt()
  candidate_id: number;

  @ApiProperty({ enum: ['accepted', 'rejected'] })
  @IsIn(['accepted', 'rejected'])
  decision: 'accepted' | 'rejected';

  @ApiProperty({
    required: false,
    description:
      'اصلاحات بازبین پیش از ثبت. برای واژه: term, category, definition, aliases, tags, status, importance. ' +
      'برای شاهد: title, type, quote, note, claim_summary, tags, term_ids, verification, importance, sensitivity, segment_index.',
  })
  @IsOptional()
  @IsObject()
  edits?: Record<string, unknown>;
}

export class ApplyExtractionDto {
  @ApiProperty({ type: [CandidateDecisionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CandidateDecisionDto)
  decisions: CandidateDecisionDto[];
}
