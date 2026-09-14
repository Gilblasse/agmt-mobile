-- Claiming a notification is a state, not a timeout.
--
-- The previous design stamped one lease across a whole batch, sent the batch
-- serially, and put no timeout on the provider — so the last message of a
-- twenty-message batch had already spent its lease before anything was sent
-- to it. A second worker then claimed and re-sent it. A driver told twice is
-- precisely what the outbox exists to prevent.
--
-- The deeper problem was that a dead worker and a slow one looked identical:
-- both are a row whose lease lapsed. `sending` separates them — a row in that
-- state is being worked on by a named worker, and a sweeper returns it only
-- once the claim is genuinely stale.
ALTER TYPE outbox_state ADD VALUE IF NOT EXISTS 'sending';

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
    ADD COLUMN IF NOT EXISTS claimed_by text;

-- Finding stale claims is the sweeper's whole job; give it an index.
CREATE INDEX IF NOT EXISTS notifications_claimed
    ON notifications (claimed_at)
    WHERE state = 'sending';
