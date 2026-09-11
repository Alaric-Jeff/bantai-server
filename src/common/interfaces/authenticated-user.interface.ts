import { Role } from '../enums/role-enum';

export interface AuthenticatedUser {
  // userId: string;
  sub: string;
  role: Role;
}
