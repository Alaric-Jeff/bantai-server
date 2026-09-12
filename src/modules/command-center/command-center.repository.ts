import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CreateCommandCenterData } from './types/create-command-center-data.types';
import { UpdateCommandCenterData } from './types/update-command-center-data.types';
import { CommandCenterEntity } from './interfaces/command-center.interface';

@Injectable()
export class CommandCenterRepository {
  constructor(private readonly db: DatabaseService) {}

  private readonly selectFields = `
    id, 
    name, 
    branch, 
    type, 
    json_build_object(
      'latitude', ST_Y(location::geometry),
      'longitude', ST_X(location::geometry)
    ) AS location,
    created_at
  `;

  async createBranch(
    data: CreateCommandCenterData,
  ): Promise<CommandCenterEntity> {
    const { name, branch, type, location } = data;

    const sql = `
      INSERT INTO command_center (name, branch, type, location)
      VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326))
      RETURNING ${this.selectFields};
    `;

    const { rows } = await this.db.query<CommandCenterEntity>(sql, [
      name,
      branch,
      type,
      location.longitude,
      location.latitude,
    ]);

    return rows[0];
  }

  async viewAll(): Promise<CommandCenterEntity[]> {
    const sql = `
      SELECT ${this.selectFields}
      FROM command_center
      ORDER BY created_at DESC;
    `;

    const { rows } = await this.db.query<CommandCenterEntity>(sql);
    return rows;
  }

  async findById(id: string): Promise<CommandCenterEntity | null> {
    const sql = `
      SELECT ${this.selectFields}
      FROM command_center
      WHERE id = $1;
    `;

    const { rows } = await this.db.query<CommandCenterEntity>(sql, [id]);
    return rows[0] || null;
  }

  async findByName(name: string): Promise<CommandCenterEntity[]> {
    const sql = `
      SELECT ${this.selectFields}
      FROM command_center
      WHERE name ILIKE '%' || $1 || '%';
    `;

    const { rows } = await this.db.query<CommandCenterEntity>(sql, [name]);
    return rows;
  }

  async findByBranch(branch: string): Promise<CommandCenterEntity[]> {
    const sql = `
      SELECT ${this.selectFields}
      FROM command_center
      WHERE branch ILIKE '%' || $1 || '%';
    `;

    const { rows } = await this.db.query<CommandCenterEntity>(sql, [branch]);
    return rows;
  }

  async updateBranch(
    id: string,
    data: UpdateCommandCenterData,
  ): Promise<CommandCenterEntity | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (data.name !== undefined) {
      fields.push(`name = $${paramIdx++}`);
      values.push(data.name);
    }

    if (data.branch !== undefined) {
      fields.push(`branch = $${paramIdx++}`);
      values.push(data.branch);
    }

    if (data.type !== undefined) {
      fields.push(`type = $${paramIdx++}`);
      values.push(data.type);
    }

    if (data.location !== undefined) {
      fields.push(
        `location = ST_SetSRID(ST_MakePoint($${paramIdx++}, $${paramIdx++}), 4326)`,
      );
      values.push(data.location.longitude, data.location.latitude);
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    const sql = `
      UPDATE command_center
      SET ${fields.join(', ')}
      WHERE id = $${paramIdx}
      RETURNING ${this.selectFields};
    `;

    const { rows } = await this.db.query<CommandCenterEntity>(sql, values);
    return rows[0] || null;
  }

  async deleteBranch(id: string): Promise<boolean> {
    const sql = `DELETE FROM command_center WHERE id = $1;`;
    const result = await this.db.query(sql, [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
