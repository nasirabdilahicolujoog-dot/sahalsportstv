-- Existing installations: app identity/contact/price settings and audio advertisements.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS support_phone text NOT NULL DEFAULT '';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS logo_url text NOT NULL DEFAULT '';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS price_minor integer NOT NULL DEFAULT 50;
ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_currency_check;
ALTER TABLE app_settings ADD CONSTRAINT app_settings_currency_check CHECK (currency ~ '^[A-Z]{3,4}$');
ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_price_minor_check;
ALTER TABLE app_settings ADD CONSTRAINT app_settings_price_minor_check CHECK (price_minor BETWEEN 1 AND 100000000);
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_amount_minor_check;
ALTER TABLE payments ADD CONSTRAINT payments_amount_minor_check CHECK (amount_minor > 0);
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_currency_check;
ALTER TABLE payments ADD CONSTRAINT payments_currency_check CHECK (currency ~ '^[A-Z]{3,4}$');
CREATE TABLE IF NOT EXISTS audio_ads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
 mime_type text NOT NULL CHECK (mime_type IN ('audio/mpeg','audio/mp4','audio/aac','audio/ogg','audio/wav')),
 data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 5242880),
 active boolean NOT NULL DEFAULT true,
 actor_id uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audio_ads_active_idx ON audio_ads(active, created_at DESC);
