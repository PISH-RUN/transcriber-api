import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MAX_CHUNK_BYTES, MIN_CHUNK_BYTES } from './upload.service';

export class InitUploadDto {
  @ApiProperty({ example: 'meeting-2026-07-27.m4a' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(512)
  filename: string;

  @ApiProperty({ description: 'حجم کل فایل به بایت' })
  @IsInt()
  @Min(1)
  size: number;

  @ApiProperty({
    description: `اندازه هر تکه به بایت (بین ${MIN_CHUNK_BYTES} و ${MAX_CHUNK_BYTES})`,
    example: 8 * 1024 * 1024,
  })
  @IsInt()
  @Min(MIN_CHUNK_BYTES)
  @Max(MAX_CHUNK_BYTES)
  chunk_size: number;

  @ApiProperty({ required: false, example: 'audio/mp4' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  mimetype?: string;
}
