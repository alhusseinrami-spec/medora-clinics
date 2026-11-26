import { BadRequestException, Body, Controller, Get, HttpCode, Module, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Db } from '../db/db.service.js';
import { Auth, BillingExempt, Ctx, PlatformAdmin, RequirePerm } from '../common/decorators.js';
import type { AuthInfo, TenantInfo } from '../common/types.js';
import { parse, v } from '../common/validate.js';

const uid = (x: string) => parse({ id: v.uuid() }, { id: x }).id;
const FEATURES = ['specialty_templates', 'finance', 'insurance', 'whatsapp', 'patient_app', 'departments', 'advanced_analytics'] as const;
const PLAN_COLS = `code, name, description, monthly_price::float, yearly_price::float, currency, max_doctors, max_assistants, max_locations, max_patients,
  features, applies_to, is_public, is_active, sort_order`;
const SUB_COLS = `plan_code, plan_name, status, effective_status, usable, billing_cycle, trial_ends_at, current_period_end, cancel_at_period_end,
  features, max_doctors, max_assistants, max_locations, max_patients, price::float, currency`;

/** The workspace's own subscription page (workspace administrators). Online card payment is not connected. */
@Controller('subscription')
export class SubscriptionController {
  constructor(private db: Db) {}

  @RequirePerm('org.manage') @BillingExempt() @Get()
  get(@Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => ({
      subscription: await t.one(`SELECT ${SUB_COLS} FROM org_subscription($1)`, [c.orgId]),
      usage: await t.one(`SELECT * FROM org_usage($1)`, [c.orgId]),
      plans: await t.q(`SELECT ${PLAN_COLS} FROM plans WHERE is_active AND is_public AND $1 = ANY(applies_to) ORDER BY sort_order`, [c.orgKind]),
      features: await t.q(`SELECT code, description FROM plan_features ORDER BY code`),
      payments: await t.q(`SELECT id, amount::float, currency, method, reference, status, period_start, period_end, plan_code, created_at FROM subscription_payments WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 50`, [c.orgId]),
      events: await t.q(`SELECT kind, from_plan, to_plan, from_status, to_status, created_at FROM subscription_events WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 30`, [c.orgId]),
      onlinePayment: 'awaiting_credentials',
    }));
  }

  @RequirePerm('org.manage') @BillingExempt() @Post('plan') @HttpCode(200)
  async changePlan(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ plan: v.str(2, 40), cycle: v.enum('monthly', 'yearly') }, body);
    await this.db.tx(c, (t) => t.q(`SELECT org_change_plan($1,$2)`, [b.plan, b.cycle]));
    return this.get(c);
  }

  @RequirePerm('org.manage') @BillingExempt() @Post('cancel') @HttpCode(200)
  async cancel(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ cancel: v.bool() }, body);
    await this.db.tx(c, (t) => t.q(`SELECT org_set_cancel($1)`, [b.cancel]));
    return this.get(c);
  }
}

/** Support requests from any signed-in user to MEDORA. */
@Controller('support')
export class SupportController {
  constructor(private db: Db) {}

  @Get()
  list(@Auth() a: AuthInfo) {
    return this.db.tx({ userId: a.userId }, (t) => t.q(`SELECT r.id, r.category, r.subject, r.status, r.created_at, r.updated_at, o.name AS organization_name
      FROM support_requests r LEFT JOIN organizations o ON o.id = r.organization_id WHERE r.user_id = $1 ORDER BY r.updated_at DESC`, [a.userId]));
  }

  @Post()
  create(@Body() body: unknown, @Auth() a: AuthInfo) {
    const b = parse({ organizationId: v.uuid().nullable(), category: v.enum('billing', 'plan', 'technical', 'account', 'other'), subject: v.str(3, 200), body: v.str(1, 5000) }, body);
    return this.db.tx({ userId: a.userId, orgId: b.organizationId ?? undefined }, async (t) => {
      const r = await t.one(`INSERT INTO support_requests (organization_id, user_id, category, subject) VALUES ($1,$2,$3,$4) RETURNING id`, [b.organizationId ?? null, a.userId, b.category, b.subject]);
      await t.q(`INSERT INTO support_messages (request_id, author_id, body) VALUES ($1,$2,$3)`, [r.id, a.userId, b.body]);
      return r;
    });
  }

  @Get(':id')
  async get(@Param('id') id: string, @Auth() a: AuthInfo) {
    const r = await this.db.tx({ userId: a.userId }, async (t) => {
      const req = await t.one(`SELECT r.id, r.category, r.subject, r.status, r.created_at, r.organization_id, o.name AS organization_name, u.full_name AS user_name, u.email AS user_email
        FROM support_requests r LEFT JOIN organizations o ON o.id = r.organization_id LEFT JOIN users u ON u.id = r.user_id WHERE r.id = $1`, [uid(id)]);
      if (!req) return null;
      const messages = await t.q(`SELECT m.id, m.body, m.from_staff, m.created_at, CASE WHEN m.from_staff THEN 'MEDORA support' ELSE u.full_name END AS author
        FROM support_messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.request_id = $1 ORDER BY m.created_at`, [id]);
      return { ...req, messages };
    });
    if (!r) throw new NotFoundException('Request not found');
    return r;
  }

  @Post(':id/messages')
  async reply(@Param('id') id: string, @Body() body: unknown, @Auth() a: AuthInfo) {
    const b = parse({ body: v.str(1, 5000) }, body);
    await this.db.tx({ userId: a.userId }, async (t) => {
      const req = await t.one(`SELECT id, user_id FROM support_requests WHERE id = $1`, [uid(id)]);
      if (!req) throw new NotFoundException('Request not found');
      const admin = (await t.one(`SELECT app_is_platform_admin() AS a`)).a;
      await t.q(`INSERT INTO support_messages (request_id, author_id, from_staff, body) VALUES ($1,$2,$3,$4)`, [id, a.userId, admin, b.body]);
      await t.q(`UPDATE support_requests SET status = $2, updated_at = now() WHERE id = $1`, [id, admin ? 'answered' : 'open']);
    });
    return this.get(id, a);
  }

  @Post(':id/status') @HttpCode(200)
  async status(@Param('id') id: string, @Body() body: unknown, @Auth() a: AuthInfo) {
    const b = parse({ status: v.enum('open', 'closed') }, body);
    const r = await this.db.tx({ userId: a.userId }, (t) => t.q(`UPDATE support_requests SET status = $2, updated_at = now() WHERE id = $1 RETURNING id`, [uid(id), b.status]));
    if (!r.length) throw new NotFoundException('Request not found');
    return this.get(id, a);
  }
}

/** MEDORA super-admin console. Workspace metadata, subscriptions and counts only: never patient or clinical records. */
@PlatformAdmin()
@Controller('admin')
export class AdminController {
  constructor(private db: Db) {}
  private tx<T>(a: AuthInfo, fn: (t: any) => Promise<T>) { return this.db.tx({ userId: a.userId }, fn); }

  @Get('overview')
  overview(@Auth() a: AuthInfo) { return this.tx(a, async (t) => (await t.one(`SELECT admin_overview() AS o`)).o); }

  @Get('workspaces')
  workspaces(@Auth() a: AuthInfo) { return this.tx(a, (t) => t.q(`SELECT *, price::float FROM admin_workspaces()`)); }

  @Get('workspaces/:id')
  async workspace(@Param('id') id: string, @Auth() a: AuthInfo) {
    const r = await this.tx(a, async (t) => {
      const w = await t.one(`SELECT *, price::float FROM admin_workspaces() WHERE id = $1`, [uid(id)]);
      if (!w) return null;
      const sub = await t.one(`SELECT ${SUB_COLS} FROM org_subscription($1)`, [id]);
      const detail = (await t.one(`SELECT admin_subscription_detail($1) AS d`, [id])).d;
      return { ...w, subscription: sub, ...detail };
    });
    if (!r) throw new NotFoundException('Workspace not found');
    return r;
  }

  @Post('workspaces/:id/status') @HttpCode(200)
  async orgStatus(@Param('id') id: string, @Body() body: unknown, @Auth() a: AuthInfo) {
    const b = parse({ status: v.enum('active', 'suspended'), reason: v.str(3, 500).nullable() }, body);
    if (b.status === 'suspended' && !b.reason) throw new BadRequestException('A reason is required to suspend');
    await this.tx(a, (t) => t.q(`SELECT admin_set_org_status($1,$2,$3)`, [uid(id), b.status, b.reason ?? null]));
    return this.workspace(id, a);
  }

  @Patch('workspaces/:id/subscription')
  async subscription(@Param('id') id: string, @Body() body: unknown, @Auth() a: AuthInfo) {
    const b = parse({ plan: v.str(2, 40).optional(), status: v.enum('trial', 'active', 'past_due', 'cancelled', 'suspended').optional(),
      cycle: v.enum('monthly', 'yearly').optional(), trialEndsAt: v.datetime().optional(), periodEnd: v.datetime().optional(),
      price: v.num(0, 1e7).nullable(), note: v.str(1, 500).nullable() }, body);
    await this.tx(a, (t) => t.q(`SELECT admin_update_subscription($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uid(id), b.plan ?? null, b.status ?? null, b.cycle ?? null, b.trialEndsAt ?? null, b.periodEnd ?? null, b.price ?? null, b.price === null, b.note ?? null]));
    return this.workspace(id, a);
  }

  @Post('workspaces/:id/payments')
  async payment(@Param('id') id: string, @Body() body: unknown, @Auth() a: AuthInfo) {
    const b = parse({ amount: v.num(0.01, 1e9), currency: v.enum('USD', 'LBP'), method: v.enum('cash', 'bank_transfer', 'card', 'omt', 'whish', 'cheque', 'other'),
      reference: v.str(1, 200).nullable(), months: v.int(1, 36) }, body);
    await this.tx(a, (t) => t.q(`SELECT admin_record_payment($1,$2,$3,$4,$5,$6)`, [uid(id), b.amount, b.currency, b.method, b.reference ?? null, b.months]));
    return this.workspace(id, a);
  }

  @Post('payments/:id/refund') @HttpCode(200)
  async refund(@Param('id') id: string, @Auth() a: AuthInfo) {
    await this.tx(a, (t) => t.q(`SELECT admin_refund_payment($1)`, [uid(id)]));
    return { ok: true };
  }

  @Get('users')
  users(@Query('q') q: string | undefined, @Auth() a: AuthInfo) {
    const s = q && q.trim() ? q.trim().slice(0, 100) : null;
    return this.tx(a, (t) => t.q(`SELECT * FROM admin_users($1)`, [s]));
  }

  @Post('users/:id/status') @HttpCode(200)
  async userStatus(@Param('id') id: string, @Body() body: unknown, @Auth() a: AuthInfo) {
    const b = parse({ status: v.enum('active', 'suspended'), reason: v.str(3, 500).nullable() }, body);
    await this.tx(a, (t) => t.q(`SELECT admin_set_user_status($1,$2,$3)`, [uid(id), b.status, b.reason ?? null]));
    return { ok: true };
  }

  @Get('plans')
  plans(@Auth() a: AuthInfo) {
    return this.tx(a, async (t) => ({
      plans: await t.q(`SELECT ${PLAN_COLS}, (SELECT count(*)::int FROM subscriptions s WHERE s.plan_code = plans.code AND s.status IN ('trial','active','past_due')) AS workspaces FROM plans ORDER BY sort_order, code`),
      features: await t.q(`SELECT code, description FROM plan_features ORDER BY code`),
    }));
  }

  @Put('plans/:code')
  async savePlan(@Param('code') code: string, @Body() body: unknown, @Auth() a: AuthInfo) {
    const c = parse({ code: v.str(2, 40) }, { code }).code;
    if (!/^[a-z][a-z0-9_]*$/.test(c)) throw new BadRequestException('Plan codes use lowercase letters, digits and _');
    const b = parse({ name: v.str(2, 80), description: v.str(1, 500).nullable(), monthlyPrice: v.num(0, 1e6).nullable(), yearlyPrice: v.num(0, 1e7).nullable(),
      currency: v.enum('USD', 'LBP'), maxDoctors: v.int(1, 10000).nullable(), maxAssistants: v.int(0, 10000).nullable(), maxLocations: v.int(1, 1000).nullable(),
      maxPatients: v.int(1, 10_000_000).nullable(), features: v.object(Object.fromEntries(FEATURES.map((f) => [f, v.bool()])) as Record<(typeof FEATURES)[number], ReturnType<typeof v.bool>>),
      appliesTo: v.array(v.enum('independent_practice', 'medical_center'), 2), isPublic: v.bool(), isActive: v.bool(), sortOrder: v.int(0, 1000) }, body);
    if (!b.appliesTo.length) throw new BadRequestException('Choose at least one kind of workspace');
    await this.tx(a, (t) => t.q(`SELECT admin_upsert_plan($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [c, b.name, b.description ?? null, b.monthlyPrice ?? null, b.yearlyPrice ?? null, b.currency, b.maxDoctors ?? null, b.maxAssistants ?? null,
        b.maxLocations ?? null, b.maxPatients ?? null, JSON.stringify(b.features), b.appliesTo, b.isPublic, b.isActive, b.sortOrder]));
    return this.plans(a);
  }

  @Get('settings')
  settings(@Auth() a: AuthInfo) { return this.tx(a, (t) => t.q(`SELECT key, value, updated_at FROM platform_settings ORDER BY key`)); }

  @Put('settings/:key')
  async setSetting(@Param('key') key: string, @Body() body: unknown, @Auth() a: AuthInfo) {
    const shapes: Record<string, any> = {
      trial_days: v.int(0, 365), grace_days: v.int(0, 90), signups_open: v.bool(), currency: v.enum('USD', 'LBP'), support_email: v.email(),
      default_plan_independent_practice: v.str(2, 40), default_plan_medical_center: v.str(2, 40),
    };
    if (!shapes[key]) throw new NotFoundException('Unknown setting');
    const b = parse({ value: shapes[key] }, body);
    if (key.startsWith('default_plan_')) {
      const ok = await this.tx(a, (t) => t.one(`SELECT 1 AS ok FROM plans WHERE code = $1 AND is_active AND $2 = ANY(applies_to)`, [b.value, key.replace('default_plan_', '')]));
      if (!ok) throw new BadRequestException('That plan is not available for this kind of workspace');
    }
    await this.tx(a, (t) => t.q(`SELECT admin_set_setting($1,$2)`, [key, JSON.stringify(b.value)]));
    return this.settings(a);
  }

  @Get('support')
  support(@Query('status') status: string | undefined, @Auth() a: AuthInfo) {
    const s = parse({ status: v.enum('open', 'answered', 'closed').optional() }, { status }).status;
    return this.tx(a, (t) => t.q(`SELECT r.id, r.category, r.subject, r.status, r.created_at, r.updated_at, o.name AS organization_name, u.full_name AS user_name, u.email AS user_email
      FROM support_requests r LEFT JOIN organizations o ON o.id = r.organization_id JOIN users u ON u.id = r.user_id
      WHERE ($1::text IS NULL OR r.status = $1) ORDER BY (r.status = 'open') DESC, r.updated_at DESC LIMIT 200`, [s ?? null]));
  }
}

@Module({ controllers: [SubscriptionController, SupportController, AdminController] })
export class CommercialModule {}
