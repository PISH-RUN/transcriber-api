import {
  IsArray,
  IsInt,
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

export class UpdateTranscriptionDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  title?: string;
}
