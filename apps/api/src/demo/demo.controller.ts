import { fileURLToPath } from 'node:url';
import { ConflictException, Controller, Get, HttpCode, Module, NotFoundException, Post, Body, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { Db } from '../db/db.service.js';
import { config } from '../config.js';
import { Public } from '../common/decorators.js';
import type { AppRequest } from '../common/types.js';
import { parse, v } from '../common/validate.js';
import { audit } from '../common/audit.js';
import { startSession } from '../auth/auth.controller.js';

/** Roles a visitor can view the demo clinic as, and the synthetic account behind each. */
export const DEMO_ACCOUNTS = [
  { as: 'owner', email: 'owner@demo.medora' },
  { as: 'doctor', email: 'nour@demo.medora' },
  { as: 'receptionist', email: 'maya@demo.medora' },
  { as: 'assistant', email: 'lina@demo.medora' },
  { as: 'insurance', email: 'sami@demo.medora' },
  { as: 'patient', email: 'patient@demo.medora' },
] as const;
const DEMO_DOMAIN = '@demo.medora';
const ROOT = new URL('../../../../../', import.meta.url);   // repository (or image) root, from dist/src/demo
const RESET_COOLDOWN_MS = 2 * 60_000;
let resetting = false; let lastReset = 0;

/**
 * Demo mode, for showing MEDORA to clinics: on a server started with DEMO_MODE=true, visitors open the synthetic clinic
 * as the owner, a doctor, the front desk and so on without a password, and can put it back to its starting state.
 * Every endpoint answers 404 when demo mode is off. Reset refuses to run if the database holds any account outside the
 * synthetic demo domain, so it can never wipe a clinic's real data.
 */
@Controller('demo')
export class DemoController {
  constructor(private db: Db) {}

  @Public() @Get()
  info() {
    if (!config.demoMode) return { enabled: false };
    return { enabled: true, roles: DEMO_ACCOUNTS.map((a) => a.as), canReset: Boolean(process.env.DATABASE_URL) };
  }

  @Public() @Post('login') @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    if (!config.demoMode) throw new NotFoundException();
    const b = parse({ as: v.enum(...DEMO_ACCOUNTS.map((a) => a.as)) }, body);
    const email = DEMO_ACCOUNTS.find((a) => a.as === b.as)!.email;
    const u = await this.db.tx({}, (t) => t.one(`SELECT * FROM auth_find_user($1)`, [email]));
    if (!u || u.status !== 'active') throw new ServiceUnavailableException('The demo is being prepared. Reset it or try again in a minute.');
    await startSession(this.db, res, req, u.id, false);
    const ws = await this.db.tx({ userId: u.id }, async (t) => {
      await audit(t, u.id, null, 'auth.login', 'user', u.id, { demo: b.as });
      return t.one(`SELECT o.id FROM memberships m JOIN organizations o ON o.id=m.organization_id
        WHERE m.user_id=$1 AND m.status='active' AND o.status='active' ORDER BY (o.kind='medical_center') DESC, o.name LIMIT 1`, [u.id]);
    });
    return { as: b.as, organizationId: ws?.id ?? null, portal: b.as === 'patient' };
  }

  /** Wipes the database and seeds the synthetic clinic again. Takes a few seconds; everyone is signed out. */
  @Public() @Post('reset') @HttpCode(200)
  async reset(@Req() req: AppRequest) {
    if (!config.demoMode) throw new NotFoundException();
    const ownerUrl = process.env.DATABASE_URL;
    if (!ownerUrl) throw new ServiceUnavailableException('Reset is not set up on this server');
    if (resetting) throw new ConflictException('A reset is already running');
    resetting = true;
    try {
      const require = createRequire(import.meta.url);
      const { Client } = require('pg');
      const pg = new Client(ownerUrl); await pg.connect();
      try {
        const real = (await pg.query(`SELECT count(*)::int AS n FROM users WHERE lower(email) NOT LIKE '%' || $1`, [DEMO_DOMAIN])).rows[0].n;
        if (real > 0) throw new ConflictException('This database holds accounts outside the demo, so it will not be reset');
      } finally { await pg.end(); }
      if (Date.now() - lastReset < RESET_COOLDOWN_MS) throw new ConflictException('The demo was reset a moment ago');
      const { migrate } = require(fileURLToPath(new URL('db/migrate.js', ROOT)));
      const { syncPresets } = require(fileURLToPath(new URL('db/sync_presets.js', ROOT)));
      await migrate({ reset: true, log: () => {} });
      await syncPresets({ log: () => {} });
      const seed = fileURLToPath(new URL('db/seed_synthetic.mjs', ROOT));
      if (!existsSync(seed)) throw new ServiceUnavailableException('The demo data script is missing on this server');
      const port = req.socket.localPort;
      await new Promise<void>((resolve, reject) => execFile(process.execPath, [seed], {
        env: { ...process.env, API_URL: `http://127.0.0.1:${port}`, SEED_SKIP_ADMIN: '1' }, timeout: 120_000,
      }, (err, _out, stderr) => (err ? reject(new Error(`Demo seed failed: ${stderr || err.message}`)) : resolve())));
      lastReset = Date.now();
      return { ok: true };
    } finally { resetting = false; }
  }
}

@Module({ controllers: [DemoController] })
export class DemoModule {}
