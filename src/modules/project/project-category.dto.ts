import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ProjectCategoryKind } from './project-category.entity';

export class CreateProjectCategoryDto {
  @ApiProperty()
  @IsInt()
  project_id: number;

  @ApiProperty({ enum: ProjectCategoryKind })
  @IsEnum(ProjectCategoryKind)
  kind: ProjectCategoryKind;

  @ApiProperty({ example: 'ریسک‌ها' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  label: string;

  @ApiProperty({ required: false, example: '#FF5630' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string;
}

export class UpdateProjectCategoryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  label?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  sort_order?: number;
}
