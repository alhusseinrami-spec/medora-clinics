import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import express from 'express';
import { config } from './config.js';
import { DbModule } from './db/db.module.js';
import { Db } from './db/db.service.js';
import { AuthGuard, TenantGuard } from './common/guards.js';
import { ErrorFilter } from './common/errors.js';
import { AuthModule } from './auth/auth.controller.js';
import { OrgsModule } from './orgs/orgs.controller.js';
import { StaffModule } from './staff/staff.controller.js';
import { SpecialtyModule } from './specialty/specialty.controller.js';
import { PatientsModule } from './patients/patients.controller.js';
import { SchedulingModule } from './scheduling/scheduling.controller.js';
import { ClinicalModule } from './clinical/clinical.module.js';
import { attachRealtime } from './realtime/realtime.js';

@Module({
  imports: [DbModule, AuthModule, OrgsModule, StaffModule, SpecialtyModule, PatientsModule, SchedulingModule, ClinicalModule],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
class AppModule {}

export async function createApp(opts: { logger?: boolean } = {}): Promise<{ app: INestApplication; close: () => Promise<void> }> {
  const app = await NestFactory.create(AppModule, { logger: opts.logger === false ? false : ['error', 'warn', 'log'] });
  app.use(cookieParser());
  // Document uploads arrive as the raw file body (PDF or image), at most 15 MB.
  app.use(/^\/api\/patients\/[^/]+\/documents$/, express.raw({ type: ['application/pdf', 'image/*'], limit: config.maxUploadBytes }));
  app.enableCors({ origin: config.webOrigin, credentials: true });
  app.setGlobalPrefix('api', { exclude: ['health'] });
  (app as any).getHttpAdapter().getInstance().set('trust proxy', 1);
  (app as any).getHttpAdapter().getInstance().get('/health', (_: any, res: any) => res.json({ ok: true }));
  await app.init();
  const rt = await attachRealtime(app.getHttpServer(), app.get(Db));
  return { app, close: async () => { await rt.close(); await app.close(); } };
}
