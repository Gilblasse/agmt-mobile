-- A tap's nonce is unique WITHIN A TRIP, not across the whole system.
--
-- The original index was on `idempotency_key` alone. That made the guarantee
-- depend on a phone never reusing a string globally: send the same nonce for
-- two different trips and the second tap was swallowed and answered "already
-- done", with its timestamp never written and its re-send permanently
-- refused. A phone numbering taps per trip — `trip-1-step-2` — was enough to
-- destroy another trip's tap.
--
-- CLAUDE.md states "a driver's tap is never lost and never applied twice"
-- unconditionally. It cannot rest on unverified client behaviour, so the scope
-- of the nonce is now the scope it always meant: one trip.
DROP INDEX IF EXISTS trip_events_idempotency_key;

CREATE UNIQUE INDEX trip_events_idempotency_key
    ON trip_events (trip_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
