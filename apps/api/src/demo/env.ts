// Demo server on Vercel only (imported first by vercel.ts). The Neon database that Vercel connects provides the owner
// connection as DATABASE_URL (pooled) and DATABASE_URL_UNPOOLED (direct). The API needs a direct connection, because the
// live channel uses LISTEN, and it signs in as its own role (medora_app, created by the migrations) on the same host.
const env = process.env;
if (env.DEMO_MODE === 'true') {
  if (env.DATABASE_URL_UNPOOLED) env.DATABASE_URL = env.DATABASE_URL_UNPOOLED;
  if (!env.APP_DATABASE_URL && env.DATABASE_URL && env.APP_DB_PASSWORD) {
    const u = new URL(env.DATABASE_URL);
    u.username = 'medora_app';
    u.password = env.APP_DB_PASSWORD;
    env.APP_DATABASE_URL = u.toString();
  }
}
export {};
