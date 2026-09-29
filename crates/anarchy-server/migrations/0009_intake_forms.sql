-- Intake forms (DESKS-PLAN "The client side"): a public page asks someone
-- without an account for their details. The definition is sealed like a pay
-- link. Answers are encrypted in the browser to a public key whose private
-- half only the desk's members hold, so the server stores ciphertext it can't
-- open. Members import answers into the desk and delete them here.
CREATE TABLE intake_forms (
    id                 text PRIMARY KEY,
    channel_id         uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    created_by_device  uuid NOT NULL REFERENCES devices(id),
    sealed             bytea NOT NULL,
    expires_at         timestamptz NOT NULL,
    revoked_at         timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intake_forms_channel ON intake_forms (channel_id);

CREATE TABLE intake_submissions (
    id          bigserial PRIMARY KEY,
    form_id     text NOT NULL REFERENCES intake_forms(id) ON DELETE CASCADE,
    sealed      bytea NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intake_submissions_form ON intake_submissions (form_id, id);
