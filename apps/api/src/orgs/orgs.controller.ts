import { BadRequestException, Body, Controller, Delete, Get, Module, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { Db } from '../db/db.service.js';
import { Ctx, RequirePerm, Tenant, RequireFeature } from '../common/decorators.js';
import type { TenantInfo } from '../common/types.js';
import { parse, v } from '../common/validate.js';
import { audit } from '../common/audit.js';

const ORG_FIELDS: Record<string, string> = {
  name: 'name', phone: 'phone', email: 'email', address: 'address', defaultLanguage: 'default_language', timezone: 'timezone',
  legalName: 'legal_name', taxId: 'tax_id', sharePatientsBetweenDoctors: 'share_patients_between_doctors', allowOverbooking: 'allow_overbooking',
  doctorsManageAbsences: 'doctors_manage_absences', daySheetPhones: 'day_sheet_phones', messageWindowStart: 'message_window_start', messageWindowEnd: 'message_window_end',
};
const ORG_COLS = `id, kind, name, phone, email, address, default_language, timezone, legal_name, tax_id, share_patients_between_doctors, allow_overbooking,
  doctors_manage_absences, day_sheet_phones, to_char(message_window_start, 'HH24:MI') AS message_window_start, to_char(message_window_end, 'HH24:MI') AS message_window_end`;
const id = (x: string) => parse({ id: v.uuid() }, { id: x }).id;

/** The active workspace: profile, locations, rooms, departments. */
@Controller('org')
export class OrgsController {
  constructor(private db: Db) {}

  @Tenant() @Get()
  get(@Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => ({
      organization: await t.one(`SELECT ${ORG_COLS}, created_at FROM organizations WHERE id=$1`, [c.orgId]),
      locations: await t.q(`SELECT id, name, address FROM locations WHERE organization_id=$1 ORDER BY name`, [c.orgId]),
      rooms: await t.q(`SELECT r.id, r.name, r.location_id FROM rooms r JOIN locations l ON l.id=r.location_id WHERE l.organization_id=$1 ORDER BY r.name`, [c.orgId]),
      departments: await t.q(`SELECT id, name FROM departments WHERE organization_id=$1 ORDER BY name`, [c.orgId]),
      me: {
        memberships: c.memberships, permissions: [...c.permissions].sort(), actingDoctors: c.actingDoctors,
        orgWide: c.orgWide, doctorMembershipId: c.doctorMembershipId,
      },
      plan: c.plan,
    }));
  }

  /** Workspace profile and clinic-wide settings. Only owners and admins (org.manage) change them. */
  @RequirePerm('org.manage') @Patch()
  update(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ name: v.str(2, 120).optional(), phone: v.str(5, 30).nullable(), email: v.email().nullable(), address: v.str(2, 300).nullable(),
      defaultLanguage: v.enum('en', 'ar', 'fr').optional(), timezone: v.str(3, 60).optional(),
      legalName: v.str(2, 160).nullable(), taxId: v.str(2, 60).nullable(),
      sharePatientsBetweenDoctors: v.bool().optional(), allowOverbooking: v.bool().optional(), doctorsManageAbsences: v.bool().optional(),
      daySheetPhones: v.bool().optional(), messageWindowStart: v.time().optional(), messageWindowEnd: v.time().optional() }, body) as Record<string, unknown>;
    return this.db.tx(c, async (t) => {
      if (b.timezone !== undefined && !(await t.one(`SELECT 1 FROM pg_timezone_names WHERE name=$1`, [b.timezone]))) throw new BadRequestException('Unknown time zone');
      const sets: string[] = []; const vals: unknown[] = [c.orgId];
      for (const [k, col] of Object.entries(ORG_FIELDS)) if (b[k] !== undefined) { vals.push(b[k]); sets.push(`${col}=$${vals.length}`); }
      if (sets.length) {
        try { await t.q(`UPDATE organizations SET ${sets.join(', ')} WHERE id=$1`, vals); }
        catch (e: any) { if (e.constraint === 'organizations_message_window') throw new BadRequestException('The message window must end after it starts'); throw e; }
      }
      await audit(t, c.userId, c.orgId, 'organization.update', 'organization', c.orgId, b);
      return t.one(`SELECT ${ORG_COLS} FROM organizations WHERE id=$1`, [c.orgId]);
    });
  }

  /** Every emergency opening of a patient file, for owners and admins to review. */
  @RequirePerm('staff.manage') @Get('emergency-access')
  emergencyLog(@Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT e.id, e.opened_at, e.expires_at, e.reason, e.patient_id, p.full_name AS patient_name, p.patient_number, u.full_name AS doctor_name
      FROM emergency_access e JOIN memberships m ON m.id=e.membership_id JOIN users u ON u.id=m.user_id
      LEFT JOIN patients p ON p.id=e.patient_id WHERE e.organization_id=$1 ORDER BY e.opened_at DESC LIMIT 200`, [c.orgId]));
  }

  @RequirePerm('org.manage') @Post('locations')
  addLocation(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ name: v.str(2, 120), address: v.str(2, 300).optional() }, body);
    return this.db.tx(c, async (t) => {
      const r = await t.one(`INSERT INTO locations(organization_id,name,address) VALUES ($1,$2,$3) RETURNING id, name, address`, [c.orgId, b.name, b.address ?? null]);
      await audit(t, c.userId, c.orgId, 'location.create', 'location', r.id);
      return r;
    });
  }

  @RequirePerm('org.manage') @Patch('locations/:id')
  async updateLocation(@Param('id') lid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ name: v.str(2, 120).optional(), address: v.str(2, 300).nullable() }, body);
    const r = await this.db.tx(c, (t) => t.one(`UPDATE locations SET name=COALESCE($2,name), address=CASE WHEN $3::boolean THEN $4 ELSE address END WHERE id=$1 RETURNING id, name, address`,
      [id(lid), b.name ?? null, b.address !== undefined, b.address ?? null]));
    if (!r) throw new NotFoundException();
    return r;
  }

  @RequirePerm('org.manage') @Post('locations/:id/rooms')
  async addRoom(@Param('id') lid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ name: v.str(1, 80) }, body);
    return this.db.tx(c, async (t) => {
      if (!(await t.one(`SELECT 1 FROM locations WHERE id=$1`, [id(lid)]))) throw new NotFoundException('Location not found');
      const r = await t.one(`INSERT INTO rooms(location_id,name) VALUES ($1,$2) RETURNING id, name, location_id`, [lid, b.name]);
      await audit(t, c.userId, c.orgId, 'room.create', 'room', r.id);
      return r;
    });
  }

  @RequirePerm('org.manage') @Delete('rooms/:id')
  async deleteRoom(@Param('id') rid: string, @Ctx() c: TenantInfo) {
    const r = await this.db.tx(c, (t) => t.q(`DELETE FROM rooms WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM appointments WHERE room_id=$1) RETURNING id`, [id(rid)]));
    if (!r.length) throw new NotFoundException('Room not found, or it already has appointments');
    return { ok: true };
  }

  @RequireFeature('departments') @RequirePerm('org.manage') @Post('departments')
  addDepartment(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ name: v.str(2, 120) }, body);
    return this.db.tx(c, async (t) => {
      const r = await t.one(`INSERT INTO departments(organization_id,name) VALUES ($1,$2) RETURNING id, name`, [c.orgId, b.name]);
      await audit(t, c.userId, c.orgId, 'department.create', 'department', r.id);
      return r;
    });
  }

  @RequirePerm('org.manage') @Patch('departments/:id')
  async renameDepartment(@Param('id') did: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ name: v.str(2, 120) }, body);
    const r = await this.db.tx(c, (t) => t.one(`UPDATE departments SET name=$2 WHERE id=$1 RETURNING id, name`, [id(did), b.name]));
    if (!r) throw new NotFoundException();
    return r;
  }

  @RequirePerm('staff.manage') @Get('audit')
  auditLog(@Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT a.id, a.occurred_at, a.action, a.entity_type, a.entity_id, a.details, u.full_name AS actor
      FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.organization_id=$1 ORDER BY a.id DESC LIMIT 200`, [c.orgId]));
  }
}

@Module({ controllers: [OrgsController] })
export class OrgsModule {}
