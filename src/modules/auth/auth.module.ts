import { Module, forwardRef } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SmsModule } from '../../libs/sms';
import { OtpModule } from '../../libs/otp/otp.module';
import { UserModule } from '../user/user.module';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthGuard } from './auth.guard';

@Module({
  imports: [
    forwardRef(() => SmsModule),
    ConfigModule,
    PassportModule.register({ defaultStrategy: 'jwt', session: false }),
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>(
          'jwt.secret',
          'your-secret-key-change-this-in-production',
        ),
        signOptions: {
          expiresIn: configService.get('jwt.expiresIn', '60m'),
        },
      }),
    }),
    forwardRef(() => OtpModule),
    forwardRef(() => UserModule),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtAuthGuard, AuthGuard],
  exports: [
    AuthService,
    JwtAuthGuard,
    AuthGuard,
    JwtStrategy,
    PassportModule,
    JwtModule,
  ],
})
export class AuthModule {}
