import { Module } from '@nestjs/common';
import { OtpService } from './otp.service';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Otp } from './otp.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Otp]),

    ConfigModule, // Make sure it's imported
  ],
  providers: [OtpService],
  exports: [OtpService],
})
export class OtpModule {}
