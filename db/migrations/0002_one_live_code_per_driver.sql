-- A driver may have at most one sign-in code alive at a time.
--
-- Without this, two requests arriving together both passed the "is there a
-- recent code?" check and both inserted: six codes and six text messages were
-- issued inside one second. That is a way to run up someone's phone bill, and
-- it multiplies the number of codes an attacker can guess against at once.
--
-- It also makes verification unambiguous. The verify endpoint used to read one
-- arbitrary live row, so with several alive the driver's genuine code could be
-- refused while a stale one was checked instead.
--
-- The check-then-act race cannot be closed in application code; the database
-- has to refuse the second insert.
CREATE UNIQUE INDEX IF NOT EXISTS driver_sign_in_codes_one_live_per_driver
    ON driver_sign_in_codes (driver_id)
    WHERE consumed_at IS NULL;
