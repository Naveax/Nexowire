PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  provider TEXT NOT NULL CHECK (provider IN ('lemonsqueezy')),
  provider_subscription_id TEXT NOT NULL,
  provider_customer_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL CHECK (plan_id IN ('plus', 'pro')),
  variant_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'on_trial',
      'active',
      'paused',
      'past_due',
      'unpaid',
      'cancelled',
      'expired'
    )
  ),
  renews_at TEXT,
  ends_at TEXT,
  trial_ends_at TEXT,
  provider_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_account
  ON billing_subscriptions(account_id);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_customer
  ON billing_subscriptions(provider, provider_customer_id);

CREATE TABLE IF NOT EXISTS billing_webhook_events (
  provider TEXT NOT NULL CHECK (provider IN ('lemonsqueezy')),
  event_hash TEXT NOT NULL,
  event_name TEXT NOT NULL,
  provider_object_id TEXT,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (provider, event_hash)
);

CREATE INDEX IF NOT EXISTS idx_billing_webhook_events_account
  ON billing_webhook_events(account_id, processed_at);
