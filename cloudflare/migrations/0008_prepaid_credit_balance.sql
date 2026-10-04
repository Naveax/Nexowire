PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS prepaid_credit_balances (
  quota_subject_id TEXT PRIMARY KEY NOT NULL
    REFERENCES quota_subjects(id) ON DELETE CASCADE,
  prepaid_credits INTEGER NOT NULL DEFAULT 0
    CHECK (prepaid_credits >= 0),
  refund_debt_credits INTEGER NOT NULL DEFAULT 0
    CHECK (refund_debt_credits >= 0),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO prepaid_credit_balances (
  quota_subject_id,
  prepaid_credits,
  refund_debt_credits,
  updated_at
)
SELECT
  quota_subjects.id,
  COALESCE(
    (
      SELECT quota_usage_periods.prepaid_credits
      FROM quota_usage_periods
      WHERE quota_usage_periods.quota_subject_id =
        quota_subjects.id
      ORDER BY quota_usage_periods.period_key DESC
      LIMIT 1
    ),
    0
  ),
  0,
  quota_subjects.updated_at
FROM quota_subjects;

CREATE TABLE IF NOT EXISTS prepaid_credit_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  quota_subject_id TEXT NOT NULL
    REFERENCES quota_subjects(id) ON DELETE CASCADE,
  credits INTEGER NOT NULL CHECK (credits > 0),
  credited_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prepaid_purchases (
  provider TEXT NOT NULL,
  provider_order_id TEXT NOT NULL,
  account_id TEXT NOT NULL
    REFERENCES accounts(id) ON DELETE CASCADE,
  quota_subject_id TEXT NOT NULL
    REFERENCES quota_subjects(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL,
  purchased_credits INTEGER NOT NULL
    CHECK (purchased_credits > 0),
  total_amount INTEGER NOT NULL
    CHECK (total_amount > 0),
  refunded_amount INTEGER NOT NULL DEFAULT 0
    CHECK (
      refunded_amount >= 0
      AND refunded_amount <= total_amount
    ),
  revoked_credits INTEGER NOT NULL DEFAULT 0
    CHECK (
      revoked_credits >= 0
      AND revoked_credits <= purchased_credits
    ),
  provider_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_order_id)
);

CREATE INDEX IF NOT EXISTS idx_prepaid_purchases_account
  ON prepaid_purchases(account_id, created_at);

CREATE TABLE IF NOT EXISTS prepaid_refund_events (
  provider TEXT NOT NULL,
  provider_order_id TEXT NOT NULL,
  refunded_amount INTEGER NOT NULL CHECK (refunded_amount > 0),
  target_revoked_credits INTEGER NOT NULL
    CHECK (target_revoked_credits >= 0),
  provider_updated_at TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (
    provider,
    provider_order_id,
    refunded_amount
  ),
  FOREIGN KEY (provider, provider_order_id)
    REFERENCES prepaid_purchases(provider, provider_order_id)
    ON DELETE CASCADE
);

DROP TRIGGER IF EXISTS trg_prepaid_credit_event_apply;

CREATE TRIGGER trg_prepaid_credit_event_apply
AFTER INSERT ON prepaid_credit_events
BEGIN
  INSERT INTO prepaid_credit_balances (
    quota_subject_id,
    prepaid_credits,
    refund_debt_credits,
    updated_at
  )
  VALUES (
    NEW.quota_subject_id,
    NEW.credits,
    0,
    NEW.credited_at
  )
  ON CONFLICT(quota_subject_id) DO UPDATE SET
    prepaid_credits =
      prepaid_credit_balances.prepaid_credits +
      CASE
        WHEN excluded.prepaid_credits >
          prepaid_credit_balances.refund_debt_credits
          THEN excluded.prepaid_credits -
            prepaid_credit_balances.refund_debt_credits
        ELSE 0
      END,
    refund_debt_credits =
      CASE
        WHEN prepaid_credit_balances.refund_debt_credits >
          excluded.prepaid_credits
          THEN prepaid_credit_balances.refund_debt_credits -
            excluded.prepaid_credits
        ELSE 0
      END,
    updated_at = excluded.updated_at;
END;

DROP TRIGGER IF EXISTS trg_prepaid_refund_event_apply;

CREATE TRIGGER trg_prepaid_refund_event_apply
AFTER INSERT ON prepaid_refund_events
BEGIN
  SELECT RAISE(ABORT, 'prepaid_refund_stale')
  WHERE NEW.refunded_amount < (
    SELECT refunded_amount
    FROM prepaid_purchases
    WHERE provider = NEW.provider
      AND provider_order_id = NEW.provider_order_id
  );

  SELECT RAISE(ABORT, 'prepaid_refund_invalid')
  WHERE NEW.refunded_amount > (
      SELECT total_amount
      FROM prepaid_purchases
      WHERE provider = NEW.provider
        AND provider_order_id = NEW.provider_order_id
    )
    OR NEW.target_revoked_credits < (
      SELECT revoked_credits
      FROM prepaid_purchases
      WHERE provider = NEW.provider
        AND provider_order_id = NEW.provider_order_id
    )
    OR NEW.target_revoked_credits > (
      SELECT purchased_credits
      FROM prepaid_purchases
      WHERE provider = NEW.provider
        AND provider_order_id = NEW.provider_order_id
    );

  INSERT INTO prepaid_credit_balances (
    quota_subject_id,
    prepaid_credits,
    refund_debt_credits,
    updated_at
  )
  SELECT
    quota_subject_id,
    0,
    0,
    NEW.applied_at
  FROM prepaid_purchases
  WHERE provider = NEW.provider
    AND provider_order_id = NEW.provider_order_id
  ON CONFLICT(quota_subject_id) DO NOTHING;

  UPDATE prepaid_credit_balances
  SET
    refund_debt_credits =
      refund_debt_credits +
      CASE
        WHEN (
          NEW.target_revoked_credits -
          (
            SELECT revoked_credits
            FROM prepaid_purchases
            WHERE provider = NEW.provider
              AND provider_order_id =
                NEW.provider_order_id
          )
        ) > prepaid_credits
          THEN (
            NEW.target_revoked_credits -
            (
              SELECT revoked_credits
              FROM prepaid_purchases
              WHERE provider = NEW.provider
                AND provider_order_id =
                  NEW.provider_order_id
            )
          ) - prepaid_credits
        ELSE 0
      END,
    prepaid_credits =
      CASE
        WHEN prepaid_credits > (
          NEW.target_revoked_credits -
          (
            SELECT revoked_credits
            FROM prepaid_purchases
            WHERE provider = NEW.provider
              AND provider_order_id =
                NEW.provider_order_id
          )
        )
          THEN prepaid_credits - (
            NEW.target_revoked_credits -
            (
              SELECT revoked_credits
              FROM prepaid_purchases
              WHERE provider = NEW.provider
                AND provider_order_id =
                  NEW.provider_order_id
            )
          )
        ELSE 0
      END,
    updated_at = NEW.applied_at
  WHERE quota_subject_id = (
    SELECT quota_subject_id
    FROM prepaid_purchases
    WHERE provider = NEW.provider
      AND provider_order_id = NEW.provider_order_id
  );

  UPDATE prepaid_purchases
  SET
    refunded_amount = NEW.refunded_amount,
    revoked_credits = NEW.target_revoked_credits,
    provider_updated_at = NEW.provider_updated_at,
    updated_at = NEW.applied_at
  WHERE provider = NEW.provider
    AND provider_order_id = NEW.provider_order_id;
END;

DROP TRIGGER IF EXISTS trg_quota_usage_event_apply;

CREATE TRIGGER trg_quota_usage_event_apply
BEFORE INSERT ON quota_usage_events
WHEN NEW.apply_usage = 1
BEGIN
  INSERT INTO quota_usage_periods (
    quota_subject_id,
    period_key,
    period_start,
    period_end,
    used_credits,
    prepaid_credits
  )
  VALUES (
    NEW.quota_subject_id,
    NEW.period_key,
    NEW.period_start,
    NEW.period_end,
    0,
    0
  )
  ON CONFLICT(quota_subject_id, period_key) DO NOTHING;

  INSERT INTO prepaid_credit_balances (
    quota_subject_id,
    prepaid_credits,
    refund_debt_credits,
    updated_at
  )
  VALUES (
    NEW.quota_subject_id,
    0,
    0,
    NEW.charged_at
  )
  ON CONFLICT(quota_subject_id) DO NOTHING;

  SELECT RAISE(ABORT, 'quota_exhausted')
  WHERE NEW.billing_mode = 'prepaid-metered'
    AND (
      (
        SELECT prepaid_credits
        FROM prepaid_credit_balances
        WHERE quota_subject_id = NEW.quota_subject_id
      ) < NEW.credits
      OR (
        SELECT refund_debt_credits
        FROM prepaid_credit_balances
        WHERE quota_subject_id = NEW.quota_subject_id
      ) > 0
    );

  SELECT RAISE(ABORT, 'quota_exhausted')
  WHERE NEW.billing_mode <> 'prepaid-metered'
    AND NEW.monthly_credits IS NOT NULL
    AND (
      SELECT used_credits
      FROM quota_usage_periods
      WHERE quota_subject_id = NEW.quota_subject_id
        AND period_key = NEW.period_key
    ) + NEW.credits > NEW.monthly_credits;

  UPDATE prepaid_credit_balances
  SET
    prepaid_credits = prepaid_credits - NEW.credits,
    updated_at = NEW.charged_at
  WHERE NEW.billing_mode = 'prepaid-metered'
    AND quota_subject_id = NEW.quota_subject_id;

  UPDATE quota_usage_periods
  SET
    used_credits = CASE
      WHEN NEW.billing_mode = 'prepaid-metered'
        THEN used_credits
      ELSE used_credits + NEW.credits
    END,
    prepaid_credits = CASE
      WHEN NEW.billing_mode = 'prepaid-metered'
        THEN (
          SELECT prepaid_credits
          FROM prepaid_credit_balances
          WHERE quota_subject_id = NEW.quota_subject_id
        )
      ELSE prepaid_credits
    END
  WHERE quota_subject_id = NEW.quota_subject_id
    AND period_key = NEW.period_key;
END;
