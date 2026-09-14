/**
 * Backfill LOG sheet entries from legacy array format to object format.
 *
 * The LOG sheet stores JSON created by `serializeTripMap`. Older data may
 * contain arrays of row values rather than trip objects. This utility scans
 * each row, converts any array entries with {@link convertRowToTrip}, ensures
 * the map is keyed by the TripID stored in column K, and rewrites the JSON using
 * {@link serializeTripMap}.
 *
 * Run manually if historical LOG data needs normalization.
 */
function backSyncLogObjects() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('LOG');
  if (!sheet) {
    Logger.log('LOG sheet not found.');
    return;
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const range = sheet.getRange(2, 2, lastRow - 1, 1);
  const values = range.getValues();

  values.forEach((row, i) => {
    const json = row[0];
    if (!json) return;
    let map;
    try {
      map = deserializeTripMap(json);
    } catch (e) {
      Logger.log('⚠️ Parse error on row ' + (i + 2) + ': ' + e.message);
      return;
    }

    let changed = false;
    const updatedMap = new Map();
    map.forEach((val, key) => {
      let trip = val;
      if (Array.isArray(trip)) {
        trip = convertRowToTrip(trip);
        changed = true;
      }

      const desiredKey = String(trip.tripKeyID || key);
      if (desiredKey !== key) changed = true;
      updatedMap.set(desiredKey, trip);
    });

    if (changed) {
      const serialized = serializeTripMap(updatedMap);
      sheet.getRange(i + 2, 2).setValue(serialized);
    }
  });
}
