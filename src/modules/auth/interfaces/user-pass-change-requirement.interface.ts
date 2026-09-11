export interface PasswordRequirementState {
  must_change_password: boolean;
}

export interface ChangedPassRow {
  password: string;
  must_change_password: boolean;
}
