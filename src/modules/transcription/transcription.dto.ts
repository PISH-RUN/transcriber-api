import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class SpeakerAssignmentDto {
  @ApiProperty({
    example: 'SPEAKER_00',
    description: 'شناسه گوینده تشخیص داده‌شده',
  })
  @IsString()
  speakerId: string;

  @ApiProperty({
    required: false,
    nullable: true,
    example: 12,
    description: 'شناسه شخص انتخاب‌شده (null یعنی ناشناس بماند)',
  })
  @IsOptional()
  @IsInt()
  personId?: number | null;
}

export class ConfirmSpeakersDto {
  @ApiProperty({ type: [SpeakerAssignmentDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SpeakerAssignmentDto)
  assignments: SpeakerAssignmentDto[];
}

export class UpdateSegmentDto {
  @ApiProperty({ example: 'SPEAKER_00' })
  @IsString()
  speaker_id: string;

  @ApiProperty({ example: 'گوینده 1' })
  @IsString()
  speaker_label: string;

  @ApiProperty({ description: 'متن این تکه از گفتگو' })
  @IsString()
  text: string;

  @ApiProperty({ example: '00:05' })
  @IsString()
  start_time: string;

  @ApiProperty({ example: '00:12' })
  @IsString()
  end_time: string;

  @ApiProperty({ example: 5000 })
  @IsNumber()
  start_ms: number;

  @ApiProperty({ example: 12000 })
  @IsNumber()
  end_ms: number;
}

export class UpdateTranscriptionDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({ required: false, description: 'توضیحات جلسه' })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiProperty({
    required: false,
    example: '2026-07-25',
    description: 'تاریخ برگزاری جلسه (میلادی، YYYY-MM-DD)',
  })
  @IsOptional()
  @IsString()
  recorded_at?: string | null;

  @ApiProperty({
    required: false,
    type: [String],
    description: 'برچسب‌ها برای جستجو و فیلتر',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[] | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'شناسه پروژه (null یعنی بدون پروژه)',
  })
  @IsOptional()
  @IsInt()
  project_id?: number | null;

  @ApiProperty({
    required: false,
    type: [String],
    example: ['SPEAKER_00'],
    description:
      'شناسه گویندگانی که سمت مصاحبه‌کننده هستند (می‌تواند چند نفر باشد). استخراج شواهد از این استفاده می‌کند تا جمع‌بندی خودِ مصاحبه‌گر را شاهد تأییدشده نشمارد.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  interviewer_speaker_ids?: string[] | null;

  @ApiProperty({
    required: false,
    type: [UpdateSegmentDto],
    description:
      'آرایه کامل تکه‌های گفتگو پس از ویرایش متن یا تغییر گوینده. کل آرایه جایگزین می‌شود.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateSegmentDto)
  segments?: UpdateSegmentDto[];
}
