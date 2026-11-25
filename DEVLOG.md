# MEDORA CLINICS development log

Status words: **Tested** (implemented and covered by automated tests), **Implemented** (works, checked by hand, no automated test yet), **Awaiting credentials** (code path exists, external service not connected), **Planned** (later release).

## 2026-11-25 · Release 5: mobile app and patient portal

Test run at end of session: all suites passing (schema smoke test, tenant isolation 111 of 111 with 10 new, shared package 7 of 7, API end-to-end 47 of 47 with 9 new patient-app tests). Web production build passes. Browser check with synthetic data on an iPhone-sized screen and on desktop: the patient signs in and lands in the patient app, sees their request, switches to Arabic (right-to-left); the receptionist sees the request on the dashboard and books it; the patient then sees it booked. No console errors.

**Built as an installable web app (PWA), not as App Store / Play Store apps.** It installs from the browser to the home screen on Android and iPhone, works full screen and receives push notifications. Native store apps are Planned (they need Apple and Google developer accounts).

| Item | Status |
|---|---|
| 009 migration: patient accounts, portal invitations, appointment requests, push subscriptions; the patient side reads only through `portal_*` functions limited to the signed-in patient's own records | Tested (10 new isolation checks) |
| Inviting a patient from the patient file: a single-use link valid 7 days; sign-up must use the invited email; staff of that workspace cannot join as its patient; access can be removed | Tested (API), Implemented (UI). Email delivery of the link **Awaiting credentials**: staff copy the link and share it (for example on WhatsApp) |
| Patient app: next visit, appointments (upcoming and past), cancel online until 2 hours before, visit requests with preferred date and time, prescriptions the doctor shared, shared documents (open or download, audited), contact details, clinic message language, WhatsApp consent recorded as the patient's own choice | Tested (API), Implemented (UI) |
| Staff side: appointment requests on the dashboard; booking creates a confirmed appointment (double booking still refused) and queues the WhatsApp confirmation; declining sends the patient a note | Tested (API), Implemented (UI) |
| Installable app: manifest, icons (including maskable and Apple touch icon), service worker with an offline notice. API responses and pages are never cached on the device because they hold personal data | Implemented |
| Web Push: real VAPID-signed, encrypted pushes to the browser push services; texts are generic (never medical details) in the user's language; dead subscriptions removed; one push per notification even with several API instances | Tested against a local push service stand-in. Production needs `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY` and `WEB_PUSH_SUBJECT` (without them in production push is off) |
| Native iOS and Android apps, online payment from the app, chat with the clinic inside the app | **Planned** |

Decisions:
- One account can be both staff somewhere and a patient elsewhere. Staff land on their workspace (the patient app has a link back); accounts with only patient records land on `/portal`.
- A patient linked to several clinics sees each clinic's records side by side; nothing is merged between clinics.
- In development the API derives fixed VAPID keys so push works without setup; production refuses to push until real keys are set.
- iPhone receives web push only when the app was added to the home screen (Apple's rule); the app says so.

## 2026-11-25 · Release 4: communication (WhatsApp, reminders, inbox, live notifications)

Test run at end of session: all suites passing (schema smoke test, tenant isolation 101 of 101, shared package 7 of 7, API end-to-end 38 of 38 of which 11 are new messaging tests). Web production build passes. Browser click-through with synthetic data: owner connects a number (refused by Meta, shown as awaiting credentials), automatic messages, outbox; receptionist records consent and sends from the patient file. No console errors.

**WhatsApp is not connected to Meta in this build.** Everything on our side is built and tested against a local stand-in that answers like the Cloud API (same URLs, bearer token, request and response shapes, webhook signatures). Real sending needs, per clinic, a Meta WhatsApp Business number (phone number ID and a system-user access token) and, for the platform, a Meta app (`WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`) with the webhook pointed at `/api/webhooks/whatsapp`. Until a number passes the connection test it stays "awaiting credentials" and nothing is sent.

| Item | Status |
|---|---|
| 008 migration: WhatsApp numbers (per doctor or per workspace), templates, automation settings, consent with history, scheduled-message queue, conversations and messages, all with workspace-pinned row-level security | Tested (17 new isolation checks) |
| Connecting a number: token stored encrypted (AES-256-GCM), never readable by the API role or returned; "connected" only after Meta accepts the id and token | Tested against the stand-in. **Awaiting credentials** for real Meta numbers |
| Sending through the Cloud API: approved templates with variables in a fixed order per purpose, free text only inside Meta's 24-hour window | Tested against the stand-in. **Awaiting credentials** |
| Webhook: URL verification, X-Hub-Signature-256 check, incoming messages, delivery statuses (sent, delivered, read, failed; never backwards), Meta retries ignored | Tested against signed synthetic payloads. **Awaiting credentials** (app secret and verify token) |
| Automatic messages: confirmation, reminder before the visit (24 h by default), reminder on the day (2 h), rescheduling and cancellation notices, follow-up reminder from the follow-up date in a signed consultation. All off until the workspace switches them on | Tested |
| Manual messages from the patient file: follow-up, vaccination (with due date), treatment, payment reminder (from an invoice, skipped once paid), and clinic announcements to every consenting patient | Tested (API), Implemented (UI) |
| Automatic vaccination schedules and treatment reminders computed from prescriptions | **Planned**. Sent by hand from the patient file for now |
| Patient consent: off by default, recorded by staff with history; a reply of STOP (or ARRET, إلغاء) switches it off and cancels waiting messages | Tested |
| Every message records why it was not sent (no consent, no number, not connected, visit changed, no approved template, already paid) | Tested |
| Default texts in English, French and Arabic with no medical details; each workspace can edit them and add its approved Meta template name | Tested (API), Implemented (UI) |
| Inbox: unanswered, assigned to me, open, closed; conversation view with delivery status, reply, assign, close, link an unknown number to a patient; doctors see only their own number's conversations | Tested (API), Implemented (UI) |
| Live notifications: new notifications and inbox activity pushed over the WebSocket (ids only; data is fetched again under row-level security); bell and inbox update without reload | Tested (events), Implemented (UI) |
| Background sender in the API process (every 30 s), safe with several API instances (rows claimed with SKIP LOCKED), retries an interrupted send at most 3 times | Tested (sending), Implemented (recovery after an interrupted send) |
| SMS and email reminders | **Planned** (email **Awaiting credentials** as before) |

Decisions:
- Center owners now get the WhatsApp permission by default (they connect the center number). Receptionists and assistants get it when an administrator grants it; the demo seed grants it to the receptionist.
- Phone numbers without a country code are treated as Lebanese (961), configurable with `WHATSAPP_DEFAULT_COUNTRY_CODE` in the API. The same rule is used to match incoming numbers to patients; an incoming number matching more than one patient stays unlinked.
- Reminders whose time passed more than an hour ago (for example after downtime) are not sent late.

## 2026-11-25 · Release 3: finance and insurance

Test run at end of session: all suites passing (schema smoke test, tenant isolation 84 of 84, shared package 7 of 7, API end-to-end 27 of 27). Web production build passes. Browser click-through with synthetic data: receptionist billing list, invoice, payment and receipt; owner finance dashboard; insurance desk claim from draft to reimbursed; patient file billing and insurance tabs; Arabic layout. No console errors or failed API calls.

| Item | Status |
|---|---|
| 007 migration: invoices, items, payments, credit notes, exchange rates, expenses, commissions, insurers, policies, claims, with workspace-pinned row-level security | Tested (29 new isolation checks) |
| Invoices: draft, edit, issue (gap-free number at issue), void only when unpaid, from an appointment (fills the service or consultation fee, one invoice per visit) or from the patient file | Tested (API), Implemented (UI) |
| Issued invoices and payments cannot be changed or deleted (database triggers); corrections by credit note (CN- numbers) and refunds (negative payments linked to the original) | Tested |
| Payments in USD or LBP by cash, card, bank transfer, Whish or OMT, converted at the rate saved on the invoice; overpayment refused; each payment gets a receipt number | Tested. No payment gateway is connected: card, Whish and OMT are recorded by hand, not charged online |
| Exchange rate history per workspace, never rewritten; each invoice and payment keeps the rate it used | Tested |
| Printable invoice (A4) with insurance share and patient share, and receipt (A5); PDF via the browser | Implemented |
| Finance dashboard: day, week, month, year; received by method and by source, invoiced, outstanding, expenses, net; per doctor (doctor share and center share from the commission % frozen on each invoice) and per department | Tested (API), Implemented (UI) |
| Doctors in a center see only their own invoices and figures; center finance staff see the whole workspace | Tested |
| Expenses with categories, shared (center) or per doctor, soft delete only | Tested |
| Doctor commission % per center doctor, applied to invoices issued afterwards | Tested |
| Insurers: platform directory (NSSF) plus each workspace's own; policies on the patient file with coverage %, ceiling, covered and excluded services, validity | Tested (API), Implemented (UI) |
| Claims: prepared from an issued invoice (default amount = coverage % of the lines marked for insurance), submitted, approved / partially approved / rejected, reimbursed (records an insurance payment and receipt) | Tested. Attaching supporting documents from the patient file: Implemented |
| Electronic claim submission to NSSF or private insurers | **Planned**. No insurer API is connected; claims are tracked here and sent by the clinic, and the screen says so |
| Tax engine / e-invoicing to the Ministry of Finance | **Planned**. Tax is a manual amount per invoice for now |

Decisions:
- Numbers are assigned at issue, not at draft, so there are no gaps from deleted drafts. A voided invoice keeps its number.
- Amounts in reports are converted to USD at each transaction's own saved rate, so past figures never move when today's rate changes.
- Center owners do not get insurance or payment permissions by default; the demo seed adds an insurance desk account (sami@demo.medora) for that.

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
