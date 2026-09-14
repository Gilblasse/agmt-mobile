function validateTripIndexAgainstLog() {
  const ss = activeSpreadsheet_();
  const logSheet = ss.getSheetByName('LOG');
  const indexSheet = ensureTripIndexHeaders_();
  const logLastRow = logSheet.getLastRow();
  const logRows = logLastRow >= 2 ? logSheet.getRange(2, 1, logLastRow - 1, 2).getValues() : [];
  const indexLastRow = indexSheet.getLastRow();
  const indexRows = indexLastRow >= 2 ? indexSheet.getRange(2, 1, indexLastRow - 1, 5).getValues() : [];
  const issues = [];
  indexRows.forEach(function(row, offset) {
    const tripKeyID = String(row[0] || '');
    const rowNum = Number(row[2]) || 0;
    const json = rowNum >= 2 && rowNum <= logLastRow ? logRows[rowNum - 2][1] : '';
    const map = deserializeTripMap(json);
    if (!tripKeyID || !map.has(tripKeyID)) issues.push({ indexRow: offset + 2, tripKeyID: tripKeyID, logRow: rowNum });
  });
  return { indexedTrips: indexRows.length, issues: issues };
}



// SNAP SHOTS
function deleteTodaysLogsThenUpdateSnapshotDispatchToLog() {
  const ss = activeSpreadsheet_();
  const logSheet = ss.getSheetByName('LOG');
  const todayKey = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  // V120: read-modify-write across a lock boundary. A save landing between the
  // clear and the rebuild found an empty day and wrote a row holding only its own
  // trip. The clear is now inside the lock.
  // V120: read-modify-write across a lock boundary. A save landing between the
  // clear and the rebuild found an empty day and wrote a row holding only its own
  // trip. Both halves are now inside ONE lock - the rebuild re-enters it rather
  // than taking a fresh one, so the gap the trip fell through is closed.
  return withTripsDocumentLock_(function() {
    const rowNum = getIndexedLogRowForDate_(logSheet, todayKey);
    if (rowNum) {
      const oldJson = String(logSheet.getRange(rowNum, 2).getValue() || '');
      if (oldJson) backupLogJson_(ss, rowNum, todayKey, oldJson, 'full-sync-backup');
      logSheet.getRange(rowNum, 2).clearContent();
    }
    invalidateTripsCache_([todayKey]);
    return snapshotDispatchToLog(true);
  });
}



function backupLogJson_(ss, rowNum, dateKey, json, reason) {
  try {
    let archiveSheet = ss.getSheetByName('LOG_ARCHIVE');
    if (!archiveSheet) {
      archiveSheet = ss.insertSheet('LOG_ARCHIVE');
      archiveSheet.getRange(1, 1, 1, 5).setValues([['archivedAt', 'originalRow', 'date', 'json', 'reason']]);
      archiveSheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#eeeeee');
      archiveSheet.setFrozenRows(1);
      archiveSheet.hideSheet();
    }
    archiveSheet.appendRow([new Date(), rowNum, dateKey, json, reason]);
  } catch (e) {
    Logger.log('LOG backup skipped: ' + e.message);
  }
}

var passengerTripsSnapshotResult_ = null;

function snapshotDispatchToLog(isAlert, force) {
  isAlert = isAlert === true; force = force === true;
  const props = PropertiesService.getScriptProperties();
  const nowMs = Date.now();
  const last = Number(props.getProperty('lastSnapshotTs') || 0);
  passengerTripsSnapshotResult_ = { executed: false, changedDates: [], tripsByDate: {} };
  if (!isAlert && !force && nowMs - last < 5 * 60 * 1000) return false;

  const didSnapshot = withTripsDocumentLock_(function() {
    const lockedLast = Number(props.getProperty('lastSnapshotTs') || 0);
    if (!isAlert && !force && Date.now() - lockedLast < 5 * 60 * 1000) return false;

    const ss = activeSpreadsheet_();
    const logSheet = ss.getSheetByName('LOG');
    const dispatchSheet = ss.getSheetByName('DISPATCH');
    const lastDispatchRow = Math.max(2, dispatchSheet.getLastRow());
    const rowCount = lastDispatchRow - 1;
    const data = dispatchSheet.getRange(2, 1, rowCount, Math.min(dispatchSheet.getMaxColumns(), 33)).getValues();
    const groupedByDate = {};
    const keyValues = data.map(function(row) { return [row[COLUMN.DISPATCH.TRIP_KEY_ID] || '']; });
    let generatedKey = false;
    const todayKey = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

    data.forEach(function(row, index) {
      const passenger = String(row[COLUMN.DISPATCH.PASSENGER] || '').trim();
      if (!passenger) return;
      const rawDate = row[COLUMN.DISPATCH.DATE];
      const dateKey = rawDate === '' || rawDate == null ? '' : Utils.formatDateString(rawDate);
      // V120: an empty date key used to slip past this guard and create a LOG row
      // keyed by the empty string - a real trip that no date-keyed reader could
      // ever find again.
      if (!dateKey || dateKey < todayKey) return;

      let tripKeyID = row[COLUMN.DISPATCH.TRIP_KEY_ID];
      if (!groupedByDate[dateKey]) groupedByDate[dateKey] = new Map();
      if (!tripKeyID || groupedByDate[dateKey].has(tripKeyID)) {
        tripKeyID = Utilities.getUuid();
        row[COLUMN.DISPATCH.TRIP_KEY_ID] = tripKeyID;
        keyValues[index][0] = tripKeyID;
        generatedKey = true;
      }
      if (!row[COLUMN.DISPATCH.TIME]) row[COLUMN.DISPATCH.TIME] = '23:58';
      row[COLUMN.DISPATCH.DATE] = dateKey;
      const trip = convertRowToTrip(row);
      trip.tripKeyID = tripKeyID;
      if (!groupedByDate[dateKey]) groupedByDate[dateKey] = new Map();
      groupedByDate[dateKey].set(tripKeyID, trip);
    });

    if (generatedKey && keyValues.length) dispatchSheet.getRange(2, 11, keyValues.length, 1).setValues(keyValues);
    const changedDates = [];
    const tripsByDate = {};

    Object.keys(groupedByDate).forEach(function(dateKey) {
      const dispatchMap = groupedByDate[dateKey];
      let rowNum = getIndexedLogRowForDate_(logSheet, dateKey);
      const oldJson = rowNum ? String(logSheet.getRange(rowNum, 2).getValue() || '') : '';
      const logMap = deserializeTripMap(oldJson);
      // PRODUCTION_PRESERVE_LINK_IDENTITY_V14: Dispatch formulas must not replace the stable ID used by returnOf.
      dispatchMap.forEach(function(trip, tripKeyID) {
        let existing = logMap.get(tripKeyID);
        // V120: a board row with a blank or duplicated key gets a fresh UUID a few
        // lines above, which used to make this lookup miss - so the trip was
        // re-added with no price and the priced original was left orphaned in the
        // record. Fall back to the trip's own stable id.
        if (!existing && trip.id) {
          const wantId = String(trip.id);
          let foundKey = null;
          logMap.forEach(function(v, k) {
            if (foundKey || !v || Array.isArray(v)) return;
            if (String(v.id || '') === wantId) foundKey = k;
          });
          if (foundKey) { existing = logMap.get(foundKey); logMap.delete(foundKey); }
        }
        // A legacy row array still holds the shared fields; read them rather than
        // skipping the carry-over entirely.
        if (existing && Array.isArray(existing)) {
          try { existing = convertRowToTrip(existing); } catch (e) { existing = null; }
        }
        if (existing && !Array.isArray(existing)) {
          if (existing.id) trip.id = existing.id;
          if (existing.returnOf) trip.returnOf = existing.returnOf;
          if (existing.recurringId) trip.recurringId = existing.recurringId;
          // V74: the stop notes have no DISPATCH column, so carry them over
          // rather than letting a snapshot rebuild wipe them.
          if (existing.pickupNotes) trip.pickupNotes = existing.pickupNotes;
          if (existing.dropoffNotes) trip.dropoffNotes = existing.dropoffNotes;
          // V110: private-pay pricing has no DISPATCH column either. Without this the
          // price and its snapshot vanish from today's trips the first time a driver taps.
          if (existing.privatePay !== undefined) trip.privatePay = existing.privatePay;
          if (existing.price !== undefined) trip.price = existing.price;
          if (existing.pricing !== undefined) trip.pricing = existing.pricing;
          if (existing.milesOverride !== undefined) trip.milesOverride = existing.milesOverride;
          // V118: the typed deadhead miles have no DISPATCH column either.
          if (existing.deadheadMiles !== undefined) trip.deadheadMiles = existing.deadheadMiles;
        }
        logMap.set(tripKeyID, trip);
      });
      const json = serializeTripMap(logMap);

      if (json !== oldJson) {
        if (rowNum) {
          logSheet.getRange(rowNum, 2).setValue(json);
        } else {
          logSheet.appendRow([dateKey, json]);
          rowNum = logSheet.getLastRow();
          setIndexedLogRowForDate_(logSheet, dateKey, rowNum);
        }
        changedDates.push(dateKey);
        if (shouldMaintainTripIndexForLog_(logSheet)) refreshTripIndexForDate_(dateKey, rowNum, logMap);
      }

      const trips = Array.from(logMap.values()).filter(function(item) {
        return item && String(item.passenger || '').trim();
      });
      tripsByDate[dateKey] = trips;
      writeTripsCache_(dateKey, trips);
    });

    props.setProperty('lastSnapshotTs', String(Date.now()));
    passengerTripsSnapshotResult_ = { executed: true, changedDates: changedDates, tripsByDate: tripsByDate };
    return true;
  });

  if (didSnapshot && isAlert) SpreadsheetApp.getUi().alert('✅ Snapshot was taken of DISPATCH');
  return didSnapshot;
}





function restoreDispatchFromLog(date) {
  const ss = activeSpreadsheet_();
  const logSheet = ss.getSheetByName('LOG');
  const dispatchSheet = ss.getSheetByName('DISPATCH');
  const parts = String(date || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(function(value) { return !value; })) {
    SpreadsheetApp.getUi().alert('⚠️ Invalid date.');
    return false;
  }
  const year = parts[0], month = parts[1], day = parts[2];
  const targetDate = Utilities.formatDate(new Date(year, month - 1, day, 12), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const rowNum = getIndexedLogRowForDate_(logSheet, targetDate);
  if (!rowNum) {
    SpreadsheetApp.getUi().alert('⚠️ No snapshot found for ' + targetDate);
    return false;
  }
  const json = logSheet.getRange(rowNum, 2).getValue();
  if (!json) {
    SpreadsheetApp.getUi().alert('⚠️ Snapshot for ' + targetDate + ' is empty.');
    return false;
  }

  let parsed;
  try {
    parsed = Array.from(deserializeTripMap(json).entries()).map(function(entry) {
      const tripKeyID = entry[0];
      const value = entry[1];
      const row = Array.isArray(value) ? value : tripObjectToRowArray(value);
      row[COLUMN.DISPATCH.TRIP_KEY_ID] = tripKeyID;
      return row;
    });
  } catch (e) {
    SpreadsheetApp.getUi().alert('❌ Error parsing snapshot JSON for ' + targetDate);
    return false;
  }

  function cleanTime_(value) {
    if (!value || isNaN(new Date(value))) return '';
    const parsedTime = new Date(value);
    return new Date(1899, 11, 30, parsedTime.getUTCHours(), parsedTime.getUTCMinutes());
  }
  parsed = parsed.map(function(row) {
    row[COLUMN.DISPATCH.DATE] = new Date(year, month - 1, day);
    row[COLUMN.DISPATCH.START_TIME] = cleanTime_(row[COLUMN.DISPATCH.START_TIME]);
    row[COLUMN.DISPATCH.TIME] = cleanTime_(row[COLUMN.DISPATCH.TIME]);
    row[COLUMN.DISPATCH.IN] = cleanTime_(row[COLUMN.DISPATCH.IN]);
    row[COLUMN.DISPATCH.OUT] = cleanTime_(row[COLUMN.DISPATCH.OUT]);
    while (row.length < 32) row.push('');
    return row.slice(0, 32);
  });

  const neededRows = parsed.length + 1;
  if (dispatchSheet.getMaxRows() < neededRows) {
    dispatchSheet.insertRowsAfter(dispatchSheet.getMaxRows(), neededRows - dispatchSheet.getMaxRows());
  }
  dispatchSheet.getRange(2, 1, dispatchSheet.getMaxRows() - 1, 32).clearContent();
  if (!parsed.length) {
    SpreadsheetApp.getUi().alert('⚠️ No rows to restore for ' + targetDate);
    return false;
  }
  dispatchSheet.getRange(2, 1, parsed.length, 32).setValues(parsed);
  dispatchSheet.getRange(2, 10, dispatchSheet.getMaxRows() - 1, 1)
    .setNumberFormat('@STRING@')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  applyFormulas(dispatchSheet, dispatchSheetFormulas);
  rowAddressValidation();
  SpreadsheetApp.getUi().alert('✅ Restored ' + parsed.length + ' rows to DISPATCH from ' + targetDate);
  return true;
}



function cleanFirstName(rawFirstName) {
  return String(rawFirstName || "")
    .replace(/\(.*?\)/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/[^a-zA-Z\s'-]/g, "")
    .trim();
}

function addToMapArrayIfUnique(map, key, value) {
  const strVal = String(value || "").trim();
  if (!strVal) return;

  if (!map[key]) {
    map[key] = [strVal];
  } else if (!map[key].includes(strVal)) {
    map[key].push(strVal);
  }
}


function migrateAddPassengersToModularCache() {
  const count = rebuildPassengerCache();
  Logger.log('Passenger cache rebuilt with ' + count + ' profiles.');
  return count;
}












function analyzeTripLogCompaction() {
  const logSheet = activeSpreadsheet_().getSheetByName('LOG');
  const lastRow = logSheet.getLastRow();
  const rows = lastRow >= 2 ? logSheet.getRange(2, 1, lastRow - 1, 2).getValues() : [];
  const latest = {};
  let duplicateRows = 0;
  let invalidRows = 0;
  rows.forEach(function(row) {
    const dateKey = logDateKey_(row[0]);
    if (!row[1]) {
      invalidRows += 1;
      return;
    }
    if (latest[dateKey]) duplicateRows += 1;
    latest[dateKey] = true;
  });
  const result = {
    sourceRows: rows.length,
    canonicalRows: Object.keys(latest).length,
    duplicateRows: duplicateRows,
    invalidRows: invalidRows
  };
  Logger.log('TRIP_LOG_ANALYSIS ' + JSON.stringify(result));
  return result;
}

function archiveAndCompactTripLog() {
  return withTripsDocumentLock_(function() {
    const ss = activeSpreadsheet_();
    const logSheet = ss.getSheetByName('LOG');
    const lastRow = logSheet.getLastRow();
    const rows = lastRow >= 2 ? logSheet.getRange(2, 1, lastRow - 1, 2).getValues() : [];
    const latest = new Map();
    const archived = [];
    const archivedAt = new Date();

    rows.forEach(function(row, offset) {
      const originalRow = offset + 2;
      const dateKey = logDateKey_(row[0]);
      const json = row[1];
      if (!json) {
        archived.push([archivedAt, originalRow, row[0], json, 'blank-json']);
        return;
      }
      if (latest.has(dateKey)) {
        const prior = latest.get(dateKey);
        archived.push([archivedAt, prior.originalRow, prior.dateValue, prior.json, 'superseded']);
      }
      latest.set(dateKey, { originalRow: originalRow, dateValue: row[0], json: json });
    });

    if (archived.length) {
      let archiveSheet = ss.getSheetByName('LOG_ARCHIVE');
      if (!archiveSheet) {
        archiveSheet = ss.insertSheet('LOG_ARCHIVE');
        archiveSheet.getRange(1, 1, 1, 5).setValues([['archivedAt', 'originalRow', 'date', 'json', 'reason']]);
        archiveSheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#eeeeee');
        archiveSheet.setFrozenRows(1);
      }
      const start = Math.max(2, archiveSheet.getLastRow() + 1);
      const needed = start + archived.length - 1;
      if (archiveSheet.getMaxRows() < needed) {
        archiveSheet.insertRowsAfter(archiveSheet.getMaxRows(), needed - archiveSheet.getMaxRows());
      }
      archiveSheet.getRange(start, 1, archived.length, 5).setValues(archived);
      archiveSheet.hideSheet();
    }

    const canonical = Array.from(latest.values())
      .sort(function(a, b) { return a.originalRow - b.originalRow; })
      .map(function(item) { return [item.dateValue, item.json]; });
    if (lastRow >= 2) logSheet.getRange(2, 1, lastRow - 1, 2).clearContent();
    if (canonical.length) logSheet.getRange(2, 1, canonical.length, 2).setValues(canonical);

    const desiredRows = Math.max(200, canonical.length + 20);
    if (logSheet.getMaxRows() > desiredRows) {
      logSheet.deleteRows(desiredRows + 1, logSheet.getMaxRows() - desiredRows);
    }
    clearTripDateRowIndex_(logSheet);
    rebuildTripDateRowIndex_(logSheet);
    const indexedTrips = rebuildTripIndexFromLog_();
    invalidateTripsCache_(Array.from(latest.keys()));
    const result = {
      sourceRows: rows.length,
      canonicalRows: canonical.length,
      archivedRows: archived.length,
      indexedTrips: indexedTrips
    };
    Logger.log('TRIP_LOG_COMPACTION ' + JSON.stringify(result));
    return result;
  });
}


function promptRestoreSnapshotByDate() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt("📅 Restore Snapshot", "Enter the date to restore (YYYY-MM-DD):", ui.ButtonSet.OK_CANCEL);

  if (response.getSelectedButton() !== ui.Button.OK) return;

  const inputDate = response.getResponseText().trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inputDate)) {
    ui.alert("❌ Invalid date format. Please use YYYY-MM-DD.");
    return;
  }

  restoreDispatchFromLog(inputDate);
}

function maybeSnapshotDispatchToLog() {
  return snapshotDispatchToLog(false);
}

function getTripsPageData(dateStr, refreshToday) {
  const startedAt = Date.now();
  const dateKey = Utils.formatDateString(dateStr || '');
  const todayKey = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  let trips = null;
  let source = 'date-index';

  if (refreshToday && dateKey === todayKey) {
    try {
      maybeSnapshotDispatchToLog();
      if (passengerTripsSnapshotResult_ && passengerTripsSnapshotResult_.tripsByDate[dateKey]) {
        trips = passengerTripsSnapshotResult_.tripsByDate[dateKey];
        source = 'snapshot';
      }
    } catch (e) {
      recordTripMetric_('getTripsPageDataError', Date.now() - startedAt, { message: e.message });
      Logger.log('Sidebar snapshot skipped: ' + e.message);
    }
  }
  if (trips === null) trips = getTripsByDate(dateKey);
  recordTripMetric_('getTripsPageData', Date.now() - startedAt, {
    source: source, date: dateKey, count: trips.length
  });
  return trips;
}

function dispatchFingerprint_() {
  const sheet = activeSpreadsheet_().getSheetByName('DISPATCH');
  if (!sheet) return '';
  const lastRow = Math.max(2, sheet.getLastRow());
  const values = sheet.getRange(2, 1, lastRow - 1, 32).getDisplayValues();
  return tripsHash_(JSON.stringify(values));
}

// V120 SPEED: how long the board may go without a full read of the sheet. Every
// write the app makes bumps the board version, and a hand edit typed into the tab
// fires the onEdit trigger, so in practice a change is noticed at once. This is
// only the safety net for a change that announced itself in neither way.
var DISPATCH_FULL_CHECK_MS_ = 60000;

function syncDispatchIfChanged_(force) {
  // PRODUCTION_POLL_ACTIVITY_CAPTURE_V13: capture first-seen driver transitions before hashing/snapshotting.
  try { captureDriverStatusTransitions_(); } catch (e) { Logger.log('Driver transition capture skipped: ' + e.message); }
  const cache = CacheService.getDocumentCache();

  // V120 SPEED: this used to read every cell of the board - about 3,200 of them -
  // and hash the lot, on EVERY poll from EVERY open board, six times a minute
  // each, purely to answer "has anything changed". Almost always the answer was
  // no. The version counter answers the same question in one small cache read.
  let version = '';
  try { version = String(getBoardVersion() || ''); } catch (e) { version = ''; }
  const seen = cache.get('dispatchVer:v1');
  const lastFull = Number(cache.get('dispatchFullAt:v1') || 0);
  const dueFullCheck = !lastFull || (Date.now() - lastFull) > DISPATCH_FULL_CHECK_MS_;
  // V123: `force` is a dispatcher pressing Refresh, or the timer running with
  // nobody watching. Both mean "read the board, do not trust the counter".
  if (!force && version && seen === version && !dueFullCheck) return false;

  const fp = dispatchFingerprint_();
  try { cache.put('dispatchFullAt:v1', String(Date.now()), 21600); } catch (e) {}
  if (!fp) return false;
  const prev = cache.get('dispatchFp:v1');
  if (prev === fp) {
    // Nothing actually moved; remember the version so the next poll is free.
    if (version) { try { cache.put('dispatchVer:v1', version, 21600); } catch (e) {} }
    return false;
  }
  if (cache.get('dfpBusy')) {
    if (!force) return false;
    // Someone else is already doing exactly this work. Let them finish rather
    // than doing it twice, but do not report "nothing to do" to a dispatcher
    // who asked for a refresh.
    Utilities.sleep(1200);
    if (cache.get('dfpBusy')) return false;
    // The other execution finished. If it has already written this exact board,
    // the work is done - doing it again would just hold the sheet lock for
    // nothing, and a trip save arriving meanwhile would be the one to fail.
    if (cache.get('dispatchFp:v1') === fp) return false;
  }
  cache.put('dfpBusy', 'y', 30);
  snapshotDispatchToLog(false, true);
  cache.put('dispatchFp:v1', fp, 21600);
  try {
    const after = String(getBoardVersion() || version || '');
    if (after) cache.put('dispatchVer:v1', after, 21600);
  } catch (e) {}
  try { cache.remove('dfpBusy'); } catch (e) {}
  return true;
}

function getTripsPageDelta(dateStr, clientHash, refreshToday, force) {
  const dateKey = Utils.formatDateString(dateStr || '');
  const todayKey = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  // V123: make sure the board goes on updating once everyone has closed it.
  try { ensureBackgroundSyncTrigger_(); } catch (e) {}
  if (refreshToday && dateKey === todayKey) {
    try { syncDispatchIfChanged_(!!force); } catch (e) { Logger.log('Sidebar sync skipped: ' + e.message); }
  }
  // V120 SPEED: the quickest possible answer to "anything new?" - one small cache
  // read of the hash that was stored when the day was last written. This used to
  // pull the whole day's JSON back out of the cache and walk it character by
  // character to rebuild a hash it already had.
  const quickHash = readTripsHashCached_(dateKey);
  if (!force && clientHash && quickHash && clientHash === quickHash) {
    return { unchanged: true, hash: quickHash, submitted: isDateSubmittedCached_(dateKey) };
  }

  let raw = readTripsCacheRaw_(dateKey);
  let trips = null;
  if (raw === null) {
    trips = getTripsByDate(dateKey);
    raw = JSON.stringify(trips);
  }
  // V120: only trust the cached hash when the payload came from the same cache
  // entry. If the day was just re-read from the sheet, hash what we actually have.
  const hash = (trips === null && quickHash) ? quickHash : tripsHash_(raw);
  // V123: safe today only because Refresh clears the client's hash first. Say
  // what is meant, so it stays safe if that ever changes.
  if (!force && clientHash && clientHash === hash) return { unchanged: true, hash: hash, submitted: isDateSubmittedCached_(dateKey) };
  if (trips === null) {
    try { trips = JSON.parse(raw) || []; } catch (e) { trips = getTripsByDate(dateKey); }
  }
  return { unchanged: false, hash: hash, trips: trips, submitted: isDateSubmittedCached_(dateKey) };
}

function backSyncLegacyTripIds() {
  try {
    const ss = activeSpreadsheet_();
    const logSheet = ss.getSheetByName('LOG');

    const logRange = logSheet.getRange('A2:B' + logSheet.getLastRow()).getValues();

    logRange.forEach((row, idx) => {
      const json = row[1];
      if (!json) return;

      let map;
      try {
        map = deserializeTripMap(json);
      } catch (e) {
        Logger.log('⚠️ Error parsing LOG row ' + (idx + 2) + ': ' + e.message);
        return;
      }

      // If deserializeTripMap produced an empty map, try legacy array of rows
      if (map.size === 0) {
        try {
          const arr = JSON.parse(json);
          if (Array.isArray(arr)) {
            map = new Map();
            arr.forEach(r => {
              if (!Array.isArray(r)) return;
              const tripKeyID = Utilities.getUuid();
              r[COLUMN.DISPATCH.TRIP_KEY_ID] = tripKeyID;
              map.set(tripKeyID, r);
            });
          }
        } catch (e) {
          Logger.log('⚠️ Error parsing LOG row ' + (idx + 2) + ': ' + e.message);
          return;
        }
      }

      // V120: this used to run every trip through tripObjectToRowArray, which can
      // only hold the 26 mapped columns. One run flattened every trip in the whole
      // LOG into a row array and destroyed every field that lives only in the
      // record - price, pricing, private-pay flag, stop notes, deadhead, mileage
      // override - across all history, permanently. It now only ever repairs the
      // key, and leaves the shape of each entry exactly as it found it.
      const updatedMap = new Map();
      map.forEach((val, key) => {
        const fromArr = Array.isArray(val);
        let tripKeyID = key || (fromArr ? val[COLUMN.DISPATCH.TRIP_KEY_ID] : (val && val.tripKeyID));
        if (!tripKeyID || tripKeyID === 'null' || tripKeyID === 'undefined') {
          tripKeyID = Utilities.getUuid();
        }
        if (fromArr) {
          const arr = val.slice();
          arr[COLUMN.DISPATCH.TRIP_KEY_ID] = tripKeyID;
          updatedMap.set(tripKeyID, arr);
        } else {
          updatedMap.set(tripKeyID, Object.assign({}, val, { tripKeyID: tripKeyID }));
        }
      });

      if (updatedMap.size > 0) {
        const newJson = JSON.stringify(Array.from(updatedMap.entries()));
        // Nothing to fix on this row: do not rewrite it.
        if (newJson === String(json)) return;
        backupLogJson_(ss, idx + 2, String(row[0] || ''), String(json), 'back-sync');
        logSheet.getRange(idx + 2, 2).setValue(newJson);
      }
    });
  } catch (e) {
    Logger.log('❌ Back-sync error: ' + e.message);
  }
}


// === AUTO 2-WAY SYNC: DISPATCH edits -> LOG (instant sidebar refresh) ===
// V120: exactly the fields a DISPATCH row carries. Anything not in this list lives
// only in the trip record and must survive a board edit untouched.
var DISPATCH_OWNED_FIELDS_ = ['date', 'startTime', 'time', 'passenger', 'transport', 'phone',
  'medicaid', 'invoice', 'pickup', 'dropoff', 'in', 'out', 'vehicle', 'driver', 'notes',
  'dispatchStatus', 'pickupArrival', 'pickupDeparture', 'dropoffArrival', 'dropoffDeparture'];
function onDispatchEditSyncTrips_(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    if (!sheet || sheet.getName() !== "DISPATCH") return;
    // V120: the board is 33 columns wide (A..AG). Stopping at 32 meant an edit to
    // "Status At" was invisible to this trigger.
    if (e.range.getColumn() > 33) return;
    var startRow = e.range.getRow();
    var numRows = e.range.getNumRows();
    if (startRow < 2) {
      numRows = numRows - (2 - startRow);
      startRow = 2;
    }
    if (numRows < 1) return;
    if (numRows > 20) { snapshotDispatchToLog(false, true); return; }
    // Which of the two protected columns, if either, this edit covered.
    var firstColTouched_ = e.range.getColumn();
    var lastColTouched_ = firstColTouched_ + e.range.getNumColumns() - 1;
    var editedStatus_ = firstColTouched_ <= (COLUMN.DISPATCH.STATUS + 1) && lastColTouched_ >= (COLUMN.DISPATCH.STATUS + 1);
    var editedStampAt_ = firstColTouched_ <= (COLUMN.DISPATCH.STATUS_AT + 1) && lastColTouched_ >= (COLUMN.DISPATCH.STATUS_AT + 1);
    var lastCol = Math.min(33, sheet.getLastColumn());
    var rows = sheet.getRange(startRow, 1, numRows, lastCol).getValues();
    var needsFullSnapshot = false;
    // V120: updateTripInLog takes the board lock, and this loop can run twenty
    // times. Each one waited up to fifteen seconds and threw on timeout, so a
    // paste across several rows on a busy morning could stall for minutes and
    // then abort halfway, syncing some rows and silently not others. The lock is
    // re-entrant, so taking it once around the whole batch makes the inner calls
    // free and the whole edit all-or-nothing.
    withTripsDocumentLock_(function() {
    for (var i = 0; i < rows.length; i++) {
      var rowData = rows[i];
      var passenger = String(rowData[COLUMN.DISPATCH.PASSENGER] || '').trim();
      if (!passenger) continue;
      if (!rowData[COLUMN.DISPATCH.TRIP_KEY_ID]) { needsFullSnapshot = true; break; }
      var trip = dispatchRowToTripObject(rowData);
      trip.time = toWallClockTimeIso_(trip.time);
      // V120: these come off the sheet as Date objects and would be stored as UTC,
      // while the driver app writes them as a local wall clock with no zone. Left
      // alone, correcting a phone number in another column shifted every progress
      // time on that trip by the timezone offset.
      ['pickupArrival', 'pickupDeparture', 'dropoffArrival', 'dropoffDeparture', 'in', 'out'].forEach(function(f) {
        if (trip[f]) { try { trip[f] = toWallClockTimeIso_(trip[f]); } catch (eT) {} }
      });
      // V120: with no field list this fell into the whole-record path and wiped
      // everything that lives only in the trip record - the price, the pricing
      // breakdown, the stop notes, the mileage override - every time anyone typed
      // in a DISPATCH cell. Name the fields the board actually owns. `status` and
      // `statusAt` are protected against a stale page, so they are only written
      // when those very cells were the ones edited - otherwise correcting a phone
      // number in column D would push the board's status over the record's.
      var extraNames = [], extraVals = {};
      if (editedStatus_) { extraNames.push('status'); extraVals.status = trip.status; }
      if (editedStampAt_) { extraNames.push('statusAt'); extraVals.statusAt = trip.statusAt; }
      updateTripInLog(trip, DISPATCH_OWNED_FIELDS_.concat(extraNames),
                      extraNames.length ? extraVals : null);
    }
    });
    if (needsFullSnapshot) snapshotDispatchToLog(false, true);
  } catch (err) {
    Logger.log("onDispatchEditSyncTrips_ error: " + err.message);
  }
}

// V123: how often the board is brought up to date when nobody has it open.
// Ten minutes keeps the daily script time this uses well clear of the budget it
// shares with the standing-order queue, and a board nobody is looking at does
// not need to be fresher than that. Anyone actually watching still sees a change
// within about three seconds, through the version check their page runs.
var BG_SYNC_MINUTES_ = 10;
var BG_SYNC_HANDLER_ = 'backgroundDispatchSync';

function backgroundDispatchSync() {
  try {
    // A standing order being written holds the same sheet lock and comes out of
    // the same daily budget. It will finish in a minute or two; this can wait.
    if (typeof soAnyJobOpen_ === 'function' && soAnyJobOpen_()) return;
  } catch (e) { /* if we cannot tell, carry on */ }
  try {
    syncDispatchIfChanged_(true);
  } catch (e) {
    Logger.log('backgroundDispatchSync: ' + ((e && e.message) || e));
  }
}

function installBackgroundSyncTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === BG_SYNC_HANDLER_) { ScriptApp.deleteTrigger(tr); removed++; }
  });
  ScriptApp.newTrigger(BG_SYNC_HANDLER_).timeBased().everyMinutes(BG_SYNC_MINUTES_).create();
  return 'background sync installed, every ' + BG_SYNC_MINUTES_ + ' minutes (replaced ' + removed + ')';
}

function uninstallBackgroundSyncTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === BG_SYNC_HANDLER_) { ScriptApp.deleteTrigger(tr); removed++; }
  });
  return 'removed ' + removed + ' background sync trigger(s)';
}

// Put the timer in place without anybody having to run anything by hand. Checked
// at most once an hour, from an ordinary board load, and it does nothing at all
// once the trigger exists - so the usual cost is one small cache read.
function ensureBackgroundSyncTrigger_() {
  var cache;
  try { cache = CacheService.getScriptCache(); } catch (e) { return; }
  try { if (cache.get('bgSyncChecked:v1')) return; } catch (e) { return; }
  // Two boards loading at the same moment must not each create a timer.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;
  try {
    if (cache.get('bgSyncChecked:v1')) return;
    var found = 0;
    ScriptApp.getProjectTriggers().forEach(function (tr) {
      if (tr.getHandlerFunction() === BG_SYNC_HANDLER_) found++;
    });
    if (!found) {
      ScriptApp.newTrigger(BG_SYNC_HANDLER_).timeBased().everyMinutes(BG_SYNC_MINUTES_).create();
      Logger.log('ensureBackgroundSyncTrigger_: installed');
    } else if (found > 1) {
      // Tidy up duplicates rather than paying for each of them on every run.
      var kept = false;
      ScriptApp.getProjectTriggers().forEach(function (tr) {
        if (tr.getHandlerFunction() !== BG_SYNC_HANDLER_) return;
        if (!kept) { kept = true; return; }
        ScriptApp.deleteTrigger(tr);
      });
    }
    cache.put('bgSyncChecked:v1', '1', 3600);
  } catch (e) {
    Logger.log('ensureBackgroundSyncTrigger_: ' + ((e && e.message) || e));
    // Without this the guard below is never written, and every poll from every
    // open board retries the trigger API - taking the script lock each time,
    // which is the lock the passenger list also waits on.
    try { cache.put('bgSyncChecked:v1', '1', 300); } catch (e2) {}
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function installDispatchSyncTrigger() {
  var ss = activeSpreadsheet_();
  ScriptApp.getProjectTriggers().forEach(function(tr){
    if (tr.getHandlerFunction() === "onDispatchEditSyncTrips_") ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger("onDispatchEditSyncTrips_").forSpreadsheet(ss).onEdit().create();
  return "installed onDispatchEditSyncTrips_ onEdit trigger";
}

function installWeeklyLogCompactionTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(tr) {
    if (tr.getHandlerFunction() === 'archiveAndCompactTripLog') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('archiveAndCompactTripLog').timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).create();
  activeSpreadsheet_().toast('Weekly LOG cleanup scheduled (Sundays around 3 AM).', 'Scheduled');
  return 'installed';
}

function uninstallDispatchSyncTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(tr){
    if (tr.getHandlerFunction() === "onDispatchEditSyncTrips_") { ScriptApp.deleteTrigger(tr); removed++; }
  });
  return "removed " + removed + " trigger(s)";
}

function applyCleanupNow() {
  return snapshotDispatchToLog(false, true);
}