import { UserRole } from '../../common/enums/user-role.enum';

export class AuthInterface {
  id: number | string;
  phone: string;
  first_name?: string;
  last_name?: string;
  role?: UserRole;
}

export interface JwtPayload {
  sub: number;
  phone: string;
  name: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}
