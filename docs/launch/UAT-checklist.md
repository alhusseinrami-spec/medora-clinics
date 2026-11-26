# MEDORA user acceptance checklist

Walk through this on the staging copy before real clinics use MEDORA. Use only the synthetic demo accounts (password `Demo-Medora-2026`), never real patients. Tick each line, and note anything that surprises you next to it.

Automated tests already cover permissions, tenant isolation, security and every API route (`npm test`), and a browser smoke test opens every main screen on desktop, Android and iPhone sizes in English and Arabic (`e2e/smoke.mjs`). This list is for what only a person can judge: whether the workflow makes sense in a real clinic.

## 1. Front desk (maya@demo.medora, receptionist at Cedar center)

- [ ] Register a new patient with a phone number; the duplicate warning appears when you type an existing patient's phone.
- [ ] Book an appointment from the calendar; booking the same doctor at the same time is refused.
- [ ] Mark a patient as arrived; the doctor's waiting room updates without reloading (open nour@ in another browser).
- [ ] Create an invoice from a completed visit, take a partial payment, print the receipt.
- [ ] Switch the language to Arabic: the whole layout flips right to left and the receipt prints in Arabic.

## 2. Doctor (nour@demo.medora)

- [ ] Open today's dashboard; the numbers match the calendar.
- [ ] Call in the next patient, write the consultation using the pediatrics template, sign it. A signed consultation cannot be edited, only given an addendum.
- [ ] Write and issue a prescription; print it (A5). A draft shows the watermark.
- [ ] Upload a lab PDF to the patient file; open it again.
- [ ] Switch to the own practice (workspace switcher): Cedar's patients are not visible there.
- [ ] As the doctor on the Solo plan, Finance and WhatsApp are hidden and the plan page explains why.

## 3. Assistant (lina@demo.medora)

- [ ] Sees only Dr Nour's patients and calendar, not Dr Karim's.
- [ ] Cannot write prescriptions (the button is absent and the API refuses).

## 4. Center owner (owner@demo.medora)

- [ ] Invite a new staff member; change one permission; the change applies at once.
- [ ] Finance: expenses, commissions and the yearly overview add up.
- [ ] Subscription page shows the Medical Center plan, renewal date and usage against limits.
- [ ] Open a support request; the reply from the admin appears in the thread.

## 5. Patient app (patient@demo.medora, on a phone)

- [ ] Install to the home screen from the browser menu; it opens full screen with the MEDORA icon.
- [ ] Request an appointment; the clinic sees it on the dashboard and books it; the patient sees the time.
- [ ] See shared prescriptions and documents only.
- [ ] Turn on notifications in Profile (needs push keys on the server).

## 6. MEDORA admin (admin@demo.medora)

- [ ] Sign-in asks to turn on two-factor sign-in first (production).
- [ ] Workspaces list shows plans, status and usage; record a payment and the renewal date moves.
- [ ] Suspend a test workspace: its users are blocked; reactivate it.
- [ ] Edit a plan's price; existing subscriptions keep their price override if set.

## 7. Before go-live (owner: rami)

- [ ] Hosting chosen and the server set up from `deploy/README.md`.
- [ ] Domain and DNS ready; HTTPS certificate issued.
- [ ] All keys generated and stored in a password manager (especially `FILE_ENC_KEY` and `BACKUP_PASSPHRASE`).
- [ ] Off-server backup copy set up, and the restore drill run once on the server.
- [ ] Push notification keys generated.
- [ ] WhatsApp: Meta business account, phone number and app secret (otherwise WhatsApp stays switched off).
- [ ] Email provider account (password reset and invitations by email); until then links are shown on screen.
- [ ] Payment method for subscriptions decided (recorded manually by the admin today; online card payment is not built).
- [ ] Privacy policy and terms of service written for Lebanon and any other launch country.
- [ ] A medical professional has reviewed the specialty templates.
- [ ] The demo accounts are not created on the production server (do not run `db:seed` there).
