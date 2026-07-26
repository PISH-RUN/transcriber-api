import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateProjectDto {
  @ApiProperty({ example: 'تدبر در قرآن', description: 'نام پروژه' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ required: false, description: 'توضیح پروژه' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, example: '#1877F2' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string;
}

export class UpdateProjectDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string;
}
