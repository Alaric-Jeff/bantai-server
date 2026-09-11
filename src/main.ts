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
  const corsOrigin = configService.get<string>(
    'CORS_ORIGIN',
    'http://localhost:3001',
  );
  const cookieSecret = configService.getOrThrow<string>('COOKIE_SECRET');
  app.setGlobalPrefix(apiPrefix);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.register(fastifyCookie as any, {
    secret: cookieSecret,
  });

  app.enableCors({
    origin: corsOrigin,
    credentials: true,
  });

  await app.listen(port, host);
}

bootstrap().catch((err) => {
  console.error('Error during application bootstrap:', err);
  process.exit(1);
});
