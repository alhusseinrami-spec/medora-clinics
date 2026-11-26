-- Specialty packs (cardiology, endocrinology, gynecology and obstetrics): endocrinology gets its own full preset
-- (diabetes, lab trends, insulin, complication screening). Presets themselves are synced by db/sync_presets.js.
UPDATE specialties SET has_full_preset = true WHERE code = 'endocrinology';
