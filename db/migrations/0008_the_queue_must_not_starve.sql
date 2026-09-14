-- Two states the queue had no way to say, and each one cost it.
--
-- `unresolved` — the request reached the provider and the answer did not come
-- back. A timeout is not a failure to send: Twilio may well have the message.
-- Retrying it texted a driver the same sign-in code twice, which is the exact
-- thing the outbox exists to prevent, and the row said "pending" throughout.
-- Where the provider cannot be asked whether it has the message, the row stops
-- here and a person decides. Never guessed either way.
--
-- `config_attempts` — a failure that has nothing to do with the message (no
-- provider configured, a token rotated, a console switch off) hands back the
-- attempt it was charged, so the message is not abandoned for it. Without a
-- separate count there was then no back-off either: twenty such rows came due
-- every sixty seconds, were the twenty oldest, and filled every batch for
-- ever. Nothing else in the queue was ever reached — a whole depot's sign-in
-- codes expired behind twenty emails nobody could send.
ALTER TYPE outbox_state ADD VALUE IF NOT EXISTS 'unresolved' AFTER 'sending';

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS config_attempts int NOT NULL DEFAULT 0;
