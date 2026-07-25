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
  @ApiProperty({ example: 'SPEAKER_00', description: 'شناسه گوینده تشخیص داده‌شده' })
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
