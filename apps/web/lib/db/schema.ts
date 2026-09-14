import { pgTable, unique, uuid, text, boolean, timestamp, index, foreignKey, integer, uniqueIndex, check, date, time, numeric, bigserial, jsonb, pgView, pgEnum } from "drizzle-orm/pg-core"
import { citext } from './citext';
import { sql } from "drizzle-orm"

export const dispatchStatus = pgEnum("dispatch_status", ['none', 'ready', 'not_confirmed', 'reassign', 'update_time', 'complete', 'cancel', 'no_show'])
export const driverProgress = pgEnum("driver_progress", ['none', 'in_route', 'pickup_location', 'in_transit', 'dropoff_location', 'complete'])
export const notificationChannel = pgEnum("notification_channel", ['sms', 'email', 'push'])
export const officeRole = pgEnum("office_role", ['dispatcher', 'admin', 'owner'])
export const outboxState = pgEnum("outbox_state", ['pending', 'sent', 'failed', 'abandoned'])
export const transportType = pgEnum("transport_type", ['ambulatory', 'wheelchair', 'stretcher', 'taxi', 'other'])
export const tripEventKind = pgEnum("trip_event_kind", ['created', 'updated', 'deleted', 'dispatch_status_set', 'driver_tap', 'driver_undo', 'driver_assigned', 'driver_unassigned', 'priced', 'note'])


export const drivers = pgTable("drivers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: citext("name").notNull(),
	email: citext("email"),
	phone: text(),
	carrier: text(),
	active: boolean().default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("drivers_name_key").on(table.name),
	unique("drivers_email_key").on(table.email),
]);

export const driverSignInCodes = pgTable("driver_sign_in_codes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	driverId: uuid("driver_id").notNull(),
	codeHash: text("code_hash").notNull(),
	sentTo: text("sent_to").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	consumedAt: timestamp("consumed_at", { withTimezone: true, mode: 'string' }),
	attempts: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("driver_codes_live_idx").using("btree", table.driverId.asc().nullsLast().op("timestamptz_ops"), table.expiresAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(consumed_at IS NULL)`),
	foreignKey({
			columns: [table.driverId],
			foreignColumns: [drivers.id],
			name: "driver_sign_in_codes_driver_id_fkey"
		}).onDelete("cascade"),
]);

export const driverSessions = pgTable("driver_sessions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	driverId: uuid("driver_id").notNull(),
	tokenHash: text("token_hash").notNull(),
	userAgent: text("user_agent"),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.driverId],
			foreignColumns: [drivers.id],
			name: "driver_sessions_driver_id_fkey"
		}).onDelete("cascade"),
	unique("driver_sessions_token_hash_key").on(table.tokenHash),
]);

export const passengers = pgTable("passengers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: citext("name").notNull(),
	phone: text(),
	medicaidNo: text("medicaid_no"),
	defaultTransport: text("default_transport"),
	defaultPickup: text("default_pickup"),
	defaultDropoff: text("default_dropoff"),
	notes: text(),
	blacklisted: boolean().default(false).notNull(),
	blacklistReason: text("blacklist_reason"),
	blacklistSetBy: text("blacklist_set_by"),
	blacklistSetAt: timestamp("blacklist_set_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("passengers_blacklist_idx").using("btree", table.blacklisted.asc().nullsLast().op("bool_ops")).where(sql`blacklisted`),
	uniqueIndex("passengers_name_key").using("btree", sql`lower(regexp_replace((name)::text, '\s+'::text, ' '::text, 'g':`),
	check("blacklist_needs_a_reason", sql`(NOT blacklisted) OR (blacklist_reason IS NOT NULL)`),
]);

export const trips = pgTable("trips", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	serviceDate: date("service_date").notNull(),
	scheduledTime: time("scheduled_time"),
	startTime: time("start_time"),
	passengerId: uuid("passenger_id"),
	passengerName: text("passenger_name").notNull(),
	phone: text(),
	medicaidNo: text("medicaid_no"),
	invoiceNo: text("invoice_no"),
	transport: transportType(),
	transportLabel: text("transport_label"),
	pickup: text().notNull(),
	dropoff: text(),
	pickupNotes: text("pickup_notes"),
	dropoffNotes: text("dropoff_notes"),
	notes: text(),
	driverId: uuid("driver_id"),
	driverName: text("driver_name"),
	vehicleId: uuid("vehicle_id"),
	dispatchStatus: dispatchStatus("dispatch_status").default('none').notNull(),
	dispatchStatusAt: timestamp("dispatch_status_at", { withTimezone: true, mode: 'string' }),
	dispatchStatusBy: text("dispatch_status_by"),
	driverProgress: driverProgress("driver_progress").default('none').notNull(),
	pickupArrivalAt: timestamp("pickup_arrival_at", { withTimezone: true, mode: 'string' }),
	pickupDepartureAt: timestamp("pickup_departure_at", { withTimezone: true, mode: 'string' }),
	dropoffArrivalAt: timestamp("dropoff_arrival_at", { withTimezone: true, mode: 'string' }),
	dropoffDepartureAt: timestamp("dropoff_departure_at", { withTimezone: true, mode: 'string' }),
	returnOfTripId: uuid("return_of_trip_id"),
	standingOrderId: uuid("standing_order_id"),
	privatePay: boolean("private_pay").default(false).notNull(),
	milesOverride: numeric("miles_override", { precision: 7, scale:  2 }),
	deadheadMiles: numeric("deadhead_miles", { precision: 7, scale:  2 }),
	pricedMiles: numeric("priced_miles", { precision: 7, scale:  2 }),
	quotedTotal: numeric("quoted_total", { precision: 10, scale:  2 }),
	unpricedReason: text("unpriced_reason"),
	pricedAt: timestamp("priced_at", { withTimezone: true, mode: 'string' }),
	pricedVersion: integer("priced_version"),
	legacyId: text("legacy_id"),
	legacyTripKey: text("legacy_trip_key"),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("trips_day_idx").using("btree", table.serviceDate.asc().nullsLast().op("date_ops"), table.scheduledTime.asc().nullsLast().op("time_ops")),
	index("trips_driver_day_idx").using("btree", table.driverId.asc().nullsLast().op("uuid_ops"), table.serviceDate.asc().nullsLast().op("date_ops")).where(sql`(driver_id IS NOT NULL)`),
	index("trips_legacy_idx").using("btree", table.legacyId.asc().nullsLast().op("text_ops")).where(sql`(legacy_id IS NOT NULL)`),
	uniqueIndex("trips_legacy_key_idx").using("btree", table.legacyTripKey.asc().nullsLast().op("text_ops")).where(sql`(legacy_trip_key IS NOT NULL)`),
	uniqueIndex("trips_one_return_per_outbound").using("btree", table.returnOfTripId.asc().nullsLast().op("uuid_ops")).where(sql`(return_of_trip_id IS NOT NULL)`),
	index("trips_open_idx").using("btree", table.serviceDate.asc().nullsLast().op("date_ops")).where(sql`((dispatch_status <> ALL (ARRAY['complete'::dispatch_status, 'cancel'::dispatch_status, 'no_show'::dispatch_status, 'reassign'::dispatch_status])) AND (driver_progress <> 'complete'::driver_progress))`),
	index("trips_passenger_idx").using("btree", table.passengerId.asc().nullsLast().op("uuid_ops"), table.serviceDate.desc().nullsFirst().op("uuid_ops")),
	index("trips_return_idx").using("btree", table.returnOfTripId.asc().nullsLast().op("uuid_ops")).where(sql`(return_of_trip_id IS NOT NULL)`),
	index("trips_standing_idx").using("btree", table.standingOrderId.asc().nullsLast().op("uuid_ops")).where(sql`(standing_order_id IS NOT NULL)`),
	uniqueIndex("trips_standing_one_per_day").using("btree", sql`standing_order_id`, sql`service_date`, sql`COALESCE(return_of_trip_id, '00000000-0000-0000-0000-0000000000`).where(sql`(standing_order_id IS NOT NULL)`),
	index("trips_updated_idx").using("btree", table.updatedAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.passengerId],
			foreignColumns: [passengers.id],
			name: "trips_passenger_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.driverId],
			foreignColumns: [drivers.id],
			name: "trips_driver_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.vehicleId],
			foreignColumns: [vehicles.id],
			name: "trips_vehicle_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.returnOfTripId],
			foreignColumns: [table.id],
			name: "trips_return_of_trip_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.standingOrderId],
			foreignColumns: [standingOrders.id],
			name: "trips_standing_order_id_fkey"
		}).onDelete("set null"),
	check("price_or_reason_never_both", sql`(quoted_total IS NULL) OR (unpriced_reason IS NULL)`),
	check("a_trip_is_not_its_own_return", sql`(return_of_trip_id IS NULL) OR (return_of_trip_id <> id)`),
	check("miles_are_not_negative", sql`(COALESCE(miles_override, (0)::numeric) >= (0)::numeric) AND (COALESCE(deadhead_miles, (0)::numeric) >= (0)::numeric)`),
]);

export const vehicles = pgTable("vehicles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	label: citext("label").notNull(),
	active: boolean().default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("vehicles_label_key").on(table.label),
]);

export const standingOrders = pgTable("standing_orders", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	title: text(),
	startDate: date("start_date").notNull(),
	endDate: date("end_date"),
	days: text().array().default([""]).notNull(),
	active: boolean().default(true).notNull(),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	check("standing_order_days_are_real", sql`days <@ ARRAY['SUN'::text, 'MON'::text, 'TUE'::text, 'WED'::text, 'THU'::text, 'FRI'::text, 'SAT'::text]`),
	check("standing_order_ends_after_it_starts", sql`(end_date IS NULL) OR (end_date >= start_date)`),
]);

export const tripEvents = pgTable("trip_events", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	tripId: uuid("trip_id").notNull(),
	kind: tripEventKind().notNull(),
	value: text(),
	actor: text().notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).notNull(),
	recordedAt: timestamp("recorded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	payload: jsonb(),
	idempotencyKey: text("idempotency_key"),
}, (table) => [
	uniqueIndex("trip_events_idempotency_key").using("btree", table.idempotencyKey.asc().nullsLast().op("text_ops")).where(sql`(idempotency_key IS NOT NULL)`),
	index("trip_events_kind_idx").using("btree", table.kind.asc().nullsLast().op("timestamptz_ops"), table.occurredAt.desc().nullsFirst().op("enum_ops")),
	index("trip_events_trip_idx").using("btree", table.tripId.asc().nullsLast().op("uuid_ops"), table.occurredAt.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.tripId],
			foreignColumns: [trips.id],
			name: "trip_events_trip_id_fkey"
		}).onDelete("cascade"),
]);

export const tripCharges = pgTable("trip_charges", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tripId: uuid("trip_id").notNull(),
	ruleKey: text("rule_key").notNull(),
	label: text().notNull(),
	detail: text(),
	amount: numeric({ precision: 10, scale:  2 }).notNull(),
	quantity: numeric({ precision: 10, scale:  2 }),
	unitAmount: numeric("unit_amount", { precision: 10, scale:  2 }),
	passThrough: boolean("pass_through").default(false).notNull(),
	isDiscount: boolean("is_discount").default(false).notNull(),
	source: text().default('auto').notNull(),
	pricedVersion: integer("priced_version"),
	sortOrder: integer("sort_order").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("trip_charges_trip_idx").using("btree", table.tripId.asc().nullsLast().op("int4_ops"), table.sortOrder.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.tripId],
			foreignColumns: [trips.id],
			name: "trip_charges_trip_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.pricedVersion],
			foreignColumns: [pricingConfig.version],
			name: "trip_charges_priced_version_fkey"
		}),
	check("a_discount_takes_money_off", sql`(NOT is_discount) OR (amount <= (0)::numeric)`),
	check("source_is_known", sql`source = ANY (ARRAY['auto'::text, 'manual'::text])`),
]);

export const pricingConfig = pgTable("pricing_config", {
	version: integer().primaryKey().notNull(),
	config: jsonb().notNull(),
	updatedBy: text("updated_by"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const notifications = pgTable("notifications", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	channel: notificationChannel().notNull(),
	recipient: text().notNull(),
	subject: text(),
	body: text().notNull(),
	tripId: uuid("trip_id"),
	driverId: uuid("driver_id"),
	dedupeKey: text("dedupe_key"),
	state: outboxState().default('pending').notNull(),
	attempts: integer().default(0).notNull(),
	lastError: text("last_error"),
	sendAfter: timestamp("send_after", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("notifications_dedupe_key").using("btree", table.dedupeKey.asc().nullsLast().op("text_ops")).where(sql`(dedupe_key IS NOT NULL)`),
	index("notifications_due_idx").using("btree", table.sendAfter.asc().nullsLast().op("timestamptz_ops")).where(sql`(state = 'pending'::outbox_state)`),
	foreignKey({
			columns: [table.tripId],
			foreignColumns: [trips.id],
			name: "notifications_trip_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.driverId],
			foreignColumns: [drivers.id],
			name: "notifications_driver_id_fkey"
		}).onDelete("set null"),
]);

export const submittedDays = pgTable("submitted_days", {
	serviceDate: date("service_date").primaryKey().notNull(),
	submittedBy: text("submitted_by").notNull(),
	submittedAt: timestamp("submitted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	tripCount: integer("trip_count"),
	note: text(),
});

export const driveCache = pgTable("drive_cache", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	origin: text().notNull(),
	destination: text().notNull(),
	minutes: numeric({ precision: 7, scale:  2 }),
	miles: numeric({ precision: 7, scale:  2 }),
	provider: text().default('google').notNull(),
	fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("drive_cache_expiry").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	uniqueIndex("drive_cache_route").using("btree", sql`lower(origin)`, sql`lower(destination)`, sql`provider`),
]);

export const stopTimeStats = pgTable("stop_time_stats", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	locationKey: text("location_key").notNull(),
	transport: transportType(),
	samples: integer().default(0).notNull(),
	medianMinutes: numeric("median_minutes", { precision: 6, scale:  2 }),
	p90Minutes: numeric("p90_minutes", { precision: 6, scale:  2 }),
	rebuiltAt: timestamp("rebuilt_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("stop_time_stats_key").using("btree", sql`location_key`, sql`COALESCE(transport, 'other'::transport_type)`),
]);

export const outboundEvents = pgTable("outbound_events", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	endpoint: text().notNull(),
	payload: jsonb().notNull(),
	state: outboxState().default('pending').notNull(),
	attempts: integer().default(0).notNull(),
	lastError: text("last_error"),
	sendAfter: timestamp("send_after", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("outbound_events_due_idx").using("btree", table.sendAfter.asc().nullsLast().op("timestamptz_ops")).where(sql`(state = 'pending'::outbox_state)`),
]);

export const officeUsers = pgTable("office_users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	email: citext("email").notNull(),
	name: text().notNull(),
	role: officeRole().default('dispatcher').notNull(),
	active: boolean().default(true).notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("office_users_email_key").on(table.email),
]);

export const pendingTrips = pgTable("pending_trips", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	passengerName: text("passenger_name").notNull(),
	phone: text(),
	detail: text(),
	wantedDate: date("wanted_date"),
	createdBy: text("created_by"),
	chasedAt: timestamp("chased_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});
export const boardTrips = pgView("board_trips", {	id: uuid(),
	serviceDate: date("service_date"),
	scheduledTime: time("scheduled_time"),
	startTime: time("start_time"),
	passengerId: uuid("passenger_id"),
	passengerName: text("passenger_name"),
	phone: text(),
	medicaidNo: text("medicaid_no"),
	invoiceNo: text("invoice_no"),
	transport: transportType(),
	transportLabel: text("transport_label"),
	pickup: text(),
	dropoff: text(),
	pickupNotes: text("pickup_notes"),
	dropoffNotes: text("dropoff_notes"),
	notes: text(),
	driverId: uuid("driver_id"),
	driverName: text("driver_name"),
	vehicleId: uuid("vehicle_id"),
	dispatchStatus: dispatchStatus("dispatch_status"),
	dispatchStatusAt: timestamp("dispatch_status_at", { withTimezone: true, mode: 'string' }),
	dispatchStatusBy: text("dispatch_status_by"),
	driverProgress: driverProgress("driver_progress"),
	pickupArrivalAt: timestamp("pickup_arrival_at", { withTimezone: true, mode: 'string' }),
	pickupDepartureAt: timestamp("pickup_departure_at", { withTimezone: true, mode: 'string' }),
	dropoffArrivalAt: timestamp("dropoff_arrival_at", { withTimezone: true, mode: 'string' }),
	dropoffDepartureAt: timestamp("dropoff_departure_at", { withTimezone: true, mode: 'string' }),
	returnOfTripId: uuid("return_of_trip_id"),
	standingOrderId: uuid("standing_order_id"),
	privatePay: boolean("private_pay"),
	milesOverride: numeric("miles_override", { precision: 7, scale:  2 }),
	deadheadMiles: numeric("deadhead_miles", { precision: 7, scale:  2 }),
	pricedMiles: numeric("priced_miles", { precision: 7, scale:  2 }),
	quotedTotal: numeric("quoted_total", { precision: 10, scale:  2 }),
	unpricedReason: text("unpriced_reason"),
	pricedAt: timestamp("priced_at", { withTimezone: true, mode: 'string' }),
	pricedVersion: integer("priced_version"),
	legacyId: text("legacy_id"),
	legacyTripKey: text("legacy_trip_key"),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
	outcome: text(),
	chargesTotal: numeric("charges_total"),
}).as(sql`SELECT id, service_date, scheduled_time, start_time, passenger_id, passenger_name, phone, medicaid_no, invoice_no, transport, transport_label, pickup, dropoff, pickup_notes, dropoff_notes, notes, driver_id, driver_name, vehicle_id, dispatch_status, dispatch_status_at, dispatch_status_by, driver_progress, pickup_arrival_at, pickup_departure_at, dropoff_arrival_at, dropoff_departure_at, return_of_trip_id, standing_order_id, private_pay, miles_override, deadhead_miles, priced_miles, quoted_total, unpriced_reason, priced_at, priced_version, legacy_id, legacy_trip_key, created_by, created_at, updated_at, CASE WHEN dispatch_status = 'no_show'::dispatch_status THEN 'no-show'::text WHEN dispatch_status = 'cancel'::dispatch_status THEN 'cancelled'::text WHEN dispatch_status = 'reassign'::dispatch_status THEN 'reassigned'::text WHEN driver_progress = 'complete'::driver_progress OR dropoff_departure_at IS NOT NULL THEN 'completed'::text ELSE 'in progress'::text END AS outcome, ( SELECT COALESCE(sum(c.amount), 0::numeric) AS "coalesce" FROM trip_charges c WHERE c.trip_id = t.id) AS charges_total FROM trips t`);