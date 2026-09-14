// ===============================
//  PASSENGER CACHE + CRUD OPERATIONS
// ===============================

const PASSENGERS_SHEET_NAME_ = 'PASSENGERS';
const PASSENGERS_HEADERS_ = [
  'key', 'Passenger Name', 'Medicaid #', 'Type', 'Primary Phone', 'All Phones', 'Addresses', 'Blacklisted', 'Blacklist Reason', 'Updated', 'Flagged By'
];

function passengersSheet_() {
  const sheet = activeSpreadsheet_().getSheetByName(PASSENGERS_SHEET_NAME_);
  if (!sheet) throw new Error('PASSENGERS sheet is missing. Run migrateToPassengersSheet() once to create it.');
  return sheet;
}

// Legacy alias kept so any old call sites keep working.
function passengerCacheSheet_() {
  return passengersSheet_();
}

function ensurePassengerCache_() {
  return passengersSheet_();
}

function passengerCacheKey_(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function parsePassengerList_(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function splitLines_(value) {
  return String(value || '').split(/\r?\n/)
    .map(function(v) { return v.trim(); })
    .filter(Boolean);
}

function markPassengerCacheDirty_() {
  invalidateFormOptionsCache_();
}

function getPassengerCacheLookup_() {
  const sheet = passengersSheet_();
  const lastRow = sheet.getLastRow();
  const lookup = new Map();
  if (lastRow < 2) return lookup;
  const rows = sheet.getRange(2, 1, lastRow - 1, 11).getDisplayValues();
  rows.forEach(function(row) {
    const key = passengerCacheKey_(row[0] || row[1]);
    if (!key) return;
    lookup.set(key, {
      displayName: String(row[1] || '').trim(),
      medicaid: row[2],
      type: row[3],
      primaryPhone: row[4],
      phones: splitLines_(row[5]),
      addresses: splitLines_(row[6]),
      blacklisted: String(row[7]).trim().toUpperCase() === 'TRUE',
      blacklistReason: String(row[8] || '').trim(),
      blacklistedBy: String(row[10] || '').trim()
    });
  });
  return lookup;
}

function getPassengerAddressesFromCache_(name) {
  const key = passengerCacheKey_(name);
  if (!key) return [];
  const record = getPassengerCacheLookup_().get(key);
  return record ? record.addresses : [];
}

function getPassengerBlacklistInfo_(name) {
  const record = getPassengerCacheLookup_().get(passengerCacheKey_(name));
  if (!record) return { blacklisted: false, reason: '', displayName: String(name || '') };
  return { blacklisted: record.blacklisted, reason: record.blacklistReason, displayName: record.displayName };
}

function updatePassengerProfile(key, profile) {
  return withPassengersLock_(function() {
    const r = updatePassengerProfileUnlocked_(key, profile);
    sortPassengersSheet_();
    return r;
  });
}

function updatePassengerProfileUnlocked_(key, profile) {
  const sheet = passengersSheet_();
  const normalizedKey = passengerCacheKey_(key);
  if (!normalizedKey) throw new Error('Passenger key is required.');
  const lastRow = sheet.getLastRow();
  const match = lastRow >= 2
    ? sheet.getRange(2, 1, lastRow - 1, 1).createTextFinder(normalizedKey).matchEntireCell(true).findNext()
    : null;
  const targetRow = match ? match.getRow() : lastRow + 1;
  const current = match ? sheet.getRange(targetRow, 1, 1, 9).getDisplayValues()[0] : [];
  const displayName = profile.displayName || (
    profile.lastName && profile.firstName ? profile.lastName + ', ' + profile.firstName : current[1] || key
  );
  const phones = Array.isArray(profile.phones) ? profile.phones : splitLines_(current[5]);
  const addresses = Array.isArray(profile.addresses) ? profile.addresses : splitLines_(current[6]);
  const cleanPhones = Array.from(new Set(phones.map(function(v) { return String(v).trim(); }).filter(Boolean)));
  const cleanAddresses = Array.from(new Set(addresses.map(function(v) { return String(v).trim(); }).filter(Boolean)));
  const blacklisted = typeof profile.blacklisted === 'boolean'
    ? profile.blacklisted
    : String(current[7]).trim().toUpperCase() === 'TRUE';
  const reason = profile.blacklistReason !== undefined ? String(profile.blacklistReason) : String(current[8] || '');
  sheet.getRange(targetRow, 1, 1, 10).setValues([[
    normalizedKey,
    String(displayName || '').trim(),
    String(profile.medicaid || current[2] || '').trim(),
    String(profile.type || current[3] || '').trim(),
    cleanPhones[0] || '',
    cleanPhones.join('\n'),
    cleanAddresses.join('\n'),
    blacklisted,
    reason,
    new Date()
  ]]);
  invalidateFormOptionsCache_();
  return true;
}

function ensurePassengersHeaders_() {
  const sheet = passengersSheet_();
  const width = PASSENGERS_HEADERS_.length;
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  const current = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
  let changed = false;
  for (let i = 0; i < width; i++) {
    if (String(current[i] || '').trim() !== PASSENGERS_HEADERS_[i]) { changed = true; break; }
  }
  if (changed) sheet.getRange(1, 1, 1, width).setValues([PASSENGERS_HEADERS_]).setFontWeight('bold');
  return sheet;
}

function currentDispatcherLabel_() {
  let who = '';
  try { who = Session.getActiveUser().getEmail() || ''; } catch (e) {}
  if (!who) { try { who = Session.getEffectiveUser().getEmail() || ''; } catch (e) {} }
  if (!who) who = 'unknown';
  return who + ' on ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy h:mm a');
}

function setPassengerBlacklist(displayName, flagged, reason) {
  return withPassengersLock_(function() { return setPassengerBlacklistUnlocked_(displayName, flagged, reason); });
}

function setPassengerBlacklistUnlocked_(displayName, flagged, reason) {
  const sheet = ensurePassengersHeaders_();
  const key = passengerCacheKey_(displayName);
  if (!key) throw new Error('Passenger name is required.');
  const on = !!flagged;
  const note = String(reason || '').trim();
  if (on && !note) throw new Error('A reason is required to flag a passenger.');

  const lastRow = sheet.getLastRow();
  const match = lastRow >= 2
    ? sheet.getRange(2, 1, lastRow - 1, 1).createTextFinder(key).matchEntireCell(true).findNext()
    : null;
  if (!match) throw new Error('Passenger not found on the PASSENGERS tab: ' + displayName);

  const row = match.getRow();
  const who = on ? currentDispatcherLabel_() : '';
  sheet.getRange(row, 8, 1, 4).setValues([[on, on ? note : '', new Date(), who]]);
  invalidateFormOptionsCache_();
  return {
    passenger: sheet.getRange(row, 2).getDisplayValue(),
    blacklisted: on,
    blacklistReason: on ? note : '',
    blacklistedBy: who
  };
}

function getPassengerNames() {
  return Array.from(getPassengerCacheLookup_().values())
    .map(function(record) { return record.displayName; })
    .filter(Boolean)
    .sort();
}

function getPassengerProfiles() {
  const profiles = {};
  getPassengerCacheLookup_().forEach(function(record) {
    profiles[record.displayName] = {
      medicaid: record.medicaid,
      type: record.type,
      phones: record.phones.length ? record.phones : (record.primaryPhone ? [record.primaryPhone] : []),
      addresses: record.addresses,
      blacklisted: record.blacklisted,
      blacklistReason: record.blacklistReason,
      blacklistedBy: record.blacklistedBy || ''
    };
  });
  return profiles;
}

const FORM_OPTIONS_CACHE_KEY_ = 'trip-form:options:v2';

function getFormOptionsBundle() {
  try {
    const cached = CacheService.getDocumentCache().get(FORM_OPTIONS_CACHE_KEY_);
    if (cached) return JSON.parse(decodeTripsCacheValue_(cached));
  } catch (e) {}
  const bundle = {
    profiles: getPassengerProfiles(),
    vehicles: getVehicleOptions(),
    drivers: getDriverOptions()
  };
  try {
    let payload = JSON.stringify(bundle);
    if (payload.length > 90000) {
      payload = 'GZ:' + Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(payload, 'text/plain')).getBytes());
    }
    CacheService.getDocumentCache().put(FORM_OPTIONS_CACHE_KEY_, payload, 600);
  } catch (e) {}
  return bundle;
}

function invalidateFormOptionsCache_() {
  try { CacheService.getDocumentCache().remove(FORM_OPTIONS_CACHE_KEY_); } catch (e) {}
}

/**
 * One-time migration:
 *  1. Reads every passenger from the old ADD PASSENGERS tab (rows 10+).
 *  2. Builds the new PASSENGERS sheet (one row per passenger, blacklist checkbox).
 *  3. Backs up the old ADD PASSENGERS tab into a brand-new spreadsheet (kept in Drive).
 *  4. Removes the old ADD PASSENGERS tab and the hidden PASSENGER_CACHE tab to free cells.
 *  5. Re-points the DISPATCH lookup formulas and passenger dropdown at the new sheet.
 */
function repairPassengersFromBackup() {
  const BACKUP_ID = '1V8CU4KK_ekP7ePS-A5JZkbE5Zrr1HBsOzNDcEhgC-Bg';
  const ss = activeSpreadsheet_();
  const source = SpreadsheetApp.openById(BACKUP_ID).getSheetByName('ADD PASSENGERS');
  if (!source) throw new Error('Backup sheet not found.');
  const lastRow = source.getLastRow();
  const rows = lastRow >= 2 ? source.getRange(2, 1, lastRow - 1, 6).getDisplayValues() : [];
  const records = new Map();
  rows.forEach(function(row) {
    const displayName = String(row[0] || '').trim().replace(/\s+/g, ' ');
    const key = passengerCacheKey_(displayName);
    if (!key || displayName.length < 3 || !displayName.includes(',')) return;
    if (!records.has(key)) {
      records.set(key, { key: key, displayName: displayName, medicaid: '', type: '', phones: [], addresses: [], flagged: false });
    }
    const record = records.get(key);
    if (!record.medicaid && row[1]) record.medicaid = String(row[1]).trim();
    if (!record.type && row[2]) record.type = String(row[2]).trim();
    const phone = String(row[3] || '').trim();
    const address = String(row[4] || '').trim();
    if (phone && record.phones.indexOf(phone) < 0) record.phones.push(phone);
    if (address && record.addresses.indexOf(address) < 0) record.addresses.push(address);
    if (String(row[5] || '').trim().toUpperCase() === 'TRUE') record.flagged = true;
  });
  const output = Array.from(records.values())
    .sort(function(a, b) { return a.displayName.localeCompare(b.displayName); })
    .map(function(r) {
      return [r.key, r.displayName, r.medicaid, r.type, r.phones[0] || '', r.phones.join('\n'), r.addresses.join('\n'), r.flagged, '', new Date()];
    });
  if (!output.length) throw new Error('No passengers found in the backup.');

  let sheet = ss.getSheetByName(PASSENGERS_SHEET_NAME_);
  if (!sheet) sheet = ss.insertSheet(PASSENGERS_SHEET_NAME_);
  sheet.clear();
  const neededRows = output.length + 1;
  if (sheet.getMaxRows() < neededRows) sheet.insertRowsAfter(sheet.getMaxRows(), neededRows - sheet.getMaxRows());
  sheet.getRange(1, 1, 1, PASSENGERS_HEADERS_.length).setValues([PASSENGERS_HEADERS_]).setFontWeight('bold');
  sheet.getRange(2, 1, output.length, PASSENGERS_HEADERS_.length).setValues(output);
  sheet.setFrozenRows(1);
  sheet.hideColumns(1);
  try {
    const cbRule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
    sheet.getRange(2, 8, Math.max(1, sheet.getMaxRows() - 1), 1).setDataValidation(cbRule);
    sheet.getRange(2, 6, Math.max(1, sheet.getMaxRows() - 1), 2).setWrap(true);
    sheet.setColumnWidth(2, 180);
    sheet.setColumnWidth(6, 160);
    sheet.setColumnWidth(7, 260);
    sheet.setColumnWidth(9, 180);
  } catch (e) {}

  const dispatch = ss.getSheetByName('DISPATCH');
  if (dispatch) {
    dispatch.getRange('F2:F100').setFormula('=IFERROR(VLOOKUP(D2,PASSENGERS!$B$2:$E,3,false),"")');
    dispatch.getRange('G2:G100').setFormula('=IFERROR(VLOOKUP(D2,PASSENGERS!$B$2:$E,4,false),"")');
    dispatch.getRange('H2:H100').setFormula('=IFERROR(VLOOKUP(D2,PASSENGERS!$B$2:$E,2,false),"")');
  }
  try {
    const nameRange = sheet.getRange('B2:B');
    const rule = SpreadsheetApp.newDataValidation().requireValueInRange(nameRange, true).setAllowInvalid(true).build();
    ['DISPATCH', 'PAGE 2 of DISPATCH'].forEach(function(tabName) {
      const tab = ss.getSheetByName(tabName);
      if (tab) tab.getRange('D2:D100').setDataValidation(rule);
    });
  } catch (e) {}

  invalidateFormOptionsCache_();
  const summary = 'Repaired PASSENGERS with ' + output.length + ' passengers from backup.';
  Logger.log(summary);
  return summary;
}

function migrateToPassengersSheet() {
  const ss = activeSpreadsheet_();
  const source = ss.getSheetByName('ADD PASSENGERS');
  let sheet = ss.getSheetByName(PASSENGERS_SHEET_NAME_);
  if (!source) {
    if (sheet) return 'Already migrated: PASSENGERS exists and ADD PASSENGERS is gone.';
    throw new Error('ADD PASSENGERS sheet not found and PASSENGERS does not exist yet.');
  }

  // --- 1) Aggregate passenger records from ADD PASSENGERS ---
  const lastRow = source.getLastRow();
  const rows = lastRow >= 10 ? source.getRange(10, 1, lastRow - 9, 5).getDisplayValues() : [];
  const records = new Map();
  rows.forEach(function(row) {
    const displayName = String(row[0] || '').trim().replace(/\s+/g, ' ');
    const key = passengerCacheKey_(displayName);
    if (!key || displayName.length < 3 || !displayName.includes(',')) return;
    if (!records.has(key)) {
      records.set(key, { key: key, displayName: displayName, medicaid: '', type: '', phones: [], addresses: [] });
    }
    const record = records.get(key);
    if (!record.medicaid && row[1]) record.medicaid = String(row[1]).trim();
    if (!record.type && row[2]) record.type = String(row[2]).trim();
    const phone = String(row[3] || '').trim();
    const address = String(row[4] || '').trim();
    if (phone && record.phones.indexOf(phone) < 0) record.phones.push(phone);
    if (address && record.addresses.indexOf(address) < 0) record.addresses.push(address);
  });
  const output = Array.from(records.values())
    .sort(function(a, b) { return a.displayName.localeCompare(b.displayName); })
    .map(function(r) {
      return [r.key, r.displayName, r.medicaid, r.type, r.phones[0] || '', r.phones.join('\n'), r.addresses.join('\n'), false, '', new Date()];
    });

  if (!output.length) throw new Error('No passengers found on ADD PASSENGERS; aborting so nothing is deleted.');

  // --- 3) Back up ADD PASSENGERS into a brand-new spreadsheet (safety copy in Drive) ---
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  const backup = SpreadsheetApp.create('ADD PASSENGERS Backup (' + stamp + ')');
  const copied = source.copyTo(backup);
  copied.setName('ADD PASSENGERS');
  const defaultSheet = backup.getSheets()[0];
  if (backup.getSheets().length > 1 && defaultSheet.getName() !== 'ADD PASSENGERS') backup.deleteSheet(defaultSheet);

  // --- 4) Remove the old tabs (data already backed up above) to free workbook cells ---
  ss.deleteSheet(source);
  const oldCache = ss.getSheetByName('PASSENGER_CACHE');
  if (oldCache) ss.deleteSheet(oldCache);
  SpreadsheetApp.flush();

  // --- 2) Build the PASSENGERS sheet ---
  if (!sheet) sheet = ss.insertSheet(PASSENGERS_SHEET_NAME_);
  sheet.clear();
  const neededRows = output.length + 1;
  if (sheet.getMaxRows() < neededRows) sheet.insertRowsAfter(sheet.getMaxRows(), neededRows - sheet.getMaxRows());
  sheet.getRange(1, 1, 1, PASSENGERS_HEADERS_.length).setValues([PASSENGERS_HEADERS_]).setFontWeight('bold');
  if (output.length) sheet.getRange(2, 1, output.length, PASSENGERS_HEADERS_.length).setValues(output);
  sheet.setFrozenRows(1);
  sheet.hideColumns(1);
  try {
    const cbRule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
    sheet.getRange(2, 8, Math.max(1, sheet.getMaxRows() - 1), 1).setDataValidation(cbRule);
    sheet.getRange(2, 6, Math.max(1, sheet.getMaxRows() - 1), 2).setWrap(true);
    sheet.setColumnWidth(2, 180);
    sheet.setColumnWidth(6, 160);
    sheet.setColumnWidth(7, 260);
    sheet.setColumnWidth(9, 180);
  } catch (e) {}

  // --- 5) Re-point DISPATCH formulas + passenger dropdowns at the new PASSENGERS sheet ---
  const dispatch = ss.getSheetByName('DISPATCH');
  if (dispatch) {
    dispatch.getRange('F2:F100').setFormula('=IFERROR(VLOOKUP(D2,PASSENGERS!$B$2:$E,3,false),"")');
    dispatch.getRange('G2:G100').setFormula('=IFERROR(VLOOKUP(D2,PASSENGERS!$B$2:$E,4,false),"")');
    dispatch.getRange('H2:H100').setFormula('=IFERROR(VLOOKUP(D2,PASSENGERS!$B$2:$E,2,false),"")');
  }
  try {
    const nameRange = sheet.getRange('B2:B');
    const rule = SpreadsheetApp.newDataValidation().requireValueInRange(nameRange, true).setAllowInvalid(true).build();
    ['DISPATCH', 'PAGE 2 of DISPATCH'].forEach(function(tabName) {
      const tab = ss.getSheetByName(tabName);
      if (tab) tab.getRange('D2:D100').setDataValidation(rule);
    });
  } catch (e) {}

  invalidateFormOptionsCache_();
  const summary = 'Migrated ' + output.length + ' passengers to PASSENGERS. Backup: ' + backup.getUrl();
  Logger.log(summary);
  return summary;
}

// Legacy alias: rebuilding now just means clearing the cached form options.
function rebuildPassengerCache() {
  invalidateFormOptionsCache_();
  return getPassengerCacheLookup_().size;
}

//  ==========  END  ============


// ===============================
//          VEHICALS
// ===============================

function getVehicleOptions() {
  const ss = SpreadsheetApp.openById("13ynJ0Q_pn-Ao4fcJTmpSswbAk8MRy-RMpCF3YnIm-Ug");
  const sheet = ss.getSheetByName("Vehicles");
  const data = sheet.getRange("B2:K").getValues(); // B → K = columns 2 → 11

  const options = [];

  for (let i = 0; i < data.length; i++) {
    const [name, nickname, make, plate, type, vin, , , , , vehicleType] = data[i];

    if (!name) continue;

    const label = nickname
      ? `${name} (${nickname})`
      : name;

    options.push({
      label: label.trim(),
      value: name.trim(),
      vehicleType: (vehicleType || "").trim(),
      meta: {
        plate: plate?.toString().trim(),
        make: make?.toString().trim(),
        type: type?.toString().trim(),
        vin: vin?.toString().trim()
      }
    });
  }

  return options;
}


//  ==========  END  ============



// ===============================
//          DRIVERS
// ===============================

function getDriverOptions() {
  const ss = SpreadsheetApp.openById("1W9gT2Tkifd9Mdh9q3ZGaR-4Q6E24S75AzGuRe10DrKE");
  const sheet = ss.getSheetByName("STAFF");
  const data = sheet.getRange("A2:AT").getValues(); // Includes Column AT

  const options = [];

  for (let i = 0; i < data.length; i++) {
    const name = String(data[i][0] || "").trim();
    if (!name) continue;

    options.push({
      label: name,
      value: name,
      license: String(data[i][1] || "").trim(),
      initials: String(data[i][2] || "").trim(),
      phone: String(data[i][3] || "").trim(),
      email: String(data[i][4] || "").trim(),
      carrier: String(data[0][45] || "").trim()  // Column AT = index 45 (0-based)
    });
  }

  return options;
}

//  ==========  END  ============




