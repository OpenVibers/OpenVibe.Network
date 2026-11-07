-- phase: expand
-- Apps ask for consent per purpose at sign-in (the consent plan's C4, 2026-11-07; Contracts 0.307.0
-- network.consent-claim@1). A purpose the person grants an app is a `consents` row (client = the app, source
-- oauth) and needs nothing new. A purpose the person leaves unticked is a refusal, kept here so that app does not
-- ask for it again for 30 days. One row per person, app and purpose, replaced when the screen asks again. Granting
-- the purpose, or the person asking for it again on their account page, removes the row.
--
-- It holds no content and no choice: only the end of a quiet period. Account deletion and merge remove the
-- subject's rows, and the account export carries them.
--
-- Expand only: an older release never reads this table, and nothing here changes an existing one.
CREATE TABLE IF NOT EXISTS consent_refusals (
    subject text COLLATE "C" NOT NULL,
    client text COLLATE "C" NOT NULL,
    purpose text NOT NULL CHECK (purpose IN ('ai.train', 'data.public', 'face.recognize', 'app.data')),
    text_version text NOT NULL,
    refused_at timestamptz NOT NULL,
    quiet_until timestamptz NOT NULL,
    PRIMARY KEY (subject, client, purpose),
    CHECK (subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CHECK (client ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$'),
    CHECK (text_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]{1,3}$'),
    CHECK (quiet_until > refused_at)
);
