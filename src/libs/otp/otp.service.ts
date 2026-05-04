import { HttpException, Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Otp } from './otp.entity';
import { GenerateOtpDto, ValidateOtpDto } from './otp.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class OtpService {
  constructor(
    @InjectRepository(Otp)
    private otpRepository: Repository<Otp>,
    private configService: ConfigService,
  ) {}

  async generateOtp(generateOtpDto: GenerateOtpDto) {
    const founded = await this.findByPhoneNumber(generateOtpDto.phone);

    if (founded) {
      if (this.isExpired(founded)) {
        await this.deleteOtp(generateOtpDto.phone);
      } else {
        // Calculate remaining time
        const expireTime = this.configService.get('otp_expire') || 2;
        const expiresAt = new Date(
          founded.sent_at.getTime() + expireTime * 60 * 1000,
        );
        const remainingSeconds = Math.ceil(
          (expiresAt.getTime() - Date.now()) / 1000,
        );

        throw new HttpException(
          `لطفاً ${remainingSeconds} ثانیه صبر کنید و دوباره تلاش کنید`,
          400,
        );
      }
    }

    const otp = this.otpRepository.create({
      phone: generateOtpDto.phone,
      sent_at: new Date(),
    });

    // Set fixed OTP codes for test phone numbers
    const testPhones = {
      '+989121111111': 1111, // USER role
      '09121111111': 1111, // USER role (alternative format)
      '+989122222222': 2222, // OPERATOR role
      '09122222222': 2222, // OPERATOR role (alternative format)
      '+989123333333': 3333, // ADMIN role
      '09123333333': 3333, // ADMIN role (alternative format)
    };

    if (testPhones[generateOtpDto.phone]) {
      otp.code = testPhones[generateOtpDto.phone];
    }

    return await this.otpRepository.save(otp);
  }

  async validateOtp(validateOtpDto: ValidateOtpDto) {
    const otp = await this.findByPhoneNumber(validateOtpDto.phone);

    if (!otp) {
      throw new HttpException(
        'کد تأیید یافت نشد، لطفاً دوباره درخواست دهید',
        400,
      );
    }

    if (this.isExpired(otp)) {
      await this.deleteOtp(otp.phone);
      throw new HttpException('کد تأیید منقضی شده است', 400);
    }

    if (otp.code !== +validateOtpDto.code) {
      throw new HttpException('کد وارد شده صحیح نمی‌باشد', 400);
    }
    return true;
  }

  async findByPhoneNumber(phoneNumber: string) {
    return await this.otpRepository.findOne({ where: { phone: phoneNumber } });
  }

  async deleteOtp(phoneNumber: string) {
    await this.otpRepository.delete({ phone: phoneNumber });
  }

  isExpired(otp: Otp) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const expireTime = this.configService.get('otp_expire') || 2;

    return (
      new Date() > new Date(otp.sent_at.getTime() + expireTime * 60 * 1000)
    );
  }
}
