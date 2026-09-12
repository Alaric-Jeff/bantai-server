import { CommandCenterEntity } from '../interfaces/command-center.interface';

export type CreateCommandCenterData = Omit<
  CommandCenterEntity,
  'id' | 'created_at'
>;
