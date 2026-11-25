# MEDORA CLINICS development log

Status words: **Tested** (implemented and covered by automated tests), **Implemented** (works, checked by hand, no automated test yet), **Awaiting credentials** (code path exists, external service not connected), **Planned** (later release).

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
- Consultations, prescriptions, documents (Release 2) and finance/insurance (Release 3): schema exists, API and UI **Planned**.
- Not production-ready yet: no hosting and no backups configured. CI (GitHub Actions) runs every test suite and the web build on each push and pull request.
