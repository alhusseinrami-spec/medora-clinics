import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Db } from '../db/db.service.js';
import { Ctx, RequireAnyPerm, RequirePerm } from '../common/decorators.js';
import type { TenantInfo } from '../common/types.js';
import { parse, v } from '../common/validate.js';
import { audit } from '../common/audit.js';
import { round2, uid } from './invoices.controller.js';

const CATEGORIES = ['rent', 'salaries', 'supplies', 'equipment', 'utilities', 'maintenance', 'marketing', 'insurance', 'taxes', 'fees', 'other'] as const;

@Controller('finance')
export class FinanceController {
  constructor(private db: Db) {}

  // ---------- Exchange rates (history is permanent; each transaction keeps the rate it used) ----------
  @RequireAnyPerm('payment.register', 'finance.view') @Get('rates')
  rates(@Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => ({
      current: (await t.one(`SELECT app_current_rate($1) AS r`, [c.orgId])).r,
      history: await t.q(`SELECT r.id, r.lbp_per_usd, r.effective_from, r.note, u.full_name AS created_by_name FROM exchange_rates r
        LEFT JOIN users u ON u.id=r.created_by WHERE r.organization_id=$1 ORDER BY r.effective_from DESC LIMIT 100`, [c.orgId]),
    }));
  }

  @RequirePerm('finance.view') @Post('rates')
  setRate(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ lbpPerUsd: v.num(1, 10_000_000), note: v.str(1, 300).nullable() }, body);
    if (!c.permissions.has('org.manage')) throw new ForbiddenException('Setting the exchange rate needs the workspace management permission');
    return this.db.tx(c, async (t) => {
      const r = await t.one(`INSERT INTO exchange_rates(organization_id, lbp_per_usd, note, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [c.orgId, b.lbpPerUsd, b.note ?? null, c.userId]);
      await audit(t, c.userId, c.orgId, 'finance.rate', 'exchange_rate', r.id, { lbpPerUsd: b.lbpPerUsd });
      return { id: r.id, current: b.lbpPerUsd };
    });
  }

  // ---------- Doctor commissions (medical centers) ----------
  @RequirePerm('finance.view') @Get('commissions')
  commissions(@Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT m.id AS membership_id, u.full_name, m.specialty_code, cr.doctor_percent, cr.updated_at
      FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN commission_rules cr ON cr.membership_id=m.id
      WHERE m.organization_id=$1 AND m.role_code='doctor' AND m.status='active' AND ($2 OR m.user_id=$3) ORDER BY u.full_name`, [c.orgId, c.orgWide, c.userId]));
  }

  /** The doctor's share of what they bill. It is frozen on each invoice when issued, so changes apply to new invoices only. */
  @RequirePerm('finance.view') @Put('commissions/:membershipId')
  setCommission(@Param('membershipId') mid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ doctorPercent: v.num(0, 100) }, body);
    if (!c.orgWide || !c.permissions.has('org.manage')) throw new ForbiddenException('Only center management sets commissions');
    return this.db.tx(c, async (t) => {
      const m = await t.one(`SELECT id FROM memberships WHERE id=$1 AND organization_id=$2 AND role_code='doctor'`, [uid(mid), c.orgId]);
      if (!m) throw new NotFoundException('Doctor not found in this workspace');
      await t.q(`INSERT INTO commission_rules(membership_id, doctor_percent, updated_by) VALUES ($1,$2,$3)
        ON CONFLICT (membership_id) DO UPDATE SET doctor_percent=EXCLUDED.doctor_percent, updated_by=EXCLUDED.updated_by, updated_at=now()`, [mid, b.doctorPercent, c.userId]);
      await audit(t, c.userId, c.orgId, 'finance.commission', 'membership', mid, { doctorPercent: b.doctorPercent });
      return { membership_id: mid, doctor_percent: b.doctorPercent };
    });
  }

  // ---------- Expenses ----------
  @RequirePerm('finance.view') @Get('expenses')
  expenses(@Ctx() c: TenantInfo, @Query('from') from?: string, @Query('to') to?: string) {
    const q = parse({ from: v.date().optional(), to: v.date().optional() }, { from, to });
    return this.db.tx(c, (t) => t.q(`SELECT e.id, e.category, e.description, e.amount, e.currency, e.lbp_per_usd, e.spent_at, e.method_code, e.membership_id, e.department_id,
        du.full_name AS doctor_name, d.name AS department_name, cu.full_name AS created_by_name, e.created_at
      FROM expenses e LEFT JOIN memberships m ON m.id=e.membership_id LEFT JOIN users du ON du.id=m.user_id LEFT JOIN departments d ON d.id=e.department_id
      LEFT JOIN users cu ON cu.id=e.created_by
      WHERE e.organization_id=$1 AND e.deleted_at IS NULL AND ($2::date IS NULL OR e.spent_at >= $2) AND ($3::date IS NULL OR e.spent_at <= $3)
      ORDER BY e.spent_at DESC, e.created_at DESC LIMIT 500`, [c.orgId, q.from ?? null, q.to ?? null]));
  }

  /** In a center, a shared expense has no doctor; doctors can only record their own. */
  @RequirePerm('finance.view') @Post('expenses')
  addExpense(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ category: v.enum(...CATEGORIES), description: v.str(1, 300).nullable(), amount: v.num(0.01, 1e12), currency: v.enum('USD', 'LBP'),
      spentAt: v.date().optional(), method: v.enum('cash', 'card', 'bank_transfer', 'whish', 'omt').nullable(), doctorMembershipId: v.uuid().nullable(), departmentId: v.uuid().nullable() }, body);
    return this.db.tx(c, async (t) => {
      let doctor = b.doctorMembershipId ?? null;
      if (!doctor && !c.orgWide) doctor = c.doctorMembershipId;
      if (!c.orgWide && (!doctor || !c.actingDoctors.includes(doctor))) throw new ForbiddenException('You can only record your own expenses');
      if (c.orgKind === 'independent_practice' && !doctor) doctor = c.doctorMembershipId;
      const r = await t.one(`INSERT INTO expenses(organization_id, membership_id, department_id, category, description, amount, currency, spent_at, method_code, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8::date, current_date),$9,$10) RETURNING id`,
        [c.orgId, doctor, b.departmentId ?? null, b.category, b.description ?? null, b.amount, b.currency, b.spentAt ?? null, b.method ?? null, c.userId]);
      await audit(t, c.userId, c.orgId, 'expense.create', 'expense', r.id, { amount: b.amount, currency: b.currency });
      return r;
    });
  }

  @RequirePerm('finance.view') @Patch('expenses/:id')
  updateExpense(@Param('id') eid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ category: v.enum(...CATEGORIES).optional(), description: v.str(1, 300).nullable(), spentAt: v.date().optional() }, body);
    return this.db.tx(c, async (t) => {
      const r = await t.q(`UPDATE expenses SET category=coalesce($2, category), description=CASE WHEN $5 THEN $3 ELSE description END, spent_at=coalesce($4::date, spent_at)
        WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [uid(eid), b.category ?? null, b.description ?? null, b.spentAt ?? null, b.description !== undefined]);
      if (!r.length) throw new NotFoundException('Expense not found');
      await audit(t, c.userId, c.orgId, 'expense.update', 'expense', eid);
      return { ok: true };
    });
  }

  @RequirePerm('finance.view') @Delete('expenses/:id')
  removeExpense(@Param('id') eid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const r = await t.q(`UPDATE expenses SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [uid(eid)]);
      if (!r.length) throw new NotFoundException('Expense not found');
      await audit(t, c.userId, c.orgId, 'expense.delete', 'expense', eid);
      return { ok: true };
    });
  }

  // ---------- Reports ----------
  /**
   * Financial overview for a period. Every amount is converted to USD with the rate frozen on its own
   * transaction; cash actually received is also given per currency. Row-level security limits a doctor in
   * a center to their own figures, so the same report serves the center and each doctor.
   */
  @RequirePerm('finance.view') @Get('summary')
  summary(@Ctx() c: TenantInfo, @Query('from') from: string, @Query('to') to: string) {
    const q = parse({ from: v.date(), to: v.date() }, { from, to });
    if (q.to < q.from) throw new BadRequestException('The end date is before the start date');
    const P = [c.orgId, q.from, q.to];
    const usd = (amt: string, cur: string, rate: string) => `CASE WHEN ${cur}='USD' THEN ${amt} ELSE ${amt} / ${rate} END`;
    return this.db.tx(c, async (t) => {
      const invoiced = await t.one(`SELECT
          coalesce(sum(${usd('b.total', 'i.currency', 'i.lbp_per_usd')}) FILTER (WHERE i.kind='invoice'), 0) AS invoiced,
          coalesce(sum(${usd('b.total', 'i.currency', 'i.lbp_per_usd')}) FILTER (WHERE i.kind='credit_note'), 0) AS credited,
          count(*) FILTER (WHERE i.kind='invoice')::int AS invoice_count
        FROM invoices i JOIN invoice_balances b ON b.invoice_id=i.id
        WHERE i.organization_id=$1 AND i.status='issued' AND i.issued_at >= $2::date AND i.issued_at < $3::date + 1`, P);
      const byKind = await t.q(`SELECT it.kind, sum(${usd('it.quantity*it.unit_price', 'i.currency', 'i.lbp_per_usd')}) AS amount
        FROM invoice_items it JOIN invoices i ON i.id=it.invoice_id
        WHERE i.organization_id=$1 AND i.status='issued' AND i.kind='invoice' AND i.issued_at >= $2::date AND i.issued_at < $3::date + 1 GROUP BY it.kind`, P);
      const received = await t.one(`SELECT
          coalesce(sum(${usd('p.amount', 'p.currency', 'p.lbp_per_usd')}) FILTER (WHERE p.claim_id IS NULL), 0) AS patients,
          coalesce(sum(${usd('p.amount', 'p.currency', 'p.lbp_per_usd')}) FILTER (WHERE p.claim_id IS NOT NULL), 0) AS insurance,
          coalesce(sum(-${usd('p.amount', 'p.currency', 'p.lbp_per_usd')}) FILTER (WHERE p.refund_of IS NOT NULL), 0) AS refunds,
          coalesce(sum(p.amount) FILTER (WHERE p.currency='USD'), 0) AS cash_usd,
          coalesce(sum(p.amount) FILTER (WHERE p.currency='LBP'), 0) AS cash_lbp
        FROM payments p JOIN invoices i ON i.id=p.invoice_id
        WHERE p.organization_id=$1 AND p.received_at >= $2::date AND p.received_at < $3::date + 1`, P);
      const byMethod = await t.q(`SELECT p.method_code, pm.name, p.currency, sum(p.amount) AS amount FROM payments p JOIN payment_methods pm ON pm.code=p.method_code
        JOIN invoices i ON i.id=p.invoice_id WHERE p.organization_id=$1 AND p.received_at >= $2::date AND p.received_at < $3::date + 1
        GROUP BY p.method_code, pm.name, p.currency ORDER BY pm.name, p.currency`, P);
      const outstanding = await t.one(`SELECT coalesce(sum(${usd('(b.total - b.credited - b.paid)', 'i.currency', 'i.lbp_per_usd')}), 0) AS amount,
          count(*)::int AS invoices
        FROM invoices i JOIN invoice_balances b ON b.invoice_id=i.id
        WHERE i.organization_id=$1 AND i.status='issued' AND i.kind='invoice' AND b.total - b.credited - b.paid > 0.004`, [c.orgId]);
      const expenses = await t.one(`SELECT coalesce(sum(${usd('e.amount', 'e.currency', 'e.lbp_per_usd')}), 0) AS total,
          coalesce(sum(${usd('e.amount', 'e.currency', 'e.lbp_per_usd')}) FILTER (WHERE e.membership_id IS NULL), 0) AS shared
        FROM expenses e WHERE e.organization_id=$1 AND e.deleted_at IS NULL AND e.spent_at BETWEEN $2::date AND $3::date`, P);
      const expensesByCategory = await t.q(`SELECT e.category, sum(${usd('e.amount', 'e.currency', 'e.lbp_per_usd')}) AS amount FROM expenses e
        WHERE e.organization_id=$1 AND e.deleted_at IS NULL AND e.spent_at BETWEEN $2::date AND $3::date GROUP BY e.category ORDER BY 2 DESC`, P);
      // Doctor and center shares come from money actually collected, split with the percentage frozen on each invoice.
      const byDoctor = await t.q(`WITH col AS (
          SELECT i.doctor_membership_id AS mid, ${usd('p.amount', 'p.currency', 'p.lbp_per_usd')} AS amt, coalesce(i.doctor_percent, 100) AS pct
            FROM payments p JOIN invoices i ON i.id=p.invoice_id
           WHERE p.organization_id=$1 AND p.received_at >= $2::date AND p.received_at < $3::date + 1),
        inv AS (
          SELECT i.doctor_membership_id AS mid, sum(${usd('b.total', 'i.currency', 'i.lbp_per_usd')} * CASE WHEN i.kind='credit_note' THEN -1 ELSE 1 END) AS invoiced
            FROM invoices i JOIN invoice_balances b ON b.invoice_id=i.id
           WHERE i.organization_id=$1 AND i.status='issued' AND i.issued_at >= $2::date AND i.issued_at < $3::date + 1 GROUP BY 1),
        exp AS (
          SELECT e.membership_id AS mid, sum(${usd('e.amount', 'e.currency', 'e.lbp_per_usd')}) AS expenses FROM expenses e
           WHERE e.organization_id=$1 AND e.deleted_at IS NULL AND e.spent_at BETWEEN $2::date AND $3::date AND e.membership_id IS NOT NULL GROUP BY 1)
        SELECT m.id AS membership_id, u.full_name AS doctor_name, coalesce(inv.invoiced, 0) AS invoiced,
               coalesce((SELECT sum(amt) FROM col WHERE col.mid=m.id), 0) AS collected,
               coalesce((SELECT sum(amt * pct / 100) FROM col WHERE col.mid=m.id), 0) AS doctor_share,
               coalesce((SELECT sum(amt * (100 - pct) / 100) FROM col WHERE col.mid=m.id), 0) AS center_share,
               coalesce(exp.expenses, 0) AS expenses
          FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN inv ON inv.mid=m.id LEFT JOIN exp ON exp.mid=m.id
         WHERE m.organization_id=$1 AND m.role_code='doctor' AND (inv.mid IS NOT NULL OR exp.mid IS NOT NULL OR EXISTS (SELECT 1 FROM col WHERE col.mid=m.id))
         ORDER BY u.full_name`, P);
      const byDepartment = await t.q(`SELECT coalesce(d.name, '—') AS department, sum(${usd('b.total', 'i.currency', 'i.lbp_per_usd')} * CASE WHEN i.kind='credit_note' THEN -1 ELSE 1 END) AS invoiced
        FROM invoices i JOIN invoice_balances b ON b.invoice_id=i.id LEFT JOIN departments d ON d.id=i.department_id
        WHERE i.organization_id=$1 AND i.status='issued' AND i.issued_at >= $2::date AND i.issued_at < $3::date + 1 AND i.department_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`, P);
      const daily = await t.q(`SELECT (p.received_at AT TIME ZONE coalesce(o.timezone, 'Asia/Beirut'))::date AS day, sum(${usd('p.amount', 'p.currency', 'p.lbp_per_usd')}) AS received
        FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN organizations o ON o.id=p.organization_id
        WHERE p.organization_id=$1 AND p.received_at >= $2::date AND p.received_at < $3::date + 1 GROUP BY 1 ORDER BY 1`, P);
      const n = (x: any) => round2(Number(x ?? 0));
      const receivedTotal = n(received.patients) + n(received.insurance);
      const exp = n(expenses.total);
      const centerShare = byDoctor.reduce((s, d) => s + Number(d.center_share), 0);
      const orphanCollected = receivedTotal - byDoctor.reduce((s, d) => s + Number(d.collected), 0);  // invoices without a doctor
      return {
        period: q, currency: 'USD', rate: (await t.one(`SELECT app_current_rate($1) AS r`, [c.orgId])).r,
        scope: c.orgWide ? 'workspace' : 'own',
        invoiced: n(invoiced.invoiced), credited: n(invoiced.credited), invoiceCount: invoiced.invoice_count,
        revenueByKind: Object.fromEntries(byKind.map((k) => [k.kind, n(k.amount)])),
        received: { total: receivedTotal, patients: n(received.patients), insurance: n(received.insurance), refunds: n(received.refunds),
          cashUsd: n(received.cash_usd), cashLbp: n(received.cash_lbp), byMethod: byMethod.map((m) => ({ ...m, amount: n(m.amount) })) },
        outstanding: { amount: n(outstanding.amount), invoices: outstanding.invoices },
        expenses: { total: exp, shared: n(expenses.shared), byCategory: expensesByCategory.map((e) => ({ ...e, amount: n(e.amount) })) },
        net: round2(receivedTotal - exp),
        center: c.orgKind === 'medical_center' && c.orgWide ? { share: round2(centerShare + orphanCollected), sharedExpenses: n(expenses.shared), net: round2(centerShare + orphanCollected - n(expenses.shared)) } : null,
        byDoctor: byDoctor.map((d) => ({ ...d, invoiced: n(d.invoiced), collected: n(d.collected), doctor_share: n(d.doctor_share), center_share: n(d.center_share), expenses: n(d.expenses), net: round2(Number(d.doctor_share) - Number(d.expenses)) })),
        byDepartment: byDepartment.map((d) => ({ ...d, invoiced: n(d.invoiced) })),
        daily: daily.map((d) => ({ day: d.day, received: n(d.received) })),
      };
    });
  }
}
