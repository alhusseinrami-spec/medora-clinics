import { Injectable, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { config } from '../config.js';

export type Q = <R = any>(sql: string, params?: unknown[]) => Promise<R[]>;
export interface TxCtx { userId?: string | null; orgId?: string | null }
export interface Tx { q: Q; one: <R = any>(sql: string, params?: unknown[]) => Promise<R | undefined>; setOrg: (orgId: string | null) => Promise<void>; setUser: (userId: string) => Promise<void> }

// Dates stay as ISO strings; numerics as numbers.
pg.types.setTypeParser(1700, (v: string) => Number(v));
pg.types.setTypeParser(1082, (v: string) => v);

/**
 * Every query runs inside a transaction that carries the caller's identity (app.user_id) and active
 * workspace (app.org_id). PostgreSQL row-level security reads those, so the database itself enforces tenancy.
 */
@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });

  async tx<T>(ctx: TxCtx, fn: (t: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)`, [ctx.userId ?? '', ctx.orgId ?? '']);
      const q: Q = async (sql, params) => (await client.query(sql, params as any[])).rows;
      const t: Tx = {
        q,
        one: async (sql, params) => (await q(sql, params))[0],
        setOrg: async (orgId) => { await client.query(`SELECT set_config('app.org_id', $1, true)`, [orgId ?? '']); },
        setUser: async (userId) => { await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]); },
      };
      const result = await fn(t);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() { await this.pool.end(); }
}
