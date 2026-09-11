import { Role } from '../../../common/enums/role-enum';

export interface UserAuthRow {
  id: string;
  password_hash: string;
  deleted_at: Date | null;
  // is_deleted: boolean;
  must_change_password: boolean;
  role: Role;
  command_center_id: string | null;
}
