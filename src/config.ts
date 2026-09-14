const env = process.env;
export const config = {
  apiKey: env.WHOP_API_KEY ?? '',
  accountId: env.WHOP_ACCOUNT_ID || undefined,
  webhookSecret: env.WHOP_WEBHOOK_SECRET ?? '',
  publicUrl: env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8787}`,
  alertUrl: env.ALERT_WEBHOOK_URL || undefined,
  refundDelayMin: Number(env.REFUND_DELAY_MIN ?? 10),
  immediateRevoke: env.IMMEDIATE_REVOKE === '1',
  windowMin: Number(env.WINDOW_MIN ?? 10),
  port: Number(env.PORT ?? 8787),
  dbPath: env.DB_PATH ?? './tripwire.db',
  /** Set by the simulator / tests so no real Whop calls are made. */
  dryRun: env.DRY_RUN === '1',
};
