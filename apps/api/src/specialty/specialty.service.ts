import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { BASE_SPECIALTY, type TemplateSchema } from '@medora/shared';
import type { Tx } from '../db/db.service.js';
import type { TenantInfo } from '../common/types.js';

export interface EffectiveTemplate {
  templateId: string; versionId: string; version: number; schema: TemplateSchema; isCustom: boolean; basedOnPreset: string | null; specialty: string;
}

@Injectable()
export class SpecialtyService {
  /** Which doctor membership a request is about: explicit (must be one the caller acts for, or org-wide), else the caller's own / first assisted doctor. */
  async resolveDoctor(t: Tx, c: TenantInfo, requested?: string): Promise<{ id: string; specialty: string }> {
    const mid = requested ?? c.doctorMembershipId ?? c.actingDoctors[0];
    if (!mid) throw new BadRequestException('Choose a doctor');
    if (!c.actingDoctors.includes(mid) && !c.orgWide) throw new ForbiddenException('You do not work for this doctor');
    const m = await t.one(`SELECT id, specialty_code FROM memberships WHERE id=$1 AND organization_id=$2 AND role_code='doctor'`, [mid, c.orgId]);
    if (!m) throw new BadRequestException('Doctor not found in this workspace');
    return { id: m.id, specialty: m.specialty_code ?? BASE_SPECIALTY };
  }

  /** The doctor's own published template if they customized one, otherwise the platform preset (or the base preset for prepared specialties). */
  async effective(t: Tx, doctorMid: string, specialty: string, kind: 'patient_profile' | 'dashboard'): Promise<EffectiveTemplate> {
    const own = await t.one(`SELECT t.id AS template_id, v.id AS version_id, v.version, v.schema, t.based_on_template_id
      FROM clinical_templates t JOIN template_versions v ON v.template_id=t.id
      WHERE t.owner_membership_id=$1 AND t.kind=$2 AND t.specialty_code=$3 AND t.is_active AND v.published_at IS NOT NULL
      ORDER BY v.version DESC LIMIT 1`, [doctorMid, kind, specialty]);
    if (own) return { templateId: own.template_id, versionId: own.version_id, version: own.version, schema: own.schema, isCustom: true, basedOnPreset: own.based_on_template_id, specialty };
    const preset = await this.preset(t, specialty, kind) ?? await this.preset(t, BASE_SPECIALTY, kind);
    if (!preset) throw new BadRequestException('No preset found. Run db/sync_presets.js');
    return { ...preset, isCustom: false, basedOnPreset: null, specialty };
  }

  private async preset(t: Tx, specialty: string, kind: string) {
    const r = await t.one(`SELECT t.id AS template_id, v.id AS version_id, v.version, v.schema FROM clinical_templates t JOIN template_versions v ON v.template_id=t.id
      WHERE t.owner_membership_id IS NULL AND t.kind=$1 AND t.specialty_code=$2 AND v.published_at IS NOT NULL ORDER BY v.version DESC LIMIT 1`, [kind, specialty]);
    return r ? { templateId: r.template_id, versionId: r.version_id, version: r.version, schema: r.schema as TemplateSchema } : null;
  }
}
