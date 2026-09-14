class Utils {
  static formatDateString(date) {
    if (!date) return '';
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const [y, m, d] = date.split('-').map(Number);
      return Utilities.formatDate(new Date(y, m - 1, d), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    }
    const parsed = new Date(date);
    return isNaN(parsed)
      ? (typeof date === 'string' ? date : '')
      : Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  /**
   * Generate a deterministic Trip ID using a salted SHA-256 hash of key fields.
   * @param {Object} fields Object with date, time, passenger, phone, pickup and dropoff
   * @return {string} Hex encoded SHA-256 digest
   */
  static generateTripId({ date = '', time = '', passenger = '', phone = '', pickup = '', dropoff = '' } = {}) {
    const salt = 'AGMT_TRIP_SALT';
    const str = [date, time, passenger, phone, pickup, dropoff].join('|');
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + str);
    return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  }
}

const utils = Utils;

function TRIP_ID(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (sheet.getName() !== 'DISPATCH') return;

  const editedRow = e.range.getRow();
  const editedCol = e.range.getColumn();
  if (editedRow < 2 || editedRow > 100) return;

  if (editedCol === 4) {
    const name = sheet.getRange(editedRow, 4).getValue();
    const tripKeyCell = sheet.getRange(editedRow, 11);
    if (name && !tripKeyCell.getValue()) tripKeyCell.setValue(Utilities.getUuid());
  }

  SpreadsheetApp.flush();
  try {
    tripManager.onDispatchSheetEdit(e);
  } catch (error) {
    Logger.log('Trip sync failed: ' + error.message);
  }
}

function generateTripIDs_K2toK100() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("DISPATCH");
  const rangeStart = 2;
  const rangeEnd = 100;

  const names = sheet.getRange(rangeStart, 4, rangeEnd - 1, 1).getValues(); // Column D
  const ids = sheet.getRange(rangeStart, 11, rangeEnd - 1, 1).getValues();  // Column K

  for (let i = 0; i < names.length; i++) {
    const name = (names[i][0] || "").toString().trim();
    const currentId = (ids[i][0] || "").toString().trim();

    if (name && !currentId) {
      sheet.getRange(i + rangeStart, 11).setValue(Utilities.getUuid());
    }
  }

  Logger.log("TripIDKEYs generated in K2:K100 where needed.");
}

/**
 * Encode recurring trip information into a compact pattern string.
 * @param {string} startDate ISO formatted start date (yyyy-MM-dd)
 * @param {string} endDate ISO formatted end date (yyyy-MM-dd)
 * @param {string[]} daysOfWeek Array of weekday abbreviations e.g. ['MON','WED']
 * @return {string} Encoded pattern string
 */
function encodeDatePattern(startDate, endDate, daysOfWeek) {
  const days = Array.isArray(daysOfWeek)
    ? daysOfWeek.map(d => d.toUpperCase()).join(',')
    : '';
  return [startDate, endDate, days].join('|');
}

/**
 * Decode a pattern string back into an array of matching date strings.
 * @param {string} patternStr Encoded pattern string
 * @return {string[]} Array of ISO formatted date strings
 */
function decodeDatePattern(patternStr) {
  if (!patternStr) return [];
  const [startStr, endStr, daysStr] = patternStr.split('|');
  if (!startStr || !endStr || !daysStr) return [];

  const dayMap = {
    SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
  };
  const dayNums = daysStr
    .split(',')
    .map(d => dayMap[d.trim().toUpperCase()])
    .filter(d => d !== undefined);
  if (dayNums.length === 0) return [];

  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = endStr.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);

  const dates = [];
  const current = new Date(start);
  while (current <= end) {
    if (dayNums.includes(current.getDay())) {
      const iso = Utilities.formatDate(current, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      dates.push(iso);
    }
    current.setDate(current.getDate() + 1);
  }
  return dates;
}
