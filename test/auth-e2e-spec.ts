import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Authentication & Token Lifecycle (E2E)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );

    // Register directly on the native Fastify instance to bypass Nest's wrapper types
    const fastifyInstance = app.getHttpAdapter().getInstance();
    await fastifyInstance.register(
      fastifyCookie as unknown as Parameters<
        typeof fastifyInstance.register
      >[0],
    );

    await app.init();
    await fastifyInstance.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should enforce rotation and reject spent refresh token reuse', async () => {
    // Step 1: Sign In
    const signinRes = await request(app.getHttpServer())
      .post('/api/v1/auth/local/signin')
      .send({
        email: 'admin@bantai.ph',
        password: 'ChangeThisSuperAdminPassword2026!',
      })
      .expect(201);

    const rawInitialHeader = signinRes.headers['set-cookie'];
    const initialCookie = Array.isArray(rawInitialHeader)
      ? rawInitialHeader
      : [String(rawInitialHeader)];

    expect(rawInitialHeader).toBeDefined();

    // Step 2: First Refresh (Valid Token -> Rotates Token)
    const refreshRes = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', initialCookie)
      .expect(201);

    const rawRotatedHeader = refreshRes.headers['set-cookie'];
    const rotatedCookie = Array.isArray(rawRotatedHeader)
      ? rawRotatedHeader
      : [String(rawRotatedHeader)];

    expect(rawRotatedHeader).toBeDefined();
    expect(rotatedCookie).not.toEqual(initialCookie);

    // Step 3: Replay Attack Simulation (Re-send spent initialCookie -> Expect 401)
    const replayRes = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', initialCookie)
      .expect(401);

    const body = replayRes.body as Record<string, unknown>;
    expect(body.message).toBe('Invalid session.');
  });
});
