import { Role } from '../enums/role-enum';

export interface AuthenticatedUser {
  sub: string;
  role: Role;
  command_center_id?: string;
}
