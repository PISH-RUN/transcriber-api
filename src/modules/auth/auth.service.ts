import { Injectable, forwardRef, Inject } from '@nestjs/common';
import { AuthInterface } from './auth.interface';
import { JwtService } from '@nestjs/jwt';
import { OtpService } from '../../libs/otp/otp.service';
import { GenerateOtpDto, ValidateOtpDto } from '../../libs/otp/otp.dto';
import { SmsService } from '../../libs/sms';
import { UserService } from '../user/user.service';

@Injectable()
export class AuthService {
  constructor(
    private smsService: SmsService,
    private jwtService: JwtService,
    private otpService: OtpService,
    @Inject(forwardRef(() => UserService))
    private userService: UserService,
  ) {}

  async otp(generateOtpDto: GenerateOtpDto & { force?: boolean }) {
    const otp = await this.otpService.generateOtp(generateOtpDto);

    try {
      await this.smsService.sendSms({
        receptor: generateOtpDto.phone,
        message: `کد ورود شما: ${otp.code}`,
      });
    } catch (error) {
      console.warn(
        'SMS sending failed (this is OK in development):',
        (error as Error).message,
      );
    }

    console.log('otp : ', otp);
    return { message: 'کد تأیید ارسال شد' };
  }

  async validateOtp(validateOtpDto: ValidateOtpDto) {
    const isValid = await this.otpService.validateOtp(validateOtpDto);

    if (isValid) {
      let user = await this.userService.getByPhoneNumber(validateOtpDto.phone);

      if (!user) {
        user = await this.userService.findByPhoneNumberOrCreate(
          validateOtpDto.phone,
        );
      }

      await this.otpService.deleteOtp(validateOtpDto.phone);

      const tokenData = await this.generateToken(user);
      return tokenData;
    }

    return 'ERROR';
  }

  async generateToken(entity: AuthInterface) {
    const payload = {
      sub: entity.id,
      phone: entity.phone,
      name: `${entity.first_name || ''} ${entity.last_name || ''}`.trim(),
      role: entity.role || 'user',
    };

    return {
      access_token: await this.jwtService.signAsync(payload),
    };
  }
}
