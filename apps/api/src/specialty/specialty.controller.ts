import { BadRequestException, Body, Controller, ForbiddenException, Get, Module, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { customize, type Customization } from '@medora/shared';
import { Db } from '../db/db.service.js';
import { Ctx, Public, RequirePerm, Tenant, RequireFeature } from '../common/decorators.js';
import type { TenantInfo } from '../common/types.js';
import { parse, v } from '../common/validate.js';
import { audit } from '../common/audit.js';
import { SpecialtyService } from './specialty.service.js';

@Controller()
export class SpecialtyController {
  constructor(private db: Db, private spec: SpecialtyService) {}

  @Public() @Get('specialties')
  specialties() {
    return this.db.tx({}, (t) => t.q(`SELECT code, name, names, has_full_preset FROM specialties ORDER BY has_full_preset DESC, name`));
  }

  /** What the doctor's workspace looks like: profile sections and dashboard widgets for their specialty. */
  @Tenant() @Get('specialty/workspace')
  workspace(@Ctx() c: TenantInfo, @Query('doctor') doctor?: string) {
    return this.db.tx(c, async (t) => {
      const d = await this.spec.resolveDoctor(t, c, doctor || undefined);
      const profile = await this.spec.effective(t, d.id, d.specialty, 'patient_profile');
      const dashboard = await this.spec.effective(t, d.id, d.specialty, 'dashboard');
      const sp = await t.one(`SELECT code, name, names, has_full_preset FROM specialties WHERE code=$1`, [d.specialty]);
      return { doctorMembershipId: d.id, specialty: sp, profile, widgets: dashboard.schema.widgets ?? [] };
    });
  }

  @Tenant() @Get('specialty/versions/:id')
  async version(@Param('id') vid: string, @Ctx() c: TenantInfo) {
    const r = await this.db.tx(c, (t) => t.one(`SELECT v.id, v.version, v.schema, v.published_at, t.kind, t.specialty_code, t.owner_membership_id
      FROM template_versions v JOIN clinical_templates t ON t.id=v.template_id WHERE v.id=$1`, [parse({ id: v.uuid() }, { id: vid }).id]));
    if (!r) throw new NotFoundException();
    return r;
  }

  @Tenant() @Get('specialty/history')
  history(@Ctx() c: TenantInfo) {
    if (!c.doctorMembershipId) return [];
    return this.db.tx(c, (t) => t.q(`SELECT t.id AS template_id, t.kind, t.specialty_code, v.id AS version_id, v.version, v.published_at
      FROM clinical_templates t JOIN template_versions v ON v.template_id=t.id WHERE t.owner_membership_id=$1 ORDER BY t.kind, v.version DESC`, [c.doctorMembershipId]));
  }

  /**
   * Doctor customization: add custom fields, hide optional ones, relabel. Produces a NEW published version of the
   * doctor's own template; records saved under older versions keep pointing at them and are never altered.
   */
  @RequireFeature('specialty_templates') @RequirePerm('template.manage') @Post('specialty/customize')
  customizeTemplate(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ customization: v.any() }, body);
    if (!c.doctorMembershipId) throw new ForbiddenException('Only a doctor can customize their specialty templates');
    const cz = b.customization as Customization;
    if (!cz || typeof cz !== 'object') throw new BadRequestException('customization must be an object');
    return this.db.tx(c, async (t) => {
      const d = await this.spec.resolveDoctor(t, c, c.doctorMembershipId!);
      const cur = await this.spec.effective(t, d.id, d.specialty, 'patient_profile');
      const { schema, errors } = customize(cur.schema, cz);
      if (errors.length) throw new BadRequestException({ message: 'Customization not valid', errors: errors.map((e) => `${e.path}: ${e.message}`) });
      let templateId = cur.isCustom ? cur.templateId : null;
      if (!templateId) {
        templateId = (await t.one(`INSERT INTO clinical_templates(kind,specialty_code,owner_membership_id,name,based_on_template_id)
          VALUES ('patient_profile',$1,$2,'My patient profile',$3) RETURNING id`, [d.specialty, d.id, cur.templateId])).id;
      }
      const version = cur.isCustom ? cur.version + 1 : 1;
      const ver = await t.one(`INSERT INTO template_versions(template_id,version,schema,published_at) VALUES ($1,$2,$3,now()) RETURNING id, version`, [templateId, version, JSON.stringify(schema)]);
      await audit(t, c.userId, c.orgId, 'template.publish', 'template_version', ver.id, { version });
      return { templateId, versionId: ver.id, version: ver.version, schema };
    });
  }
}

@Module({ controllers: [SpecialtyController], providers: [SpecialtyService], exports: [SpecialtyService] })
export class SpecialtyModule {}
