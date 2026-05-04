import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { User } from '../user/user.entity';

/**
 * Custom decorator to extract the authenticated user from the request.
 * Must be used with AuthGuard which attaches the user to the request.
 */
export const Auth = createParamDecorator(
  (data: keyof User | undefined, ctx: ExecutionContext): User | any => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as User;

    // If a specific property is requested, return just that property
    if (data) {
      return user?.[data];
    }

    // Otherwise return the full user object
    return user;
  },
);

/**
 * Alias for Auth decorator - extracts current user from request
 */
export const CurrentUser = Auth;
