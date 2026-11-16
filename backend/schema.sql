BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
COMMIT;
-- Canonical schema is applied once by scripts/migrate.js, under an advisory lock.
CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
 email text NOT NULL UNIQUE CHECK (email = lower(email)),
 phone text NOT NULL UNIQUE,
 password_hash text NOT NULL,
 role text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin')),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
 created_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz
);
CREATE TABLE sessions (
 token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
 user_id uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE trials (
 user_id uuid PRIMARY KEY REFERENCES users(id),
 started_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 CHECK (expires_at > started_at AND expires_at <= started_at + interval '120 minutes')
);
CREATE FUNCTION immutable_trial() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Trial history is immutable';
END;
$$;
CREATE TRIGGER trials_immutable BEFORE UPDATE OR DELETE ON trials FOR EACH ROW EXECUTE FUNCTION immutable_trial();
CREATE TABLE subscriptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL UNIQUE REFERENCES users(id),
 started_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 cancelled_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE channels (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL,
 category text NOT NULL,
 quality text NOT NULL,
 stream_url_encrypted text,
 stream_type text CHECK (stream_type IN ('hls','dash')),
 logo_url text,
 active boolean NOT NULL DEFAULT false,
 premium boolean NOT NULL DEFAULT true,
 licensed boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (NOT active OR (licensed AND stream_url_encrypted IS NOT NULL AND stream_type IS NOT NULL))
);
CREATE TABLE matches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 home text NOT NULL, away text NOT NULL, competition text NOT NULL,
 starts_at timestamptz NOT NULL, live boolean NOT NULL DEFAULT false
);
CREATE TABLE payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id),
 provider text NOT NULL CHECK (provider IN ('zaad','edahab')),
 phone text NOT NULL,
 amount_minor integer NOT NULL DEFAULT 50 CHECK (amount_minor = 50),
 currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
 status text NOT NULL DEFAULT 'initiating' CHECK (status IN ('initiating','pending','succeeded','failed','refunded')),
 provider_reference text,
 provider_transaction_id text,
 instructions text,
 failure_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 paid_at timestamptz,
 refunded_at timestamptz,
 UNIQUE(provider, provider_reference),
 UNIQUE(provider, provider_transaction_id)
);
CREATE INDEX payments_user_idx ON payments(user_id, created_at DESC);
CREATE UNIQUE INDEX payments_one_inflight ON payments(user_id) WHERE status IN ('initiating','pending');
CREATE TABLE payment_events (
 provider text NOT NULL,
 external_id text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('payment','refund')),
 payment_id uuid NOT NULL REFERENCES payments(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (provider, external_id)
);
CREATE TABLE providers (
 provider text PRIMARY KEY CHECK (provider IN ('zaad','edahab')),
 merchant_id text NOT NULL DEFAULT '',
 api_url text NOT NULL DEFAULT '',
 api_key_encrypted text,
 secret_key_encrypted text,
 environment text NOT NULL DEFAULT 'production' CHECK (environment IN ('sandbox','production')),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO providers(provider) VALUES ('zaad'),('edahab');
CREATE TABLE app_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 trial_enabled boolean NOT NULL DEFAULT true,
 trial_minutes integer NOT NULL DEFAULT 15 CHECK (trial_minutes BETWEEN 1 AND 120),
 app_name text NOT NULL DEFAULT 'SAHAL SPORTS TV',
 support_email text NOT NULL DEFAULT ''
);
INSERT INTO app_settings DEFAULT VALUES;
CREATE TABLE audit_logs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id uuid REFERENCES users(id),
 action text NOT NULL,
 target_type text NOT NULL,
 target_id text,
 details jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON audit_logs(created_at DESC);
CREATE FUNCTION immutable_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Audit history is append-only';
END;
$$;
CREATE TRIGGER audits_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION immutable_audit();
CREATE TABLE notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL REFERENCES users(id),
 title text NOT NULL,
 body text NOT NULL,
 audience text NOT NULL CHECK (audience IN ('all','premium')),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
 provider_message_id text,
 failure_code text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE playback_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id),
 session_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 channel_version timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE playback_resources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 playback_id uuid NOT NULL REFERENCES playback_sessions(id) ON DELETE CASCADE,
 url_encrypted text NOT NULL,
 url_hash text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('manifest','binary')),
 UNIQUE(playback_id, url_hash, kind)
);
CREATE TABLE devices (
 token text PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id),
 session_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_recipients (
 notification_id uuid NOT NULL REFERENCES notifications(id),
 user_id uuid NOT NULL REFERENCES users(id),
 PRIMARY KEY(notification_id,user_id)
);
CREATE TABLE channel_logos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL REFERENCES users(id),
 data bytea NOT NULL CHECK (octet_length(data) <= 2097152),
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO channels(name,category,quality) VALUES
 ('beIN SPORTS 1','Football','HD'),('beIN SPORTS 2','Football','HD'),('beIN SPORTS 3','Football','HD');
