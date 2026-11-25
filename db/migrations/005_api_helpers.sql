-- MEDORA CLINICS: migration 005, helpers the API needs under row-level security.

-- The signed-in user's own encrypted TOTP secret (column is not readable by the app role otherwise).
CREATE FUNCTION auth_my_mfa_secret() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT mfa_secret_enc FROM users WHERE id = app_user_id()
$$;

-- Public preview of an invitation (shown on the accept page before signing in). Reveals no patient data.
CREATE FUNCTION app_invitation_preview(p_token_hash text)
RETURNS TABLE (organization_name text, organization_kind text, role_code text, email text, expires_at timestamptz, valid boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.name, o.kind, i.role_code, i.email, i.expires_at,
         (i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now())
    FROM invitations i JOIN organizations o ON o.id = i.organization_id
   WHERE i.token_hash = p_token_hash
$$;

-- Walk-in patients may overlap the schedule; they are queued in the waiting room instead.
ALTER TABLE appointments DROP CONSTRAINT appointments_no_double_booking;
ALTER TABLE appointments ADD CONSTRAINT appointments_no_double_booking
  EXCLUDE USING gist (doctor_membership_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
  WHERE (status NOT IN ('cancelled','no_show') AND NOT is_walk_in);

-- A room cannot hold two appointments at once either.
ALTER TABLE appointments ADD CONSTRAINT appointments_no_room_double_booking
  EXCLUDE USING gist (room_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
  WHERE (room_id IS NOT NULL AND status NOT IN ('cancelled','no_show') AND NOT is_walk_in);

REVOKE EXECUTE ON FUNCTION auth_my_mfa_secret(), app_invitation_preview(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_my_mfa_secret(), app_invitation_preview(text) TO medora_app;
