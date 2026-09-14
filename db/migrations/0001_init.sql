-- Amazing Grace Mobile Transport — the schema
-- ===========================================
-- PostgreSQL 14+. Run it against an empty database:
--
--     createdb agnext
--     psql -d agnext -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql
--     psql -d agnext -v ON_ERROR_STOP=1 -f db/smoke.sql
--
-- Everything here comes from a real column, a real rule, or a real failure in
-- the system it replaces. Where a decision is not obvious, the comment says why.
--
-- Three ideas run through the whole thing:
--
--   1. ONE ROW PER TRIP. The old system kept a whole day of trips inside a
--      single spreadsheet cell, which is why it needed locks, caches, version
--      counters and a nightly snapshot routine. All of that disappears here.
--
--   2. THE OFFICE AND THE DRIVER HAVE SEPARATE COLUMNS. `dispatch_status` is
--      the office's; `driver_progress` is the driver's. They look like the same
--      field. Merging them silently erased dispatcher statuses for years.
--
--   3. NOTHING IMPORTANT IS OVERWRITTEN IN PLACE. Every tap, every status, every
--      price lands in `trip_events` as well, so "what actually happened" is a
--      query rather than a guess. The spreadsheet never had this.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;        -- case-insensitive names and emails

-- ---------------------------------------------------------------------------
-- Who works here
-- ---------------------------------------------------------------------------

CREATE TYPE office_role AS ENUM ('dispatcher', 'admin', 'owner');

CREATE TABLE office_users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email           citext      NOT NULL UNIQUE,
    name            text        NOT NULL,
    role            office_role NOT NULL DEFAULT 'dispatcher',
    active          boolean     NOT NULL DEFAULT true,
    last_seen_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Passengers
-- ---------------------------------------------------------------------------

CREATE TABLE passengers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            citext      NOT NULL,
    phone           text,
    medicaid_no     text,

    -- What the form fills in when this passenger is picked. The old system kept
    -- these on a PASSENGERS sheet and copied them onto each trip.
    default_transport text,
    default_pickup    text,
    default_dropoff   text,
    notes             text,

    -- A blacklist needs a reason and a name against it. Clearing one does not.
    blacklisted       boolean     NOT NULL DEFAULT false,
    blacklist_reason  text,
    blacklist_set_by  text,
    blacklist_set_at  timestamptz,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    -- A blacklist without a reason is how a passenger gets refused and nobody
    -- can say why.
    --
    -- IMPORTER: the old sheet only started requiring a reason partway through,
    -- so historical blacklisted rows may have none. Do not drop this
    -- constraint to get them in — write
    --   'Reason not recorded (imported from the spreadsheet)'
    -- so the gap is visible rather than invented.
    CONSTRAINT blacklist_needs_a_reason
        CHECK (NOT blacklisted OR blacklist_reason IS NOT NULL)
);

-- The old system matched passengers on a squashed key, so spacing and case
-- could not create two of the same person.
CREATE UNIQUE INDEX passengers_name_key ON passengers (lower(regexp_replace(name::text, '\s+', ' ', 'g')));
CREATE INDEX passengers_blacklist_idx ON passengers (blacklisted) WHERE blacklisted;

-- ---------------------------------------------------------------------------
-- Drivers and vehicles
-- ---------------------------------------------------------------------------

CREATE TABLE drivers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            citext      NOT NULL UNIQUE,
    email           citext      UNIQUE,
    phone           text,
    -- The old system sent "texts" by emailing a carrier gateway
    -- (8455551234@vtext.com). Keep the field for the import; replace the
    -- mechanism with a real SMS provider — see docs/06-external-services.md.
    carrier         text,
    active          boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    label           citext      NOT NULL UNIQUE,
    active          boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- How a driver signs in: a short code to their email or phone, used once.
CREATE TABLE driver_sign_in_codes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id       uuid        NOT NULL REFERENCES drivers (id) ON DELETE CASCADE,
    code_hash       text        NOT NULL,
    sent_to         text        NOT NULL,
    expires_at      timestamptz NOT NULL,
    consumed_at     timestamptz,
    attempts        int         NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX driver_codes_live_idx ON driver_sign_in_codes (driver_id, expires_at) WHERE consumed_at IS NULL;

CREATE TABLE driver_sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id       uuid        NOT NULL REFERENCES drivers (id) ON DELETE CASCADE,
    token_hash      text        NOT NULL UNIQUE,
    user_agent      text,
    expires_at      timestamptz NOT NULL,
    revoked_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_used_at    timestamptz
);

-- ---------------------------------------------------------------------------
-- Standing orders — a trip that repeats
-- ---------------------------------------------------------------------------

CREATE TABLE standing_orders (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title           text,
    start_date      date        NOT NULL,
    end_date        date,
    -- Which days it runs. Empty means every day.
    days            text[]      NOT NULL DEFAULT '{}',
    active          boolean     NOT NULL DEFAULT true,
    created_by      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT standing_order_days_are_real
        CHECK (days <@ ARRAY['SUN','MON','TUE','WED','THU','FRI','SAT']::text[]),
    CONSTRAINT standing_order_ends_after_it_starts
        CHECK (end_date IS NULL OR end_date >= start_date)
);

-- The old system used the first generated day's trip id as the order's id, so
-- deleting that one day orphaned the whole order. The order has its own id here.

-- ---------------------------------------------------------------------------
-- Trips
-- ---------------------------------------------------------------------------

CREATE TYPE transport_type AS ENUM (
    'ambulatory', 'wheelchair', 'stretcher', 'taxi', 'other'
);

-- The office's call on the trip. Old DISPATCH column E.
CREATE TYPE dispatch_status AS ENUM (
    'none', 'ready', 'not_confirmed', 'reassign', 'update_time',
    'complete', 'cancel', 'no_show'
);

-- Where the driver physically is. Old DISPATCH column Q. Driver app only.
CREATE TYPE driver_progress AS ENUM (
    'none', 'in_route', 'pickup_location', 'in_transit', 'dropoff_location', 'complete'
);

CREATE TABLE trips (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The day this trip runs, in the OFFICE's timezone. Every board query is
    -- keyed on this. It is a date, never a timestamp: a trip belongs to a day.
    service_date        date        NOT NULL,
    -- Scheduled pickup. NULL means nobody typed one — the old system wrote
    -- 23:58 for that and then charged a late-night surcharge on it.
    scheduled_time      time,
    -- When the driver should set off. Same sentinel problem on import.
    start_time          time,

    passenger_id        uuid        REFERENCES passengers (id) ON DELETE SET NULL,
    -- Kept on the trip on purpose: the name as it was written on the day. A
    -- passenger renamed later must not rewrite last year's trips.
    passenger_name      text        NOT NULL,
    phone               text,
    medicaid_no         text,
    invoice_no          text,

    transport           transport_type,
    -- What the dispatcher actually typed, before it was classified.
    transport_label     text,

    pickup              text        NOT NULL,
    dropoff             text,
    pickup_notes        text,
    dropoff_notes       text,
    notes               text,

    driver_id           uuid        REFERENCES drivers (id) ON DELETE SET NULL,
    -- The name as written on the trip. The old system had ONLY this, and worked
    -- out who it meant by matching names. Keep it for the import and for history.
    driver_name         text,
    vehicle_id          uuid        REFERENCES vehicles (id) ON DELETE SET NULL,

    -- The two status fields. Two writers. Never merge them.
    dispatch_status     dispatch_status NOT NULL DEFAULT 'none',
    dispatch_status_at  timestamptz,
    dispatch_status_by  text,
    driver_progress     driver_progress NOT NULL DEFAULT 'none',

    -- The four taps. Written from the SERVER's clock, never the phone's.
    pickup_arrival_at   timestamptz,
    pickup_departure_at timestamptz,
    dropoff_arrival_at  timestamptz,
    dropoff_departure_at timestamptz,

    -- A round trip is two rows. The second points at the first.
    return_of_trip_id   uuid        REFERENCES trips (id) ON DELETE SET NULL,
    standing_order_id   uuid        REFERENCES standing_orders (id) ON DELETE SET NULL,

    private_pay         boolean     NOT NULL DEFAULT false,
    -- Dispatcher-typed, overriding the map lookup.
    miles_override      numeric(7,2),
    -- The empty run out to the passenger. Nothing measures it; it is typed.
    deadhead_miles      numeric(7,2),
    -- The loaded distance actually used for the quote, once resolved.
    priced_miles        numeric(7,2),

    -- NULL is NOT zero. NULL means "could not be priced"; 0 means "quoted at
    -- nothing". The old system collapsed the two and under-billed.
    quoted_total        numeric(10,2),
    -- Why there is no total, in words the office can read back to a customer.
    unpriced_reason     text,
    priced_at           timestamptz,
    priced_version      int,

    -- The old system's composite key:
    --   driver | date | time | passenger | pickup
    -- It is not an identity — it changes the moment a driver is reassigned —
    -- but it is how the importer recognises a row it has already brought over,
    -- and how a migrated trip is traced back to its old self during
    -- reconciliation. Nullable, and nothing new ever writes it.
    legacy_id           text,
    -- The old `tripKeyID`, kept for the same reason.
    legacy_trip_key     text,

    created_by          text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    -- A priced trip carries a total; an unpriced one carries a reason. Never both.
    CONSTRAINT price_or_reason_never_both
        CHECK (quoted_total IS NULL OR unpriced_reason IS NULL),
    CONSTRAINT a_trip_is_not_its_own_return
        CHECK (return_of_trip_id IS NULL OR return_of_trip_id <> id),
    CONSTRAINT miles_are_not_negative
        CHECK (COALESCE(miles_override, 0) >= 0 AND COALESCE(deadhead_miles, 0) >= 0)
);

-- The queries the board actually runs.
CREATE INDEX trips_day_idx          ON trips (service_date, scheduled_time NULLS LAST);
CREATE INDEX trips_driver_day_idx   ON trips (driver_id, service_date) WHERE driver_id IS NOT NULL;
CREATE INDEX trips_passenger_idx    ON trips (passenger_id, service_date DESC);
CREATE INDEX trips_standing_idx     ON trips (standing_order_id) WHERE standing_order_id IS NOT NULL;
CREATE INDEX trips_return_idx       ON trips (return_of_trip_id) WHERE return_of_trip_id IS NOT NULL;
CREATE INDEX trips_updated_idx      ON trips (updated_at DESC);
CREATE INDEX trips_legacy_idx       ON trips (legacy_id) WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX trips_legacy_key_idx ON trips (legacy_trip_key) WHERE legacy_trip_key IS NOT NULL;
-- "Still live": what the board shows above the fold.
CREATE INDEX trips_open_idx         ON trips (service_date)
    WHERE dispatch_status NOT IN ('complete', 'cancel', 'no_show', 'reassign')
      AND driver_progress <> 'complete';
-- One outbound may have only one return leg.
CREATE UNIQUE INDEX trips_one_return_per_outbound ON trips (return_of_trip_id)
    WHERE return_of_trip_id IS NOT NULL;
-- A standing order runs once a day, not twice.
CREATE UNIQUE INDEX trips_standing_one_per_day ON trips (standing_order_id, service_date, COALESCE(return_of_trip_id, '00000000-0000-0000-0000-000000000000'))
    WHERE standing_order_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- What happened, in order
-- ---------------------------------------------------------------------------

CREATE TYPE trip_event_kind AS ENUM (
    'created', 'updated', 'deleted',
    'dispatch_status_set',
    'driver_tap', 'driver_undo',
    'driver_assigned', 'driver_unassigned',
    'priced', 'note'
);

CREATE TABLE trip_events (
    id              bigserial PRIMARY KEY,
    trip_id         uuid        NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
    kind            trip_event_kind NOT NULL,
    value           text,
    -- 'office:<email>', 'driver:<uuid>', or 'system'.
    actor           text        NOT NULL,
    -- When it happened out in the world (the office's clock for a tap).
    occurred_at     timestamptz NOT NULL,
    -- When we heard about it. On a phone that was underground these differ by hours.
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    payload         jsonb,

    -- The phone stamps each tap with a nonce. A re-send from the offline queue
    -- carries the same one and MUST be refused here rather than applied twice.
    -- This unique index is the whole of that guarantee.
    idempotency_key text
);

CREATE UNIQUE INDEX trip_events_idempotency_key ON trip_events (idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX trip_events_trip_idx ON trip_events (trip_id, occurred_at);
CREATE INDEX trip_events_kind_idx ON trip_events (kind, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Pricing
-- ---------------------------------------------------------------------------

-- One row per saved version. Never edited in place: a quote records which
-- version it was computed under, so an old invoice can always be explained.
CREATE TABLE pricing_config (
    version         int PRIMARY KEY,
    config          jsonb       NOT NULL,
    updated_by      text,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trip_charges (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id         uuid        NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
    -- 'base', 'mileage', 'minimum', 'deadhead', 'wait', or a rule key.
    rule_key        text        NOT NULL,
    label           text        NOT NULL,
    -- The sentence the office reads back to a customer.
    detail          text,
    amount          numeric(10,2) NOT NULL,
    quantity        numeric(10,2),
    unit_amount     numeric(10,2),
    -- Money passed on, not earned. Excluded from every percentage base.
    pass_through    boolean     NOT NULL DEFAULT false,
    is_discount     boolean     NOT NULL DEFAULT false,
    source          text        NOT NULL DEFAULT 'auto',
    priced_version  int         REFERENCES pricing_config (version),
    sort_order      int         NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT a_discount_takes_money_off CHECK (NOT is_discount OR amount <= 0),
    CONSTRAINT source_is_known CHECK (source IN ('auto', 'manual'))
);

CREATE INDEX trip_charges_trip_idx ON trip_charges (trip_id, sort_order);

-- ---------------------------------------------------------------------------
-- Telling people things
-- ---------------------------------------------------------------------------

CREATE TYPE notification_channel AS ENUM ('sms', 'email', 'push');
CREATE TYPE outbox_state AS ENUM ('pending', 'sent', 'failed', 'abandoned');

-- Nothing sends inline. Everything queues, dedupes and retries — which is the
-- part the old system did not have, and why a driver was sometimes told twice
-- and sometimes not at all.
CREATE TABLE notifications (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel         notification_channel NOT NULL,
    recipient       text        NOT NULL,
    subject         text,
    body            text        NOT NULL,
    trip_id         uuid        REFERENCES trips (id) ON DELETE SET NULL,
    driver_id       uuid        REFERENCES drivers (id) ON DELETE SET NULL,

    -- The same alert must never go out twice, however many times it is queued.
    dedupe_key      text,

    state           outbox_state NOT NULL DEFAULT 'pending',
    attempts        int         NOT NULL DEFAULT 0,
    last_error      text,
    -- Quiet hours and back-off both work by moving this forward.
    send_after      timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX notifications_dedupe_key ON notifications (dedupe_key)
    WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_due_idx ON notifications (send_after)
    WHERE state = 'pending';

-- ---------------------------------------------------------------------------
-- The day the office closes
-- ---------------------------------------------------------------------------

-- Once a day is submitted, nothing on it may change. Enforce it in one place in
-- the application, and keep this table as the record of who closed it and when.
CREATE TABLE submitted_days (
    service_date    date PRIMARY KEY,
    submitted_by    text        NOT NULL,
    submitted_at    timestamptz NOT NULL DEFAULT now(),
    trip_count      int,
    note            text
);

-- ---------------------------------------------------------------------------
-- Things worth remembering so they need not be asked again
-- ---------------------------------------------------------------------------

-- Distance and drive time between two addresses. Maps costs money per call and
-- the answer does not change; the old system cached it for six hours.
CREATE TABLE drive_cache (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    origin          text        NOT NULL,
    destination     text        NOT NULL,
    minutes         numeric(7,2),
    miles           numeric(7,2),
    provider        text        NOT NULL DEFAULT 'google',
    fetched_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL
);
CREATE UNIQUE INDEX drive_cache_route ON drive_cache (lower(origin), lower(destination), provider);
CREATE INDEX drive_cache_expiry ON drive_cache (expires_at);

-- How long this driver actually takes at this kind of stop, learned from their
-- own stamps. Feeds the "can they make the next pickup?" check.
CREATE TABLE stop_time_stats (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_key    text        NOT NULL,
    transport       transport_type,
    samples         int         NOT NULL DEFAULT 0,
    median_minutes  numeric(6,2),
    p90_minutes     numeric(6,2),
    rebuilt_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX stop_time_stats_key ON stop_time_stats (location_key, COALESCE(transport, 'other'));

-- A trip the office knows about but has not scheduled yet.
CREATE TABLE pending_trips (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    passenger_name  text        NOT NULL,
    phone           text,
    detail          text,
    wanted_date     date,
    created_by      text,
    chased_at       timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The old project POSTs every board edit to an outside Cloud Function. Whatever
-- that turns out to feed, an integration like it belongs in a queue with
-- retries, not in the middle of a save. See docs/06-external-services.md.
CREATE TABLE outbound_events (
    id              bigserial PRIMARY KEY,
    endpoint        text        NOT NULL,
    payload         jsonb       NOT NULL,
    state           outbox_state NOT NULL DEFAULT 'pending',
    attempts        int         NOT NULL DEFAULT 0,
    last_error      text,
    send_after      timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbound_events_due_idx ON outbound_events (send_after) WHERE state = 'pending';

-- ---------------------------------------------------------------------------
-- Keep updated_at honest
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trips_touch        BEFORE UPDATE ON trips
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER passengers_touch   BEFORE UPDATE ON passengers
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER drivers_touch      BEFORE UPDATE ON drivers
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER standing_touch     BEFORE UPDATE ON standing_orders
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER office_users_touch BEFORE UPDATE ON office_users
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER pending_touch      BEFORE UPDATE ON pending_trips
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- The board, as a view
-- ---------------------------------------------------------------------------

-- What the old system called "the DISPATCH sheet" is just today and tomorrow.
-- It is a query here, not a second copy of the data that has to be kept in step.
CREATE VIEW board_trips AS
SELECT t.*,
       CASE
           WHEN t.dispatch_status = 'no_show'  THEN 'no-show'
           WHEN t.dispatch_status = 'cancel'   THEN 'cancelled'
           WHEN t.dispatch_status = 'reassign' THEN 'reassigned'
           WHEN t.driver_progress = 'complete' OR t.dropoff_departure_at IS NOT NULL THEN 'completed'
           ELSE 'in progress'
       END AS outcome,
       (SELECT coalesce(sum(c.amount), 0) FROM trip_charges c WHERE c.trip_id = t.id) AS charges_total
  FROM trips t;

COMMIT;
