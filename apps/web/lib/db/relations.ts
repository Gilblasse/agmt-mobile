import { relations } from "drizzle-orm/relations";
import { drivers, driverSignInCodes, driverSessions, passengers, trips, vehicles, standingOrders, tripEvents, tripCharges, pricingConfig, notifications } from "./schema";

export const driverSignInCodesRelations = relations(driverSignInCodes, ({one}) => ({
	driver: one(drivers, {
		fields: [driverSignInCodes.driverId],
		references: [drivers.id]
	}),
}));

export const driversRelations = relations(drivers, ({many}) => ({
	driverSignInCodes: many(driverSignInCodes),
	driverSessions: many(driverSessions),
	trips: many(trips),
	notifications: many(notifications),
}));

export const driverSessionsRelations = relations(driverSessions, ({one}) => ({
	driver: one(drivers, {
		fields: [driverSessions.driverId],
		references: [drivers.id]
	}),
}));

export const tripsRelations = relations(trips, ({one, many}) => ({
	passenger: one(passengers, {
		fields: [trips.passengerId],
		references: [passengers.id]
	}),
	driver: one(drivers, {
		fields: [trips.driverId],
		references: [drivers.id]
	}),
	vehicle: one(vehicles, {
		fields: [trips.vehicleId],
		references: [vehicles.id]
	}),
	trip: one(trips, {
		fields: [trips.returnOfTripId],
		references: [trips.id],
		relationName: "trips_returnOfTripId_trips_id"
	}),
	trips: many(trips, {
		relationName: "trips_returnOfTripId_trips_id"
	}),
	standingOrder: one(standingOrders, {
		fields: [trips.standingOrderId],
		references: [standingOrders.id]
	}),
	tripEvents: many(tripEvents),
	tripCharges: many(tripCharges),
	notifications: many(notifications),
}));

export const passengersRelations = relations(passengers, ({many}) => ({
	trips: many(trips),
}));

export const vehiclesRelations = relations(vehicles, ({many}) => ({
	trips: many(trips),
}));

export const standingOrdersRelations = relations(standingOrders, ({many}) => ({
	trips: many(trips),
}));

export const tripEventsRelations = relations(tripEvents, ({one}) => ({
	trip: one(trips, {
		fields: [tripEvents.tripId],
		references: [trips.id]
	}),
}));

export const tripChargesRelations = relations(tripCharges, ({one}) => ({
	trip: one(trips, {
		fields: [tripCharges.tripId],
		references: [trips.id]
	}),
	pricingConfig: one(pricingConfig, {
		fields: [tripCharges.pricedVersion],
		references: [pricingConfig.version]
	}),
}));

export const pricingConfigRelations = relations(pricingConfig, ({many}) => ({
	tripCharges: many(tripCharges),
}));

export const notificationsRelations = relations(notifications, ({one}) => ({
	trip: one(trips, {
		fields: [notifications.tripId],
		references: [trips.id]
	}),
	driver: one(drivers, {
		fields: [notifications.driverId],
		references: [drivers.id]
	}),
}));