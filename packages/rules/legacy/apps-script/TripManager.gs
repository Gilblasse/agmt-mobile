const TRIP_CACHE_TTL_SECONDS = 300;
const TRIP_DATE_INDEX_PREFIX_ = 'passengerTrips:dateRows:v1:';
const TRIP_METRICS_PROPERTY_ = 'passengerTrips:metrics:v1';
const SIDEBAR_DISPATCH_MAX_ROW_ = 100;

// ---- DISPATCH day window (V74) ---------------------------------------------
// The DISPATCH sheet is the drivers' working board, so it only carries the days
// they are actually driving: today and tomorrow. A trip saved for a later date is
// still created in full — it lives in LOG and shows on the Passenger Trips page —
// it just doesn't take a DISPATCH row until its day comes round. Rows already on
// the sheet are never touched by this; it only decides where new writes go.
const DISPATCH_WINDOW_DAYS_ = 1;
let DISPATCH_WINDOW_MEMO_ = null;

function dispatchWindowKeys_() {
  if (DISPATCH_WINDOW_MEMO_) return DISPATCH_WINDOW_MEMO_;
  const tz = Session.getScriptTimeZone();
  const keys = [];
  for (let i = 0; i <= DISPATCH_WINDOW_DAYS_; i += 1) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    keys.push(Utilities.formatDate(d, tz, 'yyyy-MM-dd'));
  }
  DISPATCH_WINDOW_MEMO_ = keys;
  return keys;
}

function isDispatchWindowDate_(value) {
  const key = Utils.formatDateString(value);
  return !!key && dispatchWindowKeys_().indexOf(key) >= 0;
}

function activeSpreadsheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss || SpreadsheetApp.openById('1oc_ac8XTmjcoUjy0l_vj6m5j4YYVFuRykybSHToDAME');
}

function tripCacheKey_(dateKey) {
  return 'passenger-trips:v4:' + (dateKey || 'undated');
}

function decodeTripsCacheValue_(raw) {
  if (raw == null) return null;
  if (raw.indexOf('GZ:') === 0) {
    const bytes = Utilities.base64Decode(raw.slice(3));
    return Utilities.ungzip(Utilities.newBlob(bytes, 'application/x-gzip')).getDataAsString();
  }
  return raw;
}

// Per-execution memo of the trips JSON per date, so the same date is not fetched from
// CacheService (a network hop) dozens of times inside one request. Cleared by
// invalidateTripsCache_ and refreshed by writeTripsCache_.
const SO_TRIPS_MEMO_ = {};

function readTripsCache_(dateKey) {
  try {
    const raw = decodeTripsCacheValue_(CacheService.getDocumentCache().get(tripCacheKey_(dateKey)));
    return raw == null ? null : JSON.parse(raw);
  } catch (e) {
    Logger.log('Trip cache read failed: ' + e.message);
    return null;
  }
}

function readTripsCacheRaw_(dateKey) {
  try {
    return decodeTripsCacheValue_(CacheService.getDocumentCache().get(tripCacheKey_(dateKey)));
  } catch (e) {
    return null;
  }
}

function tripsHash_(raw) {
  const str = String(raw || '');
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash * 33) ^ str.charCodeAt(i)) >>> 0;
  }
  return str.length + ':' + hash.toString(36);
}

// V120 SPEED: the board polls every few seconds, and each poll used to walk the
// whole day's JSON character by character to produce a hash it had already
// produced a moment earlier. The hash is now written once, when the day is
// written, and simply read back.
function tripsHashKey_(dateKey) { return tripCacheKey_(dateKey) + ':h'; }

function readTripsHashCached_(dateKey) {
  try { return CacheService.getDocumentCache().get(tripsHashKey_(dateKey)); }
  catch (e) { return null; }
}

function writeTripsCache_(dateKey, trips) {
  try {
    let payload = JSON.stringify(trips || []);
    SO_TRIPS_MEMO_[String(dateKey)] = payload;
    const hash = tripsHash_(payload);
    // V120: the cache limit is 100KB in BYTES, and this was counting characters.
    // One em-dash in a pricing note is three bytes, so a day could sail past the
    // check and then be rejected outright - losing both the day and its hash.
    let payloadBytes = payload.length;
    try { payloadBytes = Utilities.newBlob(payload).getBytes().length; } catch (eB) {}
    if (payloadBytes > 90000) {
      payload = 'GZ:' + Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(payload, 'text/plain')).getBytes());
    }
    const puts = {};
    puts[tripCacheKey_(dateKey)] = payload;
    puts[tripsHashKey_(dateKey)] = hash;
    CacheService.getDocumentCache().putAll(puts, TRIP_CACHE_TTL_SECONDS);
  } catch (e) {
    Logger.log('Trip cache write skipped: ' + e.message);
  }
}

function invalidateTripsCache_(dateKeys) {
  (dateKeys || []).forEach(function(k) { delete SO_TRIPS_MEMO_[String(k)]; delete SO_TRIPS_MEMO_[Utils.formatDateString(k)]; });
  const keys = Array.from(new Set((dateKeys || []).reduce(function(acc, dateKey) {
    acc.push(tripCacheKey_(dateKey));
    acc.push(tripsHashKey_(dateKey));
    return acc;
  }, [])));
  if (!keys.length) return;
  try {
    CacheService.getDocumentCache().removeAll(keys);
  } catch (e) {
    Logger.log('Trip cache invalidation failed: ' + e.message);
  }
}

function logDateKey_(value) {
  if (value === '' || value == null) return '';
  return Utils.formatDateString(value);
}

function findLatestLogRowIndex_(data, dateKey) {
  for (let i = data.length - 1; i >= 0; i -= 1) {
    if (logDateKey_(data[i][0]) === dateKey) return i;
  }
  return -1;
}

function tripDateIndexPropertyKey_(sheet) {
  return TRIP_DATE_INDEX_PREFIX_ + sheet.getSheetId();
}

function readTripDateRowIndex_(sheet) {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty(tripDateIndexPropertyKey_(sheet)) || '{}');
  } catch (e) {
    return {};
  }
}

function writeTripDateRowIndex_(sheet, index) {
  PropertiesService.getScriptProperties().setProperty(tripDateIndexPropertyKey_(sheet), JSON.stringify(index || {}));
}

function rebuildTripDateRowIndex_(sheet) {
  const lastRow = sheet.getLastRow();
  const index = {};
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function(row, offset) {
      index[logDateKey_(row[0])] = offset + 2;
    });
  }
  writeTripDateRowIndex_(sheet, index);
  return index;
}

function getIndexedLogRowForDate_(sheet, dateKey) {
  let index = readTripDateRowIndex_(sheet);
  let rowNum = Number(index[dateKey]) || 0;
  if (rowNum >= 2 && rowNum <= sheet.getLastRow() && logDateKey_(sheet.getRange(rowNum, 1).getValue()) === dateKey) {
    return rowNum;
  }
  index = rebuildTripDateRowIndex_(sheet);
  return Number(index[dateKey]) || 0;
}

function setIndexedLogRowForDate_(sheet, dateKey, rowNum) {
  const index = readTripDateRowIndex_(sheet);
  index[dateKey] = Number(rowNum) || 0;
  writeTripDateRowIndex_(sheet, index);
}

function clearTripDateRowIndex_(sheet) {
  PropertiesService.getScriptProperties().deleteProperty(tripDateIndexPropertyKey_(sheet));
}

function recordTripMetric_(operation, durationMs, details) {
  try {
    if ((Number(durationMs) || 0) < 1000 && Math.random() > 0.05) return;
    const props = PropertiesService.getScriptProperties();
    const metrics = JSON.parse(props.getProperty(TRIP_METRICS_PROPERTY_) || '{}');
    const current = metrics[operation] || { count: 0, totalMs: 0, maxMs: 0 };
    current.count += 1;
    current.totalMs += Number(durationMs) || 0;
    current.maxMs = Math.max(current.maxMs || 0, Number(durationMs) || 0);
    current.lastMs = Number(durationMs) || 0;
    current.lastAt = new Date().toISOString();
    current.lastDetails = details || {};
    metrics[operation] = current;
    props.setProperty(TRIP_METRICS_PROPERTY_, JSON.stringify(metrics));
  } catch (e) {
    Logger.log('Trip metric skipped: ' + e.message);
  }
}

function getTripPerformanceMetrics() {

  const raw = PropertiesService.getScriptProperties().getProperty(TRIP_METRICS_PROPERTY_) || '{}';
  const metrics = JSON.parse(raw);
  Object.keys(metrics).forEach(function(key) {
    metrics[key].averageMs = metrics[key].count ? Math.round(metrics[key].totalMs / metrics[key].count) : 0;
  });
  return metrics;
}

function resetTripPerformanceMetrics() {
  PropertiesService.getScriptProperties().deleteProperty(TRIP_METRICS_PROPERTY_);
  return true;
}

// ---- Concurrent-edit safety (V75) ------------------------------------------
// Builds the record to store from the one that is on the sheet right now, changing
// only the fields the dispatcher actually edited. Fields nobody edited keep whatever
// value they currently hold, so a save started ten minutes ago cannot undo a change
// somebody else made in the meantime. With no field list it falls back to the old
// whole-record behaviour, which keeps an already-open older page working.
function mergeTripFields_(stored, incoming, changedFields, forced) {
  if (!stored || Array.isArray(stored) || !Array.isArray(changedFields) || !changedFields.length) {
    return incoming;
  }
  const merged = Object.assign({}, stored);
  // Never writable from the trip form: the driver's own progress and the identity
  // fields. Listing them here means a stale page can never roll them back.
  // V120: `forced` is the server's own override list (e.g. a dispatcher pressing
  // CANCEL). Those are trusted and must be allowed past the guard, otherwise a
  // cancel was written to the board but never to the record.
  const PROTECTED = ['tripKeyID', 'id', 'status', 'statusAt', 'returnOf', 'recurringId'];
  const FORCED = Array.isArray(forced) ? forced : [];
  changedFields.forEach(function(field) {
    const name = String(field || '');
    if (!name) return;
    if (PROTECTED.indexOf(name) >= 0 && FORCED.indexOf(name) < 0) return;
    if (!Object.prototype.hasOwnProperty.call(incoming, name)) return;
    merged[name] = incoming[name];
  });
  merged.tripKeyID = stored.tripKeyID || incoming.tripKeyID;
  return merged;
}

// Minutes either side of a trip's time that count as "probably the same trip".
// Wide enough to catch a re-entry typed at a slightly different time, narrow
// enough to leave genuine back-to-back trips alone.
const NEAR_DUPLICATE_WINDOW_MIN_ = 20;

function tripMinutesOfDay_(value) {
  let s = String(value == null ? '' : value);
  // The sheet hands times back in several shapes (a Date, a fraction of a day, an
  // anchored ISO string). The app already has one normaliser for all of them.
  try {
    const norm = tripManager.normalizeTimeString(value);
    if (norm) s = String(norm);
  } catch (e) {}
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let h = Number(m[1]);
  const mins = Number(m[2]);
  if (!isFinite(h) || !isFinite(mins)) return null;
  const upper = s.toUpperCase();
  if (upper.indexOf('PM') >= 0 && h < 12) h += 12;
  if (upper.indexOf('AM') >= 0 && h === 12) h = 0;
  return h * 60 + mins;
}

// An existing trip for the same passenger on the same day, close enough in time to
// be the same journey typed twice. Returns the existing trip, or null.
function findNearDuplicateTrip_(trip) {
  try {
    if (!trip || !trip.date || !trip.passenger) return null;
    const when = tripMinutesOfDay_(trip.time);
    if (when === null) return null;
    const key = passengerCacheKey_(trip.passenger);
    if (!key) return null;
    const myKey = String(trip.tripKeyID || '');
    const list = tripManager.getTripsByDate(Utils.formatDateString(trip.date)) || [];
    for (let i = 0; i < list.length; i += 1) {
      const other = list[i];
      if (!other) continue;
      if (myKey && String(other.tripKeyID || '') === myKey) continue;
      if (passengerCacheKey_(other.passenger) !== key) continue;
      const theirs = tripMinutesOfDay_(other.time);
      if (theirs === null) continue;
      if (Math.abs(theirs - when) <= NEAR_DUPLICATE_WINDOW_MIN_) return other;
    }
    return null;
  } catch (e) { return null; }
}

// V102: a number that changes every time anything is written. Both apps ask for it
// every few seconds (a cache read, no sheet touched) and only fetch the board when
// it has moved, so a driver's tap shows up on the dispatcher's screen within a
// few seconds instead of on the next ten-second poll.
const BOARD_VERSION_KEY_ = 'board:version:v1';
function boardBump_() {
  try { CacheService.getScriptCache().put(BOARD_VERSION_KEY_, String(Date.now()), 21600); } catch (e) {}
}
// V116: the office's clock, for a board that cannot trust the machine it is
// running on. 'now' is the instant; 'clock' is that same instant written as a
// wall clock in the spreadsheet's timezone, in the shape the progress stamps
// arrive in - so a page can measure BOTH how far its clock is out and how far
// its timezone is out, and correct every stamp it is given.
function getServerClock() {
  let clock = '';
  try {
    const tz = activeSpreadsheet_().getSpreadsheetTimeZone();
    clock = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ss");
  } catch (e) {}
  return { now: Date.now(), clock: clock };
}

function getBoardVersion() {
  try { return String(CacheService.getScriptCache().get(BOARD_VERSION_KEY_) || ''); } catch (e) { return ''; }
}

// V120: the same bookkeeping as withTripsDocumentLock_, but it gives up rather
// than waiting, and does not announce a board change. For work that polls.
function withTripsDocumentTryLock_(waitMs, callback) {
  if (tripsLockDepth_ > 0) return callback();          // already inside the real lock
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(waitMs)) return null;
  tripsLockDepth_ += 1;
  try {
    return callback();
  } finally {
    tripsLockDepth_ -= 1;
    if (tripsLockDepth_ <= 0) {
      tripsLockDepth_ = 0;
      if (dispatchNeedsSort_) {
        dispatchNeedsSort_ = false;
        try { sortDispatchSheet_(); } catch (e) { Logger.log('sortDispatchSheet_: ' + ((e && e.message) || e)); }
      }
    }
    lock.releaseLock();
  }
}

function withTripsDocumentLock_(callback) {
  // V120: repair functions call snapshotDispatchToLog while already holding this
  // lock. The old code took a fresh lock each time and released it on the INNER
  // return, so the outer frame carried on writing with the board unlocked. Only
  // the outermost frame now takes and releases the lock.
  const outermost = tripsLockDepth_ === 0;
  const lock = outermost ? LockService.getDocumentLock() : null;
  if (lock) lock.waitLock(15000);
  tripsLockDepth_ += 1;
  try {
    return callback();
  } finally {
    tripsLockDepth_ -= 1;
    if (tripsLockDepth_ <= 0) {
      tripsLockDepth_ = 0;
      if (dispatchNeedsSort_) {
        dispatchNeedsSort_ = false;
        // A board that cannot be tidied is not a reason to fail the save.
        try { sortDispatchSheet_(); } catch (e) { Logger.log('sortDispatchSheet_: ' + ((e && e.message) || e)); }
      }
      boardBump_();
    }
    if (lock) lock.releaseLock();
  }
}

class TripManager {
  constructor(service, logManager) {
    this.service = service;
    this.logManager = logManager;
  }

  get logSheet() {
    // V120 SPEED: same as dispatchSheet - this was a fresh lookup on every access
    // and a single save touches it a dozen times.
    if (this._logSheetMemo) return this._logSheetMemo;
    this._logSheetMemo = this.service.getSheet('Dispatcher', 'LOG');
    return this._logSheetMemo;
  }

  getStandingOrderMap() {
    const cell = this.logSheet.getRange(1, 1);
    const val = cell.getValue();
    try {
      return val ? JSON.parse(val) : {};
    } catch (e) {
      return {};
    }
  }

  updateStandingOrderMap(map) {
    this.logSheet.getRange(1, 1).setValue(JSON.stringify(map || {}));
  }

  /**
   * Normalize time strings to ISO date anchored at 1899-12-30.
   * Accepts "HH:mm" or "HH:mm:ss" and returns
   * "1899-12-30THH:MM:SSZ".
   * If the value already looks like an ISO string, it is converted
   * to the same anchored date.
   * @param {string} timeStr
   * @return {string}
   */
  normalizeTimeString(timeValue) {
    if (timeValue === '' || timeValue === null || typeof timeValue === 'undefined') return '';

    if (timeValue instanceof Date && !isNaN(timeValue.getTime())) {
      const displayTime = Utilities.formatDate(
        timeValue,
        Session.getScriptTimeZone(),
        'HH:mm:ss'
      );
      return '1899-12-30T' + displayTime + 'Z';
    }

    if (typeof timeValue === 'number' && Number.isFinite(timeValue)) {
      const totalSeconds = Math.round(((timeValue % 1) + 1) % 1 * 86400) % 86400;
      const hh = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
      const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
      const ss = String(totalSeconds % 60).padStart(2, '0');
      return '1899-12-30T' + hh + ':' + mm + ':' + ss + 'Z';
    }

    const timeStr = String(timeValue).trim();
    const match = /^(d{1,2}):(d{2})(?::(d{2}))?$/.exec(timeStr);
    if (match) {
      const h = String(Number(match[1])).padStart(2, '0');
      const m = match[2];
      const s = match[3] || '00';
      return '1899-12-30T' + h + ':' + m + ':' + s + 'Z';
    }
    if (timeStr.includes('T')) {
      const d = new Date(timeStr);
      if (!isNaN(d)) {
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mm = String(d.getUTCMinutes()).padStart(2, '0');
        const ss = String(d.getUTCSeconds()).padStart(2, '0');
        return '1899-12-30T' + hh + ':' + mm + ':' + ss + 'Z';
      }
    }
    return timeStr;
  }

  testOnEdit() {
    const sheet = spreadsheetService.getSheet('Dispatcher', 'DISPATCH');
    const editedRow = 88;
    const editedCol = 21;
    const range = sheet.getRange(editedRow, editedCol);
    const e = { range, source: sheet.getParent() };
    this.onDispatchSheetEdit(e);
  }

  onDispatchSheetEdit(e) {
    try {
      const sheet = e.source.getSheetByName('DISPATCH');
      if (!sheet) return { updated: 0, skipped: 0 };

      const watchedCols = [
        COLUMN.DISPATCH.DATE + 1,
        COLUMN.DISPATCH.TIME + 1,
        COLUMN.DISPATCH.PASSENGER + 1,
        COLUMN.DISPATCH.TRANSPORT + 1,
        COLUMN.DISPATCH.PHONE + 1,
        COLUMN.DISPATCH.MEDICAID + 1,
        COLUMN.DISPATCH.INVOICE + 1,
        COLUMN.DISPATCH.PICKUP + 1,
        COLUMN.DISPATCH.TRIP_KEY_ID + 1,
        COLUMN.DISPATCH.DROPOFF + 1,
        COLUMN.DISPATCH.STATUS + 1,
        COLUMN.DISPATCH.VEHICLE + 1,
        COLUMN.DISPATCH.DRIVER + 1,
        COLUMN.DISPATCH.NOTES + 1,
        COLUMN.DISPATCH.RETURN_OF + 1,
        COLUMN.DISPATCH.RECURRING_ID + 1
      ];
      const editedRanges = e?.rangeList?.getRanges() || [e.range];
      const rowsToSync = new Set();

      editedRanges.filter(Boolean).forEach(function(range) {
        const firstCol = range.getColumn();
        const lastCol = range.getLastColumn();
        const touchesTripData = watchedCols.some(function(col) {
          return col >= firstCol && col <= lastCol;
        });
        if (!touchesTripData) return;

        const firstRow = Math.max(2, range.getRow());
        const lastRow = Math.min(SIDEBAR_DISPATCH_MAX_ROW_, range.getLastRow());
        for (let row = firstRow; row <= lastRow; row += 1) rowsToSync.add(row);
      });

      let updated = 0;
      let skipped = 0;
      let allTrips = null;
      rowsToSync.forEach(row => {
        const rowData = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
        const tripKeyID = String(rowData[COLUMN.DISPATCH.TRIP_KEY_ID] || '').trim();
        if (!tripKeyID) {
          skipped += 1;
          return;
        }

        const dispatchTrip = dispatchRowToTripObject(rowData);
        const dateKey = Utils.formatDateString(dispatchTrip.date || '');
        let existing = dateKey
          ? this.getTripsByDate(dateKey).find(function(trip) {
              return String(trip.tripKeyID || '') === tripKeyID;
            })
          : null;

        if (!existing) {
          if (allTrips === null) allTrips = this.getAllTrips();
          existing = allTrips.find(function(trip) {
            return String(trip.tripKeyID || '') === tripKeyID;
          });
        }
        if (!existing) {
          Logger.log('Trip key not found in Passenger Trips for Dispatch row ' + row + ': ' + tripKeyID);
          skipped += 1;
          return;
        }

        const merged = Object.assign({}, existing, dispatchTrip, {
          tripKeyID: tripKeyID,
          id: dispatchTrip.id || existing.id || '',
          date: dispatchTrip.date || existing.date
        });
        this.updateTripInLog(merged);
        updated += 1;
      });

      return { updated: updated, skipped: skipped };
    } catch (err) {
      Logger.log('Dispatch edit synchronization error: ' + err.message);
      return { updated: 0, skipped: 0, error: err.message };
    }
  }

  addTripToLog(trip) {
    const incoming = Array.isArray(trip) ? trip : [trip];
    const sheet = this.logSheet;
    const grouped = new Map();

    incoming.forEach(item => {
      if (!item) return;
      item.time = this.normalizeTimeString(item.time);
      if (!item.tripKeyID) item.tripKeyID = Utilities.getUuid();
      const dateKey = Utils.formatDateString(item.date || '');
      item.date = dateKey;
      if (!grouped.has(dateKey)) grouped.set(dateKey, []);
      grouped.get(dateKey).push(item);
    });

    grouped.forEach((items, dateKey) => {
      let rowNum = getIndexedLogRowForDate_(sheet, dateKey);
      let tripsMap = rowNum ? deserializeTripMap(sheet.getRange(rowNum, 2).getValue()) : new Map();
      items.forEach(item => tripsMap.set(item.tripKeyID, item));
      const json = serializeTripMap(tripsMap);
      if (rowNum) {
        sheet.getRange(rowNum, 2).setValue(json);
      } else {
        sheet.appendRow([dateKey, json]);
        rowNum = sheet.getLastRow();
        setIndexedLogRowForDate_(sheet, dateKey, rowNum);
      }
      const trips = Array.from(tripsMap.values()).filter(item => item && String(item.passenger || '').trim());
      writeTripsCache_(dateKey, trips);
      if (shouldMaintainTripIndexForLog_(sheet)) {
        items.forEach(item => upsertTripIndex_(item.tripKeyID, dateKey, rowNum, item.returnOf, item.id));
      }
    });
  }

  getTripsByDate(dateStr) {
    const startedAt = Date.now();
    const dateKey = Utils.formatDateString(dateStr || '');
    const memo = SO_TRIPS_MEMO_[dateKey];
    if (memo != null) {
      try { return JSON.parse(memo); } catch (e) { delete SO_TRIPS_MEMO_[dateKey]; }
    }
    const cached = readTripsCache_(dateKey);
    if (cached !== null) {
      SO_TRIPS_MEMO_[dateKey] = JSON.stringify(cached);
      recordTripMetric_('getTripsByDate', Date.now() - startedAt, { source: 'cache', date: dateKey, count: cached.length });
      return cached;
    }

    const sheet = this.logSheet;
    const rowNum = getIndexedLogRowForDate_(sheet, dateKey);
    const json = rowNum ? sheet.getRange(rowNum, 2).getValue() : '';
    const trips = json
      ? this.logManager.jsonToTrips(json).filter(item => item && String(item.passenger || '').trim())
      : [];
    writeTripsCache_(dateKey, trips);
    recordTripMetric_('getTripsByDate', Date.now() - startedAt, { source: 'date-index', date: dateKey, count: trips.length });
    return trips;
  }

  getTripById(encodedId, date) {
    const id = decodeURIComponent(encodedId);
    const allData = this.getTripsByDate(date);
    const row = allData.find(r => r.id === id);
    return row || {};
  }

  /**
   * Check if a trip already exists on the given date. Duplicates are
   * identified either by matching the full trip id or by matching a variant
   * that ignores the driver portion of the id.
   * @param {Object} trip Trip object to compare
   * @return {boolean} True if a duplicate exists
   */
  isDuplicateTrip(trip, excludeKey) {
    if (!trip || !trip.date) return false;
    const trips = this.getTripsByDate(Utils.formatDateString(trip.date));
    const altId = `|${Utils.formatDateString(trip.date)}|${trip.time}|${trip.passenger}|${trip.pickup}`;
    const skip = String(excludeKey || '');
    return trips.some(t => {
      if (skip && String(t.tripKeyID || '') === skip) return false;
      const matchAlt = `|${Utils.formatDateString(t.date)}|${t.time}|${t.passenger}|${t.pickup}`;
      return t.id === trip.id || matchAlt === altId;
    });
  }

  /**
   * Determine if the given trip conflicts with another trip for the same
   * driver at the same time on the same day.
   * @param {Object} trip Trip object to compare
   * @return {boolean} True if a conflict exists
   */
  hasDriverConflict(trip, excludeKey) {
    if (!trip || !trip.date || !trip.driver) return false;
    const dateKey = Utils.formatDateString(trip.date);
    const timeKey = this.normalizeTimeString(trip.time);
    const driver = trip.driver || '';
    const skip = String(excludeKey || '');
    const trips = this.getTripsByDate(dateKey);
    return trips.some(t => {
      if (skip && String(t.tripKeyID || '') === skip) return false;
      const tTime = this.normalizeTimeString(t.time);
      return tTime === timeKey && (t.driver || '') === driver;
    });
  }

  /**
   * Determine if the given trip conflicts with another trip for the same
   * passenger at the same time on the same day.
   * @param {Object} trip Trip object to compare
   * @return {boolean} True if a conflict exists
   */
  hasPassengerConflict(trip, excludeKey) {
    if (!trip || !trip.date || !trip.passenger) return false;
    const dateKey = Utils.formatDateString(trip.date);
    const timeKey = this.normalizeTimeString(trip.time);
    const passenger = (trip.passenger || '').toString().trim();
    const skip = String(excludeKey || '');
    const trips = this.getTripsByDate(dateKey);
    return trips.some(t => {
      if (skip && String(t.tripKeyID || '') === skip) return false;
      const tTime = this.normalizeTimeString(t.time);
      return (
        tTime === timeKey &&
        (t.passenger || '').toString().trim() === passenger
      );
    });
  }

  getAllTrips() {
    const sheet = this.logSheet;
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    const latestJsonByDate = new Map();
    data.forEach(row => {
      if (row[1]) latestJsonByDate.set(logDateKey_(row[0]), row[1]);
    });

    const all = [];
    latestJsonByDate.forEach(json => {
      try {
        all.push(...this.logManager.jsonToTrips(json));
      } catch (e) {
        Logger.log('Error reading trip JSON: ' + e.message);
      }
    });
    return all;
  }

  // changedFields, when given, is the list of fields the dispatcher actually edited.
  // Everything else is taken from the record as it stands right now, so a save can
  // never write back a value that was loaded minutes ago — another dispatcher's edit
  // and a driver's progress both survive. Called with no changedFields (an older page
  // still open, or an internal caller) it behaves exactly as it always did.
  updateTripInLog(trip, changedFields, overrides) {
    if (!trip || !trip.tripKeyID) return null;
    // V120: keys the server itself set are trusted, so mergeTripFields_ lets them
    // past the PROTECTED guard. Without this a dispatcher's CANCEL reached the
    // board but never the trip record.
    // V120: only these may be forced past PROTECTED. updateTripInLog is reachable
  // from the page, so an open list here would let a stale client rewrite a trip's
  // identity or relink it to a different journey.
  const FORCEABLE_ = ['status', 'statusAt', 'dispatchStatus'];
  const forcedKeys = overrides
    ? Object.keys(overrides).filter(function(k) { return FORCEABLE_.indexOf(k) >= 0; })
    : [];
    if (overrides) { trip = Object.assign({}, trip, overrides); }
    const sheet = this.logSheet;
    trip.time = this.normalizeTimeString(trip.time);

    let sourceRowNum = shouldMaintainTripIndexForLog_(sheet) ? getIndexedLogRowForTrip_(trip.tripKeyID) : 0;
    let sourceTripsMap = sourceRowNum ? deserializeTripMap(sheet.getRange(sourceRowNum, 2).getValue()) : new Map();

    if (!sourceTripsMap.has(trip.tripKeyID)) {
      const lastRow = sheet.getLastRow();
      const allData = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 2).getValues() : [];
      sourceRowNum = 0;
      for (let i = allData.length - 1; i >= 0; i -= 1) {
        const candidate = deserializeTripMap(allData[i][1]);
        if (candidate.has(trip.tripKeyID)) {
          sourceRowNum = i + 2;
          sourceTripsMap = candidate;
          break;
        }
      }
    }

    if (!sourceRowNum) {
      trip.date = Utils.formatDateString(trip.date || '');
      this.addTripToLog(trip);
      return trip;
    }

    const stored = sourceTripsMap.get(trip.tripKeyID);
    const merged = mergeTripFields_(stored, trip, changedFields, forcedKeys);
    const targetDateKey = Utils.formatDateString(merged.date || '');
    merged.date = targetDateKey;

    const sourceDateKey = logDateKey_(sheet.getRange(sourceRowNum, 1).getValue());
    if (sourceDateKey === targetDateKey) {
      sourceTripsMap.set(merged.tripKeyID, merged);
      sheet.getRange(sourceRowNum, 2).setValue(serializeTripMap(sourceTripsMap));
      writeTripsCache_(targetDateKey, Array.from(sourceTripsMap.values()).filter(item => item && String(item.passenger || '').trim()));
      if (shouldMaintainTripIndexForLog_(sheet)) upsertTripIndex_(merged.tripKeyID, targetDateKey, sourceRowNum, merged.returnOf, merged.id);
      return merged;
    }

    // V120: write the destination FIRST. If anything throws in between, the worst
    // case is the trip briefly existing on both days (which the next save or
    // snapshot resolves) rather than on neither, which was unrecoverable.
    let targetRowNum = getIndexedLogRowForDate_(sheet, targetDateKey);
    let targetTripsMap = targetRowNum ? deserializeTripMap(sheet.getRange(targetRowNum, 2).getValue()) : new Map();
    targetTripsMap.set(merged.tripKeyID, merged);
    if (targetRowNum) {
      sheet.getRange(targetRowNum, 2).setValue(serializeTripMap(targetTripsMap));
    } else {
      sheet.appendRow([targetDateKey, serializeTripMap(targetTripsMap)]);
      targetRowNum = sheet.getLastRow();
      setIndexedLogRowForDate_(sheet, targetDateKey, targetRowNum);
    }
    if (shouldMaintainTripIndexForLog_(sheet)) upsertTripIndex_(merged.tripKeyID, targetDateKey, targetRowNum, merged.returnOf, merged.id);
    SpreadsheetApp.flush();
    // Only now is it safe to take the trip off the day it came from.
    sourceTripsMap.delete(merged.tripKeyID);
    sheet.getRange(sourceRowNum, 2).setValue(serializeTripMap(sourceTripsMap));
    invalidateTripsCache_([sourceDateKey, targetDateKey]);
    return merged;
  }

  deleteTripFromLog(tripKeyID, date) {
    if (!tripKeyID) return;
    const sheet = this.logSheet;
    let rowNum = shouldMaintainTripIndexForLog_(sheet) ? getIndexedLogRowForTrip_(tripKeyID) : 0;
    const targetDateKey = Utils.formatDateString(date || '');
    if (!rowNum) rowNum = getIndexedLogRowForDate_(sheet, targetDateKey);
    let tripsMap = rowNum ? deserializeTripMap(sheet.getRange(rowNum, 2).getValue()) : new Map();

    if (!tripsMap.has(tripKeyID)) {
      const lastRow = sheet.getLastRow();
      const allData = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 2).getValues() : [];
      rowNum = 0;
      for (let i = allData.length - 1; i >= 0; i -= 1) {
        const candidate = deserializeTripMap(allData[i][1]);
        if (candidate.has(tripKeyID)) {
          rowNum = i + 2;
          tripsMap = candidate;
          break;
        }
      }
    }
    if (!rowNum || !tripsMap.has(tripKeyID)) return;

    const actualDateKey = logDateKey_(sheet.getRange(rowNum, 1).getValue());
    const tripToDelete = tripsMap.get(tripKeyID);
    tripsMap.delete(tripKeyID);
    const removedKeys = [tripKeyID];
    if (tripToDelete) {
      const originalId = tripToDelete.id;
      Array.from(tripsMap.entries()).forEach(([key, item]) => {
        if ((item.returnOf || '') === originalId) { tripsMap.delete(key); removedKeys.push(key); }
      });
    }
    sheet.getRange(rowNum, 2).setValue(serializeTripMap(tripsMap));
    if (shouldMaintainTripIndexForLog_(sheet)) removedKeys.forEach(key => removeTripIndexEntry_(key));
    invalidateTripsCache_([actualDateKey]);
  }

  deleteStandingOrderOnDates(recurringId, dates) {
    if (!recurringId || !Array.isArray(dates) || dates.length === 0) return;
    const sheet = this.logSheet;
    const normalizedDates = dates.map(d => Utils.formatDateString(d));

    const lastRow = sheet.getLastRow();
    const data = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 2).getValues() : [];
    const dateToRow = {};
    for (let i = 0; i < data.length; i++) {
      const d = data[i][0];
      if (!d) continue;
      const key = Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'yyyy-MM-dd');
      if (!dateToRow[key]) dateToRow[key] = i + 2;
    }

    normalizedDates.forEach(dateStr => {
      const rowIndex = dateToRow[dateStr];
      if (!rowIndex) return;
      const cell = sheet.getRange(rowIndex, 2);
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

    invalidateTripsCache_(normalizedDates);
    // One rule for switching a repeat off, shared with every other delete path: the
    // pattern goes when no trip is left carrying it. This used to keep its own copy of
    // the old "every date must be in the request" rule, which is the bug fixed in V76.
    soFinalizeStandingOrderDelete_(recurringId, normalizedDates);
  }
}


class SidebarTripService {
  constructor(service, manager) {
    this.service = service || spreadsheetService;
    this.manager = manager || tripManager;
  }

  get dispatchSheet() {
    // V120 SPEED: this is read six or more times in a single save, and each read
    // was a fresh lookup. The handle is valid for the whole request.
    if (this._dispatchSheetMemo) return this._dispatchSheetMemo;
    const sheet = this.service.getSheet('Dispatcher', 'DISPATCH');
    if (!sheet) throw new Error('DISPATCH sheet is missing.');
    this._dispatchSheetMemo = sheet;
    return sheet;
  }

  findDispatchRowByTripKey_(tripKeyID) {
    if (!tripKeyID) return 0;
    const sheet = this.dispatchSheet;
    const lastRow = Math.max(2, sheet.getLastRow());
    const match = sheet.getRange(2, COLUMN.DISPATCH.TRIP_KEY_ID + 1, lastRow - 1, 1)
      .createTextFinder(String(tripKeyID))
      .matchEntireCell(true)
      .findNext();
    return match ? match.getRow() : 0;
  }


  // PRODUCTION_DRIVER_PROGRESS_V12: status drives middle milestones; Dispatch In/Out supply edge timestamps.
  getActivity(tripKeyID) {
    const key = String(tripKeyID || '').trim();
    const empty = {
      found: false,
      tripKeyID: key,
      scheduledTime: '',
      driverStatus: '',
      pickupArrival: '',
      dropoffDeparture: ''
    };
    if (!key) return empty;

    const sheet = this.dispatchSheet;
    const lastAllowedRow = Math.min(
      SIDEBAR_DISPATCH_MAX_ROW_,
      sheet.getMaxRows(),
      sheet.getLastRow()
    );
    if (lastAllowedRow < 2) return empty;

    const match = sheet
      .getRange(2, COLUMN.DISPATCH.TRIP_KEY_ID + 1, lastAllowedRow - 1, 1)
      .createTextFinder(key)
      .matchEntireCell(true)
      .findNext();
    if (!match) return empty;

    // PRODUCTION_CACHED_ACTIVITY_FALLBACK_V13: keep this endpoint consistent with the polling cache.
    const values = sheet.getRange(
      match.getRow(),
      COLUMN.DISPATCH.TIME + 1,
      1,
      COLUMN.DISPATCH.COMPLETED_AT - COLUMN.DISPATCH.TIME + 1
    ).getDisplayValues()[0];
    const at = function(column) { return String(values[column - COLUMN.DISPATCH.TIME] || '').trim(); };

    return {
      found: true,
      tripKeyID: key,
      scheduledTime: at(COLUMN.DISPATCH.TIME),
      driverStatus: at(COLUMN.DISPATCH.STATUS),
      pickupArrival: at(COLUMN.DISPATCH.PICKUP_IN_AT) || at(COLUMN.DISPATCH.IN),
      pickupDeparture: at(COLUMN.DISPATCH.INTRANSIT_AT),
      dropoffArrival: at(COLUMN.DISPATCH.ARRIVED_AT),
      dropoffDeparture: at(COLUMN.DISPATCH.COMPLETED_AT) || at(COLUMN.DISPATCH.OUT)
    };
  }

  buildDispatchRowMaps_() {
    const sheet = this.dispatchSheet;
    const maxRows = sheet.getMaxRows();
    const lastAllowedRow = Math.min(maxRows, SIDEBAR_DISPATCH_MAX_ROW_);
    const keyToRow = new Map();
    const openRows = [];
    if (lastAllowedRow >= 2) {
      const data = sheet.getRange(2, COLUMN.DISPATCH.PASSENGER + 1, lastAllowedRow - 1,
        COLUMN.DISPATCH.TRIP_KEY_ID - COLUMN.DISPATCH.PASSENGER + 1).getDisplayValues();
      for (let i = 0; i < data.length; i += 1) {
        const passenger = String(data[i][0] || '').trim();
        const tripKey = String(data[i][COLUMN.DISPATCH.TRIP_KEY_ID - COLUMN.DISPATCH.PASSENGER] || '').trim();
        if (tripKey) keyToRow.set(tripKey, i + 2);
        else if (!passenger) openRows.push(i + 2);
      }
    }
    return { keyToRow: keyToRow, openRows: openRows };
  }

  findOpenDispatchRow_() {
    const sheet = this.dispatchSheet;
    const maxRows = sheet.getMaxRows();
    const lastAllowedRow = Math.min(maxRows, SIDEBAR_DISPATCH_MAX_ROW_);
    if (lastAllowedRow >= 2) {
      const data = sheet.getRange(2, COLUMN.DISPATCH.PASSENGER + 1, lastAllowedRow - 1,
        COLUMN.DISPATCH.TRIP_KEY_ID - COLUMN.DISPATCH.PASSENGER + 1).getDisplayValues();
      for (let i = 0; i < data.length; i += 1) {
        const passenger = String(data[i][0] || '').trim();
        const tripKey = String(data[i][COLUMN.DISPATCH.TRIP_KEY_ID - COLUMN.DISPATCH.PASSENGER] || '').trim();
        if (!passenger && !tripKey) return i + 2;
      }
    }

    if (maxRows >= SIDEBAR_DISPATCH_MAX_ROW_) return 0;

    const sourceRow = Math.max(2, maxRows);
    sheet.insertRowAfter(maxRows);
    const targetRow = maxRows + 1;
    const width = Math.min(32, sheet.getMaxColumns());
    const source = sheet.getRange(sourceRow, 1, 1, width);
    const target = sheet.getRange(targetRow, 1, 1, width);
    source.copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    source.copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
    source.copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
    return targetRow;
  }


  toDispatchDate_(value) {
    const key = Utils.formatDateString(value);
    const parts = key.split('-').map(Number);
    return parts.length === 3 && parts.every(Number.isFinite)
      ? new Date(parts[0], parts[1] - 1, parts[2])
      : '';
  }

  // Wipes what a recycled DISPATCH row would otherwise lend to its next trip: the
  // start time and the four driver stamps (plus IN/OUT/STATUS, which a driver can
  // overwrite). Only rows genuinely changing hands are passed in, so a driver's live
  // progress on their own row is never touched. Formulas are put back untouched.
  clearInheritedDispatchCells_(rows) {
    const list = (rows || []).filter(Boolean);
    if (!list.length) return 0;
    const sheet = this.dispatchSheet;
    const spans = dispatchInheritedSpans_();
    list.forEach(function(row) {
      spans.forEach(function(span) {
        const range = sheet.getRange(row, span[0], 1, span[1]);
        const formulas = range.getFormulasR1C1()[0];
        range.clearContent();
        formulas.forEach(function(f, i) { if (f) range.getCell(1, i + 1).setFormulaR1C1(f); });
      });
    });
    return list.length;
  }

  writeTripToDispatchRow_(row, trip, fresh) {
    const sheet = this.dispatchSheet;
    // V120 SPEED: the board is sorted by date then time. A save that changed
    // neither cannot have changed the order, so there is nothing to tidy. This
    // used to run a full board sort - three whole-sheet reads and several writes,
    // about a second, with the board locked - after every single save.
    if (fresh || !Array.isArray(trip.__changedFields) ||
        trip.__changedFields.indexOf('date') >= 0 || trip.__changedFields.indexOf('time') >= 0) {
      dispatchMarkForSort_();
    }
    if (fresh) this.clearInheritedDispatchCells_([row]);
    sheet.getRange(row, COLUMN.DISPATCH.DATE + 1).setValue(this.toDispatchDate_(trip.date));
    if (trip.startTime !== undefined) sheet.getRange(row, COLUMN.DISPATCH.START_TIME + 1).setValue(startTimeCellValue_(trip.startTime));
    sheet.getRange(row, COLUMN.DISPATCH.TIME + 1, 1, 3).setValues([[
      toTimeOnlySmart(trip.time, { returnMillis: false }),
      trip.passenger || '',
      // C, D, then E. E is the DISPATCHER's status column - the one the board's
      // status control writes and the one read back as dispatchStatus. It used to
      // be given the DRIVER's progress instead, so saving any edit to a trip wiped
      // a READY the dispatcher had set, and the rebuild from the board a moment
      // later wiped it from the record too. The driver's progress has its own
      // column (Q) and is not written from here at all.
      trip.dispatchStatus || ''
    ]]);
    sheet.getRange(row, COLUMN.DISPATCH.INVOICE + 1, 1, 3).setValues([[
      trip.invoice || '',
      trip.pickup || '',
      trip.tripKeyID || ''
    ]]);
    sheet.getRange(row, COLUMN.DISPATCH.DROPOFF + 1).setValue(trip.dropoff || '');
    sheet.getRange(row, COLUMN.DISPATCH.VEHICLE + 1).setValue(trip.vehicle || '');
    sheet.getRange(row, COLUMN.DISPATCH.DRIVER + 1).setValue(trip.driver || '');
    sheet.getRange(row, COLUMN.DISPATCH.NOTES + 1).setValue(trip.notes || '');
    sheet.getRange(row, COLUMN.DISPATCH.RETURN_OF + 1, 1, 2).setValues([[
      trip.returnOf || '',
      trip.recurringId || ''
    ]]);
    return row;
  }



  clearDispatchRowPreservingFormulas_(row) {
    dispatchMarkForSort_();
    const range = this.dispatchSheet.getRange(row, 1, 1, 32);
    const formulas = range.getFormulasR1C1()[0];
    range.clearContent();
    formulas.forEach(function(formula, offset) {
      if (formula) range.getCell(1, offset + 1).setFormulaR1C1(formula);
    });
    return row;
  }

  createRecurring(parentTrip, dates) {
    if (!parentTrip || !Array.isArray(parentTrip) || parentTrip.length < 2 ||
        !Array.isArray(dates) || !dates.length) {
      return { created: 0, dispatchRows: [] };
    }
    const t0 = Date.now();
    const made = standingOrderManager.createAcrossDatesFast(parentTrip, dates);
    const msLog = Date.now() - t0;
    const trips = Array.isArray(made) ? made.slice() : [];
    if (!trips.length) {
      // Older engine that returns nothing: fall back to reading the dates back.
      const recurringId = parentTrip[1][COLUMN.LOG.RECURRING_ID];
      dates.map(function(date) { return Utils.formatDateString(date); }).forEach(dateKey => {
        this.manager.getTripsByDate(dateKey).forEach(trip => {
          if (trip && trip.recurringId === recurringId) trips.push(trip);
        });
      });
    }
    const maps = this.buildDispatchRowMaps_();
    const pairs = [];
    let dispatchSkipped = 0;
    let dispatchDeferred = 0;
    trips.forEach(trip => {
      if (!isDispatchWindowDate_(trip.date)) { dispatchDeferred += 1; return; }
      let row = maps.keyToRow.get(String(trip.tripKeyID || '')) || 0;
      let freshRow = false;
      if (!row) { row = maps.openRows.shift() || this.findOpenDispatchRow_(); freshRow = !!row; }
      if (!row) {
        dispatchSkipped += 1;
        return;
      }
      pairs.push({ row: row, trip: trip, fresh: freshRow });
    });
    const t1 = Date.now();
    const rows = this.writeTripsToDispatchRows_(pairs);
    return { created: trips.length, dispatchRows: rows, dispatchSkipped: dispatchSkipped, dispatchDeferred: dispatchDeferred, ms: { log: msLog, maps: t1 - t0 - msLog, dispatch: Date.now() - t1 } };
  }

  // Writes many trips to DISPATCH with a handful of sheet calls instead of nine per trip.
  // Only the columns this app owns are touched (same cells as writeTripToDispatchRow_);
  // rows that sit next to each other are written together.
  writeTripsToDispatchRows_(pairs) {
    if (!pairs || !pairs.length) return [];
    dispatchMarkForSort_();
    this.clearInheritedDispatchCells_(pairs.filter(function(p) { return p && p.fresh; })
      .map(function(p) { return p.row; }));
    const sheet = this.dispatchSheet;
    const C = COLUMN.DISPATCH;
    const sorted = pairs.slice().sort((a, b) => a.row - b.row);
    const runs = [];
    sorted.forEach(p => {
      const last = runs[runs.length - 1];
      if (last && p.row === last.start + last.items.length) last.items.push(p);
      else runs.push({ start: p.row, items: [p] });
    });
    runs.forEach(run => {
      const n = run.items.length;
      const head = sheet.getRange(run.start, C.DATE + 1, n, 5); // A:E, read first so an unset start time keeps its cell
      const headVals = head.getValues();
      const blkA = [], blkB = [], blkC = [], blkD = [], blkE = [], blkF = [], blkG = [];
      run.items.forEach((p, i) => {
        const t = p.trip;
        const row = headVals[i];
        row[0] = this.toDispatchDate_(t.date);
        if (t.startTime !== undefined) row[1] = startTimeCellValue_(t.startTime);
        row[2] = toTimeOnlySmart(t.time, { returnMillis: false });
        row[3] = t.passenger || '';
        row[4] = t.dispatchStatus || '';   // E: dispatcher status, not driver progress
        blkA.push(row);
        blkB.push([t.invoice || '', t.pickup || '', t.tripKeyID || '']);
        blkC.push([t.dropoff || '']);
        blkD.push([t.vehicle || '']);
        blkE.push([t.driver || '']);
        blkF.push([t.notes || '']);
        blkG.push([t.returnOf || '', t.recurringId || '']);
      });
      head.setValues(blkA);
      sheet.getRange(run.start, C.INVOICE + 1, n, 3).setValues(blkB);
      sheet.getRange(run.start, C.DROPOFF + 1, n, 1).setValues(blkC);
      sheet.getRange(run.start, C.VEHICLE + 1, n, 1).setValues(blkD);
      sheet.getRange(run.start, C.DRIVER + 1, n, 1).setValues(blkE);
      sheet.getRange(run.start, C.NOTES + 1, n, 1).setValues(blkF);
      sheet.getRange(run.start, C.RETURN_OF + 1, n, 2).setValues(blkG);
    });
    return sorted.map(p => p.row);
  }

  deleteRecurring(recurringId, dates, requestedAll) {
    if (!recurringId || !Array.isArray(dates) || !dates.length) {
      return { deleted: 0, dispatchRows: [] };
    }
    const rid = String(recurringId);
    const dateKeys = dates.map(d => Utils.formatDateString(d)).filter((k, i, arr) => k && arr.indexOf(k) === i);
    const sheet = this.manager.logSheet;
    const lastRow = sheet.getLastRow();
    const colA = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues() : [];
    const rowsOf = {};
    colA.forEach((r, i) => { const k = logDateKey_(r[0]); if (k) (rowsOf[k] = rowsOf[k] || []).push(i + 2); });
    const removed = [];
    dateKeys.forEach(k => (rowsOf[k] || []).forEach(row => {
      const cell = sheet.getRange(row, 2);
      const json = cell.getValue();
      if (!json) return;
      let map;
      try { map = deserializeTripMap(json); } catch (e) { return; }
      let changed = false;
      Array.from(map.entries()).forEach(([id, trip]) => {
        if (trip && String(trip.recurringId || '') === rid) {
          map.delete(id);
          removed.push(trip);
          changed = true;
        }
      });
      if (changed) cell.setValue(serializeTripMap(map));
    }));
    invalidateTripsCache_(dateKeys);
    if (removed.length && shouldMaintainTripIndexForLog_(sheet)) soRemoveTripIndexEntries_(removed.map(t => t.tripKeyID));

    const clearedRows = [];
    if (removed.length) {
      const maps = this.buildDispatchRowMaps_();
      removed.forEach(t => {
        const row = maps.keyToRow.get(String(t.tripKeyID || '')) || 0;
        if (row) clearedRows.push(this.clearDispatchRowPreservingFormulas_(row));
      });
    }
    let patternState = 'skipped';
    if (requestedAll !== null) {
      const hint = Array.isArray(requestedAll) ? requestedAll.concat(dateKeys) : dateKeys;
      patternState = soFinalizeStandingOrderDelete_(rid, hint);
    }
    return {
      deleted: removed.length,
      dispatchRows: clearedRows,
      patternRemoved: patternState === 'removed',
      repeatStillActive: patternState === 'kept'
    };
  }

  delete(tripKeyID, date) {
    if (!tripKeyID) throw new Error('A tripKeyID is required to delete a sidebar trip.');
    const row = this.findDispatchRowByTripKey_(tripKeyID);
    // Note which repeat this trip belonged to before it goes, so deleting a standing
    // order one day at a time still switches the repeat off at the end.
    let rid = '';
    try {
      const before = this.manager.getTripsByDate(Utils.formatDateString(date)) || [];
      const found = before.filter(function(t) { return t && String(t.tripKeyID || '') === String(tripKeyID); })[0];
      rid = found ? String(found.recurringId || '') : '';
    } catch (e) {}
    this.manager.deleteTripFromLog(tripKeyID, date);
    if (row) this.clearDispatchRowPreservingFormulas_(row);
    let patternRemoved = false;
    if (rid) patternRemoved = soFinalizeStandingOrderDelete_(rid, [date]) === 'removed';
    return { deleted: true, dispatchRow: row || 0, patternRemoved: patternRemoved };
  }

  update(trip, changedFields) {
    if (!trip || !trip.tripKeyID) {
      throw new Error('A tripKeyID is required to update a sidebar trip.');
    }
    const saved = this.manager.updateTripInLog(trip, changedFields) || trip;
    // V120 SPEED: carried only as far as writeTripToDispatchRow_, so it can skip
    // the board sort when the order cannot have changed. Never stored.
    try { Object.defineProperty(saved, '__changedFields', { value: changedFields, enumerable: false, configurable: true }); } catch (e) {}
    let row = this.findDispatchRowByTripKey_(saved.tripKeyID);
    let freshRow = false;
    if (isDispatchWindowDate_(saved.date)) {
      // moved into today/tomorrow — put it on the board even if it wasn't there before
      if (!row) { row = this.findOpenDispatchRow_(); freshRow = !!row; }
      // the board is written from the merged record, never from the page's stale copy
      if (row) this.writeTripToDispatchRow_(row, saved, freshRow);
      return { updated: true, dispatchRow: row || 0, dispatchSkipped: row ? 0 : 1, trip: saved };
    }
    // moved out past tomorrow — leaving the old row behind would show a stale date
    if (row) this.clearDispatchRowPreservingFormulas_(row);
    return { updated: true, dispatchRow: 0, dispatchDeferred: true, trip: saved };
  }

  create(trips) {
    const incoming = (Array.isArray(trips) ? trips : [trips]).filter(Boolean);
    if (!incoming.length) return { created: 0, dispatchRows: [] };

    this.manager.addTripToLog(incoming);
    const maps = this.buildDispatchRowMaps_();
    const rows = [];
    let dispatchSkipped = 0;
    let dispatchDeferred = 0;
    incoming.forEach(trip => {
      if (!isDispatchWindowDate_(trip.date)) { dispatchDeferred += 1; return; }
      let row = maps.keyToRow.get(String(trip.tripKeyID || '')) || 0;
      let freshRow = false;
      if (!row) { row = maps.openRows.shift() || this.findOpenDispatchRow_(); freshRow = !!row; }
      if (!row) {
        dispatchSkipped += 1;
        return;
      }
      rows.push(this.writeTripToDispatchRow_(row, trip, freshRow));
    });
    return { created: incoming.length, dispatchRows: rows, dispatchSkipped: dispatchSkipped, dispatchDeferred: dispatchDeferred };
  }
}

const tripManager = new TripManager(spreadsheetService, logManager);
const sidebarTripService = new SidebarTripService(spreadsheetService, tripManager);

function addTripToLog(trip) {
  return withTripsDocumentLock_(() => tripManager.addTripToLog(trip));
}
// V120: a private-pay trip whose distance could not be looked up is stored with
// no price rather than a wrong one. Silently is not good enough - the dispatcher
// has to be told, or a trip goes out unbilled and nobody notices.
function unpricedCount_(trips) {
  return (Array.isArray(trips) ? trips : [trips]).filter(function(t) {
    return t && t.pricing && typeof t.pricing === 'object' && t.pricing.incomplete;
  }).length;
}

function addTripsFromSidebar(trips) {
  (Array.isArray(trips) ? trips : [trips]).filter(Boolean).forEach(function(trip) { assertDateNotSubmitted_(trip.date); });
  // V114: every leg priced on its own date and time, not the form's.
  try { repricePrivatePayTrips_(trips); } catch (e) { Logger.log('reprice on add: ' + ((e && e.message) || e)); }
  const unpriced = unpricedCount_(trips);
  const result = withTripsDocumentLock_(() => sidebarTripService.create(trips));
  if (unpriced && result && typeof result === 'object' && !Array.isArray(result)) result.unpriced = unpriced;
  try { const synced = syncPassengersFromTrips_(trips); if (result && typeof result === 'object' && !Array.isArray(result)) result.passengers = synced; } catch (err) {}
  try { (Array.isArray(trips) ? trips : [trips]).filter(Boolean).forEach(function(trip) { driverAssignmentAlert_(trip, '', ''); }); } catch (err) {}
  return result;
}
function createRecurringTripsFromSidebar(parentTrip, dates) {
  const allowedDates = filterUnsubmittedDates_(dates);
  if (!allowedDates.length) throw new Error('Those days have been submitted and are locked as history.');
  return withTripsDocumentLock_(() => sidebarTripService.createRecurring(parentTrip, allowedDates));
}
function updateTripFromSidebar(trip, changedFields) {
  if (trip) assertDateNotSubmitted_(trip.date);
  let oldDriver = '';
  let oldTime = '';
  let prevTrip = null;
  // V120: read the stored trip BEFORE re-pricing. It is what tells us whether
  // this save moved the journey, and what the price actually was beforehand -
  // neither of which can be learned from the page's own payload.
  try {
    if (trip) {
      const prev = (tripManager.getTripsByDate(trip.date) || []).find(function(tp) { return tp && String(tp.tripKeyID || '') === String(trip.tripKeyID || ''); });
      if (prev) { prevTrip = prev; oldDriver = String(prev.driver || ''); oldTime = String(prev.time || ''); }
    }
  } catch (err) {}
  // A save that also changes the date will not find the trip on its NEW day, so
  // look across the days the board covers before giving up. Without this, moving
  // a trip to another date and hitting a failed distance lookup in the same save
  // would clear a price that was perfectly good.
  if (!prevTrip && trip && trip.tripKeyID) {
    try {
      const want = String(trip.tripKeyID);
      dispatchWindowKeys_().forEach(function(dk) {
        if (prevTrip || dk === trip.date) return;
        const hit = (tripManager.getTripsByDate(dk) || []).find(function(tp) { return tp && String(tp.tripKeyID || '') === want; });
        if (hit) prevTrip = hit;
      });
    } catch (err) {}
  }
  const storedForPricing_ = {};
  if (prevTrip && prevTrip.tripKeyID) storedForPricing_[String(prevTrip.tripKeyID)] = prevTrip;
  try { repricePrivatePayTrips_([trip], storedForPricing_); } catch (e) { Logger.log('reprice on update: ' + ((e && e.message) || e)); }
  const unpricedOnUpdate_ = unpricedCount_([trip]);
  const result = withTripsDocumentLock_(() => sidebarTripService.update(trip, changedFields));
  if (unpricedOnUpdate_ && result && typeof result === 'object' && !Array.isArray(result)) result.unpriced = unpricedOnUpdate_;
  try { const synced = syncPassengersFromTrips_([trip]); if (result && typeof result === 'object' && !Array.isArray(result)) result.passengers = synced; } catch (err) {}
  try { driverAssignmentAlert_(trip, oldDriver, oldTime, prevTrip, changedFields); } catch (err) {}
  return result;
}
function deleteTripFromSidebar(tripKeyID, date) {
  assertDateNotSubmitted_(date);
  return withTripsDocumentLock_(() => sidebarTripService.delete(tripKeyID, date));
}
function deleteRecurringTripsFromSidebar(recurringId, dates) {
  const allowedDates = filterUnsubmittedDates_(dates);
  if (!allowedDates.length) throw new Error('Those days have been submitted and are locked as history.');
  const split = soSplitDates_(allowedDates);
  return withTripsDocumentLock_(function() {
    const finalNow = !split.later.length;
    const result = sidebarTripService.deleteRecurring(recurringId, split.near, finalNow ? split.all : null);
    let jobId = '';
    if (split.later.length) {
      jobId = Utilities.getUuid();
      soEnqueueLocked_({ id: jobId, kind: 'delete', recurringId: String(recurringId || ''), dates: split.later, requested: split.all, total: split.later.length, done: 0, tries: 0, createdAt: Date.now(), updatedAt: Date.now() });
    }
    const orphans = soSweepOrphanPatterns_();
    return {
      deleted: split.near.length,
      immediate: split.near.length,
      queued: split.later.length,
      jobId: jobId,
      result: result,
      tripsRemoved: (result && result.deleted) || 0,
      patternRemoved: !!(result && result.patternRemoved),
      repeatStillActive: !!(result && result.repeatStillActive),
      orphansCleared: orphans.length
    };
  });
}
function getTripActivity(tripKeyID) { return sidebarTripService.getActivity(tripKeyID); }
function getTripsByDate(dateStr) { return tripManager.getTripsByDate(dateStr); }
function getTripById(encodedId, date) { return tripManager.getTripById(encodedId, date); }
function getAllTrips() { return tripManager.getAllTrips(); }
function updateTripInLog(trip, changedFields, overrides) {
  // V120: the field list used to be dropped here, so onDispatchEditSyncTrips_
  // fell into mergeTripFields_'s whole-record path and erased every field that
  // lives only in the LOG (price, pricing, stop notes, milesOverride).
  return withTripsDocumentLock_(() => tripManager.updateTripInLog(trip, changedFields, overrides));
}
function deleteTripFromLog(id, date) {
  return withTripsDocumentLock_(() => tripManager.deleteTripFromLog(id, date));
}
function getStandingOrderMap() { return tripManager.getStandingOrderMap(); }
function updateStandingOrderMap(map) {
  return withTripsDocumentLock_(() => tripManager.updateStandingOrderMap(map));
}
function checkDuplicateTrip(trip) { return tripManager.isDuplicateTrip(trip); }
function checkDriverConflict(trip) { return tripManager.hasDriverConflict(trip); }
function checkPassengerConflict(trip) { return tripManager.hasPassengerConflict(trip); }

const TRIP_DATES_CHUNK_ROWS_ = 200;
// The same test getTripsByDate applies: a stored day counts only if it holds at least
// one trip with a real passenger name. A plain string scan, so 400 days of stored text
// can be checked without parsing 400 JSON blobs. Not global — /g would make .test stateful.
const TRIP_DATES_HAS_TRIP_RE_ = /"passenger"\s*:\s*"\s*[^"\s]/;

// Which days should get a dot on the dispatcher's date picker.
//
// This used to list every date that had a ROW in the LOG, which is not the same thing as
// a date that has trips: a day whose trips were all deleted keeps its row, and so kept
// its dot, and tapping it showed "No trips found for this date". Now a day has to
// actually contain a trip.
function getTripDatesInfo() {
  try {
    const cached = CacheService.getDocumentCache().get('passenger-trips:dates:v2');
    if (cached) return JSON.parse(cached);
  } catch (e) {}
  const sheet = tripManager.logSheet;
  const lastRow = sheet.getLastRow();
  const dates = [];
  if (lastRow >= 2) {
    // A date can appear more than once in the LOG; the app always treats the LAST row for
    // a date as the live one, so work out which rows those are before reading.
    const dateCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    const liveRow = {};
    for (let i = 0; i < dateCol.length; i++) {
      const k = logDateKey_(dateCol[i][0]);
      if (k) liveRow[k] = i + 2;
    }
    const keep = {};
    Object.keys(liveRow).forEach(function(k) { keep[liveRow[k]] = k; });
    for (let start = 2; start <= lastRow; start += TRIP_DATES_CHUNK_ROWS_) {
      const n = Math.min(TRIP_DATES_CHUNK_ROWS_, lastRow - start + 1);
      const block = sheet.getRange(start, 2, n, 1).getValues();
      for (let i = 0; i < n; i++) {
        const key = keep[start + i];
        if (!key) continue;
        if (TRIP_DATES_HAS_TRIP_RE_.test(String(block[i][0] || ''))) dates.push(key);
      }
    }
  }
  dates.sort();
  const info = { dates: dates, firstDate: dates.length ? dates[0] : '' };
  try {
    CacheService.getDocumentCache().put('passenger-trips:dates:v2', JSON.stringify(info), 120);
  } catch (e) {}
  return info;
}

const SUBMITTED_DATES_PROPERTY_ = 'passengerTrips:submittedDates:v1';

// V120 SPEED: this is a network read, and it happens on every poll from every
// open board. A day is submitted at most once, so a few seconds of staleness
// costs nothing and this saves one round trip per poll per tab.
let SUBMITTED_MEMO_ = null;
function isDateSubmittedCached_(dateKey) {
  const k = String(dateKey || '');
  if (!k) return false;
  if (SUBMITTED_MEMO_ && Object.prototype.hasOwnProperty.call(SUBMITTED_MEMO_, k)) return !!SUBMITTED_MEMO_[k];
  let map = null;
  try {
    const raw = CacheService.getDocumentCache().get('submitted-dates:v1');
    if (raw) map = JSON.parse(raw);
  } catch (e) { map = null; }
  if (!map) {
    map = getSubmittedDatesMap_();
    try { CacheService.getDocumentCache().put('submitted-dates:v1', JSON.stringify(map), 60); } catch (e) {}
  }
  SUBMITTED_MEMO_ = map;
  return !!map[k];
}

function getSubmittedDatesMap_() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty(SUBMITTED_DATES_PROPERTY_) || '{}');
  } catch (e) {
    return {};
  }
}

function isDateSubmitted_(dateKey) {
  if (!dateKey) return false;
  return !!getSubmittedDatesMap_()[dateKey];
}

function markDateSubmitted_(dateKey) {
  SUBMITTED_MEMO_ = null;
  try { CacheService.getDocumentCache().remove('submitted-dates:v1'); } catch (e) {}
  const map = getSubmittedDatesMap_();
  map[dateKey] = new Date().toISOString();
  PropertiesService.getScriptProperties().setProperty(SUBMITTED_DATES_PROPERTY_, JSON.stringify(map));
}

function assertDateNotSubmitted_(dateValue) {
  if (isDateSubmitted_(Utils.formatDateString(dateValue || ''))) {
    throw new Error('This day has been submitted and is locked as history.');
  }
}

function filterUnsubmittedDates_(dates) {
  return (dates || []).filter(function(d) { return !isDateSubmitted_(Utils.formatDateString(d)); });
}

function auditWorkbookCells() {
  const ss = activeSpreadsheet_();
  let total = 0;
  const report = ss.getSheets().map(function(sheet) {
    const cells = sheet.getMaxRows() * sheet.getMaxColumns();
    total += cells;
    return [sheet.getName(), sheet.getMaxRows(), sheet.getMaxColumns(), cells, sheet.getLastRow(), sheet.getLastColumn()];
  });
  report.sort(function(a, b) { return b[3] - a[3]; });
  Logger.log('TOTAL CELLS: ' + total);
  Logger.log(JSON.stringify(report));
  return { total: total, sheets: report };
}

function conflictDetail_(trip, kind) {
  try {
    const trips = tripManager.getTripsByDate(trip.date) || [];
    const norm = function(x) { return String(x || '').trim().toLowerCase(); };
    const match = trips.find(function(t) {
      if (String(t.tripKeyID || '') === String(trip.tripKeyID || '') && t.tripKeyID) return false;
      if (kind === 'driver') return norm(t.driver) && norm(t.driver) === norm(trip.driver);
      return norm(t.passenger) && norm(t.passenger) === norm(trip.passenger);
    });
    if (!match) return null;
    return { passenger: match.passenger || '', driver: match.driver || '', time: match.time || '' };
  } catch (e) { return null; }
}

// V120: a dispatcher cancelling from the board should take the linked return leg
// with it. A DRIVER cancelling from their phone should not: that return leg is
// often another driver's job, it is never checked against the tapping driver, and
// they would simply watch it vanish. This is the same function with the linked-leg
// step switched off.
function setTripQuickStatusSingle_(tripKeyID, value) {
  return setTripQuickStatus(tripKeyID, value, true);
}

function setTripQuickStatus(tripKeyID, value, singleLegOnly, dateKey) {
  // PRODUCTION_LINKED_TERMINAL_STATUS_V14: cancel/reassign both legs of an attached journey.
  const allowed = ['', 'READY', 'NOT CONFIRMED', 'REASSIGN', 'UPDATE TIME', 'COMPLETE', 'CANCEL', 'NO SHOW'];
  const v = String(value || '').toUpperCase().trim();
  if (allowed.indexOf(v) < 0) throw new Error('Unsupported status: ' + value);
  const todayKey = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  // V121: the day this change belongs to. Everything below used to be pinned to
  // today, so a status set while looking at any other date was written nowhere
  // and still reported as saved. A page that sends nothing still means today,
  // so an already-open older board keeps working exactly as it did.
  let dayKey = todayKey;
  try { dayKey = Utils.formatDateString(dateKey) || todayKey; } catch (e) { dayKey = todayKey; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dayKey))) dayKey = todayKey;
  assertDateNotSubmitted_(dayKey);
  const sheet = activeSpreadsheet_().getSheetByName('DISPATCH');
  if (!sheet) throw new Error('DISPATCH sheet not found.');
  const last = sheet.getLastRow();
  if (last < 2) throw new Error('No trips on the DISPATCH board.');

  const key = String(tripKeyID || '').trim();
  const dayTrips = tripManager.getTripsByDate(dayKey) || [];
  const selectedTrip = dayTrips.find(function(trip) {
    return String(trip && trip.tripKeyID || '').trim() === key;
  });
  const targetKeys = {};
  targetKeys[key] = true;

  if (!singleLegOnly && (v === 'CANCEL' || v === 'REASSIGN' || v === 'NOT CONFIRMED') && selectedTrip) {
    const selectedId = String(selectedTrip.id || '').trim();
    const returnOf = String(selectedTrip.returnOf || '').trim();
    dayTrips.forEach(function(trip) {
      if (!trip) return;
      const candidateKey = String(trip.tripKeyID || '').trim();
      const candidateId = String(trip.id || '').trim();
      const candidateReturnOf = String(trip.returnOf || '').trim();
      if (!candidateKey) return;
      const isOriginalForSelectedReturn = returnOf && (candidateId === returnOf || candidateKey === returnOf);
      const isReturnForSelectedOriginal = !returnOf && selectedId && (candidateReturnOf === selectedId || candidateReturnOf === key);
      const isSiblingReturn = returnOf && candidateReturnOf === returnOf;
      if ((v === 'NOT CONFIRMED') ? isReturnForSelectedOriginal : (isOriginalForSelectedReturn || isReturnForSelectedOriginal || isSiblingReturn)) targetKeys[candidateKey] = true;
    });
  }

  // AUTO_RESTORE_RETURN_V15: primary back from CANCEL / NOT CONFIRMED clears the auto-set status on its return leg.
  const restoreKeys = {};
  const restoreTriggers = ['', 'READY', 'UPDATE TIME', 'COMPLETE'];
  if (!singleLegOnly && restoreTriggers.indexOf(v) >= 0 && selectedTrip && !String(selectedTrip.returnOf || '').trim()) {
    const primaryId = String(selectedTrip.id || '').trim();
    dayTrips.forEach(function(trip) {
      if (!trip) return;
      const cKey = String(trip.tripKeyID || '').trim();
      const cReturnOf = String(trip.returnOf || '').trim();
      if (!cKey || !cReturnOf) return;
      if (cReturnOf !== primaryId && cReturnOf !== key) return;
      const cur = String(trip.dispatchStatus || '').toUpperCase().trim();
      if (cur === 'CANCEL' || cur === 'NOT CONFIRMED') restoreKeys[cKey] = true;
    });
  }
  // V120: this map of key -> row number is what every write below indexes into.
  // Reading it outside the lock meant a board re-sort finishing in between could
  // move the rows, and the status then landed on a different passenger's line.
  // It is now read inside the same lock that writes.
  const rowsByKey = {};
  let onBoard = false;

  const stamped = ['NO SHOW', 'CANCEL', 'REASSIGN'];
  const needsStamp = stamped.indexOf(v) >= 0;
  const stampCol = COLUMN.DISPATCH.STATUS_AT + 1;
  if (needsStamp && sheet.getMaxColumns() < stampCol) sheet.insertColumnsAfter(sheet.getMaxColumns(), stampCol - sheet.getMaxColumns());
  const canStamp = sheet.getMaxColumns() >= stampCol;
  if (canStamp && !String(sheet.getRange(1, stampCol).getDisplayValue() || '').trim()) sheet.getRange(1, stampCol).setValue('Status At');
  const stampValue = needsStamp ? new Date() : '';
  // V120: these board cells used to be written with no lock at all, so a status
  // could land in the middle of another dispatcher's save or a board re-sort.
  withTripsDocumentLock_(function() {
    const keys = sheet.getRange(2, COLUMN.DISPATCH.TRIP_KEY_ID + 1, Math.max(1, sheet.getLastRow() - 1), 1).getDisplayValues();
    keys.forEach(function(rowValue, index) {
      const rowKey = String(rowValue[0] || '').trim();
      if (rowKey) rowsByKey[rowKey] = index + 2;
    });
    // sidebar-only trips (not yet on the DISPATCH grid) update the LOG records below
    onBoard = !!rowsByKey[key];
    Object.keys(targetKeys).forEach(function(targetKey) {
      const row = rowsByKey[targetKey];
      if (!row) return;
      sheet.getRange(row, COLUMN.DISPATCH.TODAY + 1).setValue(v);
      if (canStamp) sheet.getRange(row, stampCol).setValue(stampValue);
    });
    Object.keys(restoreKeys).forEach(function(rKey) {
      const row = rowsByKey[rKey];
      if (!row) return;
      sheet.getRange(row, COLUMN.DISPATCH.TODAY + 1).setValue('');
      if (canStamp) sheet.getRange(row, stampCol).setValue('');
    });
    if (v === 'READY' && onBoard) sheet.getRange(rowsByKey[key], COLUMN.DISPATCH.TIME + 1).setValue(new Date());
    SpreadsheetApp.flush();
  });
  // V121: neither the board nor the day's record holds this trip, so the loops
  // below have nothing to write to. This used to return a clean success, and the
  // dispatcher watched the card change, tick, and then quietly go back.
  if (!onBoard && !dayTrips.some(function(t) { return String(t && t.tripKeyID || '').trim() === key; })) {
    return {
      ok: false,
      reason: 'notfound',
      status: v,
      boardWritten: false,
      message: 'That status was not saved - this trip is not on the dispatch board for ' + dayKey + '. Open the trip and set its status there.'
    };
  }
  if (onBoard) { try { snapshotDispatchToLog(false, true); } catch (e) {} }

  // Keep the stored trip records in step so the sidebar reflects this immediately.
  // V75: these rewrite the whole day's trip record, so they must hold the same lock
  // every other write path holds. Without it a driver tapping a step at the same
  // moment could drop an unrelated trip from the day.
  let recordFailure_ = '';  // V120: set when the board was written but the record was not
  const ttToRecord = [];   // V106: TRIP_TIMES rows to refresh once the lock is released
  try {
    const stampIso = needsStamp ? new Date() : '';
    withTripsDocumentLock_(function() {
      (tripManager.getTripsByDate(dayKey) || []).forEach(function(trip) {
        const tKey = String(trip && trip.tripKeyID || '').trim();
        if (!tKey) return;
        if (targetKeys[tKey]) {
          tripManager.updateTripInLog(trip, ['dispatchStatus', 'statusAt'], { dispatchStatus: v, statusAt: stampIso });
          ttToRecord.push(Object.assign({}, trip, { dispatchStatus: v, statusAt: stampIso }));
        } else if (restoreKeys[tKey]) {
          const ds = String(trip.status || '').toUpperCase().trim();
          const clearStatus = (ds === 'CANCEL' || ds === 'REASSIGN' || ds === 'NOT CONFIRMED');
          tripManager.updateTripInLog(trip, clearStatus ? ['dispatchStatus', 'statusAt', 'status'] : ['dispatchStatus', 'statusAt'],
            { dispatchStatus: '', statusAt: '', status: '' });
          ttToRecord.push(Object.assign({}, trip, { dispatchStatus: '', statusAt: '' }, clearStatus ? { status: '' } : {}));
        }
      });
    });
  } catch (e) {
    // V120: this used to be an empty catch, so the board showed the new status
    // while the trip record still said the old one, and the dispatcher was told
    // the change had saved. Throwing here would be just as wrong in the other
    // direction - the board HAS been written by this point - and a throw on this
    // path also reaches the driver app, where it jams that phone's queue. Report
    // exactly what happened and let the caller decide.
    Logger.log('setTripQuickStatus record: ' + ((e && e.message) || e));
    recordFailure_ = 'The board now shows ' + (v || 'no status') + ', but the trip record did not update. Please refresh and check it.';
  }
  ttToRecord.forEach(function(t) { tripTimesRecord_(t); });

  // A linked return may live only in the LOG when the 100-row Dispatch limit is full.
  if (v === 'CANCEL' || v === 'REASSIGN') {
    try {
      withTripsDocumentLock_(function() {
        dayTrips.forEach(function(trip) {
          const targetKey = String(trip && trip.tripKeyID || '').trim();
          if (!targetKeys[targetKey] || rowsByKey[targetKey]) return;
          tripManager.updateTripInLog(trip, ['status', 'dispatchStatus'], { status: v, dispatchStatus: v });
        });
      });
    } catch (e) {
      Logger.log('setTripQuickStatus linked: ' + ((e && e.message) || e));
      recordFailure_ = recordFailure_ || 'This trip was updated but its linked return leg was not. Please check the return trip.';
    }
  }

  if (v === 'CANCEL' || v === 'REASSIGN') {
    try {
      dayTrips.forEach(function(trip) {
        const aKey = String(trip && trip.tripKeyID || '').trim();
        if (aKey && targetKeys[aKey]) driverCancelAlert_(trip, v);
      });
    } catch (err) {}
  }

  if (recordFailure_) {
    // The board was written but the record was not. Say so plainly rather than
    // reporting a clean success or throwing after the fact.
    return { ok: false, reason: 'record', message: recordFailure_, status: v, boardWritten: true };
  }
  return { ok: true, status: v, linkedCount: Math.max(0, Object.keys(targetKeys).length - 1) };
}


function checkTripConflictsBatch(trips, overrideBlacklist, overrideNearDuplicate, excludeTripKeyID) { 
  const list = (Array.isArray(trips) ? trips : [trips]).filter(Boolean);
  const skipKey = String(excludeTripKeyID || '');
  if (list.length > 1) soPrewarmTripsCache_(list.map(function(t) { return t && t.date; }));
  if (!overrideBlacklist) {
    const blacklistLookup = getPassengerCacheLookup_(); // one sheet read for the whole batch
    for (let i = 0; i < list.length; i++) {
      const nm = list[i] && list[i].passenger;
      if (!nm) continue;
      const rec = blacklistLookup.get(passengerCacheKey_(nm));
      if (rec && rec.blacklisted) {
        return { ok: false, reason: 'blacklist', passenger: rec.displayName || nm, note: rec.blacklistReason || '' };
      }
    }
  }
  for (let i = 0; i < list.length; i++) {
    if (tripManager.isDuplicateTrip(list[i], skipKey)) return { ok: false, reason: 'duplicate', detail: conflictDetail_(list[i], 'passenger') };
  }
  for (let i = 0; i < list.length; i++) {
    if (tripManager.hasPassengerConflict(list[i], skipKey)) return { ok: false, reason: 'passenger', detail: conflictDetail_(list[i], 'passenger') };
  }
  for (let i = 0; i < list.length; i++) {
    if (tripManager.hasDriverConflict(list[i], skipKey)) return { ok: false, reason: 'driver', detail: conflictDetail_(list[i], 'driver') };
  }
  // Softer than the exact-match duplicate check above: the same passenger within
  // twenty minutes on the same day is usually the same trip entered twice, but it
  // is occasionally legitimate, so the dispatcher is asked rather than blocked.
  if (!overrideNearDuplicate) {
    for (let i = 0; i < list.length; i++) {
      const near = findNearDuplicateTrip_(list[i]);
      if (near) {
        return {
          ok: false,
          reason: 'near-duplicate',
          detail: {
            passenger: near.passenger || '',
            time: near.time || '',
            pickup: near.pickup || '',
            dropoff: near.dropoff || '',
            driver: near.driver || ''
          }
        };
      }
    }
  }
  // Nothing clashes outright. Can the driver actually get from one to the next?
  let plan = { warnings: [] };
  try { plan = checkTripPlan(list, skipKey); } catch (e) { Logger.log('checkTripPlan: ' + ((e && e.message) || e)); }
  return { ok: true, warnings: plan.warnings || [], checkedDays: plan.checkedDays, ofDays: plan.ofDays };
}

// ---- Standing order: the other days of the same order (V78) ----------------
// Used when a dispatcher saves one day of a standing order and wants the same change
// on the rest. Only today onward is offered: past days are history, and submitted
// days are locked anyway (they come back marked so the page can grey them out).
const SO_SPREAD_HORIZON_DAYS_ = 180;

function getStandingOrderTripsFrom(recurringId, fromDateKey, excludeTripKeyID) {
  const rid = String(recurringId || '');
  if (!rid) return [];
  const from = Utils.formatDateString(fromDateKey || '') || Utils.formatDateString(new Date());
  const skip = String(excludeTripKeyID || '');
  const seen = {};
  const add = function(d) {
    const k = Utils.formatDateString(d);
    if (k && k >= from) seen[k] = true;
  };
  let hasPattern = false;
  try {
    const so = (tripManager.getStandingOrderMap() || {})[rid];
    if (so && so.pattern) { hasPattern = true; decodeDatePattern(so.pattern).forEach(add); }
  } catch (e) {}
  // With a pattern, its own dates are where the trips are — one or two log rows, and
  // this runs while the dispatcher waits for a save. Only an old-style repeat id with
  // no pattern behind it needs the wider sweep, and that one is bounded.
  if (!hasPattern) {
    const horizon = new Date();
    horizon.setHours(0, 0, 0, 0);
    horizon.setDate(horizon.getDate() + SO_SPREAD_HORIZON_DAYS_);
    const until = Utilities.formatDate(horizon, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    try {
      (getTripDatesInfo().dates || []).forEach(function(d) {
        const k = Utils.formatDateString(d);
        if (k && k >= from && k <= until) seen[k] = true;
      });
    } catch (e) {}
  }
  const keys = Object.keys(seen).sort();
  if (!keys.length) return [];
  try { soPrewarmTripsCache_(keys); } catch (e) {}
  const submitted = getSubmittedDatesMap_() || {};
  const out = [];
  keys.forEach(function(k) {
    (tripManager.getTripsByDate(k) || []).forEach(function(t) {
      if (!t || String(t.recurringId || '') !== rid) return;
      if (skip && String(t.tripKeyID || '') === skip) return;
      out.push({
        tripKeyID: String(t.tripKeyID || ''),
        date: k,
        time: t.time || '',
        passenger: t.passenger || '',
        pickup: t.pickup || '',
        dropoff: t.dropoff || '',
        driver: t.driver || '',
        vehicle: t.vehicle || '',
        isReturn: !!String(t.returnOf || ''),
        locked: !!submitted[k]
      });
    });
  });
  return out;
}

// Applies the same handful of details to several trips of one standing order. Each
// trip is merged field by field exactly as a normal save is, so anything the
// dispatcher did not change on the others is left alone.
// V120: price and pricing must never be copied verbatim across days. A Saturday
// carries a weekend surcharge a Monday does not, so spreading Monday's figure
// silently under-billed every weekend in the series. The re-price after the
// spread sets each day's own correct price instead.
const SO_MASS_EDIT_BLOCKED_ = ['date', 'tripKeyID', 'id', 'status', 'statusAt', 'returnOf', 'recurringId', 'price', 'pricing'];
// Fields that mean the opposite thing on a return leg.
const SO_RETURN_LEG_SKIP_ = ['pickup', 'dropoff', 'time', 'startTime', 'pickupNotes', 'dropoffNotes'];

function applyStandingOrderEdit(recurringId, items, fields) {
  const rid = String(recurringId || '');
  const list = (Array.isArray(items) ? items : []).filter(function(x) { return x && x.tripKeyID && x.date; });
  const source = fields || {};
  const names = Object.keys(source).filter(function(n) { return SO_MASS_EDIT_BLOCKED_.indexOf(n) < 0; });
  const result = { updated: 0, skipped: 0, locked: 0, dispatchSkipped: 0, fields: names };
  if (!rid || !list.length || !names.length) return result;
  const apply = {};
  names.forEach(function(n) { apply[n] = source[n]; });
  // Grouped by day and written in batches: one log row read and written per day, one
  // read of the board, and the board rows written together. Doing it trip by trip cost
  // about fifteen seconds each, which is no use for a dozen days.
  const byDate = {};
  list.forEach(function(item) {
    const k = Utils.formatDateString(item.date);
    if (!k) { result.skipped += 1; return; }
    (byDate[k] = byDate[k] || []).push(String(item.tripKeyID));
  });
  const dateKeys = Object.keys(byDate).sort();
  if (!dateKeys.length) return result;
  return withTripsDocumentLock_(function() {
    const sheet = tripManager.logSheet;
    const lastRow = sheet.getLastRow();
    const colA = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues() : [];
    const rowOf = {};
    // V120: last row wins, matching every reader in this file. Taking the first
    // row sent the edit to an orphaned duplicate and reported it as saved.
    colA.forEach(function(r, i) { const k = logDateKey_(r[0]); if (k) rowOf[k] = i + 2; });
    const saved = [];
    dateKeys.forEach(function(dateKey) {
      const wanted = byDate[dateKey];
      if (isDateSubmitted_(dateKey)) { result.locked += wanted.length; return; }
      const rowNum = rowOf[dateKey];
      if (!rowNum) { result.skipped += wanted.length; return; }
      const cell = sheet.getRange(rowNum, 2);
      let map;
      try { map = deserializeTripMap(cell.getValue()); } catch (e) { result.skipped += wanted.length; return; }
      let changed = false;
      const beforeSpread = [];
      wanted.forEach(function(key) {
        const stored = map.get(key);
        if (stored && !Array.isArray(stored)) {
          // A shallow copy would share the pricing object with the merged trip,
          // so clearing the old distance below would clear it here too - and the
          // "keep the agreed price" fallback would lose the very figures it needs.
          beforeSpread.push(Object.assign({}, stored, {
            pricing: (stored.pricing && typeof stored.pricing === 'object') ? Object.assign({}, stored.pricing) : stored.pricing
          }));
        }
        // only ever touch a trip that really belongs to this repeat
        if (!stored || String(stored.recurringId || '') !== rid) { result.skipped += 1; return; }
        // V120: a return leg runs the other way round. Pushing the outbound's
        // pickup, drop-off, time or stop notes onto it turned it into a trip that
        // starts where it was meant to finish.
        const useNames = String(stored.returnOf || '')
          ? names.filter(function(n) { return SO_RETURN_LEG_SKIP_.indexOf(n) < 0; })
          : names;
        if (!useNames.length) { result.skipped += 1; return; }
        const merged = mergeTripFields_(stored, Object.assign({}, stored, apply), useNames);
        merged.date = dateKey;
        map.set(key, merged);
        saved.push(merged);
        result.updated += 1;
        changed = true;
      });
      if (!changed) return;
      // V120: a new address or time changes what the ride costs. Without this the
      // whole series kept the old price.
      try {
        const mine = [];
        map.forEach(function(t) { if (t && !Array.isArray(t) && String(t.recurringId || '') === rid) mine.push(t); });
        // V120: the stored snapshot carries the distance of the route the trip
        // used to take. Leaving it in place meant the re-price after an address
        // change quietly used the old mileage - so the fix did nothing.
        const moved = names.indexOf('pickup') >= 0 || names.indexOf('dropoff') >= 0;
        if (moved) mine.forEach(function(t) {
          if (t.pricing && typeof t.pricing === 'object') { delete t.pricing.miles; delete t.pricing.pickup; delete t.pricing.dropoff; }
        });
        // Hand over the trips as they were before this spread, so a re-price that
        // cannot reach the distance service keeps a price that is still right.
        const storedForSpread = {};
        beforeSpread.forEach(function(b) { if (b && b.tripKeyID) storedForSpread[String(b.tripKeyID)] = b; });
        if (mine.length) repricePrivatePayTrips_(mine, storedForSpread);
        result.unpriced = (result.unpriced || 0) + unpricedCount_(mine);
      } catch (e) { Logger.log('spread reprice: ' + ((e && e.message) || e)); }
      cell.setValue(serializeTripMap(map));
      writeTripsCache_(dateKey, Array.from(map.values()).filter(function(t) { return t && String(t.passenger || '').trim(); }));
    });
    if (!saved.length) return result;
    // now the board, in one read and a handful of writes
    try {
      const maps = sidebarTripService.buildDispatchRowMaps_();
      const open = maps.openRows.slice();
      const pairs = [];
      saved.forEach(function(t) {
        const key = String(t.tripKeyID || '');
        let row = maps.keyToRow.get(key) || 0;
        if (!isDispatchWindowDate_(t.date)) {
          // a later day belongs off the board; leaving a stale row would show a wrong date
          if (row) sidebarTripService.clearDispatchRowPreservingFormulas_(row);
          return;
        }
        let freshRow = false;
        if (!row) { row = open.shift() || 0; freshRow = !!row; }
        if (!row) { result.dispatchSkipped += 1; return; }
        pairs.push({ row: row, trip: t, fresh: freshRow });
      });
      if (pairs.length) sidebarTripService.writeTripsToDispatchRows_(pairs);
    } catch (e) {
      Logger.log('applyStandingOrderEdit board: ' + ((e && e.message) || e));
    }
    return result;
  });
}

// ---- One passenger's trips (V78) -------------------------------------------
// Everything upcoming plus the recent past, for the Passengers page. Reads only the
// log rows inside the window, through the same batched cache the rest of the app uses.
const PASSENGER_TRIPS_DEFAULT_DAYS_ = 90;

function getPassengerTrips(passengerName, days) {
  const key = passengerCacheKey_(passengerName);
  const out = { name: String(passengerName || ''), trips: [], from: '', days: 0, truncated: false };
  if (!key) return out;
  const tz = Session.getScriptTimeZone();
  const back = Math.max(0, Number(days) > 0 ? Number(days) : PASSENGER_TRIPS_DEFAULT_DAYS_);
  const today = Utils.formatDateString(new Date());
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - back);
  const from = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
  out.from = from;
  out.days = back;
  let all = [];
  try { all = (getTripDatesInfo().dates || []).slice(); } catch (e) { all = []; }
  const keys = all.filter(function(d) { return d && d >= from; }).sort();
  if (!keys.length) return out;
  try { soPrewarmTripsCache_(keys); } catch (e) {}
  const submitted = getSubmittedDatesMap_() || {};
  keys.forEach(function(k) {
    (tripManager.getTripsByDate(k) || []).forEach(function(t) {
      if (!t || passengerCacheKey_(t.passenger) !== key) return;
      out.trips.push({
        tripKeyID: String(t.tripKeyID || ''),
        date: k,
        time: t.time || '',
        startTime: t.startTime || '',
        passenger: t.passenger || '',
        pickup: t.pickup || '',
        dropoff: t.dropoff || '',
        driver: t.driver || '',
        vehicle: t.vehicle || '',
        transport: t.transport || '',
        notes: t.notes || '',
        dispatchStatus: t.dispatchStatus || '',
        status: t.status || '',
        recurringId: String(t.recurringId || ''),
        isReturn: !!String(t.returnOf || ''),
        past: k < today,
        locked: k < today || !!submitted[k]
      });
    });
  });
  out.earliestOnRecord = all.length ? all.sort()[0] : '';
  out.truncated = !!(out.earliestOnRecord && out.earliestOnRecord < from);
  return out;
}

// ---- One passenger's whole history (V80) -----------------------------------
// The Passengers page needs every trip a passenger has ever had: the calendar has to
// know which days to light up, and the search box has to look through all of them.
// Reading the LOG one day at a time would take far too long, so this reads the sheet
// in blocks and only unpacks the days whose text actually mentions the passenger.
const PT_HISTORY_CHUNK_ROWS_ = 200;

// The cheapest possible pre-filter: the longest plain word in the name (usually the
// surname). If a day's stored text doesn't contain it, that day cannot be theirs.
function ptHistoryNeedle_(name) {
  const tokens = String(name || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  let best = '';
  tokens.forEach(function(t) { if (t.length > best.length) best = t; });
  return best;
}

function ptHistoryRow_(t, dateKey, today, submitted) {
  return {
    tripKeyID: String(t.tripKeyID || ''),
    date: dateKey,
    time: t.time || '',
    startTime: t.startTime || '',
    passenger: t.passenger || '',
    phone: t.phone || '',
    medicaid: t.medicaid || '',
    invoice: t.invoice || '',
    transport: t.transport || '',
    pickup: t.pickup || '',
    dropoff: t.dropoff || '',
    vehicle: t.vehicle || '',
    driver: t.driver || '',
    notes: t.notes || '',
    pickupNotes: t.pickupNotes || '',
    dropoffNotes: t.dropoffNotes || '',
    status: t.status || '',
    dispatchStatus: t.dispatchStatus || '',
    // What the driver actually did, and when (V86). The trip page shows these read-only.
    pickupArrival: t.pickupArrival || t.in || '',
    pickupDeparture: t.pickupDeparture || '',
    dropoffArrival: t.dropoffArrival || '',
    dropoffDeparture: t.dropoffDeparture || t.out || '',
    statusAt: t.statusAt || '',
    // Enough to pair a trip with its other leg: a return leg's returnOf holds the
    // outbound trip's id OR its tripKeyID, so both have to travel with the row.
    id: String(t.id || ''),
    returnOf: String(t.returnOf || ''),
    recurringId: String(t.recurringId || ''),
    isReturn: !!String(t.returnOf || ''),
    past: dateKey < today,
    locked: dateKey < today || !!submitted[dateKey]
  };
}

function getPassengerTripHistory(passengerName) {
  const key = passengerCacheKey_(passengerName);
  const out = { name: String(passengerName || ''), trips: [], orders: {}, full: true, scannedRows: 0, readRows: 0, ms: 0 };
  if (!key) return out;
  const started = new Date().getTime();
  const sheet = tripManager.logSheet;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return out;
  const today = Utils.formatDateString(new Date());
  const submitted = getSubmittedDatesMap_() || {};
  const needle = ptHistoryNeedle_(passengerName);

  // A date can appear more than once in the LOG; the app always treats the last row
  // for a date as the live one, so work out which rows those are before reading.
  const dateCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const liveRow = {};
  for (let i = 0; i < dateCol.length; i++) {
    const k = logDateKey_(dateCol[i][0]);
    if (k) liveRow[k] = i + 2;
  }
  const keep = {};
  Object.keys(liveRow).forEach(function(k) { keep[liveRow[k]] = k; });
  out.scannedRows = dateCol.length;

  for (let start = 2; start <= lastRow; start += PT_HISTORY_CHUNK_ROWS_) {
    const n = Math.min(PT_HISTORY_CHUNK_ROWS_, lastRow - start + 1);
    const block = sheet.getRange(start, 2, n, 1).getValues();
    for (let i = 0; i < n; i++) {
      const dateKey = keep[start + i];
      if (!dateKey) continue;
      out.readRows += 1;
      const json = String(block[i][0] || '');
      if (!json) continue;
      if (needle && json.toLowerCase().indexOf(needle) < 0) continue;
      let trips = [];
      try { trips = tripManager.logManager.jsonToTrips(json) || []; } catch (e) { continue; }
      for (let j = 0; j < trips.length; j++) {
        const t = trips[j];
        if (!t || passengerCacheKey_(t.passenger) !== key) continue;
        out.trips.push(ptHistoryRow_(t, dateKey, today, submitted));
      }
    }
  }
  out.trips.sort(function(a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return String(a.time || '') < String(b.time || '') ? -1 : 1;
  });
  try { out.orders = soTitlesForTrips_(out.trips); } catch (e) { out.orders = {}; }
  out.ms = new Date().getTime() - started;
  return out;
}

// ---- Removing passengers (V81) ----------------------------------------------
// Deleting a passenger never touches a trip. Only their row on the PASSENGERS sheet
// goes, and a copy of that row is parked in a hidden bin for three days first, so a
// mistake can be undone. The bin prunes itself on every delete.
const PASSENGER_TRASH_SHEET_ = 'PASSENGER_TRASH';
const PASSENGER_TRASH_DAYS_ = 3;
const PASSENGER_TRASH_HEADERS_ = ['Deleted at', 'Deleted by'].concat(PASSENGERS_HEADERS_);

function passengerTrashSheet_() {
  const ss = activeSpreadsheet_();
  let sheet = ss.getSheetByName(PASSENGER_TRASH_SHEET_);
  if (!sheet) {
    sheet = ss.insertSheet(PASSENGER_TRASH_SHEET_);
    sheet.getRange(1, 1, 1, PASSENGER_TRASH_HEADERS_.length).setValues([PASSENGER_TRASH_HEADERS_]).setFontWeight('bold');
    try { sheet.hideSheet(); } catch (e) {}
  }
  return sheet;
}

// Delete a set of row numbers from the bottom up, in contiguous runs.
function deleteSheetRows_(sheet, rowNumbers) {
  const rows = (rowNumbers || []).slice().sort(function(a, b) { return b - a; });
  let run = [];
  const flush = function() {
    if (!run.length) return;
    sheet.deleteRows(run[run.length - 1], run.length);
    run = [];
  };
  rows.forEach(function(row) {
    if (run.length && run[run.length - 1] !== row + 1) flush();
    run.push(row);
  });
  flush();
  return rows.length;
}

function prunePassengerTrash_() {
  try {
    const sheet = passengerTrashSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return 0;
    const stamps = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    const cutoff = new Date().getTime() - PASSENGER_TRASH_DAYS_ * 86400000;
    const stale = [];
    stamps.forEach(function(r, i) {
      const raw = r[0];
      const t = (raw && raw.getTime) ? raw.getTime() : Date.parse(String(raw || ''));
      if (!t || t < cutoff) stale.push(i + 2);
    });
    if (!stale.length) return 0;
    return deleteSheetRows_(sheet, stale);
  } catch (e) {
    Logger.log('prunePassengerTrash_: ' + ((e && e.message) || e));
    return 0;
  }
}

// How many trips does each of these passengers still have today or later? Only the
// log rows from today onward are read, so this stays quick.
function getPassengerUpcomingCounts(names) {
  const out = {};
  const byKey = {};
  (names || []).forEach(function(n) {
    const k = passengerCacheKey_(n);
    if (!k) return;
    out[String(n)] = 0;
    if (!byKey[k]) byKey[k] = String(n);
  });
  if (!Object.keys(byKey).length) return out;
  const today = Utils.formatDateString(new Date());
  let all = [];
  try { all = (getTripDatesInfo().dates || []).slice(); } catch (e) { all = []; }
  const dates = all.filter(function(d) { return d && d >= today; }).sort();
  if (!dates.length) return out;
  try { soPrewarmTripsCache_(dates); } catch (e) {}
  dates.forEach(function(d) {
    (tripManager.getTripsByDate(d) || []).forEach(function(t) {
      const k = passengerCacheKey_(t && t.passenger);
      if (k && byKey[k]) out[byKey[k]] += 1;
    });
  });
  return out;
}

// ---- A deleted passenger's trips go too (V82) --------------------------------
// Only today onward. Trips before today are the record the invoices and payroll are
// read from, so they stay. Days already marked Submitted are left alone and counted
// back, because changing a day that has been sent on is what causes billing disputes.
const PAX_TRIP_FIRST_BATCH_ = 2; // days cleared while the dispatcher waits

// Which days from today on actually hold a trip for one of these passengers?
function paxFutureTripDates_(passengerKeys) {
  const want = {};
  (passengerKeys || []).forEach(function(k) { if (k) want[k] = true; });
  const out = { dates: [], locked: [] };
  if (!Object.keys(want).length) return out;
  const today = Utils.formatDateString(new Date());
  let all = [];
  try { all = (getTripDatesInfo().dates || []).slice(); } catch (e) { all = []; }
  const dates = all.filter(function(d) { return d && d >= today; }).sort();
  if (!dates.length) return out;
  try { soPrewarmTripsCache_(dates); } catch (e) {}
  dates.forEach(function(d) {
    const hit = (tripManager.getTripsByDate(d) || []).some(function(t) {
      return t && want[passengerCacheKey_(t.passenger)];
    });
    if (!hit) return;
    if (isDateSubmitted_(d)) out.locked.push(d); else out.dates.push(d);
  });
  return out;
}

// The same batched shape as deleteRecurring, matching on the passenger instead of the
// repeat id: one read of the LOG date column, then one write per day that changed.
// Caller must hold the trips document lock.
function paxDeleteTripsOnDates_(passengerKeys, dates) {
  const want = {};
  (passengerKeys || []).forEach(function(k) { if (k) want[k] = true; });
  const dateKeys = (dates || []).map(function(d) { return Utils.formatDateString(d); })
    .filter(function(k, i, a) { return k && a.indexOf(k) === i; });
  const out = { deleted: 0, dispatchRows: [], rids: [], dates: dateKeys };
  if (!Object.keys(want).length || !dateKeys.length) return out;
  const sheet = tripManager.logSheet;
  const lastRow = sheet.getLastRow();
  const colA = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues() : [];
  const rowsOf = {};
  colA.forEach(function(r, i) { const k = logDateKey_(r[0]); if (k) (rowsOf[k] = rowsOf[k] || []).push(i + 2); });
  const removed = [];
  dateKeys.forEach(function(k) {
    (rowsOf[k] || []).forEach(function(row) {
      const cell = sheet.getRange(row, 2);
      const json = cell.getValue();
      if (!json) return;
      let map;
      try { map = deserializeTripMap(json); } catch (e) { return; }
      let changed = false;
      Array.from(map.entries()).forEach(function(pair) {
        const trip = pair[1];
        if (trip && want[passengerCacheKey_(trip.passenger)]) {
          map.delete(pair[0]);
          removed.push(trip);
          changed = true;
        }
      });
      if (changed) cell.setValue(serializeTripMap(map));
    });
  });
  invalidateTripsCache_(dateKeys);
  if (removed.length && shouldMaintainTripIndexForLog_(sheet)) {
    soRemoveTripIndexEntries_(removed.map(function(t) { return t.tripKeyID; }));
  }
  if (removed.length) {
    const maps = sidebarTripService.buildDispatchRowMaps_();
    removed.forEach(function(t) {
      const row = maps.keyToRow.get(String(t.tripKeyID || '')) || 0;
      if (row) out.dispatchRows.push(sidebarTripService.clearDispatchRowPreservingFormulas_(row));
    });
  }
  const rids = {};
  removed.forEach(function(t) { const r = String(t.recurringId || ''); if (r) rids[r] = true; });
  out.rids = Object.keys(rids);
  out.deleted = removed.length;
  return out;
}

// Clears the first couple of days straight away and hands the rest to the same
// background worker the standing orders use, so the dispatcher gets control back.
function paxRemoveFutureTrips_(passengerKeys, out) {
  const found = paxFutureTripDates_(passengerKeys);
  out.tripDates = found.dates.length;
  out.tripDatesLocked = found.locked.length;
  out.tripsDeleted = 0;
  if (!found.dates.length) return out;
  const near = found.dates.slice(0, PAX_TRIP_FIRST_BATCH_);
  const later = found.dates.slice(PAX_TRIP_FIRST_BATCH_);
  const job = withTripsDocumentLock_(function() {
    const first = paxDeleteTripsOnDates_(passengerKeys, near);
    out.tripsDeleted = first.deleted;
    if (!later.length) {
      first.rids.forEach(function(rid) { soFinalizeStandingOrderDelete_(rid, found.dates); });
      return null;
    }
    const j = {
      id: Utilities.getUuid(),
      kind: 'paxdel',
      keys: passengerKeys.slice(),
      names: (out.deleted || []).slice(),
      dates: later,
      requested: found.dates.slice(),
      rids: first.rids,
      deleted: first.deleted,
      total: found.dates.length,
      done: near.length,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    soEnqueueLocked_(j);
    return j;
  });
  if (job) { out.jobId = job.id; out.queued = later.length; out.immediate = near.length; }
  return out;
}

function deletePassengersFromDirectory(names) {
  const byKey = {};
  (names || []).forEach(function(n) {
    const k = passengerCacheKey_(n);
    if (k && !byKey[k]) byKey[k] = String(n);
  });
  const wanted = Object.keys(byKey);
  if (!wanted.length) throw new Error('No passenger was selected.');
  const result = withPassengersLock_(function() {
    const out = { deleted: [], missing: [], trashed: 0, pruned: 0 };
    const sheet = ensurePassengersHeaders_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      wanted.forEach(function(k) { out.missing.push(byKey[k]); });
      return out;
    }
    const width = PASSENGERS_HEADERS_.length;
    const block = sheet.getRange(2, 1, lastRow - 1, width).getDisplayValues();
    const rows = [];
    const payload = [];
    const found = {};
    const stamp = new Date();
    const who = currentDispatcherLabel_();
    for (let i = 0; i < block.length; i++) {
      const k = passengerCacheKey_(block[i][0] || block[i][1]);
      if (!k || !byKey[k]) continue;
      found[k] = true;
      rows.push(i + 2);
      payload.push([stamp, who].concat(block[i]));
      out.deleted.push(String(block[i][1] || byKey[k]));
    }
    wanted.forEach(function(k) { if (!found[k]) out.missing.push(byKey[k]); });
    if (!rows.length) return out;
    // The bin is written before anything is removed, so a failure half way through
    // can only ever leave an extra copy, never lose one.
    const trash = passengerTrashSheet_();
    trash.getRange(trash.getLastRow() + 1, 1, payload.length, PASSENGER_TRASH_HEADERS_.length).setValues(payload);
    out.trashed = payload.length;
    deleteSheetRows_(sheet, rows);
    invalidateFormOptionsCache_();
    out.pruned = prunePassengerTrash_();
    return out;
  });
  // The passenger list is done and its lock released; now clear the trips they still
  // have from today on. This is deliberately outside the passengers lock so a long
  // trip clear-out cannot hold up a colleague saving a different passenger.
  if (result.deleted.length) {
    try {
      paxRemoveFutureTrips_(result.deleted.map(passengerCacheKey_), result);
    } catch (e) {
      result.tripError = String((e && e.message) || e);
      Logger.log('paxRemoveFutureTrips_: ' + result.tripError);
    }
  }
  return result;
}

// Puts a passenger back from the bin. Not wired to a button — it is here so a
// mistake within the three days can be undone without retyping anything.
function restorePassengersFromTrash(names) {
  const byKey = {};
  (names || []).forEach(function(n) {
    const k = passengerCacheKey_(n);
    if (k && !byKey[k]) byKey[k] = String(n);
  });
  const wanted = Object.keys(byKey);
  if (!wanted.length) throw new Error('No passenger was named.');
  return withPassengersLock_(function() {
    const out = { restored: [], missing: [], skipped: [] };
    const trash = passengerTrashSheet_();
    const lastRow = trash.getLastRow();
    if (lastRow < 2) {
      wanted.forEach(function(k) { out.missing.push(byKey[k]); });
      return out;
    }
    const width = PASSENGER_TRASH_HEADERS_.length;
    const block = trash.getRange(2, 1, lastRow - 1, width).getDisplayValues();
    const sheet = ensurePassengersHeaders_();
    const live = {};
    const liveLast = sheet.getLastRow();
    if (liveLast >= 2) {
      sheet.getRange(2, 1, liveLast - 1, 2).getDisplayValues().forEach(function(r) {
        const k = passengerCacheKey_(r[0] || r[1]);
        if (k) live[k] = true;
      });
    }
    const add = [];
    const used = {};
    // walk backwards so the most recent copy of a name wins
    for (let i = block.length - 1; i >= 0; i--) {
      const row = block[i].slice(2);
      const k = passengerCacheKey_(row[0] || row[1]);
      if (!k || !byKey[k] || used[k]) continue;
      used[k] = true;
      if (live[k]) { out.skipped.push(byKey[k]); continue; }
      add.push(row);
      out.restored.push(String(row[1] || byKey[k]));
    }
    wanted.forEach(function(k) { if (!used[k]) out.missing.push(byKey[k]); });
    if (!add.length) return out;
    sheet.getRange(sheet.getLastRow() + 1, 1, add.length, PASSENGERS_HEADERS_.length).setValues(add);
    sortPassengersSheet_();
    invalidateFormOptionsCache_();
    return out;
  });
}

// V120 ------------------------------------------------------------------------
// A LOG row array has no slot for the fields that live only inside the trip
// record: the price, the pricing breakdown, the private-pay flag, the stop notes,
// the deadhead and the mileage override. Standing orders were built from that row
// array, so every repeat saved with no price at all. The dispatcher's own values
// now travel alongside the row and are stamped onto each created trip.
// price and pricing are deliberately NOT here. A Saturday carries a weekend
// surcharge a Monday does not, so copying the first day's figure across the series
// would under-bill every one of them. What travels is everything the quote is
// BUILT from; each day is then quoted on its own date by repricePrivatePayTrips_.
const SO_EXTRA_FIELDS_ = ['privatePay', 'milesOverride', 'deadheadMiles', 'pickupNotes', 'dropoffNotes', 'startTime'];

function soCleanExtras_(extras) {
  const out = {};
  if (!extras || typeof extras !== 'object') return out;
  SO_EXTRA_FIELDS_.forEach(function(f) {
    if (Object.prototype.hasOwnProperty.call(extras, f) && extras[f] !== undefined) out[f] = extras[f];
  });
  return out;
}

// Stamp the extras onto every trip of this repeat on these days, then re-price.
// Caller must already hold the trips document lock.
function soApplyExtrasLocked_(recurringId, extras, dateKeys) {
  const rid = String(recurringId || '');
  const keys = (dateKeys || []).map(function(d) { return Utils.formatDateString(d); }).filter(Boolean);
  const clean = soCleanExtras_(extras);
  if (!rid || !keys.length || !Object.keys(clean).length) return 0;
  let touched = 0;
  let unpriced = 0;
  const sheet = tripManager.logSheet;
  keys.forEach(function(dateKey) {
    const rowNum = getIndexedLogRowForDate_(sheet, dateKey);
    if (!rowNum) return;
    const cell = sheet.getRange(rowNum, 2);
    let map;
    try { map = deserializeTripMap(cell.getValue()); } catch (e) { return; }
    const mine = [];
    map.forEach(function(t, k) {
      if (!t || Array.isArray(t)) return;
      if (String(t.recurringId || '') !== rid) return;
      SO_EXTRA_FIELDS_.forEach(function(f) {
        if (Object.prototype.hasOwnProperty.call(clean, f)) t[f] = clean[f];
      });
      mine.push(t);
      map.set(k, t);
    });
    if (!mine.length) return;
    // A repeat is priced exactly like a one-off trip. Clearing first means that if
    // the quote cannot be completed the day is obviously unpriced rather than
    // carrying a figure worked out for a different date.
    // Clear the figure but keep what the dispatcher decided - which optional
    // lines they added, which they took off, and any distance already looked up.
    // Wiping the whole snapshot silently reverted all of that to automatic.
    mine.forEach(function(t) {
      const keep = (t.pricing && typeof t.pricing === 'object') ? t.pricing : null;
      t.price = '';
      t.pricing = keep ? { manual: keep.manual || [], dropped: keep.dropped || [], miles: keep.miles } : '';
    });
    try { repricePrivatePayTrips_(mine); } catch (e) { Logger.log('soApplyExtras reprice: ' + ((e && e.message) || e)); }
    unpriced += unpricedCount_(mine);
    cell.setValue(serializeTripMap(map));
    writeTripsCache_(dateKey, Array.from(map.values()).filter(function(t) { return t && String(t.passenger || '').trim(); }));
    touched += mine.length;
  });
  return { touched: touched, unpriced: unpriced };
}

function createStandingOrderFromSidebar(parentTripKeyID, standingOrder, parentRow, dates, extras) {
  dates = filterUnsubmittedDates_(dates);
  if (!dates.length) throw new Error('Those days have been submitted and are locked as history.');
  // Only a real standing order (a repeat pattern) uses the background queue: the first
  // day is written while the dispatcher waits, the rest are queued. Anything else is
  // written in full right away, exactly as a normal trip.
  const isStanding = !!(standingOrder && standingOrder.pattern);
  const split = soSplitDates_(dates, !isStanding);
  try { syncPassengersFromTrips_([convertRowToTrip(parentRow)]); } catch (err) {}
  return withTripsDocumentLock_(function() {
    if (standingOrder) {
      const map = tripManager.getStandingOrderMap();
      map[parentTripKeyID] = standingOrder;
      tripManager.updateStandingOrderMap(map);
      try { soSetTitle_(parentTripKeyID, standingOrder.title); } catch (e) {}
    }
    const result = split.near.length ? sidebarTripService.createRecurring([parentTripKeyID, parentRow], split.near) : { created: 0, dispatchRows: [] };
    const cleanExtras = soCleanExtras_(extras);
    const rid = soRecurringIdOf_(parentRow);
    let soUnpriced = 0;
    if (split.near.length) {
      try {
        const applied = soApplyExtrasLocked_(rid, cleanExtras, split.near);
        soUnpriced = (applied && applied.unpriced) || 0;
      } catch (e) { Logger.log('createStandingOrder extras: ' + ((e && e.message) || e)); }
    }
    let jobId = '';
    if (split.later.length) {
      jobId = Utilities.getUuid();
      soEnqueueLocked_({ id: jobId, kind: 'create', parentTripKeyID: String(parentTripKeyID || ''), parentRow: soPlainRow_(parentRow), recurringId: rid, extras: cleanExtras, dates: split.later, total: split.later.length, done: 0, tries: 0, createdAt: Date.now(), updatedAt: Date.now() });
    }
    return { created: result.created || split.near.length, immediate: split.near.length, queued: split.later.length, jobId: jobId, dispatchSkipped: result.dispatchSkipped || 0, dispatchDeferred: (result.dispatchDeferred || 0) + split.later.length, unpriced: soUnpriced };
  });
}

// ---- Standing-order background jobs ----------------------------------------
// Dates within SO_NEAR_DAYS_ are written while the dispatcher waits; everything
// later is queued and worked through by a one-off timer trigger in chunks. Each
// chunk runs under the trips document lock so it never collides with a live edit.
// Creates are idempotent per date (a date that already holds a trip for this
// recurringId is skipped), so a retried chunk can never duplicate trips.
const SO_JOB_HANDLER_ = 'processStandingOrderJobs_';
const SO_POLL_BATCH_ = 3; // dates written per progress poll from the page
const SO_JOB_PREFIX_ = 'so-job:';
const SO_NEAR_DAYS_ = 7;
const SO_CHUNK_ = 8;
const SO_TIME_BUDGET_MS_ = 240000;
const SO_JOB_KEEP_MS_ = 24 * 3600000;
const SO_FAILED_JOB_KEEP_MS_ = 30 * 24 * 3600000;   // V120: a month to notice and retry

// The first (earliest) date is written while the dispatcher waits; every other date is
// queued for the background worker. allNow = true puts everything in `near`.
function soSplitDates_(dates, allNow) {
  const keys = (dates || []).map(function(d) { return Utils.formatDateString(d); }).filter(Boolean);
  const uniq = keys.filter(function(k, i) { return keys.indexOf(k) === i; }).sort();
  if (allNow || uniq.length < 2) return { near: uniq, later: [], all: uniq };
  return { near: uniq.slice(0, 1), later: uniq.slice(1), all: uniq };
}

function soRecurringIdOf_(parentRow) {
  return String((parentRow && parentRow[COLUMN.LOG.RECURRING_ID]) || '');
}

function soJobKey_(id) { return SO_JOB_PREFIX_ + id; }
function soReadJob_(id) {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(soJobKey_(id)) || 'null'); }
  catch (e) { return null; }
}
function soWriteJob_(job) { PropertiesService.getScriptProperties().setProperty(soJobKey_(job.id), JSON.stringify(job)); }
function soDeleteJob_(id) { PropertiesService.getScriptProperties().deleteProperty(soJobKey_(id)); }
function soListJobs_() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const jobs = [];
  Object.keys(props).forEach(function(k) {
    if (k.indexOf(SO_JOB_PREFIX_) !== 0) return;
    try { const j = JSON.parse(props[k]); if (j && j.id) jobs.push(j); } catch (e) {}
  });
  return jobs.sort(function(a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
}

function soEnsureTrigger_() {
  const has = ScriptApp.getProjectTriggers().some(function(t) { return t.getHandlerFunction() === SO_JOB_HANDLER_; });
  if (!has) ScriptApp.newTrigger(SO_JOB_HANDLER_).timeBased().after(1500).create();
}
function soClearTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(t) { if (t.getHandlerFunction() === SO_JOB_HANDLER_) ScriptApp.deleteTrigger(t); });
}

// Call only while already holding the trips document lock.
function soEnqueueLocked_(job) {
  // V120: write the job FIRST. The page's own progress poll works through a job
  // whether or not a trigger exists, so a job with no trigger still finishes -
  // but a job that was never written is simply lost, and the dispatcher is left
  // with a standing order whose remaining months silently do not exist.
  soWriteJob_(job);
  try { soEnsureTrigger_(); }
  catch (e) {
    // The page's own progress poll still works this job while the dispatcher is
    // watching, so it is not lost - but if they navigate away it stops, and that
    // has to be visible rather than silent.
    Logger.log('soEnqueueLocked_ trigger: ' + ((e && e.message) || e));
    job.noTrigger = String((e && e.message) || e);
    try { soWriteJob_(job); } catch (e2) {}
  }
}

// One chunk of the oldest open job, under the document lock. Returns true if work remains.
function soRunChunk_() {
  return withTripsDocumentLock_(function() {
    const job = soListJobs_().find(soJobOpen_);
    if (!job) return false;
    soWorkJob_(job, SO_CHUNK_);
    return soListJobs_().some(soJobOpen_);
  });
}

function soJobOpen_(j) { return !!(j && j.dates && j.dates.length && !j.error); }

// V123: is a standing order being written right now? Asked by the background
// board sync, which holds the same sheet lock and comes out of the same daily
// budget, so it stands aside rather than competing. Reads the job list only -
// no sheet, no lock.
function soAnyJobOpen_() {
  try {
    // Only a job that is still MOVING. A job left open by a lost trigger is
    // never pruned - it has dates remaining and no error - so testing "open"
    // alone would switch the background board sync off for good, weeks later,
    // with nothing anywhere to say why. A real chunk finishes inside four
    // minutes and re-queues a second and a half later, so fifteen is generous.
    var cutoff = Date.now() - 15 * 60000;
    return soListJobs_().some(function (j) {
      return soJobOpen_(j) && Number((j && j.updatedAt) || (j && j.createdAt) || 0) > cutoff;
    });
  } catch (e) { return false; }
}

// Works through up to `limit` dates of one job in ONE batched sheet pass, then saves the
// job so the dispatcher's progress pill moves. Caller must hold the document lock.
function soWorkJob_(job, limit) {
  if (!soJobOpen_(job)) return;
  const batch = job.dates.slice(0, Math.max(1, limit || 1));
  const T = { n: batch.length }; let tick = Date.now(); const lap = function(n) { T[n] = Date.now() - tick; tick = Date.now(); };
  try {
    if (job.kind === 'create') {
      const rid = job.recurringId;
      soPrewarmTripsCache_(batch); lap('prewarm');
      const fresh = batch.filter(function(k) {
        return !(tripManager.getTripsByDate(k) || []).some(function(t) { return t && String(t.recurringId || '') === rid; });
      }); lap('filter');
      if (fresh.length) {
        const res = sidebarTripService.createRecurring([job.parentTripKeyID, job.parentRow], fresh); T.detail = res && res.ms;
        // V120: same price, stop notes and start time as the day the dispatcher saw.
        try {
          const applied = soApplyExtrasLocked_(rid, job.extras, fresh);
          // Nobody is watching a background job, so an unpriced day has to leave a
          // trace somewhere. It is carried on the job and listed by
          // listFailedStandingOrderJobs alongside the genuine failures.
          if (applied && applied.unpriced) {
            job.unpriced = (job.unpriced || 0) + applied.unpriced;
            Logger.log('soWorkJob: ' + applied.unpriced + ' date(s) of standing order ' + rid + ' could not be priced');
          }
        }
        catch (e2) { Logger.log('soWorkJob extras: ' + ((e2 && e2.message) || e2)); }
      }
      lap('write');
    } else if (job.kind === 'paxdel') {
      const lastBatch = job.dates.length <= batch.length;
      const res = paxDeleteTripsOnDates_(job.keys, batch);
      job.deleted = (job.deleted || 0) + res.deleted;
      const rids = (job.rids || []).slice();
      res.rids.forEach(function(r) { if (rids.indexOf(r) < 0) rids.push(r); });
      job.rids = rids;
      // Only once, at the end: switching a repeat off decodes its whole pattern.
      if (lastBatch) rids.forEach(function(rid) { soFinalizeStandingOrderDelete_(rid, job.requested || batch); });
      lap('delete');
    } else {
      const lastBatch = job.dates.length <= batch.length;
      sidebarTripService.deleteRecurring(job.recurringId, batch, lastBatch ? (job.requested || job.dates) : null); lap('delete');
    }
    job.lastMs = T;
    job.dates = job.dates.slice(batch.length);
    job.done = (job.done || 0) + batch.length;
    job.tries = 0;
  } catch (e) {
    job.tries = (job.tries || 0) + 1;
    if (job.tries >= 3) job.error = String((e && e.message) || e);
  }
  job.updatedAt = Date.now();
  soWriteJob_(job);
}

// A job is stored as JSON, so any Date objects in the parent row would come back shifted
// to UTC. Store dates and times as the plain strings the app already understands.
function soPlainRow_(row) {
  if (!Array.isArray(row)) return row;
  const tz = Session.getScriptTimeZone();
  return row.map(function(v, i) {
    if (!(v instanceof Date)) return v;
    if (i === COLUMN.LOG.DATE) return Utils.formatDateString(v);
    return Utilities.formatDate(v, tz, 'HH:mm');
  });
}

// Is any trip still carrying this repeat id? Looks at the pattern's own dates plus any
// extra dates the caller just touched, all served from the batched trips cache.
function soStandingOrderTripsRemain_(recurringId, so, extraDates) {
  const rid = String(recurringId || '');
  if (!rid) return true;
  const seen = {};
  const add = function(d) { const k = Utils.formatDateString(d); if (k) seen[k] = true; };
  if (so && so.pattern) { try { decodeDatePattern(so.pattern).forEach(add); } catch (e) {} }
  if (Array.isArray(extraDates)) extraDates.forEach(add);
  const keys = Object.keys(seen);
  if (!keys.length) return false;
  try { soPrewarmTripsCache_(keys); } catch (e) {}
  for (let i = 0; i < keys.length; i += 1) {
    const list = tripManager.getTripsByDate(keys[i]) || [];
    for (let j = 0; j < list.length; j += 1) {
      if (list[j] && String(list[j].recurringId || '') === rid) return true;
    }
  }
  return false;
}

// Removes the repeat pattern once nothing is repeating any more. The second argument is
// only a hint of extra dates worth checking, so passing anything at all is safe.
// Returns 'removed', 'kept' (trips still repeat) or 'none' (there was no pattern).
function soFinalizeStandingOrderDelete_(recurringId, touchedDates) {
  try {
    const map = tripManager.getStandingOrderMap();
    const so = map[recurringId];
    if (!so) return 'none';
    if (soStandingOrderTripsRemain_(recurringId, so, touchedDates)) return 'kept';
    delete map[recurringId];
    tripManager.updateStandingOrderMap(map);
    try { soForgetTitles_([recurringId]); } catch (e) {}
    return 'removed';
  } catch (e) {
    Logger.log('soFinalizeStandingOrderDelete_: ' + ((e && e.message) || e));
    return 'kept';
  }
}

// Drops repeat patterns with no trips behind them at all. These accumulate from any
// delete that finished before this fix existed. Returns the ids it removed.
const SO_SWEEP_MAX_PATTERNS_ = 40;
function soSweepOrphanPatterns_() {
  const removed = [];
  try {
    const map = tripManager.getStandingOrderMap() || {};
    const ids = Object.keys(map);
    if (!ids.length || ids.length > SO_SWEEP_MAX_PATTERNS_) return removed;
    ids.forEach(function(rid) {
      if (!soStandingOrderTripsRemain_(rid, map[rid], null)) { delete map[rid]; removed.push(rid); }
    });
    if (removed.length) { tripManager.updateStandingOrderMap(map); try { soForgetTitles_(removed); } catch (e) {} }
  } catch (e) { Logger.log('soSweepOrphanPatterns_: ' + ((e && e.message) || e)); }
  return removed;
}

// Callable on its own so leftovers can be cleared without deleting anything else.
function sweepOrphanStandingOrders() {
  return withTripsDocumentLock_(function() { return { removed: soSweepOrphanPatterns_() }; });
}

// Fills the per-date trips cache for many dates at once so the conflict check and the
// idempotency check don't pay a full LOG scan per date.
function soPrewarmTripsCache_(dateKeys) {
  try {
    const keys = (dateKeys || []).map(function(k) { return Utils.formatDateString(k); }).filter(function(k, i, a) { return k && a.indexOf(k) === i; });
    if (!keys.length) return;
    const cache = CacheService.getDocumentCache();
    const have = cache.getAll(keys.map(tripCacheKey_)) || {};
    const cold = keys.filter(function(k) { return have[tripCacheKey_(k)] == null; });
    if (!cold.length) return;
    const sheet = tripManager.logSheet;
    let index = readTripDateRowIndex_(sheet);
    if (cold.some(function(k) { return !index[k]; })) index = rebuildTripDateRowIndex_(sheet); // one rebuild, not one per date
    const puts = {};
    const present = [];
    cold.forEach(function(k) {
      if (index[k]) present.push(k);
      else { puts[tripCacheKey_(k)] = '[]'; puts[tripsHashKey_(k)] = tripsHash_('[]'); SO_TRIPS_MEMO_[k] = '[]'; }
    });
    if (present.length) {
      // Read the dates' LOG rows in one block when they sit close together (they usually do).
      const rows = present.map(function(k) { return Number(index[k]); });
      const minRow = Math.min.apply(null, rows), maxRow = Math.max.apply(null, rows);
      const span = maxRow - minRow + 1;
      const parse = function(json) { return json ? tripManager.logManager.jsonToTrips(json).filter(function(t) { return t && String(t.passenger || '').trim(); }) : []; };
      if (minRow >= 2 && maxRow <= sheet.getLastRow() && span <= present.length * 2 + 10) {
        const block = sheet.getRange(minRow, 1, span, 2).getValues();
        present.forEach(function(k) {
          const r = block[index[k] - minRow];
          if (!r || logDateKey_(r[0]) !== k) { tripManager.getTripsByDate(k); return; } // index was stale for this date: slow path
          const payload = JSON.stringify(parse(r[1]));
          if (payload.length > 90000) { writeTripsCache_(k, JSON.parse(payload)); return; } // big day: let the normal writer gzip it
          puts[tripCacheKey_(k)] = payload;
          // V120: the hash must travel with the payload. A payload cached without
          // it can leave an older hash in place, and the board then believes
          // nothing has changed for as long as that hash lives.
          puts[tripsHashKey_(k)] = tripsHash_(payload);
          SO_TRIPS_MEMO_[k] = payload;
        });
      } else {
        present.forEach(function(k) { tripManager.getTripsByDate(k); });
      }
    }
    if (Object.keys(puts).length) {
      // V120: this read is taken without the lock, so between reading and writing
      // somebody else's save may already have cached a newer day. Only fill keys
      // that are still empty; never overwrite a fresher entry with a stale one.
      const names = Object.keys(puts);
      let still = {};
      try { still = cache.getAll(names) || {}; } catch (e2) { still = {}; }
      const safe = {};
      names.forEach(function(k) {
        if (k.slice(-2) === ':h') return;           // decided together with its payload
        const dateKey = k.split(':')[2] || '';
        // Both halves must be missing, or neither is written: a payload cached
        // without its hash can leave an older hash in place, and the board then
        // believes nothing has changed for as long as that hash lives.
        if (still[k] == null && still[k + ':h'] == null) {
          safe[k] = puts[k];
          if (puts[k + ':h'] !== undefined) safe[k + ':h'] = puts[k + ':h'];
        } else if (dateKey) {
          delete SO_TRIPS_MEMO_[dateKey];
        }
      });
      if (Object.keys(safe).length) cache.putAll(safe, TRIP_CACHE_TTL_SECONDS);
    }
  } catch (e) { Logger.log('soPrewarmTripsCache_: ' + ((e && e.message) || e)); }
}

// Drops many keys from the TRIP_INDEX sheet: one read, then deleteRows per contiguous run.
function soRemoveTripIndexEntries_(keys) {
  try {
    const want = {};
    (keys || []).forEach(function(k) { if (k) want[String(k)] = true; });
    if (!Object.keys(want).length) return;
    const sheet = ensureTripIndexHeaders_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    const col = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    const rows = [];
    col.forEach(function(r, i) { if (want[String(r[0])]) rows.push(i + 2); });
    rows.sort(function(a, b) { return b - a; });
    let i = 0;
    while (i < rows.length) {
      let j = i;
      while (j + 1 < rows.length && rows[j + 1] === rows[j] - 1) j++;
      sheet.deleteRows(rows[j], j - i + 1);
      i = j + 1;
    }
  } catch (e) { Logger.log('soRemoveTripIndexEntries_: ' + ((e && e.message) || e)); }
}

// V120: a job that failed three times still holds every date it never created.
// Clearing the error and the try count lets it finish.
function retryStandingOrderJob(jobId) {
  return withTripsDocumentLock_(function() {
    const job = soReadJob_(String(jobId || ''));
    if (!job) return { ok: false, reason: 'notfound' };
    delete job.error;
    job.tries = 0;
    job.updatedAt = Date.now();
    try { soEnqueueLocked_(job); }
    catch (e) { return { ok: false, reason: 'trigger', message: String((e && e.message) || e) }; }
    return { ok: true, remaining: (job.dates || []).length };
  });
}

// Every job that stopped with work still to do.
function listFailedStandingOrderJobs() {
  return soListJobs_().filter(function(j) { return j && ((j.error && j.dates && j.dates.length) || j.unpriced || (j.noTrigger && j.dates && j.dates.length)); })
    .map(function(j) {
      return { id: j.id, kind: j.kind, remaining: (j.dates || []).length, total: j.total, done: j.done,
               error: j.error || j.noTrigger || '', unpriced: j.unpriced || 0, updatedAt: j.updatedAt };
    });
}

function soPruneJobs_() {
  soListJobs_().forEach(function(j) {
    // V120: a failed job used to be swept away after a day even though its
    // remaining dates were never created, so the missing rides left no trace. It
    // is now kept for a month so somebody can see it and retry it, but not for
    // ever - script properties are finite.
    if (j.error && j.dates && j.dates.length) {
      if (Date.now() - (j.updatedAt || 0) < SO_FAILED_JOB_KEEP_MS_) return;
      Logger.log('soPruneJobs_: discarding failed job ' + j.id + ' with ' + j.dates.length + ' date(s) never created');
    }
    const finished = !(j.dates && j.dates.length) || !!j.error;
    if (finished && Date.now() - (j.updatedAt || 0) > SO_JOB_KEEP_MS_) soDeleteJob_(j.id);
  });
}

function processStandingOrderJobs_() {
  const started = Date.now();
  let more = true;
  while (more && (Date.now() - started) < SO_TIME_BUDGET_MS_) {
    try { more = soRunChunk_(); }
    catch (e) { Logger.log('processStandingOrderJobs_: ' + ((e && e.message) || e)); break; }
  }
  soClearTriggers_();
  if (more) ScriptApp.newTrigger(SO_JOB_HANDLER_).timeBased().after(1500).create();
  else soPruneJobs_();
}

function getStandingOrderJobStatus(jobId) {
  const id = String(jobId || '');
  // While the page is watching, do a small batch on each poll so the count moves right
  // away instead of waiting for the background trigger to wake up (often 30-90 seconds).
  // V120: this used to take the document lock directly, which leaves the depth
  // counter at zero - so anything it called that took the lock properly would
  // release it while this was still working. It goes through the one wrapper now,
  // taking a short try-lock rather than waiting, because the page asks about once
  // a second while a standing order runs.
  try {
    let didWork = false;
    withTripsDocumentTryLock_(3000, function() {
      const j = soReadJob_(id);
      if (soJobOpen_(j)) { soWorkJob_(j, SO_POLL_BATCH_); didWork = true; }
    });
    // Trips really were created or removed, so other boards need to know - but
    // once, at the end, rather than on every one-second poll.
    if (didWork) boardBump_();
  } catch (e) { Logger.log('getStandingOrderJobStatus: ' + ((e && e.message) || e)); }
  const job = soReadJob_(id);
  if (!job) return { found: false, done: true, total: 0, completed: 0, remaining: 0, error: '' };
  const remaining = (job.dates || []).length;
  return { found: true, done: remaining === 0 || !!job.error, total: job.total || 0, completed: job.done || 0, remaining: remaining, error: job.error || '', kind: job.kind || '' };
}


function TEMP_audit() {
  const r = auditWorkbookCells();
  const lines = r.sheets.map(function(s){ return s[0] + ' ' + s[1] + 'x' + s[2] + ' c' + s[3] + ' used' + s[4] + 'x' + s[5]; });
  throw new Error('TOTAL ' + r.total + ' :: ' + lines.join(' | '));
}

// ---- Passenger list sync (V73) --------------------------------------------
// Every trip save keeps the PASSENGERS sheet in step: an unknown passenger is added
// with the details from the trip form; a known one gains any new phone/address and
// has a blank Medicaid # or type filled in. All PASSENGERS writes share one script
// lock and the sheet is re-sorted by name whenever a row is added or renamed.
const PASSENGERS_LOCK_MS_ = 10000;

function withPassengersLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(PASSENGERS_LOCK_MS_)) throw new Error('The passenger list is busy right now. Please try again.');
  try { return fn(); } finally { lock.releaseLock(); }
}

// Re-sort rows 2..last by the display name (column B) using the sheet's own sort
// order (case-insensitive). Called whenever a row is added or renamed; ~0.7s for 3,000 rows.
function sortPassengersSheet_() {
  try {
    const sheet = ensurePassengersHeaders_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 3) return false;
    const width = Math.max(PASSENGERS_HEADERS_.length, sheet.getLastColumn());
    sheet.getRange(2, 1, lastRow - 1, width).sort({ column: 2, ascending: true });
    return true;
  } catch (e) { Logger.log('sortPassengersSheet_: ' + ((e && e.message) || e)); return false; }
}

function soDigits_(v) { return String(v || '').replace(/\D/g, ''); }

// Merges the passenger details of one trip into the PASSENGERS sheet. Never throws:
// a trip must still save even if the passenger list cannot be updated.
// Returns { name, created, updated } or null.
function syncPassengerFromTrip_(trip) {
  try {
    if (!trip) return null;
    const name = String(trip.passenger || '').trim().replace(/\s+/g, ' ');
    if (!name || name.length < 2) return null;
    const phone = String(trip.phone || '').trim();
    const medicaid = String(trip.medicaid || '').trim();
    const type = String(trip.transport || '').trim();
    const addrs = [trip.pickup, trip.dropoff].map(function(a) { return String(a || '').trim(); }).filter(Boolean);
    return withPassengersLock_(function() {
      const sheet = ensurePassengersHeaders_();
      const key = passengerCacheKey_(name);
      const lastRow = sheet.getLastRow();
      const match = lastRow >= 2
        ? sheet.getRange(2, 1, lastRow - 1, 1).createTextFinder(key).matchEntireCell(true).findNext()
        : null;
      if (!match) {
        updatePassengerProfileUnlocked_(name, { displayName: name, medicaid: medicaid, type: type, phones: phone ? [phone] : [], addresses: addrs });
        sortPassengersSheet_();
        return { name: name, created: true, updated: false };
      }
      const row = match.getRow();
      const cur = sheet.getRange(row, 1, 1, 9).getDisplayValues()[0];
      const phones = splitLines_(cur[5]);
      if (!phones.length && String(cur[4] || '').trim()) phones.push(String(cur[4]).trim());
      const addresses = splitLines_(cur[6]);
      let changed = false;
      if (phone && soDigits_(phone).length >= 7 && !phones.some(function(p) { return soDigits_(p) === soDigits_(phone); })) { phones.push(phone); changed = true; }
      addrs.forEach(function(a) {
        if (!addresses.some(function(x) { return x.toLowerCase() === a.toLowerCase(); })) { addresses.push(a); changed = true; }
      });
      const keepMedicaid = String(cur[2] || '').trim();
      const keepType = String(cur[3] || '').trim();
      if (!keepMedicaid && medicaid) changed = true;
      if (!keepType && type) changed = true;
      if (!changed) return { name: name, created: false, updated: false };
      updatePassengerProfileUnlocked_(name, { medicaid: keepMedicaid || medicaid, type: keepType || type, phones: phones, addresses: addresses });
      return { name: name, created: false, updated: true };
    });
  } catch (e) {
    Logger.log('syncPassengerFromTrip_: ' + ((e && e.message) || e));
    return null;
  }
}

// One sync per distinct passenger in a batch (return trips share the same person).
function syncPassengersFromTrips_(trips) {
  const seen = {};
  const out = [];
  (Array.isArray(trips) ? trips : [trips]).filter(Boolean).forEach(function(trip) {
    const key = passengerCacheKey_(trip && trip.passenger);
    if (!key || seen[key]) return;
    seen[key] = true;
    const r = syncPassengerFromTrip_(trip);
    if (r) out.push(r);
  });
  return out;
}

// ---- Passenger directory page (V73) ----------------------------------------
// The whole list, sorted by name, in the shape the Passengers page renders.
function getPassengerDirectory() {
  const rows = [];
  getPassengerCacheLookup_().forEach(function(record) {
    if (!record.displayName) return;
    rows.push({
      name: record.displayName,
      medicaid: String(record.medicaid || ''),
      type: String(record.type || ''),
      phones: record.phones.length ? record.phones : (record.primaryPhone ? [record.primaryPhone] : []),
      addresses: record.addresses,
      blacklisted: !!record.blacklisted,
      blacklistReason: record.blacklistReason || '',
      blacklistedBy: record.blacklistedBy || ''
    });
  });
  rows.sort(function(a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0; });
  return rows;
}

// Saves one passenger from the directory editor. originalName = the name the row had
// when it was opened (so a rename can find the row); profile = every editable field.
// changedFields works exactly as it does for trips: only the details the dispatcher
// actually edited are written, so two people correcting different things about the
// same passenger both keep their correction.
function savePassengerFromDirectory(originalName, profile, changedFields) {
  const p = profile || {};
  const newName = String(p.displayName || '').trim().replace(/\s+/g, ' ');
  if (!newName) throw new Error('Passenger name is required.');
  const oldKey = passengerCacheKey_(originalName);
  const newKey = passengerCacheKey_(newName);
  const phones = Array.from(new Set((Array.isArray(p.phones) ? p.phones : []).map(function(v) { return String(v).trim(); }).filter(Boolean)));
  const addresses = Array.from(new Set((Array.isArray(p.addresses) ? p.addresses : []).map(function(v) { return String(v).trim(); }).filter(Boolean)));
  const flagged = !!p.blacklisted;
  const reason = String(p.blacklistReason || '').trim();
  if (flagged && reason.length < 3) throw new Error('A reason is required to blacklist a passenger.');
  return withPassengersLock_(function() {
    const sheet = ensurePassengersHeaders_();
    const lastRow = sheet.getLastRow();
    const find = function(k) {
      return lastRow >= 2 && k ? sheet.getRange(2, 1, lastRow - 1, 1).createTextFinder(k).matchEntireCell(true).findNext() : null;
    };
    let match = find(oldKey);
    if (oldKey !== newKey && find(newKey)) throw new Error(newName + ' already exists on the passenger list.');
    const row = match ? match.getRow() : lastRow + 1;
    const cur = match ? sheet.getRange(row, 1, 1, 11).getDisplayValues()[0] : [];
    const wasFlagged = String(cur[7] || '').trim().toUpperCase() === 'TRUE';
    // Start from the row as it stands right now and change only what was edited, so a
    // colleague's correction made while this panel was open is not written over.
    const only = (match && Array.isArray(changedFields) && changedFields.length) ? changedFields : null;
    const touched = function(field) { return !only || only.indexOf(field) >= 0; };
    const keep = function(field, next, currentValue) { return touched(field) ? next : currentValue; };
    const curPhones = splitLines_(cur[5]);
    if (!curPhones.length && String(cur[4] || '').trim()) curPhones.push(String(cur[4]).trim());
    const outName = keep('displayName', newName, String(cur[1] || '').trim() || newName);
    const outKey = passengerCacheKey_(outName);
    const outMedicaid = keep('medicaid', String(p.medicaid || '').trim(), String(cur[2] || '').trim());
    const outType = keep('type', String(p.type || '').trim(), String(cur[3] || '').trim());
    const outPhones = keep('phones', phones, curPhones);
    const outAddresses = keep('addresses', addresses, splitLines_(cur[6]));
    const outFlagged = touched('blacklisted') ? flagged : wasFlagged;
    let outReason = (touched('blacklisted') || touched('blacklistReason')) ? reason : String(cur[8] || '').trim();
    if (!outFlagged) outReason = '';
    let flaggedBy = String(cur[10] || '');
    if (outFlagged && !wasFlagged) flaggedBy = currentDispatcherLabel_();
    if (!outFlagged) flaggedBy = '';
    sheet.getRange(row, 1, 1, 11).setValues([[
      outKey,
      outName,
      outMedicaid,
      outType,
      outPhones[0] || '',
      outPhones.join('\n'),
      outAddresses.join('\n'),
      outFlagged,
      outReason,
      new Date(),
      flaggedBy
    ]]);
    if (!match || oldKey !== outKey) sortPassengersSheet_();
    invalidateFormOptionsCache_();
    return {
      name: outName,
      medicaid: outMedicaid,
      type: outType,
      phones: outPhones,
      addresses: outAddresses,
      blacklisted: outFlagged,
      blacklistReason: outReason,
      blacklistedBy: flaggedBy,
      renamedFrom: match && oldKey !== outKey ? String(cur[1] || '') : ''
    };
  });
}

// ---- Standing-order titles (V88) --------------------------------------------
// A standing order is now named when it is created, so "Order from Sat, Sep 5" can
// become "Dialysis Mon/Wed/Fri". Titles live in their own script property rather than
// inside the order map in LOG!A1, so nothing about the existing repeat/delete/sweep
// logic changes: a title is never mistaken for a repeat pattern, and an order created
// before titles existed can be named without inventing a pattern-less map entry.
const SO_TITLES_PROPERTY_ = 'standingOrder:titles:v1';
const SO_TITLE_MAX_ = 60;
const SO_TITLES_MAX_ = 300;

function soTitleClean_(title) {
  return String(title == null ? '' : title).replace(/\s+/g, ' ').trim().slice(0, SO_TITLE_MAX_);
}

function soReadTitles_() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty(SO_TITLES_PROPERTY_) || '{}') || {};
  } catch (e) { return {}; }
}

function soWriteTitles_(map) {
  try {
    const clean = {};
    Object.keys(map || {}).slice(0, SO_TITLES_MAX_).forEach(function(k) {
      const v = soTitleClean_(map[k]);
      if (k && v) clean[k] = v;
    });
    PropertiesService.getScriptProperties().setProperty(SO_TITLES_PROPERTY_, JSON.stringify(clean));
  } catch (e) { Logger.log('soWriteTitles_: ' + ((e && e.message) || e)); }
}

function soSetTitle_(recurringId, title) {
  const rid = String(recurringId || '').trim();
  const name = soTitleClean_(title);
  if (!rid || !name) return '';
  const map = soReadTitles_();
  map[rid] = name;
  soWriteTitles_(map);
  return name;
}

// Best effort: a title with no order behind it is harmless, but there is no reason to
// keep it either. Called wherever an id leaves the order map.
function soForgetTitles_(ids) {
  const list = (ids || []).map(function(x) { return String(x || ''); }).filter(Boolean);
  if (!list.length) return;
  const map = soReadTitles_();
  let hit = false;
  list.forEach(function(rid) { if (map[rid]) { delete map[rid]; hit = true; } });
  if (hit) soWriteTitles_(map);
}

// Called from the passenger trips page. Renaming is allowed at any time, including for
// orders created before titles existed, which is why this never touches the order map.
function renameStandingOrder(recurringId, title) {
  const rid = String(recurringId || '').trim();
  const name = soTitleClean_(title);
  if (!rid) return { ok: false, reason: 'norid' };
  if (!name) return { ok: false, reason: 'notitle' };
  return { ok: true, recurringId: rid, title: soSetTitle_(rid, name) };
}

// Only the orders these trips are actually on, so the page gets a handful of names
// rather than every order the business has ever run.
function soTitlesForTrips_(trips) {
  const out = {};
  const need = {};
  (trips || []).forEach(function(t) {
    const rid = t && String(t.recurringId || '');
    if (rid) need[rid] = true;
  });
  const ids = Object.keys(need);
  if (!ids.length) return out;
  const map = soReadTitles_();
  ids.forEach(function(rid) { if (map[rid]) out[rid] = map[rid]; });
  return out;
}

// ---- Phantom driver stamps (V89) --------------------------------------------
// A DISPATCH row is a slot that gets reused by whatever trip lands in it next, and this
// app only writes the columns it owns. The driver app stamps its progress into B, Z, AA,
// AB and AC — and on this sheet AB and AC are also the old "PU/ DO" and "START TIME"
// columns, so they came pre-loaded with times from the legacy system. A recycled row
// therefore handed its previous occupant's start time and stamps to the new trip, the
// dispatch-edit sync read them back, and a trip nobody had touched ended up with a
// driver's progress times in its own record. Hence trips showing "Intransit 10:32 AM,
// Completed 11:16 AM" with no driver assigned — the very same pair on three different
// passengers across three dates, because they all sat in the same row.
//
// The cure is to wipe those cells the moment a row changes hands. A row that already
// belongs to the trip being written is left alone, so a driver's live progress is never
// disturbed. L, O, Q and X carry sheet formulas, so anything with a formula is put back
// exactly as it was; a cell a driver had overwritten stays cleared.
const PHANTOM_ARRIVAL_FIELDS_ = ['pickupArrival', 'dropoffArrival'];
const PHANTOM_DEPARTURE_FIELDS_ = ['pickupDeparture', 'dropoffDeparture'];
const PHANTOM_ALL_FIELDS_ = PHANTOM_ARRIVAL_FIELDS_.concat(PHANTOM_DEPARTURE_FIELDS_);

function dispatchInheritedSpans_() {
  const C = COLUMN.DISPATCH;
  return [
    [C.START_TIME + 1, 1],      // B
    [C.IN + 1, 1],              // L
    [C.OUT + 1, 1],             // O
    [C.STATUS + 1, 1],          // Q
    [C.PICKUP_IN_AT + 1, 4]     // Z:AC
  ];
}

// The driver app can only stamp in order — arrived at pickup, on board, arrived at
// drop-off, complete — so a trip carrying one of the two "departure" stamps while both
// "arrival" stamps are empty was never driven. That is the signature of an inherited
// row, and it is the only one this repair trusts.
function tripStampsArePhantom_(trip) {
  if (!trip) return false;
  const has = function(f) { return String(trip[f] || '').trim() !== ''; };
  if (PHANTOM_ARRIVAL_FIELDS_.some(has)) return false;
  return PHANTOM_DEPARTURE_FIELDS_.some(has);
}

// Read-only unless `apply` is true. Returns what it found either way, so the damage can
// be looked at before anything is changed.
// V100: blank start times were written as 11:58 PM for years (see
// isBlankStartTime_). This blanks them: in every LOG day's trip list and in
// DISPATCH column B. Dry run unless apply === true. A start time that is really
// 11:58 PM is not a thing on this service, so nothing genuine is at risk.
function repairBlankStartTimes(apply) {
  const doIt = apply === true;
  const out = { apply: doIt, logTrips: 0, logRows: 0, dispatchCells: 0 };
  return withTripsDocumentLock_(function() {
    const sheet = tripManager.logSheet;
    const lastRow = sheet.getLastRow();
    for (let start = 2; start <= lastRow; start += 200) {
      const n = Math.min(200, lastRow - start + 1);
      const block = sheet.getRange(start, 1, n, 2).getValues();
      for (let i = 0; i < n; i++) {
        const json = String(block[i][1] || '');
        if (!json) continue;
        let map;
        try { map = deserializeTripMap(json); } catch (e) { continue; }
        let touched = 0;
        map.forEach(function(trip) {
          if (!trip || trip.startTime === '' || trip.startTime == null) return;
          if (!isBlankStartTime_(trip.startTime)) return;
          touched += 1;
          out.logTrips += 1;
          if (doIt) trip.startTime = '';
        });
        if (touched) {
          out.logRows += 1;
          if (doIt) sheet.getRange(start + i, 2).setValue(serializeTripMap(map));
        }
      }
    }
    const dispatch = sidebarTripService.dispatchSheet;
    const rows = Math.min(dispatch.getMaxRows(), SIDEBAR_DISPATCH_MAX_ROW_);
    if (rows >= 2) {
      const col = COLUMN.DISPATCH.START_TIME + 1;
      const rng = dispatch.getRange(2, col, rows - 1, 1);
      const shown = rng.getDisplayValues();
      const vals = rng.getValues();
      let changed = false;
      for (let i = 0; i < shown.length; i++) {
        if (isBlankStartTime_(String(shown[i][0] || '')) && String(shown[i][0] || '').trim()) { vals[i][0] = ''; out.dispatchCells += 1; changed = true; }
      }
      if (doIt && changed) { rng.setValues(vals); dispatchMarkForSort_(); }
    }
    Logger.log(JSON.stringify(out));
    return out;
  });
}

// The function picker cannot pass an argument, so this is the "do it" button.
function repairBlankStartTimesApply() { return repairBlankStartTimes(true); }

function repairPhantomProgressStamps(apply) {
  // V120: this was the only repair that rewrote LOG rows with no lock held and
  // never refreshed the trips cache, so a save made while it ran could be erased
  // by its own stale in-memory copy of the sheet. It takes the lock around each
  // block rather than around the whole run - holding it for the full four minutes
  // would have made every dispatcher save and every driver tap time out.
  return repairPhantomProgressStampsLocked_(apply);
}

function repairPhantomProgressStampsLocked_(apply) {
  const doIt = apply === true;
  const out = { apply: doIt, logTrips: 0, logRows: 0, dispatchRows: 0, samples: [], touchedDates: [] };
  const sheet = tripManager.logSheet;
  const lastRow = sheet.getLastRow();
  const budgetUntil = Date.now() + 240000;
  for (let start = 2; start <= lastRow; start += 200) {
    // V120: a long LOG used to run this past the six-minute limit and die halfway
    // through, with no record of where it stopped.
    if (Date.now() > budgetUntil) { out.timedOut = true; out.resumeFromRow = start; break; }
    const n = Math.min(200, lastRow - start + 1);
    withTripsDocumentLock_(function() {
    const block = sheet.getRange(start, 1, n, 2).getValues();
    // V120: one write per 200-row window instead of one per changed row.
    const pending = [];
    for (let i = 0; i < n; i++) {
      const json = String(block[i][1] || '');
      if (!json) continue;
      let map;
      try { map = deserializeTripMap(json); } catch (e) { continue; }
      let touched = 0;
      map.forEach(function(trip, key) {
        if (!tripStampsArePhantom_(trip)) return;
        touched += 1;
        out.logTrips += 1;
        if (out.samples.length < 40) {
          out.samples.push({
            date: String(trip.date || ''), time: String(trip.time || ''),
            passenger: String(trip.passenger || ''), driver: String(trip.driver || ''),
            pickupDeparture: String(trip.pickupDeparture || ''),
            dropoffDeparture: String(trip.dropoffDeparture || '')
          });
        }
        if (doIt) PHANTOM_ALL_FIELDS_.forEach(function(f) { trip[f] = ''; });
      });
      if (touched) {
        out.logRows += 1;
        const dk = logDateKey_(block[i][0]);
        if (dk && out.touchedDates.indexOf(dk) < 0) out.touchedDates.push(dk);
        if (doIt) pending.push({ row: start + i, json: serializeTripMap(map) });
      }
    }
    if (doIt && pending.length) {
      // V120: each of these cells holds a whole day's trips - tens of kilobytes.
      // Writing all two hundred back to change one of them is megabytes per block,
      // with the board locked. Write the changed rows, joining neighbours.
      pending.sort(function(a, b) { return a.row - b.row; });
      let run = [pending[0]];
      const flushRun = function() {
        sheet.getRange(run[0].row, 2, run.length, 1).setValues(run.map(function(w) { return [w.json]; }));
      };
      for (let q = 1; q < pending.length; q++) {
        if (pending[q].row === run[run.length - 1].row + 1) run.push(pending[q]);
        else { flushRun(); run = [pending[q]]; }
      }
      flushRun();
    }
    });
  }

  // The board itself still holds the legacy times, so clear them at source too or the
  // next sync puts them straight back. A row where a driver really did something has a
  // pickup-arrival stamp in Z; those rows are left exactly as they are.
  const C = COLUMN.DISPATCH;
  const dispatch = sidebarTripService.dispatchSheet;
  const rows = Math.min(dispatch.getMaxRows(), SIDEBAR_DISPATCH_MAX_ROW_);
  // V120: the LOG half runs under the lock but this half did not, so a board
  // re-sort landing between the read and the clear wiped four progress columns
  // on the wrong passengers' rows - the very corruption this repairs.
  withTripsDocumentLock_(function() {
  if (rows >= 2) {
    const range = dispatch.getRange(2, C.PICKUP_IN_AT + 1, rows - 1, 4);
    const vals = range.getDisplayValues();
    const hits = [];
    for (let i = 0; i < vals.length; i++) {
      const z = String(vals[i][0] || '').trim(), aa = String(vals[i][1] || '').trim();
      const ab = String(vals[i][2] || '').trim(), ac = String(vals[i][3] || '').trim();
      if (!z && !aa && (ab || ac)) hits.push(i + 2);
    }
    out.dispatchRows = hits.length;
    // A run that ran out of time only repaired part of the record, so clearing the
    // whole board would leave the two halves describing different things.
    if (doIt && !out.timedOut) hits.forEach(function(row) {
      dispatch.getRange(row, C.PICKUP_IN_AT + 1, 1, 4).clearContent();
    });
  }
  });
  // V120: without this the board kept serving the pre-repair trips from cache for
  // up to five minutes, so the fix looked as though it had not worked.
  if (doIt) {
    try { invalidateTripsCache_(out.touchedDates && out.touchedDates.length ? out.touchedDates : dispatchWindowKeys_()); }
    catch (e) { Logger.log('repairPhantom invalidate: ' + ((e && e.message) || e)); }
  }
  return out;
}

function findPhantomProgressStamps() { return repairPhantomProgressStamps(false); }

// ---- Keeping DISPATCH in date and time order (V95) ---------------------------
// The board hands each new trip whichever row happens to be free, so through a day of
// adding and deleting, rows drift into the order they were touched rather than the order
// they run. This puts them back in date-then-time order after anything the app writes to
// or clears from the sheet, with empty rows collected at the bottom.
//
// Only the columns the sheet does NOT compute are moved. On this sheet F, G, H, L, O, Q,
// S, T, V, W and X hold lookups keyed off the row's own data, so they have to stay where
// they are and recompute; a column is left completely alone if any cell in it holds a
// formula. Everything else travels with its trip, the driver's progress stamps included.
const DISPATCH_SORT_COLS_ = 33;          // A..AG, the whole width the app knows about
let dispatchNeedsSort_ = false;
let tripsLockDepth_ = 0;

function dispatchMarkForSort_() { dispatchNeedsSort_ = true; }

// Rows the app treats as free are exactly the ones findOpenDispatchRow_ would hand out.
function dispatchRowIsEmpty_(row) {
  const passenger = String(row[COLUMN.DISPATCH.PASSENGER] == null ? '' : row[COLUMN.DISPATCH.PASSENGER]).trim();
  const key = String(row[COLUMN.DISPATCH.TRIP_KEY_ID] == null ? '' : row[COLUMN.DISPATCH.TRIP_KEY_ID]).trim();
  return !passenger && !key;
}

// A trip with no date sorts after every dated one, but still above the empty rows.
function dispatchDateKey_(value) {
  let key = '';
  try { key = Utils.formatDateString(value) || ''; } catch (e) { key = ''; }
  return key || '9999-99-99';
}

function dispatchTimeValue_(value) {
  if (value instanceof Date) return value.getHours() * 60 + value.getMinutes();
  const m = /(?:T|^|\s)(\d{1,2}):(\d{2})/.exec(String(value == null ? '' : value));
  if (!m) return 24 * 60 + 1;            // no time: last within its day
  let mins = Number(m[1]) * 60 + Number(m[2]);
  if (/pm/i.test(String(value)) && Number(m[1]) < 12) mins += 12 * 60;
  if (/am/i.test(String(value)) && Number(m[1]) === 12) mins -= 12 * 60;
  return mins;
}

// Runs of neighbouring columns that the sheet does not compute, so the reorder is a
// handful of writes rather than one per column.
function dispatchWritableRuns_(computed) {
  const runs = [];
  let start = -1;
  for (let c = 0; c < computed.length; c++) {
    if (!computed[c] && start < 0) start = c;
    if ((computed[c] || c === computed.length - 1) && start >= 0) {
      const end = computed[c] ? c - 1 : c;
      runs.push([start, end - start + 1]);
      start = -1;
    }
  }
  return runs;
}

function sortDispatchSheet_() {
  const sheet = sidebarTripService.dispatchSheet;
  const last = Math.min(sheet.getMaxRows(), SIDEBAR_DISPATCH_MAX_ROW_);
  const n = last - 1;
  if (n < 2) return { sorted: false, reason: 'tooshort' };

  const range = sheet.getRange(2, 1, n, DISPATCH_SORT_COLS_);
  const values = range.getValues();
  // V120 SPEED: getFormulas() and getFormulasR1C1() answer the same question here
  // - "does this column hold a formula" - and each was a full 99x33 read. One is
  // enough, so this drops a whole sheet round trip from every board sort.
  const formulasR1C1 = range.getFormulasR1C1();
  const formulas = formulasR1C1;

  const computed = [];
  for (let c = 0; c < DISPATCH_SORT_COLS_; c++) {
    let has = false;
    for (let r = 0; r < n; r++) {
      if (String(formulas[r][c] == null ? '' : formulas[r][c])) { has = true; break; }
    }
    computed.push(has);
  }

  const keyed = [];
  for (let r = 0; r < n; r++) {
    const empty = dispatchRowIsEmpty_(values[r]);
    keyed.push({
      r: r,
      empty: empty,
      date: empty ? '' : dispatchDateKey_(values[r][COLUMN.DISPATCH.DATE]),
      time: empty ? 0 : dispatchTimeValue_(values[r][COLUMN.DISPATCH.TIME])
    });
  }
  keyed.sort(function(a, b) {
    if (a.empty !== b.empty) return a.empty ? 1 : -1;
    if (a.empty) return a.r - b.r;
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.time !== b.time) return a.time - b.time;
    return a.r - b.r;                     // otherwise leave them as they were found
  });

  let moved = false;
  for (let i = 0; i < n; i++) { if (keyed[i].r !== i) { moved = true; break; } }
  if (!moved) return { sorted: false, reason: 'already', rows: n };

  const runs = dispatchWritableRuns_(computed);
  runs.forEach(function(run) {
    const block = [];
    for (let i = 0; i < n; i++) {
      block.push(values[keyed[i].r].slice(run[0], run[0] + run[1]));
    }
    sheet.getRange(2, run[0] + 1, n, run[1]).setValues(block);
  });

  // V102: a computed column (L, O, Q, X) is NOT left where it was any more. The
  // driver app writes plain values into L, O and Q (IN, OUT and the driver's
  // status) over the formula, and leaving the column alone while the rest of the
  // row moved put one trip's status on another trip's row. Now each cell travels
  // with its row: a formula cell keeps its formula (R1C1, so it is row-relative),
  // a value cell keeps its value. Written in runs of like cells, so it is still a
  // handful of calls, not one per cell.
  let cellRuns = 0;
  for (let c = 0; c < DISPATCH_SORT_COLS_; c++) {
    if (!computed[c]) continue;
    let i = 0;
    while (i < n) {
      const isFormula = !!String(formulasR1C1[keyed[i].r][c] || '');
      let j = i;
      while (j < n && (!!String(formulasR1C1[keyed[j].r][c] || '')) === isFormula) j++;
      // Only touch a run that actually changed: same kind and same content in place.
      let same = true;
      for (let k = i; k < j && same; k++) {
        if (keyed[k].r === k) continue;
        const wasFormula = !!String(formulasR1C1[k][c] || '');
        if (wasFormula !== isFormula) { same = false; break; }
        if (isFormula) { if (String(formulasR1C1[k][c]) !== String(formulasR1C1[keyed[k].r][c])) same = false; }
        else if (String(values[k][c]) !== String(values[keyed[k].r][c])) same = false;
      }
      if (!same) {
        const target = sheet.getRange(2 + i, c + 1, j - i, 1);
        const block = [];
        for (let k = i; k < j; k++) block.push([isFormula ? formulasR1C1[keyed[k].r][c] : values[keyed[k].r][c]]);
        if (isFormula) target.setFormulasR1C1(block); else target.setValues(block);
        cellRuns += 1;
      }
      i = j;
    }
  }
  return { sorted: true, rows: n, runs: runs.length, cellRuns: cellRuns };
}

// ---- V102: put driver statuses back on the trips they belong to ----------------
// Until V102 the sort left column Q (and L, O) behind, so a driver's status could
// sit on the wrong row while the four stamps in Z:AC moved with the trip. The
// stamps are the truth: this rebuilds L, O and Q from them on every board row.
// Dry run unless apply === true. Returns what it would change either way.
const REPAIR_DRIVER_STATUSES_ = ['PICKUP LOCATION', 'INTRANSIT', 'DROPOFF LOCATION', 'COMPLETE', 'IN ROUTE'];

function dispatchStatusFromStamps_(z, ab, aa, ac) {
  const has = function(v) { return v !== '' && v !== null && v !== undefined; };
  if (has(ac)) return 'COMPLETE';
  if (has(aa)) return 'DROPOFF LOCATION';
  if (has(ab)) return 'INTRANSIT';
  if (has(z)) return 'PICKUP LOCATION';
  return '';
}

function repairMisplacedDriverStatus(apply) {
  const doIt = apply === true;
  const C = COLUMN.DISPATCH;
  const out = { apply: doIt, rows: 0, statusFixed: 0, statusCleared: 0, inFixed: 0, outFixed: 0, changes: [] };
  return withTripsDocumentLock_(function() {
    const sheet = sidebarTripService.dispatchSheet;
    const last = Math.min(sheet.getMaxRows(), SIDEBAR_DISPATCH_MAX_ROW_);
    const n = last - 1;
    if (n < 1) return out;
    const range = sheet.getRange(2, 1, n, DISPATCH_SORT_COLS_);
    const values = range.getValues();
    const r1c1 = range.getFormulasR1C1();
    // a formula to put back where a value should not be: borrow one from the column
    const templateFor = function(col) {
      for (let r = 0; r < n; r++) { const f = String(r1c1[r][col] || ''); if (f) return f; }
      return '';
    };
    const tpl = { L: templateFor(C.IN), O: templateFor(C.OUT), Q: templateFor(C.STATUS) };
    const fixes = [];   // { row, col, formula|value }
    for (let r = 0; r < n; r++) {
      const row = values[r];
      const passenger = String(row[C.PASSENGER] || '').trim();
      const key = String(row[C.TRIP_KEY_ID] || '').trim();
      const z = row[C.PICKUP_IN_AT], aa = row[C.ARRIVED_AT], ab = row[C.INTRANSIT_AT], ac = row[C.COMPLETED_AT];
      const want = (passenger && key) ? dispatchStatusFromStamps_(z, ab, aa, ac) : '';
      const qIsValue = !String(r1c1[r][C.STATUS] || '');
      const q = String(row[C.STATUS] || '').toUpperCase().trim();
      out.rows += 1;
      // Q: the driver's status
      if (want) {
        if (q !== want) {
          fixes.push({ row: r + 2, col: C.STATUS + 1, value: want });
          out.statusFixed += 1;
          out.changes.push({ row: r + 2, passenger: passenger, was: q, now: want });
        }
      } else if (qIsValue && REPAIR_DRIVER_STATUSES_.indexOf(q) >= 0 && q !== 'IN ROUTE' && tpl.Q) {
        // a driver status with no stamps behind it on this row: it belongs elsewhere
        fixes.push({ row: r + 2, col: C.STATUS + 1, formula: tpl.Q });
        out.statusCleared += 1;
        out.changes.push({ row: r + 2, passenger: passenger, was: q, now: '(formula)' });
      }
      // L: IN mirrors the pick-up stamp; O: OUT mirrors the completed stamp
      const lIsValue = !String(r1c1[r][C.IN] || ''), oIsValue = !String(r1c1[r][C.OUT] || '');
      const has = function(v) { return v !== '' && v !== null && v !== undefined; };
      if (has(z) && passenger && key) {
        if (!lIsValue || String(row[C.IN]) !== String(z)) { fixes.push({ row: r + 2, col: C.IN + 1, value: z, time: true }); out.inFixed += 1; }
      } else if (lIsValue && has(row[C.IN]) && tpl.L) { fixes.push({ row: r + 2, col: C.IN + 1, formula: tpl.L }); out.inFixed += 1; }
      if (has(ac) && passenger && key) {
        if (!oIsValue || String(row[C.OUT]) !== String(ac)) { fixes.push({ row: r + 2, col: C.OUT + 1, value: ac, time: true }); out.outFixed += 1; }
      } else if (oIsValue && has(row[C.OUT]) && tpl.O) { fixes.push({ row: r + 2, col: C.OUT + 1, formula: tpl.O }); out.outFixed += 1; }
    }
    if (doIt && fixes.length) {
      fixes.forEach(function(f) {
        const cell = sheet.getRange(f.row, f.col);
        if (f.formula) cell.setFormulaR1C1(f.formula);
        else { cell.setValue(f.value); if (f.time) cell.setNumberFormat('h:mm AM/PM'); }
      });
      SpreadsheetApp.flush();
      try { snapshotDispatchToLog(false, true); } catch (e) { Logger.log('snapshot: ' + ((e && e.message) || e)); }
      try { invalidateTripsCache_(dispatchWindowKeys_()); } catch (e2) {}
    }
    Logger.log(JSON.stringify(out));
    return out;
  });
}
function repairMisplacedDriverStatusApply() { return repairMisplacedDriverStatus(true); }

// ---- V102b: stamps that skip a step are not a driver's ------------------------
// The driver app only ever offers the next step, so a real row's stamps fill in
// order: Z (pickup in), AB (in transit), AA (arrived), AC (complete). A row with a
// later stamp but an earlier one missing did not get them from a driver. In
// practice they came from the IN/OUT mirror cells (L, O) of another trip: the
// pre-V102 sort left those cells behind, and dispatchRowToTripObject reads L and O
// as the pick-up and completed times when Z and AC are blank, so the next save
// wrote them back as stamps. Such a row is cleared: Z:AC blanked, L, O and Q back
// to the column formulas. Dry run unless apply === true.
function repairSkippedStepStamps(apply) {
  const doIt = apply === true;
  const C = COLUMN.DISPATCH;
  const out = { apply: doIt, rows: 0, cleared: 0, changes: [] };
  return withTripsDocumentLock_(function() {
    const sheet = sidebarTripService.dispatchSheet;
    const last = Math.min(sheet.getMaxRows(), SIDEBAR_DISPATCH_MAX_ROW_);
    const n = last - 1;
    if (n < 1) return out;
    const range = sheet.getRange(2, 1, n, DISPATCH_SORT_COLS_);
    const values = range.getValues();
    const r1c1 = range.getFormulasR1C1();
    const templateFor = function(col) {
      for (let r = 0; r < n; r++) { const f = String(r1c1[r][col] || ''); if (f) return f; }
      return '';
    };
    const tpl = { L: templateFor(C.IN), O: templateFor(C.OUT), Q: templateFor(C.STATUS) };
    const has = function(v) { return v !== '' && v !== null && v !== undefined; };
    const hits = [];
    for (let r = 0; r < n; r++) {
      const row = values[r];
      out.rows += 1;
      const z = has(row[C.PICKUP_IN_AT]), ab = has(row[C.INTRANSIT_AT]);
      const aa = has(row[C.ARRIVED_AT]), ac = has(row[C.COMPLETED_AT]);
      const skipped = (ac && !(z && ab && aa)) || (aa && !(z && ab)) || (ab && !z);
      if (!skipped) continue;
      hits.push(r + 2);
      out.cleared += 1;
      out.changes.push({
        row: r + 2, passenger: String(row[C.PASSENGER] || ''), status: String(row[C.STATUS] || ''),
        stamps: [row[C.PICKUP_IN_AT], row[C.INTRANSIT_AT], row[C.ARRIVED_AT], row[C.COMPLETED_AT]]
          .map(function(v) { return has(v) ? String(v) : ''; })
      });
    }
    if (doIt && hits.length) {
      hits.forEach(function(row) {
        sheet.getRange(row, C.PICKUP_IN_AT + 1, 1, 4).clearContent();
        if (tpl.L) sheet.getRange(row, C.IN + 1).setFormulaR1C1(tpl.L);
        if (tpl.O) sheet.getRange(row, C.OUT + 1).setFormulaR1C1(tpl.O);
        if (tpl.Q) sheet.getRange(row, C.STATUS + 1).setFormulaR1C1(tpl.Q);
      });
      SpreadsheetApp.flush();
      try { snapshotDispatchToLog(false, true); } catch (e) { Logger.log('snapshot: ' + ((e && e.message) || e)); }
      try { invalidateTripsCache_(dispatchWindowKeys_()); } catch (e2) {}
    }
    Logger.log(JSON.stringify(out));
    return out;
  });
}
function repairSkippedStepStampsApply() { return repairSkippedStepStamps(true); }

// ---- Clearing out the trips made while testing (V105) --------------------------
// Test trips are meant to be deleted as soon as the test is over, but once their day
// has passed neither page will touch them: to the dispatcher a past day is history.
// The server only refuses a day that has actually been submitted, so the clean-up
// happens here. It matches on the note a test trip carries, never on the passenger,
// it goes through the app's own delete, and it is a dry run unless apply === true.
const TEST_TRIP_NOTE_ = /\btests?\b/i;

function removeTestTrips(dateKey, apply) {
  const key = Utils.formatDateString(dateKey || '');
  const doIt = apply === true;
  const out = { apply: doIt, date: key, onThatDay: 0, matched: 0, deleted: 0, remove: [], keep: [] };
  if (!key) { Logger.log('removeTestTrips: no date given'); return out; }
  const trips = tripManager.getTripsByDate(key) || [];
  out.onThatDay = trips.length;
  trips.forEach(function(t) {
    const note = String((t && t.notes) || '');
    const row = {
      time: String((t && t.time) || ''), passenger: String((t && t.passenger) || ''),
      driver: String((t && t.driver) || ''), notes: note.slice(0, 60),
      tripKeyID: String((t && t.tripKeyID) || '')
    };
    if (!TEST_TRIP_NOTE_.test(note)) { out.keep.push(row); return; }
    out.matched += 1;
    out.remove.push(row);
  });
  if (doIt) {
    out.remove.forEach(function(row) {
      if (!row.tripKeyID) return;
      try { deleteTripFromSidebar(row.tripKeyID, key); out.deleted += 1; }
      catch (e) { row.error = String((e && e.message) || e); }
    });
    try { invalidateTripsCache_([key]); } catch (e2) {}
  }
  Logger.log(JSON.stringify(out));
  return out;
}

// The picker cannot pass arguments, so the date is named in the button itself.
function findTestTripsOnSep5() { return removeTestTrips('2026-09-05', false); }
function removeTestTripsOnSep5() { return removeTestTrips('2026-09-05', true); }

// ---- Needs Scheduling (V105) ----------------------------------------------------
// A trip the dispatcher knows is coming but cannot place yet: the day, the time, or
// both are still unknown. It must not be saved on a guessed day (the board only
// carries today and tomorrow, and a day that has passed locks as history), and it
// must not carry a made-up time (blank times used to become 11:58 PM - see
// repairBlankStartTimes). So these live on their own hidden tab, keyed by an id,
// with no date that could ever roll into the past. The dispatcher captures what is
// known now, and "Schedule" hands it to the ordinary add-trip path once the rest is
// confirmed - every conflict, blacklist and duplicate check still runs there.
const PENDING_TRIPS_SHEET_ = 'PENDING_TRIPS';
const PENDING_TRIPS_HEADERS_ = ['id', 'createdAt', 'createdBy', 'passenger', 'phone', 'medicaid', 'invoice',
  'transport', 'pickup', 'dropoff', 'vehicle', 'notes', 'pickupNotes', 'dropoffNotes',
  'targetDate', 'targetTime', 'neededBy', 'returnWanted', 'lastChasedAt', 'lastChasedBy', 'updatedAt'];
const PENDING_TRIPS_MAX_ = 500;

function pendingTripsSheet_() {
  const ss = activeSpreadsheet_();
  let sheet = ss.getSheetByName(PENDING_TRIPS_SHEET_);
  if (!sheet) {
    sheet = ss.insertSheet(PENDING_TRIPS_SHEET_);
    sheet.getRange(1, 1, 1, PENDING_TRIPS_HEADERS_.length).setValues([PENDING_TRIPS_HEADERS_]).setFontWeight('bold');
    // Everything is kept as text so Sheets never turns "2026-09-10" into a date
    // serial or "14:30" into a time of day behind our back.
    sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), PENDING_TRIPS_HEADERS_.length).setNumberFormat('@');
    try { sheet.hideSheet(); } catch (e) {}
  }
  return sheet;
}

function pendingActor_() {
  try { const who = currentDispatcherLabel_(); if (who) return String(who); } catch (e) {}
  try { return String(Session.getActiveUser().getEmail() || ''); } catch (e2) {}
  return '';
}

// yyyy-MM-dd or '' - whether the cell held text or a real Date.
function pendingDateKey_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const s = String(value == null ? '' : value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? (m[1] + '-' + m[2] + '-' + m[3]) : '';
}

// HH:mm or '' - same idea for a time.
function pendingTimeKey_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'HH:mm');
  }
  const s = String(value == null ? '' : value).trim();
  const m = s.match(/^(\d{1,2}):(\d{1,2})(?!\d)/);
  if (!m) return '';
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const mm = Math.min(59, Math.max(0, Number(m[2])));
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

function pendingText_(value, max) {
  return String(value == null ? '' : value).replace(/\|/g, '').replace(/\s+/g, ' ').trim().slice(0, max || 500);
}

function pendingRowToItem_(row) {
  const H = PENDING_TRIPS_HEADERS_;
  const get = function(name) { const i = H.indexOf(name); return i >= 0 ? row[i] : ''; };
  const item = {};
  H.forEach(function(name) { item[name] = String(get(name) == null ? '' : get(name)); });
  item.targetDate = pendingDateKey_(get('targetDate'));
  item.neededBy = pendingDateKey_(get('neededBy'));
  item.targetTime = pendingTimeKey_(get('targetTime'));
  item.returnWanted = String(get('returnWanted')).toLowerCase() === 'true';
  return item;
}

function pendingItemToRow_(item) {
  return PENDING_TRIPS_HEADERS_.map(function(name) {
    const v = item[name];
    if (name === 'returnWanted') return v ? 'true' : 'false';
    return String(v == null ? '' : v);
  });
}

function withPendingLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// Every row on the tab, plus the server's idea of today so the page can mark what
// is overdue without trusting the phone's clock.
function listPendingTrips() {
  const sheet = pendingTripsSheet_();
  const last = sheet.getLastRow();
  const items = [];
  if (last >= 2) {
    const rows = sheet.getRange(2, 1, last - 1, PENDING_TRIPS_HEADERS_.length).getValues();
    rows.forEach(function(row) {
      if (!String(row[0] || '').trim()) return;
      const item = pendingRowToItem_(row);
      if (!item.passenger) return;
      items.push(item);
    });
  }
  return {
    items: items,
    today: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  };
}

function pendingRowNumberFor_(sheet, id) {
  const last = sheet.getLastRow();
  if (last < 2 || !id) return 0;
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '') === id) return i + 2;
  }
  return 0;
}

// Create or update. Only the passenger is required; the whole point is that the day
// and time may be missing. Returns the row as it now stands.
function savePendingTrip(input) {
  const src = input || {};
  const passenger = pendingText_(src.passenger, 120);
  if (!passenger) throw new Error('A passenger name is required.');
  const now = new Date().toISOString();
  const who = pendingActor_();
  const clean = {
    id: pendingText_(src.id, 80),
    passenger: passenger,
    phone: pendingText_(src.phone, 40),
    medicaid: pendingText_(src.medicaid, 40),
    invoice: pendingText_(src.invoice, 40),
    transport: pendingText_(src.transport, 40),
    pickup: pendingText_(src.pickup, 200),
    dropoff: pendingText_(src.dropoff, 200),
    vehicle: pendingText_(src.vehicle, 60),
    notes: String(src.notes == null ? '' : src.notes).replace(/\|/g, '').trim().slice(0, 1000),
    pickupNotes: String(src.pickupNotes == null ? '' : src.pickupNotes).replace(/\|/g, '').trim().slice(0, 500),
    dropoffNotes: String(src.dropoffNotes == null ? '' : src.dropoffNotes).replace(/\|/g, '').trim().slice(0, 500),
    targetDate: pendingDateKey_(src.targetDate),
    targetTime: pendingTimeKey_(src.targetTime),
    neededBy: pendingDateKey_(src.neededBy),
    returnWanted: src.returnWanted === true || String(src.returnWanted).toLowerCase() === 'true',
    lastChasedAt: '',
    lastChasedBy: '',
    updatedAt: now,
    createdAt: now,
    createdBy: who
  };
  return withPendingLock_(function() {
    const sheet = pendingTripsSheet_();
    const rowNum = clean.id ? pendingRowNumberFor_(sheet, clean.id) : 0;
    if (rowNum) {
      const cur = pendingRowToItem_(sheet.getRange(rowNum, 1, 1, PENDING_TRIPS_HEADERS_.length).getValues()[0]);
      clean.createdAt = cur.createdAt || now;
      clean.createdBy = cur.createdBy || who;
      clean.lastChasedAt = cur.lastChasedAt || '';
      clean.lastChasedBy = cur.lastChasedBy || '';
      sheet.getRange(rowNum, 1, 1, PENDING_TRIPS_HEADERS_.length).setValues([pendingItemToRow_(clean)]);
      return clean;
    }
    if (sheet.getLastRow() - 1 >= PENDING_TRIPS_MAX_) {
      throw new Error('The Needs Scheduling list is full (' + PENDING_TRIPS_MAX_ + '). Schedule or remove some first.');
    }
    clean.id = Utilities.getUuid();
    sheet.appendRow(pendingItemToRow_(clean));
    return clean;
  });
}

// Note that somebody chased the missing details today.
function touchPendingTrip(id) {
  const key = pendingText_(id, 80);
  if (!key) throw new Error('No pending trip given.');
  return withPendingLock_(function() {
    const sheet = pendingTripsSheet_();
    const rowNum = pendingRowNumberFor_(sheet, key);
    if (!rowNum) throw new Error('That pending trip is no longer on the list.');
    const cur = pendingRowToItem_(sheet.getRange(rowNum, 1, 1, PENDING_TRIPS_HEADERS_.length).getValues()[0]);
    cur.lastChasedAt = new Date().toISOString();
    cur.lastChasedBy = pendingActor_();
    cur.updatedAt = cur.lastChasedAt;
    sheet.getRange(rowNum, 1, 1, PENDING_TRIPS_HEADERS_.length).setValues([pendingItemToRow_(cur)]);
    return cur;
  });
}

// Remove one row. A row already gone is not an error - the page may be a step behind.
function deletePendingTrip(id) {
  const key = pendingText_(id, 80);
  if (!key) return { ok: true, deleted: 0 };
  return withPendingLock_(function() {
    const sheet = pendingTripsSheet_();
    const rowNum = pendingRowNumberFor_(sheet, key);
    if (!rowNum) return { ok: true, deleted: 0 };
    sheet.deleteRow(rowNum);
    return { ok: true, deleted: 1 };
  });
}

// ---- Trip times (V106) ------------------------------------------------------------
// The four taps a driver makes are already stamped on the trip. This keeps a second
// copy of them, one plain row per trip on a TRIP_TIMES tab, with the waits worked
// out as numbers: how long the driver stood at the pickup, how long at the drop-off,
// how long on the road, and how early or late they reached the door. A sheet like
// that can be sorted, filtered and charted; the stamps buried in LOG's JSON cannot.
// Rows are written from the same server calls that save the taps, so no page needs
// to be open. A missing tap leaves its cell blank - never 0 - so it cannot drag an
// average down. Nothing here ever writes to LOG or DISPATCH.
const TRIP_TIMES_SHEET_ = 'TRIP_TIMES';
const TRIP_TIMES_HEADERS_ = ['tripKeyID', 'date', 'scheduled', 'passenger', 'transport', 'driver', 'vehicle',
  'pickup', 'dropoff', 'arrivedPickup', 'leftPickup', 'pickupWaitMin', 'arrivedDropoff', 'completed',
  'dropoffWaitMin', 'onRoadMin', 'totalMin', 'lateByMin', 'ended', 'updatedAt'];
const TRIP_TIMES_TEXT_COLS_ = ['tripKeyID', 'date', 'scheduled', 'arrivedPickup', 'leftPickup', 'arrivedDropoff', 'completed', 'updatedAt'];
const TRIP_TIMES_MAX_GAP_MIN_ = 12 * 60;   // a gap longer than this is a forgotten tap, not a wait
// The backfill starts the week real driver taps began. Values left on a row by an
// earlier trip (the phantom problem fixed in V89/V90) are usually out of order and
// are skipped; the rows that are kept are marked "backfill" in updatedAt so they
// can be told apart from live records.
const TRIP_TIMES_BACKFILL_FROM_ = '2026-08-31';

function tripTimesSheet_() {
  const ss = activeSpreadsheet_();
  let sheet = ss.getSheetByName(TRIP_TIMES_SHEET_);
  if (!sheet) {
    sheet = ss.insertSheet(TRIP_TIMES_SHEET_);
    sheet.getRange(1, 1, 1, TRIP_TIMES_HEADERS_.length).setValues([TRIP_TIMES_HEADERS_]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    // Dates and clock times are kept as text so Sheets never turns "09:47" into a
    // fraction of a day; the minute columns stay real numbers for pivots and charts.
    const rows = Math.max(sheet.getMaxRows() - 1, 1);
    TRIP_TIMES_TEXT_COLS_.forEach(function(name) {
      const c = TRIP_TIMES_HEADERS_.indexOf(name) + 1;
      sheet.getRange(2, c, rows, 1).setNumberFormat('@');
    });
  }
  return sheet;
}

// A stamp as a moment in time, or null. Stamps arrive as local ISO text from LOG
// ("2026-09-07T09:47:00"), as UTC ISO from a Date that went through JSON, or as a
// Date from a sheet cell. A bare "HH:mm" is read against the trip's day.
function ttInstant_(value, dateKey) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.getTime();
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  if (/^\d{1,2}:\d{2}/.test(s) && dateKey) {
    const d = new Date(dateKey + 'T' + (s.length === 4 ? '0' + s : s.slice(0, 5)) + ':00');
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  // A sheet time-of-day that went through JSON: "1899-12-30T13:19:00.000Z". Its T-hours
  // are the wall clock (the same reading the dispatcher page makes), so it is placed
  // on the trip's own day. This is the shape almost every stamp in LOG has.
  if (/^1899-/.test(s)) {
    const m = /T(\d{2}):(\d{2})/.exec(s);
    if (!m || !dateKey) return null;
    const d = new Date(dateKey + 'T' + m[1] + ':' + m[2] + ':00');
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getTime();
}

// The taps in the order a driver can make them. Stamps left on a row by an older
// trip (the phantom problem fixed in V89/V90) are usually out of order, so this is
// the test that keeps them out of the history.
function ttInOrder_(trip) {
  const dateKey = pendingDateKey_(trip && trip.date);
  const seq = [trip.pickupArrival || trip['in'], trip.pickupDeparture, trip.dropoffArrival, trip.dropoffDeparture || trip.out]
    .map(function(v) { return ttInstant_(v, dateKey); }).filter(function(x) { return x != null; });
  for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1]) return false;
  return true;
}

// The trip's booked pickup as a moment: its date plus the hours and minutes of its
// time, whatever shape that time came in ("10:30", "1899-12-30T10:30:00.000Z", a Date).
// Hours and minutes of a trip's booked time, whatever shape it came in: "10:30",
// "1899-12-30T10:30:00.000Z" (a sheet time-of-day, whose T-hours are the wall clock),
// or a Date.
function ttTimeOfDay_(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? '' : Utilities.formatDate(value, Session.getScriptTimeZone(), 'HH:mm');
  const s = String(value == null ? '' : value).trim();
  const m = /(?:^|T)(\d{1,2}):(\d{2})/.exec(s);
  return m ? String(Math.min(23, Number(m[1]))).padStart(2, '0') + ':' + m[2] : '';
}

function ttScheduled_(trip) {
  const dateKey = pendingDateKey_(trip && trip.date);
  const hm = ttTimeOfDay_(trip && trip.time);
  if (!dateKey || !hm) return null;
  const d = new Date(dateKey + 'T' + hm + ':00');
  return isNaN(d.getTime()) ? null : d.getTime();
}

function ttClock_(ms) {
  if (ms == null) return '';
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'HH:mm');
}

// Whole minutes between two moments, or '' when either is missing or the gap is not
// believable (negative, or longer than a shift).
function ttGap_(a, b) {
  if (a == null || b == null) return '';
  const m = Math.round((b - a) / 60000);
  if (m < 0 || m > TRIP_TIMES_MAX_GAP_MIN_) return '';
  return m;
}

// Everything the row holds, worked out from one trip record. Returns null when the
// driver has not reached the door yet - there is nothing to measure before that.
function ttRowFor_(trip) {
  if (!trip) return null;
  const key = String(trip.tripKeyID || '').trim();
  if (!key) return null;
  const dateKey = pendingDateKey_(trip.date);
  // The same fallbacks ptHistoryRow_ uses: older records keep the door and finish
  // times under `in` and `out` (the sheet's L and O columns).
  const arrP = ttInstant_(trip.pickupArrival || trip['in'], dateKey);
  const leftP = ttInstant_(trip.pickupDeparture, dateKey);
  const arrD = ttInstant_(trip.dropoffArrival, dateKey);
  const done = ttInstant_(trip.dropoffDeparture || trip.out, dateKey);
  const ds = String(trip.dispatchStatus || '').toUpperCase().replace(/\s+/g, '');
  const endedAt = ttInstant_(trip.statusAt, dateKey);
  let ended = 'in progress';
  if (ds === 'NOSHOW') ended = 'no-show';
  else if (ds === 'CANCEL' || ds === 'CANCELED' || ds === 'CANCELLED') ended = 'cancelled';
  else if (ds === 'REASSIGN') ended = 'reassigned';
  else if (done != null || String(trip.status || '').toUpperCase() === 'COMPLETE') ended = 'completed';
  if (arrP == null && leftP == null && arrD == null && done == null) return null;

  // A no-show's wait runs from the door to the moment dispatch ended it.
  const pickupWait = (leftP != null) ? ttGap_(arrP, leftP)
    : (ended === 'no-show' || ended === 'cancelled') ? ttGap_(arrP, endedAt) : '';
  const dropoffWait = ttGap_(arrD, done);
  const onRoad = ttGap_(leftP, arrD);
  const finishAt = done != null ? done : (ended !== 'in progress' && ended !== 'completed' ? endedAt : null);
  const total = ttGap_(arrP, finishAt);
  const sched = ttScheduled_(trip);
  const lateBy = (arrP != null && sched != null) ? Math.round((arrP - sched) / 60000) : '';
  const scheduledHm = ttTimeOfDay_(trip.time);

  return {
    tripKeyID: key,
    date: dateKey,
    scheduled: scheduledHm,
    passenger: String(trip.passenger || ''),
    transport: String(trip.transport || ''),
    driver: String(trip.driver || ''),
    vehicle: String(trip.vehicle || ''),
    pickup: String(trip.pickup || ''),
    dropoff: String(trip.dropoff || ''),
    arrivedPickup: ttClock_(arrP),
    leftPickup: ttClock_(leftP),
    pickupWaitMin: pickupWait,
    arrivedDropoff: ttClock_(arrD),
    completed: ttClock_(done),
    dropoffWaitMin: dropoffWait,
    onRoadMin: onRoad,
    totalMin: total,
    lateByMin: (lateBy === '' || Math.abs(lateBy) > TRIP_TIMES_MAX_GAP_MIN_) ? '' : lateBy,
    ended: ended,
    updatedAt: new Date().toISOString()
  };
}

function ttRowArray_(rec) {
  return TRIP_TIMES_HEADERS_.map(function(h) { const v = rec[h]; return v == null ? '' : v; });
}

function ttRowNumberFor_(sheet, key) {
  const last = sheet.getLastRow();
  if (last < 2 || !key) return 0;
  const keys = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < keys.length; i++) if (String(keys[i][0] || '') === key) return i + 2;
  return 0;
}

// Write or refresh one trip's row. Safe to call after every tap: it is quick, it
// takes its own short lock (never the trips lock, which the caller may have just
// released), and it never throws - a failure here must not fail a driver's tap.
// V120: set while a driver's tap is being handled, so background maintenance
// does not run with a phone waiting on it.
var DRIVER_TAP_IN_PROGRESS_ = false;

function tripTimesRecord_(trip) {
  try {
    const rec = ttRowFor_(trip);
    if (!rec) return { ok: true, skipped: true };
    let res = { ok: false, reason: 'not written' };
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return { ok: false, reason: 'busy' };
    try {
      const sheet = tripTimesSheet_();
      const rowNum = ttRowNumberFor_(sheet, rec.tripKeyID);
      const row = ttRowArray_(rec);
      if (rowNum) sheet.getRange(rowNum, 1, 1, row.length).setValues([row]);
      else sheet.appendRow(row);
      res = { ok: true, row: rowNum || sheet.getLastRow(), ended: rec.ended };
    } finally { lock.releaseLock(); }
    // V108: outside the lock, and only when the medians have gone stale.
    // V120 SPEED: this could set a 120-day statistics rebuild running from a
    // driver's button tap, with the driver waiting on it. It belongs on a
    // schedule, not on somebody's tap. rebuildStopTimeStats() is the manual entry
    // point and is safe to put on a nightly trigger.
    if (!DRIVER_TAP_IN_PROGRESS_) stRebuildIfStale_();
    return res;
  } catch (e) {
    Logger.log('tripTimesRecord_: ' + ((e && e.message) || e));
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// Every trip in LOG that has at least one driver tap, written to TRIP_TIMES in one
// go. Dry run unless apply === true; a row already there is refreshed, not doubled.
function backfillTripTimes(apply) {
  const doIt = apply === true;
  const out = { apply: doIt, from: TRIP_TIMES_BACKFILL_FROM_, logRows: 0, tripsSeen: 0, withTaps: 0, beforeStart: 0, outOfOrder: 0, written: 0, refreshed: 0, byEnded: {}, sample: [], recent: {} };
  // Dry-run diagnostics: for days from the start date on, which timing fields the
  // records carry at all, so an empty result can be explained.
  const RECENT_KEYS_ = ['pickupArrival', 'pickupDeparture', 'dropoffArrival', 'dropoffDeparture', 'in', 'out', 'status', 'dispatchStatus'];
  const sheet = tripManager.logSheet;
  const lastRow = sheet.getLastRow();
  const recs = [];
  for (let start = 2; start <= lastRow; start += 200) {
    const n = Math.min(200, lastRow - start + 1);
    const block = sheet.getRange(start, 1, n, 2).getValues();
    for (let i = 0; i < n; i++) {
      const json = String(block[i][1] || '');
      if (!json) continue;
      out.logRows += 1;
      let map;
      try { map = deserializeTripMap(json); } catch (e) { continue; }
      map.forEach(function(trip) {
        if (!trip || !String(trip.passenger || '').trim()) return;
        out.tripsSeen += 1;
        const dk = pendingDateKey_(trip.date);
        if (dk >= TRIP_TIMES_BACKFILL_FROM_) {
          const r = out.recent[dk] || (out.recent[dk] = { trips: 0 });
          r.trips += 1;
          RECENT_KEYS_.forEach(function(k) { if (String(trip[k] == null ? '' : trip[k]).trim()) r[k] = (r[k] || 0) + 1; });
          if (!r.example && String(trip.status || '').toUpperCase() === 'COMPLETE') r.example = { passenger: trip.passenger, keys: Object.keys(trip).filter(function(k) { return /arriv|depart|^in$|^out$|At$/i.test(k) && String(trip[k] || '').trim(); }).map(function(k) { return k + '=' + String(trip[k]).slice(0, 24); }) };
        }
        const rec = ttRowFor_(trip);
        if (!rec) return;
        out.withTaps += 1;
        if (rec.date < TRIP_TIMES_BACKFILL_FROM_) { out.beforeStart += 1; return; }
        if (!ttInOrder_(trip)) { out.outOfOrder += 1; return; }
        rec.updatedAt = 'backfill ' + rec.updatedAt;
        out.byEnded[rec.ended] = (out.byEnded[rec.ended] || 0) + 1;
        if (out.sample.length < 5) out.sample.push({ date: rec.date, passenger: rec.passenger, driver: rec.driver, pickupWaitMin: rec.pickupWaitMin, dropoffWaitMin: rec.dropoffWaitMin, ended: rec.ended });
        recs.push(rec);
      });
    }
  }
  if (doIt && recs.length) {
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const tt = tripTimesSheet_();
      const existing = {};
      const last = tt.getLastRow();
      if (last >= 2) tt.getRange(2, 1, last - 1, 1).getValues().forEach(function(r, i) { if (r[0]) existing[String(r[0])] = i + 2; });
      const fresh = [];
      recs.forEach(function(rec) {
        const rowNum = existing[rec.tripKeyID];
        if (rowNum) { tt.getRange(rowNum, 1, 1, TRIP_TIMES_HEADERS_.length).setValues([ttRowArray_(rec)]); out.refreshed += 1; }
        else fresh.push(ttRowArray_(rec));
      });
      if (fresh.length) {
        tt.getRange(tt.getLastRow() + 1, 1, fresh.length, TRIP_TIMES_HEADERS_.length).setValues(fresh);
        out.written = fresh.length;
      }
    } finally { lock.releaseLock(); }
  }
  Logger.log(JSON.stringify(out));
  return out;
}
function backfillTripTimesApply() { return backfillTripTimes(true); }

// ---- What a stop really takes (V108) -----------------------------------------
// V106 gave the conflict checker a flat allowance at every stop: 5 minutes standing
// at the pickup, 3 at the drop-off, for everybody, everywhere. Real stops are not
// alike - a wheelchair passenger at a nursing home is not a walk-out at a house -
// and TRIP_TIMES now records what each one actually took. This turns that history
// into a number the checker can plan on, and says where the number came from.
//
// Three things keep it honest:
//   * a driver who arrives early is not charged for the wait before the booked
//     time - the stop is measured from the later of arrival and scheduled;
//   * no-shows, cancellations and unfinished trips are left out, because a forty
//     minute no-show is not a boarding time;
//   * a wait longer than ST_MAX_SAMPLE_MIN_ is a forgotten tap and is dropped, and
//     the answer is kept inside a sane band either way, so one bad row cannot make
//     the checker talk nonsense.
//
// The medians are worked out once and parked on their own STOP_TIMES tab, so a
// dispatcher's save never pays for reading the history; the rebuild rides along
// with a driver's tap, at most once every ST_REBUILD_HOURS_. Anything at all going
// wrong in here falls back to the V106 fixed allowance: this can only make the
// checker better informed, never stop a save.
const STOP_TIMES_SHEET_ = 'STOP_TIMES';
const STOP_TIMES_HEADERS_ = ['scope', 'which', 'key', 'label', 'trips', 'medianMin', 'minutes', 'builtAt'];
const ST_WINDOW_DAYS_ = 120;       // history older than this no longer describes today
const ST_MAX_SAMPLE_MIN_ = 45;     // a longer "wait" is a forgotten tap, not a stop
const ST_MIN_SAMPLES_ = 5;         // trips needed before a learned number is trusted
const ST_MIN_SAMPLES_ALL_ = 10;    // the company-wide figure needs more than one passenger's worth
const ST_FLOOR_MIN_ = 1;           // the band a learned answer is kept inside
const ST_CEIL_MIN_ = 30;
const ST_REBUILD_HOURS_ = 12;
const ST_BUILT_PROP_ = 'stopTimes:builtAt:v1';
let ST_MAP_ = null;                // memoised for one execution only, never longer

function stopTimesSheet_(create) {
  const ss = activeSpreadsheet_();
  let sheet = ss.getSheetByName(STOP_TIMES_SHEET_);
  if (!sheet && create) {
    sheet = ss.insertSheet(STOP_TIMES_SHEET_);
    sheet.getRange(1, 1, 1, STOP_TIMES_HEADERS_.length).setValues([STOP_TIMES_HEADERS_]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    const rows = Math.max(sheet.getMaxRows() - 1, 1);
    ['scope', 'which', 'key', 'label', 'builtAt'].forEach(function(name) {
      sheet.getRange(2, STOP_TIMES_HEADERS_.indexOf(name) + 1, rows, 1).setNumberFormat('@');
    });
  }
  return sheet || null;
}

function stNorm_(v) { return String(v == null ? '' : v).toLowerCase().replace(/\s+/g, ' ').trim(); }
function stAddrKey_(v) { return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function stKey_(scope, which, key) { return scope + '|' + which + '|' + key; }
function stNum_(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function stMedian_(list) {
  if (!list.length) return null;
  const s = list.slice().sort(function(a, b) { return a - b; });
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function stClamp_(v) { return Math.max(ST_FLOOR_MIN_, Math.min(ST_CEIL_MIN_, Math.round(v))); }

// Reads TRIP_TIMES once and works out the median stop at every level it can answer
// at: this passenger at this address, this passenger anywhere, this address for
// anyone, and the company as a whole. Returns the rows a rebuild would write.
function stBuildStats_() {
  const out = { rows: [], scanned: 0, used: 0, builtAt: new Date().toISOString() };
  const ss = activeSpreadsheet_();
  const tt = ss.getSheetByName(TRIP_TIMES_SHEET_);
  if (!tt) return out;
  const last = tt.getLastRow();
  if (last < 2) return out;
  const values = tt.getRange(2, 1, last - 1, TRIP_TIMES_HEADERS_.length).getValues();
  const col = {};
  TRIP_TIMES_HEADERS_.forEach(function(h, i) { col[h] = i; });
  const cutoffKey = Utilities.formatDate(new Date(Date.now() - ST_WINDOW_DAYS_ * 86400000),
    Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const buckets = {};
  const add = function(scope, which, key, label, value) {
    if (!key) return;
    const k = stKey_(scope, which, key);
    if (!buckets[k]) buckets[k] = { scope: scope, which: which, key: key, label: label, samples: [] };
    buckets[k].samples.push(value);
  };

  values.forEach(function(r) {
    out.scanned += 1;
    // Only trips a driver actually finished describe a normal stop.
    if (String(r[col.ended] || '').toLowerCase() !== 'completed') return;
    const date = String(r[col.date] || '').slice(0, 10);
    if (date && date < cutoffKey) return;
    const passengerText = String(r[col.passenger] || '');
    const passenger = stNorm_(passengerText);
    const late = stNum_(r[col.lateByMin]);
    const early = late == null ? 0 : Math.max(0, -late);   // arrived before the booked time
    let counted = false;

    const pw = stNum_(r[col.pickupWaitMin]);
    if (pw != null) {
      const eff = Math.max(0, pw - early);                 // the wait the passenger caused
      if (eff <= ST_MAX_SAMPLE_MIN_) {
        const addrText = String(r[col.pickup] || '');
        const addr = stAddrKey_(addrText);
        if (passenger && addr) add('passenger+address', 'pickup', passenger + '|' + addr, passengerText + ' at ' + addrText, eff);
        if (passenger) add('passenger', 'pickup', passenger, passengerText, eff);
        if (addr) add('address', 'pickup', addr, addrText, eff);
        add('all', 'pickup', 'all', 'every pickup', eff);
        counted = true;
      }
    }

    const dw = stNum_(r[col.dropoffWaitMin]);
    if (dw != null && dw >= 0 && dw <= ST_MAX_SAMPLE_MIN_) {
      const addrText = String(r[col.dropoff] || '');
      const addr = stAddrKey_(addrText);
      if (passenger && addr) add('passenger+address', 'dropoff', passenger + '|' + addr, passengerText + ' at ' + addrText, dw);
      if (passenger) add('passenger', 'dropoff', passenger, passengerText, dw);
      if (addr) add('address', 'dropoff', addr, addrText, dw);
      add('all', 'dropoff', 'all', 'every drop-off', dw);
      counted = true;
    }
    if (counted) out.used += 1;
  });

  const rank = { 'passenger+address': 0, 'passenger': 1, 'address': 2, 'all': 3 };
  Object.keys(buckets).forEach(function(k) {
    const b = buckets[k];
    const need = b.scope === 'all' ? ST_MIN_SAMPLES_ALL_ : ST_MIN_SAMPLES_;
    if (b.samples.length < need) return;
    const med = stMedian_(b.samples);
    out.rows.push([b.scope, b.which, b.key, b.label, b.samples.length,
      Math.round(med * 10) / 10, stClamp_(med), out.builtAt]);
  });
  out.rows.sort(function(a, b) {
    if (rank[a[0]] !== rank[b[0]]) return rank[a[0]] - rank[b[0]];
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return b[4] - a[4];
  });
  return out;
}

// Work the medians out and put them on the tab. Safe to run by hand at any time;
// it only ever rewrites derived numbers, and never touches LOG or DISPATCH.
function rebuildStopTimeStats() {
  const built = stBuildStats_();
  const sheet = stopTimesSheet_(true);
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, STOP_TIMES_HEADERS_.length).clearContent();
  if (built.rows.length) sheet.getRange(2, 1, built.rows.length, STOP_TIMES_HEADERS_.length).setValues(built.rows);
  PropertiesService.getScriptProperties().setProperty(ST_BUILT_PROP_, built.builtAt);
  ST_MAP_ = null;
  const res = { ok: true, entries: built.rows.length, tripsScanned: built.scanned, tripsUsed: built.used, builtAt: built.builtAt };
  Logger.log(JSON.stringify(res));
  return res;
}

function stStatsAreStale_() {
  try {
    const at = PropertiesService.getScriptProperties().getProperty(ST_BUILT_PROP_);
    if (!at) return true;
    const t = Date.parse(at);
    if (!t) return true;
    return (Date.now() - t) > ST_REBUILD_HOURS_ * 3600000;
  } catch (e) { return false; }
}

// Called after a trip's row is written. It takes the lock only if it is free, so a
// driver's tap is never held up, and it never throws.
function stRebuildIfStale_() {
  try {
    if (!stStatsAreStale_()) return;
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(1000)) return;
    try { if (stStatsAreStale_()) rebuildStopTimeStats(); } finally { lock.releaseLock(); }
  } catch (e) { Logger.log('stRebuildIfStale_: ' + ((e && e.message) || e)); }
}

function stMap_() {
  if (ST_MAP_) return ST_MAP_;
  const map = {};
  try {
    const sheet = stopTimesSheet_(false);
    if (sheet) {
      const last = sheet.getLastRow();
      if (last > 1) {
        sheet.getRange(2, 1, last - 1, STOP_TIMES_HEADERS_.length).getValues().forEach(function(r) {
          const scope = String(r[0] || ''), which = String(r[1] || ''), key = String(r[2] || '');
          if (!scope || !which || !key) return;
          const trips = stNum_(r[4]), mins = stNum_(r[6]);
          if (trips == null || mins == null || mins <= 0) return;
          map[stKey_(scope, which, key)] = { minutes: mins, trips: trips, label: String(r[3] || '') };
        });
      }
    }
  } catch (e) { Logger.log('stMap_: ' + ((e && e.message) || e)); }
  ST_MAP_ = map;
  return map;
}

function stFirstName_(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return '';
  const part = s.indexOf(',') >= 0 ? s.split(',')[1] : s;   // "Smith, Mary" -> "Mary"
  return String(part || '').trim().split(/\s+/)[0] || '';
}
function stPossessive_(name) {
  if (!name) return '';
  return /s$/i.test(name) ? name + "'" : name + "'s";
}

// The allowance for one stop, with a plain note about where the number came from.
// The most specific level that has enough history wins; short of that it falls all
// the way through to the fixed V106 numbers, which is also what any failure gives.
function planStopInfo_(trip, which) {
  const fixed = which === 'pickup' ? PLAN_STOP_PICKUP_MIN_ : PLAN_STOP_DROPOFF_MIN_;
  try {
    const map = stMap_();
    const passenger = stNorm_(trip && trip.passenger);
    const addr = stAddrKey_(which === 'pickup' ? (trip && trip.pickup) : (trip && trip.dropoff));
    const who = stPossessive_(stFirstName_(trip && trip.passenger));
    const tries = [];
    if (passenger && addr) tries.push({ k: stKey_('passenger+address', which, passenger + '|' + addr), why: (who || 'the') + ' average there' });
    if (passenger) tries.push({ k: stKey_('passenger', which, passenger), why: (who || 'their') + ' average' });
    if (addr) tries.push({ k: stKey_('address', which, addr), why: 'the usual at that address' });
    tries.push({ k: stKey_('all', which, 'all'), why: 'our average' });
    for (let i = 0; i < tries.length; i++) {
      const hit = map[tries[i].k];
      if (!hit) continue;
      return { minutes: hit.minutes, trips: hit.trips, learned: true,
        why: tries[i].why + ' over ' + hit.trips + ' trips' };
    }
  } catch (e) { Logger.log('planStopInfo_: ' + ((e && e.message) || e)); }
  return { minutes: fixed, trips: 0, learned: false, why: 'our standard' };
}

// What is on the tab right now, for a look from the editor. Reads nothing else.
function stopTimeStatsReport() {
  const map = stMap_();
  const keys = Object.keys(map);
  const out = {
    entries: keys.length,
    builtAt: PropertiesService.getScriptProperties().getProperty(ST_BUILT_PROP_) || '(never built)',
    sample: keys.slice(0, 25).map(function(k) { return k + ' -> ' + map[k].minutes + ' min from ' + map[k].trips + ' trips'; })
  };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

// ---- Private Pay pricing (V110) ----------------------------------------------
// One place decides what a private-pay trip costs. Everything the business can
// change lives in a script property; nothing about the money is hard-coded except
// the shape of the rules. Insurance, Medicaid, broker and facility trips never
// come near this code - the engine returns null unless the trip says privatePay.
//
// Three ideas hold it together:
//   * a RULE CATALOGUE (below) names every chargeable factor once, with its group,
//     its wording, and whether the system can spot it on its own;
//   * each rule has a MODE - 'auto' (added when the trip says it applies),
//     'optional' (offered to the dispatcher, never added by itself) or 'off'
//     (does not exist: not charged, not offered, not shown);
//   * a quote is a LIST OF LINES, each with its own explanation, so the price can
//     always be read back rather than taken on trust.
// The same inputs always produce the same lines in the same order.
const PRICING_PROP_ = 'privatePay:pricing:v1';
const PRICING_MAX_PERCENT_ = 200;      // a sanity ceiling for percentage rules
const PRICING_MAX_AMOUNT_ = 100000;    // and for dollar amounts
const PRICING_TRANSPORTS_ = ['ambulatory', 'wheelchair', 'stretcher', 'taxi', 'other'];
const PRICING_MODES_ = ['auto', 'optional', 'off'];

// group, label, what the sheet says under it, whether the system can detect it,
// and whether it takes money off rather than putting it on.
const PRICING_RULES_ = [
  { key: 'afterHours',   group: 'Scheduling',  label: 'After hours',          auto: true },
  { key: 'weekend',      group: 'Scheduling',  label: 'Weekend',              auto: true },
  { key: 'holiday',      group: 'Scheduling',  label: 'Holiday',              auto: true },
  { key: 'sameDay',      group: 'Scheduling',  label: 'Same-day request',     auto: true },
  { key: 'shortNotice',  group: 'Scheduling',  label: 'Short notice',         auto: false },
  { key: 'doorToDoor',   group: 'Assistance',  label: 'Door-to-door',         auto: false },
  { key: 'doorThrough',  group: 'Assistance',  label: 'Door-through-door',    auto: false },
  { key: 'stairs',       group: 'Assistance',  label: 'Stair assistance',     auto: false },
  { key: 'attendant',    group: 'Assistance',  label: 'Extra attendant',      auto: false },
  { key: 'companion',    group: 'Assistance',  label: 'Companion / escort',   auto: false },
  { key: 'extraPax',     group: 'Assistance',  label: 'Additional passenger', auto: false },
  { key: 'bariatric',    group: 'Equipment',   label: 'Bariatric',            auto: false },
  { key: 'oxygen',       group: 'Equipment',   label: 'Oxygen',               auto: false },
  { key: 'powerChair',   group: 'Equipment',   label: 'Power / oversized chair', auto: false },
  { key: 'equipment',    group: 'Equipment',   label: 'Special equipment',    auto: false },
  { key: 'extraStop',    group: 'Trip',        label: 'Additional stop',      auto: false },
  { key: 'waitReturn',   group: 'Trip',        label: 'Wait and return',      auto: false },
  { key: 'tolls',        group: 'Pass-through', label: 'Tolls',               auto: false },
  { key: 'parking',      group: 'Pass-through', label: 'Parking',             auto: false },
  { key: 'cleaning',     group: 'Other',       label: 'Cleaning / biohazard', auto: false },
  { key: 'custom',       group: 'Other',       label: 'Additional service',   auto: false },
  { key: 'recurring',    group: 'Discounts',   label: 'Recurring trip',       auto: true,  discount: true },
  { key: 'facility',     group: 'Discounts',   label: 'Facility / volume',    auto: false, discount: true },
  { key: 'otherDisc',    group: 'Discounts',   label: 'Other discount',       auto: false, discount: true }
];

function pricingRule_(key) {
  for (let i = 0; i < PRICING_RULES_.length; i++) if (PRICING_RULES_[i].key === key) return PRICING_RULES_[i];
  return null;
}

// Sensible opening numbers so the screen is never blank. Every one of them is
// meant to be changed; none of them is used unless its rule is switched on.
function pricingDefaults_() {
  const rules = {};
  const seed = {
    afterHours:  { mode: 'auto',     kind: 'fixed',   amount: 20 },
    weekend:     { mode: 'auto',     kind: 'percent', amount: 15 },
    holiday:     { mode: 'auto',     kind: 'fixed',   amount: 40 },
    sameDay:     { mode: 'optional', kind: 'fixed',   amount: 25 },
    shortNotice: { mode: 'off',      kind: 'fixed',   amount: 15 },
    doorToDoor:  { mode: 'off',      kind: 'fixed',   amount: 0 },
    doorThrough: { mode: 'optional', kind: 'fixed',   amount: 15 },
    stairs:      { mode: 'optional', kind: 'fixed',   amount: 25 },
    attendant:   { mode: 'optional', kind: 'fixed',   amount: 35 },
    companion:   { mode: 'optional', kind: 'fixed',   amount: 10 },
    extraPax:    { mode: 'optional', kind: 'fixed',   amount: 10 },
    bariatric:   { mode: 'optional', kind: 'fixed',   amount: 75 },
    oxygen:      { mode: 'optional', kind: 'fixed',   amount: 20 },
    powerChair:  { mode: 'optional', kind: 'fixed',   amount: 30 },
    equipment:   { mode: 'optional', kind: 'fixed',   amount: 25 },
    extraStop:   { mode: 'optional', kind: 'fixed',   amount: 12 },
    waitReturn:  { mode: 'optional', kind: 'fixed',   amount: 40 },
    tolls:       { mode: 'optional', kind: 'fixed',   amount: 0 },
    parking:     { mode: 'optional', kind: 'fixed',   amount: 0 },
    cleaning:    { mode: 'optional', kind: 'fixed',   amount: 100 },
    custom:      { mode: 'optional', kind: 'fixed',   amount: 0 },
    recurring:   { mode: 'off',      kind: 'percent', amount: 10 },
    facility:    { mode: 'off',      kind: 'percent', amount: 0 },
    otherDisc:   { mode: 'off',      kind: 'fixed',   amount: 0 }
  };
  PRICING_RULES_.forEach(function(r) { rules[r.key] = seed[r.key] || { mode: 'off', kind: 'fixed', amount: 0 }; });
  return {
    version: 1,
    updatedAt: '',
    updatedBy: '',
    base: { ambulatory: 45, wheelchair: 65, stretcher: 150, taxi: 35, other: 45 },
    mileage: { mode: 'auto', includedMiles: 5, perMile: 3, minimumFare: 0 },
    // V118: the empty run out to the passenger. It has its own allowance and its
    // own rate because most operators bill it below the loaded rate, and it is
    // 'off' out of the box so nothing about anybody's existing prices changes.
    // The miles are typed by the dispatcher - nothing measures them.
    deadhead: { mode: 'off', includedMiles: 0, perMile: 1.5 },
    wait: { mode: 'off', graceMin: 15, intervalMin: 15, rate: 10 },
    afterHoursFrom: '19:00',
    afterHoursTo: '06:00',
    holidays: [],
    rules: rules
  };
}

function pricingNum_(v, fallback) {
  // V120: Number('') is 0 and isFinite(0) is true, so a blank box used to read as
  // a real zero and the fallback never fired. A cleared base-fare box then quoted
  // every trip at nothing.
  const s = String(v == null ? '' : v).replace(/[^0-9.\-]/g, '').trim();
  const dflt = arguments.length > 1 ? fallback : 0;
  if (s === '' || s === '-' || s === '.' || s === '-.') return dflt === undefined ? 0 : dflt;
  const n = Number(s);
  return isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
}
function pricingMode_(v) {
  const s = String(v == null ? '' : v).toLowerCase().trim();
  return PRICING_MODES_.indexOf(s) >= 0 ? s : 'off';
}
function pricingKind_(v) { return String(v || '').toLowerCase() === 'percent' ? 'percent' : 'fixed'; }
function pricingHm_(v, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? '' : v).trim());
  if (!m) return fallback;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return fallback;
  return String(h).padStart(2, '0') + ':' + m[2];
}
function pricingMoney_(n) {
  // V120: Math.round(1.005 * 100) is 100.4999..., so a half cent used to be lost,
  // and negatives rounded the other way - discounts drifted one way and charges
  // the other. Round the magnitude half-up, then restore the sign.
  const v = Number(n);
  if (!isFinite(v)) return 0;
  const cents = Math.round(Math.abs(v) * 100 + 1e-9);
  return (v < 0 ? -cents : cents) / 100;
}

// The stored config, filled out against the defaults so a half-written record or a
// config from an older build can never crash a quote.
function pricingConfig() {
  const out = pricingDefaults_();
  let stored = null;
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(PRICING_PROP_);
    stored = raw ? JSON.parse(raw) : null;
  } catch (e) { Logger.log('pricingConfig: ' + ((e && e.message) || e)); }
  if (!stored || typeof stored !== 'object') return out;
  out.version = pricingNum_(stored.version, 1) || 1;
  out.updatedAt = String(stored.updatedAt || '');
  out.updatedBy = String(stored.updatedBy || '');
  if (stored.base) PRICING_TRANSPORTS_.forEach(function(k) {
    if (stored.base[k] != null && stored.base[k] !== '') out.base[k] = pricingNum_(stored.base[k], out.base[k]);
  });
  if (stored.mileage) {
    out.mileage.mode = pricingMode_(stored.mileage.mode);
    out.mileage.includedMiles = pricingNum_(stored.mileage.includedMiles, out.mileage.includedMiles);
    out.mileage.perMile = pricingNum_(stored.mileage.perMile, out.mileage.perMile);
    out.mileage.minimumFare = pricingNum_(stored.mileage.minimumFare, out.mileage.minimumFare);
  }
  if (stored.deadhead) {
    // Two states only, in effect: nothing is charged until a number is typed, so
    // 'auto' would mean the same thing as 'optional' and is read as it.
    out.deadhead.mode = pricingMode_(stored.deadhead.mode) === 'off' ? 'off' : 'optional';
    out.deadhead.includedMiles = pricingNum_(stored.deadhead.includedMiles, out.deadhead.includedMiles);
    out.deadhead.perMile = pricingNum_(stored.deadhead.perMile, out.deadhead.perMile);
  }
  if (stored.wait) {
    out.wait.mode = pricingMode_(stored.wait.mode);
    out.wait.graceMin = pricingNum_(stored.wait.graceMin, out.wait.graceMin);
    out.wait.intervalMin = pricingNum_(stored.wait.intervalMin, out.wait.intervalMin) || 1;
    out.wait.rate = pricingNum_(stored.wait.rate, out.wait.rate);
  }
  out.afterHoursFrom = pricingHm_(stored.afterHoursFrom, out.afterHoursFrom);
  out.afterHoursTo = pricingHm_(stored.afterHoursTo, out.afterHoursTo);
  if (Array.isArray(stored.holidays)) out.holidays = stored.holidays.map(function(d) { return String(d || '').slice(0, 10); }).filter(Boolean).slice(0, 60);
  if (stored.rules) PRICING_RULES_.forEach(function(r) {
    const s = stored.rules[r.key];
    if (!s) return;
    out.rules[r.key] = {
      mode: pricingMode_(s.mode),
      kind: pricingKind_(s.kind),
      amount: pricingNum_(s.amount, 0)
    };
    // A rule the system cannot detect can never be automatic, whatever is stored.
    if (!r.auto && out.rules[r.key].mode === 'auto') out.rules[r.key].mode = 'optional';
  });
  return out;
}

// Everything the page needs to draw the settings screen and the price sheet.
function getPricingSettings() {
  return { config: pricingConfig(), rules: PRICING_RULES_, transports: PRICING_TRANSPORTS_ };
}

// What is wrong with a proposed config, in words a dispatcher can act on. An empty
// list means it is safe to save.
function pricingProblems_(cfg) {
  const bad = [];
  PRICING_TRANSPORTS_.forEach(function(k) {
    const v = pricingNum_(cfg.base[k], -1);
    const name = k === 'other' ? 'the catch-all transport' : k;
    if (v < 0) bad.push('The base price for ' + name + ' cannot be negative.');
    // V120: a cleared box used to save as a real 0 and quote those trips at
    // nothing. Refusing the save outright would have been worse - an operator who
    // genuinely does not run stretcher trips could not record that, and anyone
    // whose config already held a 0 from the old bug could never save again. The
    // quote itself flags it instead (see ppQuote_).
    if (v > PRICING_MAX_AMOUNT_) bad.push('The base price for ' + name + ' is unreasonably large.');
  });
  // V120: a time typed as "7pm" or "19.00" was silently thrown away and the old
  // window kept, so a dispatcher believed a change had taken effect when it had not.
  ['afterHoursFrom', 'afterHoursTo'].forEach(function(k) {
    const label = k === 'afterHoursFrom' ? 'start' : 'end';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(cfg[k] || ''))) {
      bad.push('The after-hours ' + label + ' time must be typed as HH:MM on a 24-hour clock, for example 19:00.');
    }
  });
  if (cfg.afterHoursFrom && cfg.afterHoursFrom === cfg.afterHoursTo) {
    bad.push('The after-hours window starts and ends at the same time, so it would never apply.');
  }
  if (cfg.mileage.mode !== 'off') {
    if (cfg.mileage.perMile < 0) bad.push('The per-mile rate cannot be negative.');
    if (cfg.mileage.includedMiles < 0) bad.push('Included miles cannot be negative.');
    if (cfg.mileage.minimumFare < 0) bad.push('The minimum fare cannot be negative.');
    if (cfg.mileage.perMile === 0 && cfg.mileage.mode === 'auto') bad.push('Mileage is switched on but the per-mile rate is 0 - set a rate or switch mileage off.');
  }
  if (cfg.deadhead.mode !== 'off') {
    if (cfg.deadhead.perMile < 0) bad.push('The deadhead per-mile rate cannot be negative.');
    if (cfg.deadhead.includedMiles < 0) bad.push('Included deadhead miles cannot be negative.');
    if (cfg.deadhead.perMile > PRICING_MAX_AMOUNT_) bad.push('The deadhead per-mile rate is unreasonably large.');
    if (cfg.deadhead.perMile === 0) bad.push('Deadhead mileage is switched on but the per-mile rate is 0 - set a rate or switch it off.');
  }
  if (cfg.wait.mode !== 'off') {
    if (cfg.wait.rate < 0) bad.push('The waiting-time charge cannot be negative.');
    if (cfg.wait.graceMin < 0) bad.push('The free waiting period cannot be negative.');
    if (cfg.wait.intervalMin <= 0) bad.push('The waiting-time interval must be at least 1 minute.');
    if (cfg.wait.rate === 0 && cfg.wait.mode === 'auto') bad.push('Waiting time is switched on but the charge is 0 - set a charge or switch it off.');
  }
  PRICING_RULES_.forEach(function(r) {
    const s = cfg.rules[r.key];
    if (!s || s.mode === 'off') return;
    if (s.amount < 0) bad.push(r.label + ' cannot be a negative amount.');
    if (s.kind === 'percent' && s.amount > PRICING_MAX_PERCENT_) bad.push(r.label + ' is set to ' + s.amount + '% - that is outside a sensible range.');
    if (s.kind === 'fixed' && s.amount > PRICING_MAX_AMOUNT_) bad.push(r.label + ' is an unreasonably large amount.');
    if (s.amount === 0 && s.mode === 'auto') bad.push(r.label + ' is set to apply automatically but its amount is 0 - give it an amount or make it optional.');
    // V120: 0.15 typed for a 15% rule charged fifteen hundredths of one percent.
    if (s.kind === 'percent' && s.amount > 0 && s.amount < 1) bad.push(r.label + ' is set to ' + s.amount + '%. Percentages are typed as whole numbers, so 15% is "15", not "0.15".');
  });
  return bad;
}

// Save the settings. Refuses an invalid config outright and reports why; a good
// save bumps the version, which is what every later quote records against itself.
function savePricingSettings(input) {
  const current = pricingConfig();
  // V120: this used to start from the factory defaults, so any field an older or
  // half-loaded page did not send was silently reset to the shipped number rather
  // than keeping the operator's own.
  const next = JSON.parse(JSON.stringify(current));
  const src = input && typeof input === 'object' ? input : {};
  next.version = current.version;
  // V120: an emptied box used to be skipped, so the old price stayed and the save
  // still reported success - the dispatcher believed they had cleared it. Say so.
  const blankBase_ = [];
  if (src.base) PRICING_TRANSPORTS_.forEach(function(k) {
    if (src.base[k] == null) return;
    if (String(src.base[k]).trim() === '') {
      blankBase_.push('The base price for ' + (k === 'other' ? 'the catch-all transport' : k) + ' is blank. Type a price, or 0 if you do not run that service.');
      return;
    }
    next.base[k] = pricingNum_(src.base[k], next.base[k]);
  });
  if (blankBase_.length) return { ok: false, problems: blankBase_ };
  if (src.mileage) {
    next.mileage.mode = pricingMode_(src.mileage.mode);
    next.mileage.includedMiles = pricingNum_(src.mileage.includedMiles, 0);
    next.mileage.perMile = pricingNum_(src.mileage.perMile, 0);
    next.mileage.minimumFare = pricingNum_(src.mileage.minimumFare, 0);
  }
  if (src.deadhead) {
    next.deadhead.mode = pricingMode_(src.deadhead.mode) === 'off' ? 'off' : 'optional';
    next.deadhead.includedMiles = pricingNum_(src.deadhead.includedMiles, 0);
    next.deadhead.perMile = pricingNum_(src.deadhead.perMile, 0);
  }
  if (src.wait) {
    next.wait.mode = pricingMode_(src.wait.mode);
    next.wait.graceMin = pricingNum_(src.wait.graceMin, 0);
    next.wait.intervalMin = pricingNum_(src.wait.intervalMin, 0);
    next.wait.rate = pricingNum_(src.wait.rate, 0);
  }
  // V120: pricingHm_ substitutes the old value for anything it cannot read, so a
  // time typed as "7pm" used to be swallowed and the save reported as successful
  // while nothing had changed. Check what was actually typed, before that happens.
  const badTimes_ = [];
  [['afterHoursFrom', 'start'], ['afterHoursTo', 'end']].forEach(function(pair) {
    const typed = src[pair[0]];
    if (typed == null) return;
    if (String(typed).trim() === '') {
      // The same silent revert this check was written to stop, one field over:
      // an emptied box used to be swallowed and the old window quietly kept.
      badTimes_.push('The after-hours ' + pair[1] + ' time is blank. Type it as HH:MM on a 24-hour clock, for example 19:00.');
      return;
    }
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(typed).trim())) {
      badTimes_.push('The after-hours ' + pair[1] + ' time "' + String(typed) + '" is not a time. Type it as HH:MM on a 24-hour clock, for example 19:00.');
    }
  });
  if (badTimes_.length) return { ok: false, problems: badTimes_ };
  next.afterHoursFrom = pricingHm_(src.afterHoursFrom, next.afterHoursFrom);
  next.afterHoursTo = pricingHm_(src.afterHoursTo, next.afterHoursTo);
  if (Array.isArray(src.holidays)) next.holidays = src.holidays.map(function(d) { return String(d || '').slice(0, 10); }).filter(function(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }).slice(0, 60);
  if (src.rules) PRICING_RULES_.forEach(function(r) {
    const s = src.rules[r.key];
    if (!s) return;
    const mode = pricingMode_(s.mode);
    next.rules[r.key] = {
      mode: (!r.auto && mode === 'auto') ? 'optional' : mode,
      kind: pricingKind_(s.kind),
      amount: pricingNum_(s.amount, 0)
    };
  });

  const problems = pricingProblems_(next);
  if (problems.length) return { ok: false, problems: problems, config: current };

  next.version = (pricingNum_(current.version, 1) || 1) + 1;
  next.updatedAt = new Date().toISOString();
  next.updatedBy = pendingActor_();
  try {
    PropertiesService.getScriptProperties().setProperty(PRICING_PROP_, JSON.stringify(next));
  } catch (e) {
    return { ok: false, problems: ['The settings could not be saved: ' + ((e && e.message) || e)], config: current };
  }
  return { ok: true, config: next };
}

// Drive time AND distance in one lookup. planDriveMinutes_ (V96) caches a bare
// number under 'plan:drive:'; this keeps that key untouched and adds its own, so
// an old cached entry can never be read as a distance. Same budget, same 6 hours.
function planDriveInfo_(from, to, budget) {
  const a = String(from || '').trim(), b = String(to || '').trim();
  if (!a || !b) return null;
  if (planNorm_(a) === planNorm_(b)) return { minutes: 0, miles: 0 };
  let cache = null, key = '';
  try {
    cache = CacheService.getScriptCache();
    key = 'plan:drive2:' + Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, (a + '|' + b).toLowerCase()));
    const hit = cache.get(key);
    if (hit === 'x') return null;
    if (hit) {
      const parts = String(hit).split('|');
      return { minutes: Number(parts[0]), miles: Number(parts[1]) };
    }
  } catch (e) { cache = null; }
  if (budget && budget.left <= 0) return null;
  if (budget) budget.left -= 1;
  let out = null;
  try {
    const res = Maps.newDirectionFinder().setOrigin(a).setDestination(b)
      .setMode(Maps.DirectionFinder.Mode.DRIVING).getDirections();
    const leg = res && res.routes && res.routes[0] && res.routes[0].legs && res.routes[0].legs[0];
    if (leg && leg.duration && leg.duration.value && leg.distance && leg.distance.value) {
      out = {
        minutes: Math.max(1, Math.round(leg.duration.value / 60)),
        miles: Math.round((leg.distance.value / 1609.344) * 10) / 10
      };
    }
  } catch (e) { Logger.log('planDriveInfo_: ' + ((e && e.message) || e)); }
  try { if (cache) cache.put(key, out ? (out.minutes + '|' + out.miles) : 'x', out ? PLAN_DRIVE_CACHE_SECONDS_ : PLAN_DRIVE_FAIL_CACHE_SECONDS_); } catch (e) {}
  return out;
}

function ppIsPrivate_(trip) {
  const v = trip && trip.privatePay;
  if (v === true) return true;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1';
}

// Which base price a trip starts from. Transport is a free-text box, so this reads
// it the same forgiving way the board reads it for the little vehicle icons.
function ppTransportKey_(value) {
  const s = String(value == null ? '' : value).toLowerCase();
  if (/(wheel|w\/c|\bwc\b|chair)/.test(s)) return 'wheelchair';
  if (/(stretcher|gurney)/.test(s)) return 'stretcher';
  if (/(taxi|cab)/.test(s)) return 'taxi';
  if (/(ambulatory|walking|walker|\bamb\b|walk)/.test(s)) return 'ambulatory';
  return 'other';
}
function ppTransportLabel_(key) {
  return { ambulatory: 'Ambulatory', wheelchair: 'Wheelchair', stretcher: 'Stretcher', taxi: 'Taxi', other: 'Standard' }[key] || 'Standard';
}

function ppMinutesOfDay_(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// After hours wraps midnight: 19:00 to 06:00 means late evening OR early morning.
function ppIsAfterHours_(minutes, from, to) {
  const f = ppMinutesOfDay_(from), t = ppMinutesOfDay_(to);
  if (minutes == null || f == null || t == null) return false;
  return f <= t ? (minutes >= f && minutes < t) : (minutes >= f || minutes < t);
}

function ppIsWeekend_(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return false;
  const d = new Date(dateKey + 'T12:00:00');
  const day = d.getDay();
  return day === 0 || day === 6;
}

function ppDayName_(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return '';
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(dateKey + 'T12:00:00').getDay()];
}

function ppClock_(minutes) {
  if (minutes == null) return '';
  let h = Math.floor(minutes / 60), m = minutes % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
}

// The waiting a driver actually did, taken from the stamps the driver app records.
// Nothing is charged before the trip has happened, because nothing has been waited.
function ppWaitMinutes_(trip) {
  try {
    const rec = ttRowFor_(trip);
    if (!rec) return 0;
    const a = Number(rec.pickupWaitMin), b = Number(rec.dropoffWaitMin);
    return (isFinite(a) ? a : 0) + (isFinite(b) ? b : 0);
  } catch (e) { return 0; }
}

// THE ENGINE. Pure: give it the same trip, config, miles, today and selections and
// it always returns the same lines in the same order. No sheet reads, no clock.
function ppQuote_(trip, cfg, opts) {
  const o = opts || {};
  const manual = {}, dropped = {};
  (o.manual || []).forEach(function(k) { manual[String(k)] = true; });
  (o.dropped || []).forEach(function(k) { dropped[String(k)] = true; });
  const lines = [];
  const add = function(key, label, detail, amount, source) {
    lines.push({ key: key, label: label, detail: detail || '', amount: pricingMoney_(amount), source: source });
  };

  const tKey = ppTransportKey_(trip.transport);
  const baseAmount = pricingNum_(cfg.base[tKey], 0);
  add('base', ppTransportLabel_(tKey) + ' base fare', String(trip.transport || '').trim() || 'No transport set', baseAmount, 'auto');
  // V120: a zero base is a legitimate setting - a mileage-only service, or a kind
  // of transport this operator does not run. So it is not a problem on its own;
  // it is only a problem if nothing else fills the gap. Checked at the end, once
  // the total is known.
  const zeroBase_ = !(baseAmount > 0);

  // Mileage
  const miles = o.miles == null ? null : Number(o.miles);
  if (cfg.mileage.mode === 'auto' && miles != null && isFinite(miles)) {
    const billable = Math.max(0, miles - cfg.mileage.includedMiles);
    const amount = billable * cfg.mileage.perMile;
    const detail = miles + ' miles' + (cfg.mileage.includedMiles > 0 ? ', ' + cfg.mileage.includedMiles + ' included' : '') +
      ' · ' + (Math.round(billable * 10) / 10) + ' × $' + cfg.mileage.perMile.toFixed(2);
    add('mileage', 'Loaded mileage', detail, amount, 'auto');
  } else if (cfg.mileage.mode === 'auto' && miles == null) {
    add('mileage', 'Loaded mileage', 'No distance yet — check the addresses', 0, 'auto');
    // V120: mileage is usually most of the fare. Quoting $0 for it looked like a
    // finished price and under-billed by the whole distance, so say so instead.
    o.incompleteQuote = true;
  }

  // The fare so far is what percentages are worked out from, so a percentage rule
  // is never quietly applied to another percentage rule.
  let fare = 0;
  lines.forEach(function(l) { fare += l.amount; });
  if (cfg.mileage.minimumFare > 0 && fare < cfg.mileage.minimumFare) {
    const bump = cfg.mileage.minimumFare - fare;
    add('minimum', 'Minimum fare', 'Brings the fare up to $' + cfg.mileage.minimumFare.toFixed(2), bump, 'auto');
    fare = cfg.mileage.minimumFare;
  }

  // Deadhead: the empty run out to the passenger. The dispatcher types the miles,
  // so there is nothing to charge until they do - it is never guessed at. It is
  // added AFTER the fare is settled, deliberately: it is a cost being passed on,
  // not part of what the ride is worth, so a weekend percentage is not taken on
  // top of it and it cannot mask a minimum fare.
  const dhMiles = pricingNum_(o.deadheadMiles, 0);
  if (cfg.deadhead.mode !== 'off' && dhMiles > 0) {
    const dhBillable = Math.max(0, dhMiles - cfg.deadhead.includedMiles);
    const dhDetail = dhMiles + ' empty miles'
      + (cfg.deadhead.includedMiles > 0 ? ', ' + cfg.deadhead.includedMiles + ' included' : '')
      + ' · ' + (Math.round(dhBillable * 10) / 10) + ' × $' + cfg.deadhead.perMile.toFixed(2);
    add('deadhead', 'Deadhead mileage', dhDetail, dhBillable * cfg.deadhead.perMile, 'manual');
  }

  // Waiting time, from the driver's own stamps
  if (cfg.wait.mode !== 'off' && cfg.wait.rate > 0) {
    const waited = ppWaitMinutes_(trip);
    const over = Math.max(0, waited - cfg.wait.graceMin);
    const blocks = cfg.wait.intervalMin > 0 ? Math.ceil(over / cfg.wait.intervalMin) : 0;
    const wanted = cfg.wait.mode === 'auto' ? blocks > 0 : !!manual.wait;
    if (wanted && blocks > 0) {
      add('wait', 'Waiting time', waited + ' min waited, ' + cfg.wait.graceMin + ' free · ' + blocks + ' × $' + cfg.wait.rate.toFixed(2),
        blocks * cfg.wait.rate, cfg.wait.mode === 'auto' ? 'auto' : 'manual');
    }
  }

  const dateKey = String(trip.date || '').slice(0, 10);
  const mins = ppMinutesOfDay_(o.timeHm || '');
  const autoWhen = {
    afterHours: function() {
      // V120: 23:58 is what the app writes when no time was typed. Treating it as
      // a real pickup time added a late-night surcharge to every unscheduled trip.
      if (String(o.timeHm || '') === '23:58') return null;
      return ppIsAfterHours_(mins, cfg.afterHoursFrom, cfg.afterHoursTo) ? 'Picked up at ' + ppClock_(mins) : null;
    },
    weekend:    function() { return ppIsWeekend_(dateKey) ? ppDayName_(dateKey) : null; },
    holiday:    function() { return cfg.holidays.indexOf(dateKey) >= 0 ? 'Holiday' : null; },
    sameDay:    function() { return (o.today && dateKey === o.today) ? 'Booked for today' : null; },
    recurring:  function() { return String(trip.recurringId || '').trim() ? 'Part of a standing order' : null; }
  };

  const charges = [], discounts = [];
  PRICING_RULES_.forEach(function(r) {
    const s = cfg.rules[r.key];
    if (!s || s.mode === 'off') return;
    let why = '', source = '';
    if (s.mode === 'auto' && autoWhen[r.key]) {
      const hit = autoWhen[r.key]();
      if (hit && !dropped[r.key]) { why = hit; source = 'auto'; }
      else if (hit && dropped[r.key]) return;          // deliberately taken off
      else if (manual[r.key]) { why = 'Added by dispatch'; source = 'manual'; }
      else return;
    } else if (manual[r.key]) {
      why = 'Added by dispatch'; source = 'manual';
    } else return;
    if (s.amount === 0) return;
    (r.discount ? discounts : charges).push({ rule: r, set: s, why: why, source: source });
  });

  charges.forEach(function(c) {
    const amount = c.set.kind === 'percent' ? (fare * c.set.amount / 100) : c.set.amount;
    const detail = c.set.kind === 'percent'
      ? (c.why ? c.why + ' · ' : '') + c.set.amount + '% of the $' + pricingMoney_(fare).toFixed(2) + ' fare'
      : c.why;
    add(c.rule.key, c.rule.label, detail, amount, c.source);
  });

  // V120: charges take their percentage from `fare`, which deliberately excludes
  // deadhead, waiting, tolls and parking - money being passed on, not earned.
  // Discounts were using the full running total instead, so the operator was
  // handing back a slice of their own costs.
  const PRICING_PASS_THROUGH_ = { deadhead: 1, wait: 1, tolls: 1, parking: 1 };
  let running = 0;
  lines.forEach(function(l) { if (!PRICING_PASS_THROUGH_[l.key]) running += l.amount; });
  discounts.forEach(function(d) {
    const amount = d.set.kind === 'percent' ? (running * d.set.amount / 100) : d.set.amount;
    const detail = d.set.kind === 'percent'
      ? (d.why ? d.why + ' · ' : '') + d.set.amount + '% off'
      : d.why;
    add(d.rule.key, d.rule.label, detail, -Math.abs(amount), d.source);
  });

  let total = 0;
  lines.forEach(function(l) { total += l.amount; });
  total = Math.max(0, pricingMoney_(total));
  // No base fare set for this transport AND nothing else to charge: whatever this
  // is, it is not a price anybody should invoice.
  if (zeroBase_ && !(total > 0)) o.incompleteQuote = true;
  // V120: the earlier bump is taken before surcharges and discounts, so a
  // discount could pull the total back below the stated minimum while a line in
  // the breakdown still claimed the minimum had been met. Top it up at the end.
  if (cfg.mileage.minimumFare > 0 && total < cfg.mileage.minimumFare) {
    const shortfall = pricingMoney_(cfg.mileage.minimumFare - total);
    if (shortfall > 0) {
      add('minimumFloor', 'Minimum fare', 'The minimum fare is $' + cfg.mileage.minimumFare.toFixed(2), shortfall, 'auto');
      total = pricingMoney_(cfg.mileage.minimumFare);
    }
  }

  return {
    total: total,
    incomplete: !!o.incompleteQuote,
    lines: lines,
    transport: tKey,
    miles: (miles == null || !isFinite(miles)) ? null : miles,
    deadheadMiles: dhMiles > 0 ? dhMiles : 0,
    configVersion: cfg.version,
    manual: Object.keys(manual).sort(),
    dropped: Object.keys(dropped).sort(),
    quotedAt: o.now || ''
  };
}

// What the sheet offers under "Add to this trip": every rule that is switched on,
// is not already applied, and is not a discount the dispatcher should not be
// handing out from a trip form. Off rules never appear here - that is the point.
function ppOptions_(cfg, quote) {
  const used = {};
  (quote.lines || []).forEach(function(l) { used[l.key] = true; });
  const out = [];
  PRICING_RULES_.forEach(function(r) {
    const s = cfg.rules[r.key];
    if (!s || s.mode === 'off' || used[r.key] || s.amount === 0) return;
    out.push({
      key: r.key, label: r.label, group: r.group, kind: s.kind, amount: s.amount,
      discount: !!r.discount,
      preview: s.kind === 'percent' ? s.amount + '%' : '$' + s.amount.toFixed(2)
    });
  });
  return out;
}

// The one call the page makes. Fetches the distance (one Maps lookup, cached),
// runs the engine and hands back everything the price sheet needs to draw itself.
function getPrivatePayQuote(trip, manual, dropped) {
  const t = trip && typeof trip === 'object' ? trip : {};
  if (!ppIsPrivate_(t)) return { privatePay: false };
  const cfg = pricingConfig();
  let miles = null;
  if (cfg.mileage.mode === 'auto') {
    if (t.milesOverride != null && t.milesOverride !== '') {
      miles = pricingNum_(t.milesOverride, 0);
    } else {
      const info = planDriveInfo_(t.pickup, t.dropoff, { left: 2 });
      if (info) miles = info.miles;
    }
  }
  const todayKey = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const quote = ppQuote_(t, cfg, {
    miles: miles,
    deadheadMiles: t.deadheadMiles,
    timeHm: ttTimeOfDay_(t.time),
    today: todayKey,
    manual: Array.isArray(manual) ? manual : [],
    dropped: Array.isArray(dropped) ? dropped : [],
    now: new Date().toISOString()
  });
  return { privatePay: true, quote: quote, options: ppOptions_(cfg, quote), configVersion: cfg.version };
}

// A route's two directions share a distance for pricing. The outbound leg's miles
// are fetched from Google; the return leg is the same road the other way, so it
// reuses them rather than spending a second lookup on the same journey.
function ppRouteKey_(a, b) {
  const x = stAddrKey_(a), y = stAddrKey_(b);
  return x < y ? x + '~' + y : y + '~' + x;
}

// V114: a trip saved as part of a batch - the return leg, or every day of a repeat -
// used to inherit the price worked out for the trip sitting in the form, because it
// is built by copying that trip. Its own date and time were never consulted, so an
// after-hours, weekend or holiday charge could land on the wrong leg entirely.
//
// The engine is pure and needs no Maps call once the distance is known, and the
// distance rides along in the snapshot, so the honest fix is simply to price every
// trip again from its own fields just before it is written. It costs nothing, it
// cannot be skipped by a page that is out of date, and the dispatcher's own choices
// travel with it: whatever extras were ticked on the form apply to both legs.
//
// A trip that is not private pay is not touched, and any failure leaves the trip
// exactly as it arrived - a price is never worth losing a trip over.
// V120: `stored` is the trip as the RECORD currently holds it, keyed by
// tripKeyID. It matters because the incoming trip and its pricing snapshot both
// come from the same page, so comparing them against each other always says
// "unchanged" - the comparison has to be against what was actually saved before.
function repricePrivatePayTrips_(trips, stored) {
  const list = (Array.isArray(trips) ? trips : [trips]).filter(Boolean);
  const storedBy = stored || {};
  if (!list.some(ppIsPrivate_)) return list;
  let cfg = null;
  const miles = {};
  // V120: this was a flat 2. Saving several private-pay trips at once therefore
  // ran out of lookups and, now that an unpriceable trip is left blank rather than
  // silently under-quoted, that would have cleared the price on every trip past
  // the second. Distinct routes are looked up once each and cached, so the budget
  // only needs to cover the trips actually being priced.
  const budget = { left: Math.max(2, list.filter(ppIsPrivate_).length + 2) };
  const todayKey = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const now = new Date().toISOString();

  // V116: a return leg costs what the trip out costs. The hour a passenger
  // happens to come back at is a scheduling fact, not a pricing one, so the
  // leg is quoted on its outbound's clock and the two legs always match. The
  // form does the same, so what the dispatcher was shown is what is written.
  const outTime = {};
  list.forEach(function(t) {
    if (!t) return;
    const id = String(t.id || ''), key = String(t.tripKeyID || '');
    if (id) outTime[id] = t.time;
    if (key) outTime[key] = t.time;
  });
  // Editing a return leg on its own sends one trip, so its outbound is not in
  // the batch; that day's trips are read once and only when it is needed.
  const dayCache = {};
  function ppPriceTime_(trip) {
    const ret = String((trip && trip.returnOf) || '');
    if (!ret) return trip.time;
    if (outTime[ret] != null) return outTime[ret];
    try {
      const day = String(trip.date || '');
      if (!day) return trip.time;
      if (dayCache[day] === undefined) dayCache[day] = tripManager.getTripsByDate(day) || [];
      const found = dayCache[day].find(function(t) {
        return t && (String(t.id || '') === ret || String(t.tripKeyID || '') === ret);
      });
      return found && found.time ? found.time : trip.time;
    } catch (e) {
      Logger.log('ppPriceTime_: ' + ((e && e.message) || e));
      return trip.time;
    }
  }

  list.forEach(function(trip) {
    if (!ppIsPrivate_(trip)) return;
    try {
      if (!cfg) cfg = pricingConfig();
      const snap = (trip.pricing && typeof trip.pricing === 'object') ? trip.pricing : null;
      // V120: a typed override is the dispatcher's decision about a route Google
      // does not know how to drive. getPrivatePayQuote already honours it; this,
      // the path that actually writes the price, did not - so the stored price
      // silently used Google's shorter distance.
      const hasOverride = trip.milesOverride != null && String(trip.milesOverride) !== '';
      // Keyed by the typed value as well as the route: two brand-new trips on the
      // same route have no key of their own yet, and would otherwise share one
      // entry and both take the first one's override.
      const key = hasOverride
        ? ('override:' + pricingNum_(trip.milesOverride, 0) + '|' + ppRouteKey_(trip.pickup, trip.dropoff))
        : ppRouteKey_(trip.pickup, trip.dropoff);
      // Did this save move the journey? Answered from the record, which is the
      // only thing that knows what the route was before.
      const was = storedBy[String(trip.tripKeyID || '')] || null;
      const routeMoved = was
        ? (String(was.pickup || '') !== String(trip.pickup || '') || String(was.dropoff || '') !== String(trip.dropoff || ''))
        : (snap && snap.pickup != null
            ? (String(snap.pickup) !== String(trip.pickup || '') || String(snap.dropoff) !== String(trip.dropoff || ''))
            : false);
      if (miles[key] === undefined) {
        // V120: the page pays for this lookup and sends the answer with the save,
        // so it is not repeated here - but only while the journey is the same one
        // it was measured on. A moved address is measured again, or the new
        // journey would be billed at the old distance.
        const carried = hasOverride ? pricingNum_(trip.milesOverride, 0)
          : ((!routeMoved && snap && snap.miles != null && isFinite(Number(snap.miles))) ? Number(snap.miles) : null);
        if (carried != null) miles[key] = carried;
        else if (cfg.mileage.mode === 'auto') {
          const info = planDriveInfo_(trip.pickup, trip.dropoff, budget);
          miles[key] = info ? info.miles : null;
        } else miles[key] = null;
      }
      const quote = ppQuote_(trip, cfg, {
        miles: miles[key],
        // The empty run happens on the way OUT to the passenger; a return leg
        // starts where the driver already is, so it never carries one.
        deadheadMiles: String(trip.returnOf || '') ? 0 : (trip.deadheadMiles != null ? trip.deadheadMiles
          : (snap && snap.deadheadMiles != null ? snap.deadheadMiles : 0)),
        timeHm: ttTimeOfDay_(ppPriceTime_(trip)),
        today: todayKey,
        manual: (snap && Array.isArray(snap.manual)) ? snap.manual : [],
        dropped: (snap && Array.isArray(snap.dropped)) ? snap.dropped : [],
        now: now
      });
      if (quote.incomplete) {
        // V120: the total is missing something real - usually the whole mileage
        // leg, because the distance lookup failed. Writing it would look like a
        // finished price and under-bill by that amount.
        const priorSnap = (trip.pricing && typeof trip.pricing === 'object') ? trip.pricing : {};
        // The price that was actually agreed lives in the record, not in what the
        // page just sent - the page is sending the incomplete quote we are here
        // to reject. Same for the route.
        const agreedPrice = was ? was.price : trip.price;
        const hadPrice = agreedPrice !== '' && agreedPrice != null && Number(agreedPrice) > 0;
        if (hadPrice && !routeMoved) {
          // Same journey, price already agreed. A lookup that failed this minute
          // is not a reason to un-bill a trip - and clearing it would be worse
          // than leaving it, because a blank price is easy to miss on an invoice.
          Logger.log('reprice: could not re-check ' + (trip.tripKeyID || trip.id || '?') + '; keeping the agreed price');
          const keptSnap = (was && was.pricing && typeof was.pricing === 'object') ? was.pricing : priorSnap;
          trip.price = agreedPrice;
          trip.pricing = Object.assign({}, keptSnap, { incomplete: true, staleQuote: true, problem: 'The distance could not be re-checked, so the previous price is still shown.' });
          return;
        }
        Logger.log('reprice: incomplete quote for ' + (trip.tripKeyID || trip.id || '?') + ' (' + trip.pickup + ' -> ' + trip.dropoff + '); price cleared');
        trip.price = '';
        trip.pricing = Object.assign({}, priorSnap, { incomplete: true, total: '', lines: [], problem: 'This trip could not be priced - check the addresses and the base fare, then save again.' });
        return;
      }
      trip.price = quote.total;
      trip.pricing = {
        pickup: String(trip.pickup || ''),
        dropoff: String(trip.dropoff || ''),
        total: quote.total,
        lines: quote.lines,
        transport: quote.transport,
        miles: quote.miles,
        manual: quote.manual,
        dropped: quote.dropped,
        configVersion: quote.configVersion,
        quotedAt: quote.quotedAt,
        deadheadMiles: quote.deadheadMiles,
        pricedHere: true
      };
    } catch (e) {
      Logger.log('repricePrivatePayTrips_: ' + ((e && e.message) || e));
    }
  });
  return list;
}

// Callable on its own, so the board can be tidied without saving anything.
function sortDispatchBoard() {
  return withTripsDocumentLock_(function() { dispatchMarkForSort_(); return true; });
}

// ---- Can the driver actually get there? (V96) --------------------------------
// The old check only caught two trips at the *same* time. It never asked whether a
// driver could physically get from one to the next: two 5:30 PM trips for the same
// driver, from addresses forty minutes apart, are impossible even though only one of
// them clashes on the clock. This works out the real driving time between a driver's
// trips and says so, in words, with the numbers behind it.
//
// Nothing here blocks a save. Every finding is a warning the dispatcher can override,
// because they know things the sheet does not.
const PLAN_TIGHT_MINUTES_ = 15;      // fits, but with less than this to spare
// V106: a driver is not free the instant a trip's clock time arrives - they stand at
// the door, then at the drop-off. These are the fallback allowances: V108 uses the
// learned median from STOP_TIMES whenever there is enough history (planStopInfo_),
// and these two numbers whenever there is not.
const PLAN_STOP_PICKUP_MIN_ = 5;
const PLAN_STOP_DROPOFF_MIN_ = 3;
function planStopMinutes_(trip, which) {
  return planStopInfo_(trip, which).minutes;
}
const PLAN_MAX_LOOKUPS_ = 8;         // a hard ceiling on Maps calls per check
const PLAN_DRIVE_CACHE_SECONDS_ = 21600;
// V120: a failure must not be remembered as long as an answer. Holding "no
// distance" for six hours meant one bad moment left every trip on that route
// unpriceable for the rest of the day.
const PLAN_DRIVE_FAIL_CACHE_SECONDS_ = 300;
const PLAN_ENDED_STATUSES_ = ['cancel', 'canceled', 'cancelled', 'noshow', 'no show', 'reassign'];

function planNorm_(v) { return String(v == null ? '' : v).toLowerCase().replace(/\s+/g, ''); }

// A trip time as minutes past midnight, whatever shape the sheet handed us.
function planMinutes_(value) {
  if (value instanceof Date) return value.getHours() * 60 + value.getMinutes();
  const text = String(value == null ? '' : value);
  const m = /(?:T|^|\s)(\d{1,2}):(\d{2})/.exec(text);
  if (!m) return null;
  let mins = Number(m[1]) * 60 + Number(m[2]);
  if (/pm/i.test(text) && Number(m[1]) < 12) mins += 12 * 60;
  if (/am/i.test(text) && Number(m[1]) === 12) mins -= 12 * 60;
  return mins;
}

function planClock_(mins) {
  if (mins == null) return '';
  let m = Math.round(mins);
  while (m < 0) m += 24 * 60;
  m = m % (24 * 60);
  const h24 = Math.floor(m / 60);
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return h + ':' + String(m % 60).padStart(2, '0') + ' ' + (h24 >= 12 ? 'PM' : 'AM');
}

function planSpell_(mins) {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return m + (m === 1 ? ' minute' : ' minutes');
  const h = Math.floor(m / 60), r = m % 60;
  return h + (h === 1 ? ' hour' : ' hours') + (r ? ' ' + r + (r === 1 ? ' minute' : ' minutes') : '');
}

// The driver app already has a cached Maps lookup; reuse it rather than opening a
// second one. Its own cache is short, so the answer is kept again here for longer —
// an address pair's driving time does not change through a dispatcher's afternoon.
function planDriveMinutes_(from, to, budget) {
  const a = String(from == null ? '' : from).trim();
  const b = String(to == null ? '' : to).trim();
  if (!a || !b) return null;
  if (planNorm_(a) === planNorm_(b)) return 0;
  let cache = null, key = '';
  try {
    cache = CacheService.getScriptCache();
    const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, (a + '|' + b).toLowerCase(), Utilities.Charset.UTF_8);
    key = 'plan:drive:' + Utilities.base64EncodeWebSafe(raw);
    const hit = cache.get(key);
    if (hit !== null && hit !== undefined) return hit === 'x' ? null : Number(hit);
  } catch (e) {}
  if (budget && budget.left <= 0) return null;
  if (budget) budget.left -= 1;
  let mins = null;
  try {
    if (typeof driverDriveMinutes_ === 'function') {
      mins = driverDriveMinutes_(a, b);
    } else {
      const res = Maps.newDirectionFinder().setOrigin(a).setDestination(b)
        .setMode(Maps.DirectionFinder.Mode.DRIVING).getDirections();
      const leg = res && res.routes && res.routes[0] && res.routes[0].legs && res.routes[0].legs[0];
      if (leg && leg.duration && leg.duration.value) mins = Math.max(1, Math.round(leg.duration.value / 60));
    }
  } catch (e) { mins = null; }
  try { if (cache && key) cache.put(key, mins === null ? 'x' : String(mins), mins === null ? PLAN_DRIVE_FAIL_CACHE_SECONDS_ : PLAN_DRIVE_CACHE_SECONDS_); } catch (e2) {}
  return mins;
}

function planTripIsOver_(t) {
  const d = planNorm_(t && t.dispatchStatus);
  if (PLAN_ENDED_STATUSES_.indexOf(d) >= 0) return true;
  return PLAN_ENDED_STATUSES_.indexOf(planNorm_(t && t.status)) >= 0;
}

// Everything else that driver is doing that day, in time order.
function planDriverDay_(trip, excludeKey) {
  const driver = String(trip && trip.driver || '').trim();
  if (!driver) return [];
  const dateKey = Utils.formatDateString(trip.date || '');
  if (!dateKey) return [];
  const skip = String(excludeKey || trip.tripKeyID || '');
  let all = [];
  try { all = tripManager.getTripsByDate(dateKey) || []; } catch (e) { return []; }
  return all.filter(function(t) {
    if (!t) return false;
    if (skip && String(t.tripKeyID || '') === skip) return false;
    if (String(t.driver || '').trim() !== driver) return false;
    if (planTripIsOver_(t)) return false;
    return planMinutes_(t.time) != null;
  }).sort(function(a, b) { return planMinutes_(a.time) - planMinutes_(b.time); });
}

function planWhere_(t) {
  return {
    passenger: String(t && t.passenger || ''),
    time: String(t && t.time || ''),
    pickup: String(t && t.pickup || ''),
    dropoff: String(t && t.dropoff || '')
  };
}

// One finding per neighbour that does not work. `spare` is how many minutes are left
// over once the driving is done: negative means it cannot be done at all.
function planFinding_(kind, driver, from, to, ride, transfer, spare, readyAt, stops) {
  return {
    kind: kind, driver: driver,
    from: planWhere_(from), to: planWhere_(to),
    ride: ride, transfer: transfer, spare: Math.round(spare),
    stops: stops || null,
    readyAt: planClock_(readyAt),
    text: planSentence_(kind, driver, from, to, ride, transfer, spare, readyAt, stops)
  };
}

function planSentence_(kind, driver, from, to, ride, transfer, spare, readyAt, stops) {
  const who = driver || 'That driver';
  const first = (from.passenger || 'another trip') + ' at ' + planClock_(planMinutes_(from.time));
  const second = (to.passenger || 'this trip') + ' at ' + planClock_(planMinutes_(to.time));
  const drive = planSpell_(transfer);
  // A learned stop says whose history it came from; the standard 5 and 3 pass
  // without comment, so the sentence only grows when there is something to say.
  const pWhy = stops && stops.pickupLearned && stops.pickupWhy ? ' (' + stops.pickupWhy + ')' : '';
  const dWhy = stops && stops.dropoffLearned && stops.dropoffWhy ? ' (' + stops.dropoffWhy + ')' : '';
  const atPickup = stops && stops.pickup ? planSpell_(stops.pickup) + ' at the pickup' + pWhy + ', ' : '';
  const atDrop = stops && stops.dropoff ? planSpell_(stops.dropoff) + ' at the drop-off' + dWhy + ', then ' : 'then ';
  const legs = ride != null
    ? (atPickup + planSpell_(ride) + ' on the road, ' + atDrop + drive + ' to the next pick-up')
    : (atPickup + drive + ' between them');
  if (kind === 'impossible') {
    return who + ' is on ' + first + '. That is ' + legs + ', so ' + second +
      ' cannot be made — they would not be free until about ' + planClock_(readyAt) +
      ', ' + planSpell_(-spare) + ' late.';
  }
  return who + ' is on ' + first + '. That is ' + legs + ', leaving only ' +
    planSpell_(spare) + ' spare before ' + second + '.';
}

// Looks at the trip's immediate neighbours on that driver's day: the one before it and
// the one after. Those are the only two that can be broken by this trip.
function checkDriverReachability_(trip, excludeKey, budget) {
  const out = [];
  const driver = String(trip && trip.driver || '').trim();
  const mine = planMinutes_(trip && trip.time);
  if (!driver || mine == null) return out;
  const pickup = String(trip.pickup || '').trim();
  const dropoff = String(trip.dropoff || '').trim();
  if (!pickup && !dropoff) return out;

  const day = planDriverDay_(trip, excludeKey);
  if (!day.length) return out;

  let before = null, after = null;
  day.forEach(function(t) {
    const m = planMinutes_(t.time);
    if (m <= mine) { if (!before || m > planMinutes_(before.time)) before = t; }
    if (m >= mine) { if (!after || m < planMinutes_(after.time)) after = t; }
  });

  const judge = function(first, second) {
    const t1 = planMinutes_(first.time), t2 = planMinutes_(second.time);
    if (t1 == null || t2 == null) return;
    const ride = planDriveMinutes_(first.pickup, first.dropoff, budget);
    const transfer = planDriveMinutes_(first.dropoff || first.pickup, second.pickup, budget);
    if (transfer == null) return;                 // no route, nothing honest to say
    // V106: time at each stop counts too; the sentence names it. V108: each one
    // carries where it came from, so a learned number can say so.
    const pStop = planStopInfo_(first, 'pickup');
    const dStop = ride == null ? { minutes: 0, why: '', learned: false, trips: 0 } : planStopInfo_(first, 'dropoff');
    const stops = { pickup: pStop.minutes, dropoff: dStop.minutes,
      pickupWhy: pStop.why, dropoffWhy: dStop.why,
      pickupLearned: pStop.learned, dropoffLearned: dStop.learned,
      pickupTrips: pStop.trips, dropoffTrips: dStop.trips };
    const readyAt = t1 + stops.pickup + (ride == null ? 0 : ride) + stops.dropoff + transfer;
    const spare = t2 - readyAt;
    if (spare < 0) out.push(planFinding_('impossible', driver, first, second, ride, transfer, spare, readyAt, stops));
    else if (spare < PLAN_TIGHT_MINUTES_) out.push(planFinding_('tight', driver, first, second, ride, transfer, spare, readyAt, stops));
  };

  if (before) judge(before, trip);
  if (after) judge(trip, after);
  return out;
}

// The one call the page makes before saving, whether adding or updating. The hard
// checks are unchanged; this only adds the warnings alongside them.
function checkTripPlan(trips, excludeTripKeyID) {
  const list = (Array.isArray(trips) ? trips : [trips]).filter(Boolean);
  const budget = { left: PLAN_MAX_LOOKUPS_ };
  const warnings = [];
  const seen = {};
  // Only the first day of a standing order is examined: the same clash would repeat
  // on every other day, and forty Maps lookups is not a save the dispatcher can wait for.
  if (list.length) {
    checkDriverReachability_(list[0], excludeTripKeyID, budget).forEach(function(f) {
      const k = f.kind + '|' + f.from.passenger + '|' + f.from.time + '|' + f.to.passenger + '|' + f.to.time;
      if (seen[k]) return;
      seen[k] = true;
      warnings.push(f);
    });
  }
  return { warnings: warnings, checkedDays: list.length > 1 ? 1 : list.length, ofDays: list.length };
}
