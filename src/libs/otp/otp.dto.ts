import { IsNotEmpty, IsNumber, IsString, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class ValidateOtpDto {
  @ApiProperty({ example: '09123456789', description: 'Iranian phone number' })
  @IsNotEmpty()
  @IsString()
  @Matches(/^(\+98|0)?9\d{9}$/, {
    message:
      'Phone number must be a valid Iranian standard number (e.g., 09123456789 or +989123456789)',
  })
  @Transform(
    ({ value }) => {
      const cleanedNumber = value.replace(/\D/g, '');

      if (cleanedNumber.startsWith('0')) {
        return `+98${cleanedNumber.slice(1)}`;
      } else if (cleanedNumber.startsWith('0098')) {
        return `+98${cleanedNumber.slice(4)}`;
      } else if (cleanedNumber.startsWith('98')) {
        return `+98${cleanedNumber.slice(2)}`;
      } else if (cleanedNumber.startsWith('9')) {
        return `+98${cleanedNumber}`;
      } else {
        return cleanedNumber;
      }
    },
    {
      toClassOnly: true,
    },
  )
  phone: string;

  @ApiProperty({ example: 123456, description: 'OTP code received via SMS' })
  @IsNotEmpty()
  @Transform(({ value }) => {
    // Convert string to number if needed
    return typeof value === 'string' ? parseInt(value, 10) : value;
  })
  @IsNumber()
  code: number;
}

export class GenerateOtpDto {
  @ApiProperty({ example: '09123456789', description: 'Iranian phone number' })
  @IsNotEmpty()
  @IsString()
  @Matches(/^(\+98|0)?9\d{9}$/, {
    message:
      'Phone number must be a valid Iranian standard number (e.g., 09123456789 or +989123456789)',
  })
  @Transform(
    ({ value }) => {
      const cleanedNumber = value.replace(/\D/g, '');

      if (cleanedNumber.startsWith('0')) {
        return `+98${cleanedNumber.slice(1)}`;
      } else if (cleanedNumber.startsWith('0098')) {
        return `+98${cleanedNumber.slice(4)}`;
      } else if (cleanedNumber.startsWith('98')) {
        return `+98${cleanedNumber.slice(2)}`;
      } else if (cleanedNumber.startsWith('9')) {
        return `+98${cleanedNumber}`;
      } else {
        return cleanedNumber;
      }
    },
    {
      toClassOnly: true,
    },
  )
  phone: string;
}
