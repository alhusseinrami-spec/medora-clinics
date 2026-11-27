// Vercel entry for the public demo (see vercel.json at the repository root): the MEDORA API from apps/api, built with
// its own TypeScript settings. Kept in its own folder so the platform does not try to compile apps/api by itself.
export { default } from '../api/dist/src/vercel.js';
