-- One-time sign-in codes sent by email, for organisations without an identity
-- provider. Only addresses on the server's allowed domains can receive one.
CREATE TABLE email_codes (
    id          bigserial PRIMARY KEY,
    email       text NOT NULL,
    code_hash   bytea NOT NULL,
    expires_at  timestamptz NOT NULL,
    attempts    integer NOT NULL DEFAULT 0,
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_codes_email ON email_codes(email, created_at DESC);
