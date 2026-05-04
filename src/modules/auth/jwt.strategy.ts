import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UserService } from '../user/user.service'; // Assuming you have a UserService
import { User } from '../user/user.entity';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly userService: UserService, // Inject UserService
  ) {
    const secret = configService.get<string>('jwt.secret');
    if (!secret) {
      throw new Error(
        'JWT_SECRET is not defined in environment variables. Please check your .env file or configuration.',
      );
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: any): Promise<User> {
    // payload will contain the decoded JWT claims (e.g., userId, username)
    // You might have stored 'sub' (subject) as userId or directly 'userId'
    const userId = payload.sub || payload.id || payload.userId;
    if (!userId) {
      throw new UnauthorizedException(
        'Invalid token: User identifier not found in payload',
      );
    }
    const user = await this.userService.getById(userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    // The returned user object will be attached to request.user
    return user;
  }
}
