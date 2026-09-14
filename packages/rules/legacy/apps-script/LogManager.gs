class LogManager {
  tripToRow(trip) {
    return tripObjectToRowArray(trip);
  }

  jsonToTrips(json) {
    return convertRawData(json);
  }

  rowToTrip(row) {
    return convertRowToTrip(row);
  }
}

const logManager = new LogManager();
