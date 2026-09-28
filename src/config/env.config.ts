// src/config/env.validation.ts
import { plainToInstance, Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsIn,
  IsUrl,
  IsEmail,
  IsInt,
  Min,
  IsOptional,
  validateSync,
} from 'class-validator';

class EnvironmentVariables {
  // ---------------- Application ----------------
  @IsString()
  @IsNotEmpty()
  APP_NAME!: string;

  @IsIn(['development', 'production', 'test'])
  APP_ENV!: string;

  @IsUrl({ require_tld: false })
  APP_URL!: string;

  @IsUrl({ require_tld: false })
  FRONTEND_URL!: string;

  @IsString()
  @IsNotEmpty()
  API_PREFIX!: string;

  @IsUrl({ require_tld: false })
  CORS_ORIGIN!: string;

  // ---------------- Seeder ----------------
  @IsEmail()
  SUPERADMIN_EMAIL!: string;

  @IsString()
  @IsNotEmpty()
  SUPERADMIN_PASSWORD!: string;

  // ---------------- Server ----------------
  @IsIn(['development', 'production', 'test'])
  NODE_ENV!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  PORT!: number;

  @IsString()
  @IsNotEmpty()
  HOST!: string;

  // ---------------- Database ----------------
  @IsString()
  @IsNotEmpty()
  DB_HOST!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  DB_PORT!: number;

  @IsString()
  @IsNotEmpty()
  DB_USERNAME!: string;

  @IsString()
  @IsNotEmpty()
  DB_PASSWORD!: string;

  @IsString()
  @IsNotEmpty()
  DB_DATABASE!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  DB_POOL_MAX!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  DB_POOL_IDLE_TIMEOUT!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  DB_POOL_CONN_TIMEOUT!: number;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  // ---------------- Redis ----------------
  @IsString()
  @IsNotEmpty()
  REDIS_HOST!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  REDIS_PORT!: number;

  @IsOptional()
  @IsString()
  REDIS_PASSWORD?: string;

  @IsString()
  @IsNotEmpty()
  REDIS_URL!: string;

  // ---------------- Auth & Security ----------------
  @IsString()
  @IsNotEmpty()
  JWT_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  JWT_EXPIRATION!: string;

  @IsString()
  @IsNotEmpty()
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  JWT_REFRESH_EXPIRATION!: string;

  @IsString()
  @IsNotEmpty()
  COOKIE_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  ACTIVATION_TOKEN_EXPIRATION!: string;

  @IsString()
  @IsNotEmpty()
  PASSWORD_RESET_TOKEN_EXPIRATION!: string;

  // ---------------- Geofencing / System ----------------
  @Type(() => Number)
  @IsInt()
  @Min(1)
  DEFAULT_ALERT_RADIUS_METERS!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  HEARTBEAT_TIMEOUT_SECONDS!: number;

  // ---------------- Resend ----------------
  @IsString()
  @IsNotEmpty()
  bantai_resend_api_key!: string;
}

export function validate(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(errors.toString());
  }

  return validatedConfig;
}
