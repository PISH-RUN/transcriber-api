import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiProperty } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { GenerateOtpDto, ValidateOtpDto } from '../../libs/otp/otp.dto';
import { UserService } from '../user/user.service';
import { IsOptional, IsBoolean } from 'class-validator';

class RequestOtpDto extends GenerateOtpDto {
  @ApiProperty({
    required: false,
    description: 'Force OTP even if user has password',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly userService: UserService,
  ) {}

  @Post('otp')
  @ApiOperation({ summary: 'Request OTP code' })
  @ApiResponse({ status: 200, description: 'OTP sent successfully' })
  @ApiResponse({ status: 400, description: 'Invalid phone number' })
  async otp(@Body() requestOtpDto: RequestOtpDto) {
    await this.userService.findByPhoneNumberOrCreate(requestOtpDto.phone);
    return await this.authService.otp(requestOtpDto);
  }

  @Post('otp/verify')
  @ApiOperation({ summary: 'Verify OTP code and get JWT token' })
  @ApiResponse({ status: 200, description: 'OTP verified, returns JWT token' })
  @ApiResponse({ status: 400, description: 'Invalid OTP code' })
  async verifyOtp(@Body() validateOtpDto: ValidateOtpDto) {
    return await this.authService.validateOtp(validateOtpDto);
  }
}
