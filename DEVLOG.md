# MEDORA CLINICS development log

Status words: **Tested** (implemented and covered by automated tests), **Implemented** (works, checked by hand, no automated test yet), **Awaiting credentials** (code path exists, external service not connected), **Planned** (later release).

## 2026-11-25 · Release 2: consultations, prescriptions, medical documents

Test run at end of session: 94 of 94 passing (schema 9, tenant isolation 55, shared package 7, API end-to-end 23). Web production build passes. Browser click-through with synthetic data as Dr Nour: start consultation from the waiting room, vitals, pediatric examination form, diagnosis, prescription from the catalog, issue, upload a PDF, sign, addendum, print page; Arabic layout; assistant view. No console errors.

| Item | Status |
|---|---|
| 006 migration: workspace-pinned row-level security for consultations, addenda, diagnoses, prescriptions, items, templates, medication catalog and documents; cross-workspace composite foreign keys | Tested (20 new isolation checks) |
| Consultations: start from an appointment (one per visit, moves the patient out of the queue) or from the patient file; chief complaint, vitals, notes, examination text, treatment plan, follow-up | Tested (API), Implemented (UI) |
| Specialty examination forms for the 7 specialties, versioned like the profile templates; data validated against the version the consultation opened with | Tested |
| Diagnoses with optional ICD-10 code and a primary diagnosis | Tested |
| Signing: signed consultations, their diagnoses and issued prescriptions cannot be changed or deleted (enforced by database triggers, not only the API); corrections as append-only addenda; signing completes the appointment; discarding a draft returns the patient to the queue | Tested |
| Medication catalog: 48 generic entries shared by all, plus each workspace's own entries, fuzzy search | Tested. A licensed national drug database is **Planned** |
| Prescriptions: draft, edit, issue, cancel with reason, delete drafts, templates per doctor, doctors only | Tested |
| Printable prescription (A5) with letterhead, allergies, watermark on drafts and cancelled ones; PDF via the browser's "Save as PDF" | Implemented |
| Sharing a prescription or document with the patient: flag and audit | Tested. WhatsApp sending **Planned** (Release 4), email **Awaiting credentials**, patient portal **Planned** |
| Medical documents: PDF/JPEG/PNG/WebP/HEIC up to 15 MB, checked by content, encrypted with AES-256-GCM on disk, audited view/download, soft delete only | Tested. S3-compatible storage **Awaiting credentials** (local encrypted storage until then) |
| Document visibility: needs the medical-history permission; an assistant sees only what they uploaded | Tested |
| Patient file tabs (consultations, prescriptions, documents) and a timeline with clinical events | Tested (API), Implemented (UI) |

Decisions:
- Only the treating doctor writes and signs a consultation; assistants prepare the visit (vitals by the doctor for now, an assistant "intake" step can come later).
- `FILE_ENC_KEY` (64 hex characters) is required in production; development uses a derived key. Losing the key makes stored files unreadable, so it must be backed up with the database.
- The appointment status machine now allows "in consultation" back to "waiting" (used when a draft is discarded).

## 2026-11-25 · Architecture and Release 1 foundation

Test run at end of session: 69 of 69 passing (schema 9, tenant isolation 35, shared package 6, API end-to-end 19). Web production build passes. Browser click-through with synthetic data: assistant marks arrival, doctor's waiting room updates live in another browser, Arabic switches the layout to right-to-left, no console errors.

### Architecture (section 20)
| Item | Status |
|---|---|
| 10 deliverables in `architecture/MEDORA-architecture.md`, logo and tokens in `architecture/brand/` | Delivered for review |

### Database
| Item | Status |
|---|---|
| Schema 001/002 (49 tables, earlier thread) moved into `db/migrations/`, migration runner with history table | Tested |
| 003 foundation: sessions, MFA fields, password resets, invitations, role default permissions, 16 specialties with en/fr/ar names, patient numbering, specialty profiles, cross-tenant composite foreign keys | Tested |
| 004 tenant isolation: row-level security on 44 tables, API role without bypass, secrets hidden by column grants, clinical-notes confidentiality inside a center, assistant scoping to assigned doctors, safe patient linking, duplicate detection with masked names | Tested (`db/rls_test.js`, 35 checks) |
| 005 API helpers, walk-ins exempt from double-booking, room double-booking prevention | Tested |

### Release 1 (section 19)
| Item | Status |
|---|---|
| Brand identity and design system (tokens, light/dark, components) | Implemented |
| Authentication: scrypt passwords, opaque server sessions (httpOnly cookie or bearer), lockout after 5 failures, logout, session list and revoke | Tested |
| Multi-factor authentication (TOTP, secret encrypted with AES-256-GCM) | Tested |
| Account recovery | Tested; email delivery **Awaiting credentials** (dev build shows the reset link) |
| Doctor registration (practice, location, default service and hours) | Tested |
| Medical center registration, locations, rooms, departments | Tested (API), Implemented (UI) |
| Organization memberships: one account across workplaces, workspace switcher, extra practice | Tested |
| Invitations (accept by link, single use, email must match) | Tested; email delivery **Awaiting credentials** (link is shown to the inviter to share) |
| Assistant accounts and assignment to doctors | Tested |
| Permissions: role defaults, individual switches, no self-change, no escalation, doctor manages own assistants only, prescriptions doctors-only | Tested |
| Specialty engine: presets for 7 specialties, 9 prepared, workspace adapts per doctor, custom fields and hidden fields as immutable versions, shared validator, growth chart and FDI dental chart widgets | Tested (engine), Implemented (widgets) |
| Patient management: register, search by name/phone/ID, duplicates, edit, controlled linking, specialty profile, timeline | Tested |
| Appointments: create, edit, reschedule, cancel, recurring, walk-in, services, working hours, breaks/holidays, free slots, double-booking prevention, day and week calendar | Tested (API), Implemented (calendar UI) |
| Live waiting room: arrival notifies doctor, per-doctor and per-department queues, WebSocket updates, call in, complete | Tested |
| Doctor and assistant dashboards (specialty widgets: vaccinations due, expected deliveries) | Tested (API), Implemented (UI) |
| English, French, Arabic with right-to-left layout, per-user language | Implemented. Specialty field labels are English only so far; section titles are translated |
| PWA manifest | Implemented; service worker **Planned** (Release 5) |
| Audit log of every important action, viewable by staff managers | Tested |

### Known gaps and decisions
- In a medical center, inviting staff needs `staff.manage` (center owner/admin). A center doctor manages permissions of assistants assigned to them but does not invite them.
- Month calendar view: **Planned**. Day and week are implemented.
- WHO growth percentile curves need licensed reference data: **Planned**. The chart shows the child's own measurements.
- Email and SMS providers: **Awaiting credentials**. WhatsApp: **Planned** (Release 4).
- Finance and insurance (Release 3): schema exists, API and UI **Planned**.
- Not production-ready yet: no hosting and no backups configured. CI (GitHub Actions) runs every test suite and the web build on each push and pull request.
