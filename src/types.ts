/** Minimal slice of Whop's payment object that the detector uses. */
export type Payment = {
  id: string;
  status: string;            // paid | failed | pending | ...
  created_at: string;        // ISO
  usd_total: number;
  user_id: string | null;
  member_id: string | null;
  membership_id: string | null;
  country: string | null;    // billing_address.country
  card_fingerprint: string | null;
  card_last4: string | null;
  decline_code: string | null;
  refunded_at: string | null;
};

export type Baseline = {
  learned_at: string;
  days: number;
  /** Mean and stddev of paid count per WINDOW_MIN bucket, by hour of day (0-23). */
  rate_by_hour: { mean: number; sd: number }[];
  new_buyer_share: number;   // 0..1, share of paid payments from first-time buyers
  decline_share: number;     // 0..1, failed / (failed + paid)
  avg_usd: number;
  sd_usd: number;
  /** Share of historical paid payments per billing country, e.g. { US: 0.7, GB: 0.1 }. */
  country_share: Record<string, number>;
  overall_rate: number; // mean paid count per window across all hours
  total_paid: number;
};

export type Signal = { name: string; value: number; threshold: number; fired: boolean; note: string };

export type Verdict = {
  level: 'normal' | 'elevated' | 'attack';
  score: number;               // number of signals fired
  signals: Signal[];
  window: Payment[];           // paid payments in the window
  suspects: Payment[];         // subset the responder should act on
};

export type Incident = {
  id: number;
  opened_at: string;
  level: string;
  score: number;
  signals: Signal[];
  suspect_ids: string[];
  status: 'holding' | 'acted' | 'undone' | 'alerted';
  act_at: string;
  acted: { refunded: string[]; revoked: string[]; errors: string[] } | null;
};
