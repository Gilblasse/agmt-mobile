// Object-oriented utilities for optimized recurring trip management.

class StandingOrderManager {
  constructor(service) {
    this.service = service || spreadsheetService;
  }

  get logSheet() {
    return this.service.getSheet('Dispatcher', 'LOG');
  }

  /**
   * Create recurring trips across multiple dates.
   * Reads LOG column A once, writes one row per touched date (brand-new dates go in a
   * single block at the bottom), keeps the caches/indexes in step, and returns the trips
   * it created so callers don't have to re-read them.
   * @param {[string, Array]} parentTrip [tripId, fieldsArray]
   * @param {string[]} datesToCreate Array of date strings (yyyy-MM-dd)
   * @return {Object[]} created trips
   */
  createAcrossDatesFast(parentTrip, datesToCreate) {
    if (!parentTrip || !Array.isArray(parentTrip) || parentTrip.length < 2) return [];
    if (!Array.isArray(datesToCreate) || datesToCreate.length === 0) return [];

    const logSheet = this.logSheet;
    if (!logSheet) return [];

    const parentFields = parentTrip[1];
    const recurringId = parentFields[COLUMN.LOG.RECURRING_ID];
    const soMap = tripManager.getStandingOrderMap();
    const standingOrderObj = soMap[recurringId] || {};
    soMap[recurringId] = standingOrderObj;

    // Column A only: column B holds the big JSON blobs and we only need the ones we touch.
    const lastRow = logSheet.getLastRow();
    const colA = lastRow > 1 ? logSheet.getRange(2, 1, lastRow - 1, 1).getValues() : [];
    const dateToRow = {};
    for (let i = 0; i < colA.length; i++) {
      const key = logDateKey_(colA[i][0]);
      if (key && !dateToRow[key]) dateToRow[key] = i + 2;
    }

    const rowsCache = {};
    const newRows = {};
    let nextRow = Math.max(lastRow, 1) + 1;

    const getRowInfo = dateStr => {
      if (!rowsCache[dateStr]) {
        let rowIndex = dateToRow[dateStr];
        if (rowIndex) {
          const json = logSheet.getRange(rowIndex, 2).getValue();
          let map;
          try { map = deserializeTripMap(json); } catch (e) { map = new Map(); }
          rowsCache[dateStr] = { index: rowIndex, map: map };
        } else {
          rowIndex = nextRow++;
          rowsCache[dateStr] = { index: rowIndex, map: new Map() };
          dateToRow[dateStr] = rowIndex;
          newRows[dateStr] = rowIndex;
        }
      }
      return rowsCache[dateStr];
    };

    const created = [];
    datesToCreate.forEach(dateStr => {
      const row = getRowInfo(dateStr);
      const newFields = parentFields.slice();
      const newId = Utilities.getUuid();
      const newTripKeyID = Utilities.getUuid();
      newFields[COLUMN.LOG.DATE] = dateStr;
      newFields[COLUMN.LOG.TRIP_KEY_ID] = newTripKeyID;
      newFields[COLUMN.LOG.ID] = newId;
      newFields[COLUMN.LOG.RECURRING_ID] = recurringId;
      const newTrip = convertRowToTrip(newFields);
      newTrip.id = newId;
      newTrip.tripKeyID = newTripKeyID;
      row.map.set(newTripKeyID, newTrip);
      created.push({ trip: newTrip, dateKey: dateStr, rowIndex: row.index });

      if (standingOrderObj.withReturnTrip && standingOrderObj.returnTime) {
        const returnFields = parentFields.slice();
        const returnId = Utilities.getUuid();
        const returnTripKeyID = Utilities.getUuid();
        returnFields[COLUMN.LOG.DATE] = dateStr;
        returnFields[COLUMN.LOG.TRIP_KEY_ID] = returnTripKeyID;
        returnFields[COLUMN.LOG.ID] = returnId;
        returnFields[COLUMN.LOG.TIME] = standingOrderObj.returnTime;
        returnFields[COLUMN.LOG.PICKUP] = parentFields[COLUMN.LOG.DROPOFF];
        returnFields[COLUMN.LOG.DROPOFF] = parentFields[COLUMN.LOG.PICKUP];
        returnFields[COLUMN.LOG.NOTES] = ((returnFields[COLUMN.LOG.NOTES] || '') + ' [RETURN TRIP]').trim();
        returnFields[COLUMN.LOG.RETURN_OF] = newId;
        returnFields[COLUMN.LOG.RECURRING_ID] = recurringId;
        const returnTrip = convertRowToTrip(returnFields);
        returnTrip.id = returnId;
        returnTrip.tripKeyID = returnTripKeyID;
        row.map.set(returnTripKeyID, returnTrip);
        created.push({ trip: returnTrip, dateKey: dateStr, rowIndex: row.index });
      }
    });

    // Make sure the grid is tall enough for the rows we are about to add.
    const needRows = (nextRow - 1) - logSheet.getMaxRows();
    if (needRows > 0) logSheet.insertRowsAfter(logSheet.getMaxRows(), needRows);

    // Write every touched row. Rows are written in contiguous runs, so the brand-new
    // dates at the bottom of the sheet go out in a single call.
    const entries = Object.keys(rowsCache)
      .map(key => ({ key: key, index: rowsCache[key].index, json: serializeTripMap(rowsCache[key].map) }))
      .sort((a, b) => a.index - b.index);
    let run = [];
    let runStart = 0;
    const flush = () => {
      if (run.length) logSheet.getRange(runStart, 1, run.length, 2).setValues(run);
      run = [];
    };
    entries.forEach(entry => {
      if (run.length && entry.index !== runStart + run.length) flush();
      if (!run.length) runStart = entry.index;
      run.push([entry.key, entry.json]);
    });
    flush();

    // Anyone who read these dates in the last few minutes must see the new trips.
    invalidateTripsCache_(datesToCreate.map(d => Utils.formatDateString(d)));

    // Keep the date -> row index in step for the rows we just appended.
    const newKeys = Object.keys(newRows);
    if (newKeys.length) {
      try {
        const index = readTripDateRowIndex_(logSheet);
        newKeys.forEach(k => { index[k] = newRows[k]; });
        writeTripDateRowIndex_(logSheet, index);
      } catch (e) { Logger.log('Date index update skipped: ' + e.message); }
    }

    // Trip index: these keys are brand new, so one appended block is enough.
    if (created.length && shouldMaintainTripIndexForLog_(logSheet)) {
      try {
        const indexSheet = ensureTripIndexHeaders_();
        const start = Math.max(2, indexSheet.getLastRow() + 1);
        const short = start + created.length - 1 - indexSheet.getMaxRows();
        if (short > 0) indexSheet.insertRowsAfter(indexSheet.getMaxRows(), short);
        indexSheet.getRange(start, 1, created.length, 5).setValues(created.map(c => [
          String(c.trip.tripKeyID), String(c.dateKey || ''), Number(c.rowIndex) || 0,
          String(c.trip.returnOf || ''), String(c.trip.id || '')
        ]));
      } catch (e) { Logger.log('Trip index batch append skipped: ' + e.message); }
    }

    tripManager.updateStandingOrderMap(soMap);
    return created.map(c => c.trip);
  }

  /**
   * Delete recurring trip instances from specific dates.
   * @param {string} recurringId Parent tripId stored in fields[COLUMN.LOG.RECURRING_ID]
   * @param {string[]} datesToDelete Dates to remove (yyyy-MM-dd)
   */
  deleteFromDates(recurringId, datesToDelete) {
    if (!recurringId || !Array.isArray(datesToDelete) || datesToDelete.length === 0) return;

    const logSheet = this.logSheet;
    if (!logSheet) return;

    const lastRow = logSheet.getLastRow();
    const data = lastRow > 1 ? logSheet.getRange(2, 1, lastRow - 1, 2).getValues() : [];
    const dateToRow = {};
    for (let i = 0; i < data.length; i++) {
      const d = data[i][COLUMN.LOG.DATE];
      const key = d ? Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'yyyy-MM-dd') : '';
      if (!dateToRow[key]) {
        dateToRow[key] = i + 2;
      }
    }

    datesToDelete.forEach(dateStr => {
      const rowIndex = dateToRow[dateStr];
      if (!rowIndex) return;
      const cell = logSheet.getRange(rowIndex, 2);
      const json = cell.getValue();
      if (!json) return;
      let map;
      try {
        map = deserializeTripMap(json);
      } catch (e) {
        map = new Map();
      }
      let changed = false;
      Array.from(map.entries()).forEach(([id, trip]) => {
        if (trip && trip.recurringId === recurringId) {
          map.delete(id);
          changed = true;
        }
      });
      if (changed) {
        cell.setValue(serializeTripMap(map));
      }
    });
    invalidateTripsCache_(datesToDelete.map(d => Utils.formatDateString(d)));
  }
}

const standingOrderManager = new StandingOrderManager();

function createRecurringTripAcrossDatesFast(parentTrip, datesToCreate) {
  return standingOrderManager.createAcrossDatesFast(parentTrip, datesToCreate);
}

function deleteRecurringTripFromDates(recurringId, datesToDelete) {
  return standingOrderManager.deleteFromDates(recurringId, datesToDelete);
}

