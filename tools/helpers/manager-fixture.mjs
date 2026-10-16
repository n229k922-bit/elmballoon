import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

// In-memory D1-shaped fixture; never opens a real database or makes requests.
export function createManagerFixture({ legacy = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const migrations = new URL('../../workers/admin-line-secretary/migrations/', import.meta.url);
  for (const file of fs.readdirSync(migrations).filter(file => file.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(new URL(file, migrations), 'utf8'));
  }
  class Statement {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...args) { this.args = args; return this; }
    async first() { return db.prepare(this.sql).get(...this.args) || null; }
    async all() { return { results: db.prepare(this.sql).all(...this.args) }; }
    async run() { return { meta: { changes: db.prepare(this.sql).run(...this.args).changes } }; }
  }
  const env = {
    ORDER_ENGINE: legacy ? 'legacy' : 'v2',
    MANAGER_TEST_MODE: 'false', MANAGER_RELEASE_STAGE: 'pilot', MANAGER_SEND_PAUSED: 'false',
    MANAGER_SEND_NOT_BEFORE: '2026-09-01T00:00:00.000Z',
    ADMIN_LINE_USER_IDS: 'OWNER', MANAGER_PILOT_CUSTOMER_IDS: 'CUSTOMER',
    LINE_CHANNEL_SECRET: 'fixture-owner-secret', CUSTOMER_LINE_CHANNEL_SECRET: 'fixture-customer-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'fixture-owner-token', CUSTOMER_LINE_CHANNEL_ACCESS_TOKEN: 'fixture-customer-token',
    DB: {
      prepare: sql => new Statement(sql),
      async batch(statements) {
        db.exec('BEGIN');
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          db.exec('COMMIT');
          return results;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
    },
  };
  return { db, env };
}
