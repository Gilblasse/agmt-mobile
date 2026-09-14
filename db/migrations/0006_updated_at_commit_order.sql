-- `updated_at` must order by when a change became visible, not when its
-- transaction began.
--
-- `now()` is `transaction_timestamp()`: every row written in one transaction
-- shares the moment that transaction *started*. A long transaction that edits
-- a trip therefore commits a row stamped earlier than rows written and
-- committed while it was still open — so the newest `updated_at` on a driver's
-- day could go backwards, and a change token built from it would not move.
--
-- The phone polls that token specifically to decide whether to redraw. Not
-- moving it means a driver keeps looking at the old pickup address.
--
-- `clock_timestamp()` reads the wall clock at the moment the row is written,
-- which also means two rows written in one transaction differ.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
