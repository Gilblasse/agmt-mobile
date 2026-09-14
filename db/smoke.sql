-- Amazing Grace — schema smoke test
-- =================================
-- Proves the schema does what the design claims, not just that it parses.
--
--     psql -d agnext -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql
--     psql -d agnext -v ON_ERROR_STOP=1 -f db/smoke.sql
--
-- Every block below is one of the non-negotiables in CLAUDE.md. If a change to
-- the schema breaks one of these, it has broken something the old system got
-- right the hard way. The whole thing rolls back, so it leaves nothing behind.

\set ON_ERROR_STOP on
\set QUIET on

BEGIN;

-- ---------------------------------------------------------------------------
-- The day: a passenger, a driver, a vehicle, an outbound and its return
-- ---------------------------------------------------------------------------

INSERT INTO office_users (id, email, name, role)
VALUES ('00000000-0000-0000-0000-0000000000aa', 'kim@example.com', 'Kim', 'dispatcher');

INSERT INTO passengers (id, name, phone, medicaid_no)
VALUES ('11111111-1111-1111-1111-111111111111', 'Blasse, Nathaniel', '845-555-0100', 'MA88213');

INSERT INTO drivers (id, name, email, phone, carrier)
VALUES ('22222222-2222-2222-2222-222222222222', 'Jasmin DeFino', 'jasmin@example.com', '845-555-0111', 'verizon');

INSERT INTO vehicles (id, label) VALUES ('33333333-3333-3333-3333-333333333333', 'Van 2');

INSERT INTO trips (
    id, service_date, scheduled_time, passenger_id, passenger_name, phone,
    transport, transport_label, pickup, dropoff, driver_id, driver_name, vehicle_id,
    dispatch_status, dispatch_status_at, private_pay
) VALUES (
    '44444444-4444-4444-4444-444444444444', DATE '2026-09-07', TIME '09:00',
    '11111111-1111-1111-1111-111111111111', 'Blasse, Nathaniel', '845-555-0100',
    'wheelchair', 'Wheelchair', '127 Bermuda Blvd', '4885 U.S. 9',
    '22222222-2222-2222-2222-222222222222', 'Jasmin DeFino',
    '33333333-3333-3333-3333-333333333333',
    'ready', now(), true
);

INSERT INTO trips (
    id, service_date, scheduled_time, passenger_id, passenger_name,
    transport, pickup, dropoff, driver_id, driver_name, return_of_trip_id
) VALUES (
    '55555555-5555-5555-5555-555555555555', DATE '2026-09-07', TIME '13:30',
    '11111111-1111-1111-1111-111111111111', 'Blasse, Nathaniel',
    'wheelchair', '4885 U.S. 9', '127 Bermuda Blvd',
    '22222222-2222-2222-2222-222222222222', 'Jasmin DeFino',
    '44444444-4444-4444-4444-444444444444'
);

DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM trips WHERE return_of_trip_id IS NOT NULL;
    ASSERT n = 1, 'a return leg should link back to its outbound';
END $$;

-- One outbound, one return. A second return leg is a double booking.
DO $$
DECLARE duplicated boolean := false;
BEGIN
    BEGIN
        INSERT INTO trips (service_date, passenger_name, pickup, return_of_trip_id)
        VALUES (DATE '2026-09-07', 'Blasse, Nathaniel', '4885 U.S. 9',
                '44444444-4444-4444-4444-444444444444');
        duplicated := true;
    EXCEPTION WHEN unique_violation THEN duplicated := false;
    END;
    ASSERT NOT duplicated, 'one outbound may have only one return leg';
END $$;

-- ---------------------------------------------------------------------------
-- NON-NEGOTIABLE 1 — the office's status and the driver's are separate fields
-- ---------------------------------------------------------------------------
-- The single most expensive bug in the old system: the board writer put driver
-- progress into the dispatcher's column on every save.

UPDATE trips SET driver_progress = 'pickup_location',
                 pickup_arrival_at = TIMESTAMPTZ '2026-09-07 08:52:00-04'
 WHERE id = '44444444-4444-4444-4444-444444444444';

DO $$
DECLARE d text; p text;
BEGIN
    SELECT dispatch_status::text, driver_progress::text INTO d, p
      FROM trips WHERE id = '44444444-4444-4444-4444-444444444444';
    ASSERT d = 'ready', 'the dispatcher''s status survives a driver tap, got ' || d;
    ASSERT p = 'pickup_location', 'the driver''s progress is its own field, got ' || p;
END $$;

-- The office calls it off while the driver is mid-route. The board must say so.
DO $$
DECLARE outcome text;
BEGIN
    UPDATE trips SET dispatch_status = 'cancel', dispatch_status_at = now()
     WHERE id = '55555555-5555-5555-5555-555555555555';
    UPDATE trips SET driver_progress = 'in_transit'
     WHERE id = '55555555-5555-5555-5555-555555555555';
    SELECT b.outcome INTO outcome FROM board_trips b
     WHERE b.id = '55555555-5555-5555-5555-555555555555';
    ASSERT outcome = 'cancelled', 'a cancelled trip reads as cancelled whatever the driver is doing, got ' || outcome;
    -- put it back for the rest of the test
    UPDATE trips SET dispatch_status = 'none', dispatch_status_at = NULL, driver_progress = 'none'
     WHERE id = '55555555-5555-5555-5555-555555555555';
END $$;

-- ---------------------------------------------------------------------------
-- NON-NEGOTIABLE 2 — a driver's tap is never lost, and never applied twice
-- ---------------------------------------------------------------------------

INSERT INTO trip_events (trip_id, kind, value, actor, occurred_at, idempotency_key)
VALUES ('44444444-4444-4444-4444-444444444444', 'driver_tap', 'pickup_location',
        'driver:22222222-2222-2222-2222-222222222222',
        TIMESTAMPTZ '2026-09-07 08:52:00-04', 'nonce-pickup-001');

-- The same tap arriving again, hours later, from a phone that was underground.
DO $$
DECLARE duplicated boolean := false;
BEGIN
    BEGIN
        INSERT INTO trip_events (trip_id, kind, value, actor, occurred_at, idempotency_key)
        VALUES ('44444444-4444-4444-4444-444444444444', 'driver_tap', 'pickup_location',
                'driver:22222222-2222-2222-2222-222222222222',
                TIMESTAMPTZ '2026-09-07 08:52:00-04', 'nonce-pickup-001');
        duplicated := true;
    EXCEPTION WHEN unique_violation THEN duplicated := false;
    END;
    ASSERT NOT duplicated, 'a re-sent tap must be refused, not applied twice';
END $$;

-- Two different taps on the same trip are both kept.
INSERT INTO trip_events (trip_id, kind, value, actor, occurred_at, idempotency_key)
VALUES ('44444444-4444-4444-4444-444444444444', 'driver_tap', 'in_transit',
        'driver:22222222-2222-2222-2222-222222222222',
        TIMESTAMPTZ '2026-09-07 09:04:00-04', 'nonce-transit-002');

-- A tap recorded long after it happened is still recorded at its real time.
DO $$
DECLARE happened timestamptz; heard timestamptz;
BEGIN
    SELECT occurred_at, recorded_at INTO happened, heard
      FROM trip_events WHERE idempotency_key = 'nonce-transit-002';
    ASSERT happened < heard, 'a tap keeps the time it happened, not the time we heard it';
END $$;

-- Dispatcher actions are not re-sent, so they need no nonce.
INSERT INTO trip_events (trip_id, kind, value, actor, occurred_at)
VALUES ('44444444-4444-4444-4444-444444444444', 'dispatch_status_set', 'ready', 'office:kim@example.com', now()),
       ('44444444-4444-4444-4444-444444444444', 'note', 'Call on arrival', 'office:kim@example.com', now());

-- ---------------------------------------------------------------------------
-- NON-NEGOTIABLE 3 — a price is a breakdown, and is never silently zero
-- ---------------------------------------------------------------------------

INSERT INTO pricing_config (version, config, updated_by)
VALUES (1, '{"base":{"wheelchair":65},"mileage":{"mode":"auto","includedMiles":5,"perMile":3}}'::jsonb,
        'office:kim@example.com');

INSERT INTO trip_charges (trip_id, rule_key, label, detail, amount, quantity, unit_amount, priced_version, sort_order)
VALUES ('44444444-4444-4444-4444-444444444444', 'base',    'Wheelchair base fare', 'Wheelchair', 65.00, NULL, NULL, 1, 0),
       ('44444444-4444-4444-4444-444444444444', 'mileage', 'Loaded mileage', '12.4 miles, 5 included', 22.20, 7.40, 3.00, 1, 1);

-- A pass-through is excluded from every percentage base, so the flag must survive.
INSERT INTO trip_charges (trip_id, rule_key, label, amount, pass_through, priced_version, sort_order)
VALUES ('44444444-4444-4444-4444-444444444444', 'tolls', 'Tolls', 6.50, true, 1, 2);

INSERT INTO trip_charges (trip_id, rule_key, label, amount, is_discount, priced_version, sort_order)
VALUES ('44444444-4444-4444-4444-444444444444', 'recurring', 'Recurring trip discount', -8.72, true, 1, 3);

DO $$
DECLARE total numeric; discountable numeric; board numeric;
BEGIN
    SELECT sum(amount) INTO total FROM trip_charges
     WHERE trip_id = '44444444-4444-4444-4444-444444444444';
    ASSERT total = 84.98, 'the breakdown should total 84.98, got ' || total;

    -- The discount was taken on 87.20 (base + mileage), not on the tolls.
    SELECT sum(amount) INTO discountable FROM trip_charges
     WHERE trip_id = '44444444-4444-4444-4444-444444444444'
       AND NOT pass_through AND NOT is_discount;
    ASSERT discountable = 87.20, 'the discount base excludes pass-throughs, got ' || discountable;

    SELECT charges_total INTO board FROM board_trips
     WHERE id = '44444444-4444-4444-4444-444444444444';
    ASSERT board = 84.98, 'the board shows the same total as the breakdown, got ' || board;
END $$;

-- A discount that adds money is not a discount.
DO $$
DECLARE allowed boolean := false;
BEGIN
    BEGIN
        INSERT INTO trip_charges (trip_id, rule_key, label, amount, is_discount)
        VALUES ('44444444-4444-4444-4444-444444444444', 'otherDisc', 'Backwards discount', 25.00, true);
        allowed := true;
    EXCEPTION WHEN check_violation THEN allowed := false;
    END;
    ASSERT NOT allowed, 'a discount must take money off';
END $$;

UPDATE trips SET quoted_total = 84.98, priced_at = now(), priced_version = 1, priced_miles = 12.4
 WHERE id = '44444444-4444-4444-4444-444444444444';

-- A trip that could not be priced says so, in words, and carries no total.
UPDATE trips SET unpriced_reason = 'The distance could not be checked - look at the addresses, then save again.'
 WHERE id = '55555555-5555-5555-5555-555555555555';

DO $$
DECLARE had_both boolean := false;
BEGIN
    BEGIN
        UPDATE trips SET quoted_total = 0
         WHERE id = '55555555-5555-5555-5555-555555555555';
        had_both := true;
    EXCEPTION WHEN check_violation THEN had_both := false;
    END;
    ASSERT NOT had_both, 'an unpriced trip must not also carry a total - nil is not zero';
END $$;

-- ---------------------------------------------------------------------------
-- NON-NEGOTIABLE 4 — a blacklist has a reason against it
-- ---------------------------------------------------------------------------

DO $$
DECLARE allowed boolean := false;
BEGIN
    BEGIN
        UPDATE passengers SET blacklisted = true
         WHERE id = '11111111-1111-1111-1111-111111111111';
        allowed := true;
    EXCEPTION WHEN check_violation THEN allowed := false;
    END;
    ASSERT NOT allowed, 'a passenger cannot be refused without a reason on record';
END $$;

UPDATE passengers SET blacklisted = true, blacklist_reason = 'Non-payment, Aug 2026',
                      blacklist_set_by = 'office:kim@example.com', blacklist_set_at = now()
 WHERE id = '11111111-1111-1111-1111-111111111111';
-- Clearing it needs nothing.
UPDATE passengers SET blacklisted = false, blacklist_reason = NULL
 WHERE id = '11111111-1111-1111-1111-111111111111';

-- The same person cannot be entered twice with different spacing.
DO $$
DECLARE duplicated boolean := false;
BEGIN
    BEGIN
        INSERT INTO passengers (name) VALUES ('blasse,   nathaniel');
        duplicated := true;
    EXCEPTION WHEN unique_violation THEN duplicated := false;
    END;
    ASSERT NOT duplicated, 'spacing and case must not create a second copy of a passenger';
END $$;

-- ---------------------------------------------------------------------------
-- NON-NEGOTIABLE 5 — an alert goes out once, however many times it is queued
-- ---------------------------------------------------------------------------

INSERT INTO notifications (channel, recipient, body, trip_id, driver_id, dedupe_key)
VALUES ('sms', '845-555-0111', 'AMAZING GRACE: trip cancelled',
        '44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222',
        'cancel:44444444:2026-09-07');

DO $$
DECLARE duplicated boolean := false;
BEGIN
    BEGIN
        INSERT INTO notifications (channel, recipient, body, trip_id, dedupe_key)
        VALUES ('sms', '845-555-0111', 'AMAZING GRACE: trip cancelled',
                '44444444-4444-4444-4444-444444444444', 'cancel:44444444:2026-09-07');
        duplicated := true;
    EXCEPTION WHEN unique_violation THEN duplicated := false;
    END;
    ASSERT NOT duplicated, 'the same alert must not be sent twice';
END $$;

-- ---------------------------------------------------------------------------
-- NON-NEGOTIABLE 6 — a standing order runs once a day, and owns its own identity
-- ---------------------------------------------------------------------------

INSERT INTO standing_orders (id, title, start_date, end_date, days, created_by)
VALUES ('66666666-6666-6666-6666-666666666666', 'Dialysis - Mon/Wed/Fri',
        DATE '2026-09-07', DATE '2026-12-14', ARRAY['MON','WED','FRI'], 'office:kim@example.com');

UPDATE trips SET standing_order_id = '66666666-6666-6666-6666-666666666666'
 WHERE id = '44444444-4444-4444-4444-444444444444';

DO $$
DECLARE duplicated boolean := false;
BEGIN
    BEGIN
        INSERT INTO trips (service_date, passenger_name, pickup, standing_order_id)
        VALUES (DATE '2026-09-07', 'Blasse, Nathaniel', '127 Bermuda Blvd',
                '66666666-6666-6666-6666-666666666666');
        duplicated := true;
    EXCEPTION WHEN unique_violation THEN duplicated := false;
    END;
    ASSERT NOT duplicated, 'a standing order runs once a day, not twice';
END $$;

-- A day nobody asked for is refused by the pattern, not by the database — but a
-- nonsense day token is refused here.
DO $$
DECLARE allowed boolean := false;
BEGIN
    BEGIN
        INSERT INTO standing_orders (start_date, days) VALUES (DATE '2026-09-07', ARRAY['FUNDAY']);
        allowed := true;
    EXCEPTION WHEN check_violation THEN allowed := false;
    END;
    ASSERT NOT allowed, 'a standing order runs on real days of the week';
END $$;

-- Deleting the first day must NOT take the order with it. In the old system the
-- order's identity WAS that trip's id, so deleting it orphaned every other day.
DO $$
DECLARE still_there boolean;
BEGIN
    DELETE FROM trips WHERE id = '55555555-5555-5555-5555-555555555555';
    SELECT EXISTS (SELECT 1 FROM standing_orders WHERE id = '66666666-6666-6666-6666-666666666666')
      INTO still_there;
    ASSERT still_there, 'a standing order outlives any one of its days';
END $$;

-- ---------------------------------------------------------------------------
-- NON-NEGOTIABLE 7 — the day the office closes
-- ---------------------------------------------------------------------------

INSERT INTO submitted_days (service_date, submitted_by, trip_count)
VALUES (DATE '2026-09-06', 'office:kim@example.com', 11);

DO $$
DECLARE locked boolean;
BEGIN
    SELECT EXISTS (SELECT 1 FROM submitted_days WHERE service_date = DATE '2026-09-06')
      INTO locked;
    ASSERT locked, 'a submitted day is on the record as closed';
END $$;

-- ---------------------------------------------------------------------------
-- The queries the board and the phone actually run
-- ---------------------------------------------------------------------------

DO $$
DECLARE n int; first_time time; open_count int;
BEGIN
    SELECT count(*) INTO n FROM trips WHERE service_date = DATE '2026-09-07';
    ASSERT n = 1, 'the day should hold one trip after the delete, got ' || n;

    SELECT scheduled_time INTO first_time FROM trips
     WHERE service_date = DATE '2026-09-07' ORDER BY scheduled_time NULLS LAST LIMIT 1;
    ASSERT first_time = TIME '09:00', 'the board comes back in time order, got ' || first_time;

    -- One driver's day, which is all the phone ever asks for.
    SELECT count(*) INTO n FROM trips
     WHERE driver_id = '22222222-2222-2222-2222-222222222222' AND service_date = DATE '2026-09-07';
    ASSERT n = 1, 'the driver sees their own day, got ' || n;

    -- Still live: the partial index the board leans on.
    SELECT count(*) INTO open_count FROM trips
     WHERE service_date = DATE '2026-09-07'
       AND dispatch_status NOT IN ('complete','cancel','no_show','reassign')
       AND driver_progress <> 'complete';
    ASSERT open_count = 1, 'one trip still open, got ' || open_count;

    -- What actually happened, in order. The spreadsheet never had this.
    SELECT count(*) INTO n FROM trip_events
     WHERE trip_id = '44444444-4444-4444-4444-444444444444';
    ASSERT n = 4, 'the trip has four recorded events, got ' || n;
END $$;

-- A trip with no time sorts LAST. An untimed trip at the top of the board was
-- read as the next job to run.
INSERT INTO trips (id, service_date, scheduled_time, passenger_name, pickup)
VALUES ('77777777-7777-7777-7777-777777777777', DATE '2026-09-07', NULL, 'No Time Given', '1 Somewhere Rd');

DO $$
DECLARE last_name text;
BEGIN
    SELECT passenger_name INTO last_name FROM trips
     WHERE service_date = DATE '2026-09-07'
     ORDER BY scheduled_time NULLS LAST, id LIMIT 1 OFFSET 1;
    ASSERT last_name = 'No Time Given', 'a trip with no time sorts last, got ' || last_name;
END $$;

-- Deleting a trip takes its events and charges with it, and nothing else.
DO $$
DECLARE n int;
BEGIN
    DELETE FROM trips WHERE id = '77777777-7777-7777-7777-777777777777';
    SELECT count(*) INTO n FROM trips;
    ASSERT n = 1, 'one trip should remain, got ' || n;
    SELECT count(*) INTO n FROM trip_events;
    ASSERT n = 4, 'the surviving trip keeps its events, got ' || n;
    SELECT count(*) INTO n FROM trip_charges;
    ASSERT n = 4, 'and its charges, got ' || n;
    SELECT count(*) INTO n FROM drivers;
    ASSERT n = 1, 'deleting a trip does not delete the driver';
END $$;

-- ---------------------------------------------------------------------------
-- Things remembered so they need not be asked again
-- ---------------------------------------------------------------------------

INSERT INTO drive_cache (origin, destination, minutes, miles, expires_at)
VALUES ('127 Bermuda Blvd', '4885 U.S. 9', 24.5, 12.4, now() + interval '6 hours');

DO $$
DECLARE duplicated boolean := false;
BEGIN
    BEGIN
        INSERT INTO drive_cache (origin, destination, minutes, miles, expires_at)
        VALUES ('127 BERMUDA BLVD', '4885 u.s. 9', 24.5, 12.4, now() + interval '6 hours');
        duplicated := true;
    EXCEPTION WHEN unique_violation THEN duplicated := false;
    END;
    ASSERT NOT duplicated, 'one route is asked about once, whatever the capitalisation';
END $$;

ROLLBACK;

\echo ''
\echo '  schema smoke test: all assertions passed'
\echo ''
