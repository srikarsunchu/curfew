const env = process.env;
export const config = {
  publicUrl: (env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8787}`).replace(/\/$/, ''),
  port: Number(env.PORT ?? 8787),
  dbPath: env.DB_PATH ?? './curfew.db',
  /** Postgres connection string (Neon on Vercel). When unset, SQLite at dbPath. */
  databaseUrl: env.DATABASE_URL || env.POSTGRES_URL || '',
  /** Shared secret for /api/tick, called by the Vercel cron. */
  cronSecret: env.CRON_SECRET ?? '',
  /** 32-byte hex/base64 key for encrypting Whop API keys and webhook secrets at rest. Required outside dry run. */
  encryptionKey: env.ENCRYPTION_KEY ?? '',
  /** Demo mode: one synthetic tenant, no Whop calls, simulate endpoints enabled. */
  dryRun: env.DRY_RUN === '1',
  secureCookies: (env.PUBLIC_URL ?? '').startsWith('https://'),
  defaults: {
    refundDelayMin: Number(env.REFUND_DELAY_MIN ?? 10),
    immediateRevoke: env.IMMEDIATE_REVOKE === '1',
    windowMin: Number(env.WINDOW_MIN ?? 10),
    learnDays: Number(env.LEARN_DAYS ?? 60),
  },
};
export type Settings = { refundDelayMin: number; immediateRevoke: boolean; windowMin: number; alertUrl: string | null };
export const DEMO_TENANT = 'demo';
