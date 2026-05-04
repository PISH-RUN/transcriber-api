import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

export class userCreateDto {
  @IsOptional()
  @IsString()
  first_name?: string;

  @IsOptional()
  @IsString()
  last_name?: string;

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
