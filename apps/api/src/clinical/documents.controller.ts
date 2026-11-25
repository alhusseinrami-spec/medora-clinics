import { BadRequestException, Body, Controller, Delete, Get, Headers, NotFoundException, Param, Patch, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Db } from '../db/db.service.js';
import { Ctx, RequirePerm } from '../common/decorators.js';
import type { TenantInfo } from '../common/types.js';
import { parse, v } from '../common/validate.js';
import { audit } from '../common/audit.js';
import { config } from '../config.js';
import { ALLOWED_TYPES, readDecrypted, storeEncrypted } from './storage.js';
import { uid } from './consultations.controller.js';

const KINDS = ['lab_result', 'imaging', 'report', 'photo', 'insurance_card', 'other'] as const;
const COLS = 'd.id, d.patient_id, d.consultation_id, d.kind, d.title, d.original_filename, d.mime_type, d.size_bytes, d.notes, d.shared_with_patient, d.created_at, u.full_name AS uploaded_by_name';

/**
 * Medical documents. The file body is sent raw (Content-Type = the file's type) with its metadata in the
 * query string, so no multipart parser is needed. Files are checked by their first bytes, encrypted, and stored.
 */
@Controller()
export class DocumentsController {
  constructor(private db: Db) {}

  @RequirePerm('document.upload') @Post('patients/:id/documents')
  async upload(@Param('id') pid: string, @Req() req: Request, @Ctx() c: TenantInfo, @Headers('content-type') ctype = '',
    @Query('kind') kind = 'other', @Query('title') title = '', @Query('filename') filename = '', @Query('consultationId') consultationId = '') {
    const m = parse({ kind: v.enum(...KINDS), title: v.str(1, 200), filename: v.str(1, 255).optional(), consultationId: v.uuid().optional() },
      { kind, title: title || filename || undefined, filename: filename || undefined, consultationId: consultationId || undefined });
    const mime = ctype.split(';')[0].trim().toLowerCase();
    const sniff = ALLOWED_TYPES[mime];
    if (!sniff) throw new BadRequestException(`Accepted files: PDF, JPEG, PNG, WebP, HEIC`);
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) throw new BadRequestException('The file is empty');
    if (body.length > config.maxUploadBytes) throw new BadRequestException('Files can be at most 15 MB');
    if (!sniff(body)) throw new BadRequestException('The file content does not match its type');
    const patientId = uid(pid);
    return this.db.tx(c, async (t) => {
      const p = await t.one(`SELECT id FROM patients WHERE id=$1 AND organization_id=$2`, [patientId, c.orgId]);
      if (!p) throw new NotFoundException('Patient not found');
      if (m.consultationId) {
        const con = await t.one(`SELECT patient_id FROM consultations WHERE id=$1`, [m.consultationId]);
        if (!con || con.patient_id !== patientId) throw new BadRequestException('That consultation is not for this patient');
      }
      const stored = await storeEncrypted(c.orgId, body);
      const r = await t.one(`INSERT INTO medical_documents(organization_id, patient_id, consultation_id, uploaded_by, kind, title, original_filename,
          storage_key, storage_backend, mime_type, size_bytes, sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'local',$9,$10,$11) RETURNING id`,
        [c.orgId, patientId, m.consultationId ?? null, c.userId, m.kind, m.title, m.filename ?? null, stored.storageKey, mime, body.length, stored.sha256]);
      await audit(t, c.userId, c.orgId, 'document.upload', 'document', r.id, { patient: patientId, kind: m.kind, bytes: body.length });
      return t.one(`SELECT ${COLS} FROM medical_documents d LEFT JOIN users u ON u.id=d.uploaded_by WHERE d.id=$1`, [r.id]);
    });
  }

  @RequirePerm('patient.file.read') @Get('patients/:id/documents')
  list(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT ${COLS} FROM medical_documents d LEFT JOIN users u ON u.id=d.uploaded_by
      WHERE d.patient_id=$1 AND d.deleted_at IS NULL ORDER BY d.created_at DESC`, [uid(pid)]));
  }

  /** Streams the decrypted file. Every download is written to the audit log. */
  @RequirePerm('patient.file.read') @Get('documents/:id/content')
  async content(@Param('id') did: string, @Ctx() c: TenantInfo, @Query('download') download: string, @Res({ passthrough: true }) res: Response) {
    const doc = await this.db.tx(c, async (t) => {
      const d = await t.one(`SELECT id, storage_key, mime_type, title, original_filename, sha256 FROM medical_documents WHERE id=$1 AND deleted_at IS NULL`, [uid(did)]);
      if (!d) throw new NotFoundException('Document not found');
      await audit(t, c.userId, c.orgId, download ? 'document.download' : 'document.view', 'document', d.id);
      return d;
    });
    const bytes = await readDecrypted(doc.storage_key);
    const name = (doc.original_filename || doc.title || 'document').replace(/[^\w.\- ]+/g, '_');
    res.set({
      'Content-Type': doc.mime_type, 'Content-Length': String(bytes.length), 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${name}"`,
    });
    return new StreamableFile(bytes);
  }

  @RequirePerm('document.upload') @Patch('documents/:id')
  update(@Param('id') did: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ title: v.str(1, 200).optional(), kind: v.enum(...KINDS).optional(), notes: v.str(1, 2000).nullable(), sharedWithPatient: v.bool().optional() }, body);
    const map: Record<string, string> = { title: 'title', kind: 'kind', notes: 'notes', sharedWithPatient: 'shared_with_patient' };
    const fields = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
    if (!fields.length) throw new BadRequestException('Nothing to update');
    return this.db.tx(c, async (t) => {
      const r = await t.q(`UPDATE medical_documents SET ${fields.map((k, i) => `${map[k]}=$${i + 2}`).join(', ')} WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
        [uid(did), ...fields.map((k) => (b as any)[k])]);
      if (!r.length) throw new NotFoundException('Document not found');
      await audit(t, c.userId, c.orgId, 'document.update', 'document', did, { fields });
      return t.one(`SELECT ${COLS} FROM medical_documents d LEFT JOIN users u ON u.id=d.uploaded_by WHERE d.id=$1`, [did]);
    });
  }

  /** Removes a document from the file. The encrypted bytes and the record are kept for the legal retention period. */
  @RequirePerm('document.upload') @Delete('documents/:id')
  remove(@Param('id') did: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const r = await t.q(`UPDATE medical_documents SET deleted_at=now(), deleted_by=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [uid(did), c.userId]);
      if (!r.length) throw new NotFoundException('Document not found');
      await audit(t, c.userId, c.orgId, 'document.delete', 'document', did);
      return { ok: true };
    });
  }
}
