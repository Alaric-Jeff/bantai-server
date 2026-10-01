import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import fastifyCookie from '@fastify/cookie';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: false,
      trustProxy: true,
    }),
  );

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);
  const host = configService.get<string>('HOST', '0.0.0.0');
  const apiPrefix = configService.get<string>('API_PREFIX', '/api/v1');

  // CORS_ORIGIN is a comma-separated list of allowed origins, e.g.
  //   CORS_ORIGIN=http://localhost:3001,http://localhost:5173,https://onboarding.example.com
  // (ConfigService.get only takes ONE default, so the list has to be
  // parsed from a single string.) In production this must include the
  // onboarding SPA's origin — the same value as FRONTEND_URL.
  const corsOrigins = configService
    .get<string>('CORS_ORIGIN', 'http://localhost:3001,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const cookieSecret = configService.getOrThrow<string>('COOKIE_SECRET');
  app.setGlobalPrefix(apiPrefix);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  await app.register(fastifyCookie as any, {
    secret: cookieSecret,
  });

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  await app.listen(port, host);
}

bootstrap().catch((err) => {
  console.error('Error during application bootstrap:', err);
  process.exit(1);
});
