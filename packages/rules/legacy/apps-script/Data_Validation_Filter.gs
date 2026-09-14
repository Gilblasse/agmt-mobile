function normalizePassengerCacheKey_(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function buildAddressValidationRule_(addresses) {
  const values = Array.from(new Set((addresses || []).map(function(value) {
    return String(value || '').trim();
  }).filter(Boolean)));
  if (!values.length) return null;
  return SpreadsheetApp.newDataValidation()
    .requireValueInList(values, true)
    .setAllowInvalid(true)
    .build();
}

const ADDRESS_VALIDATION_SHEETS_ = ['DISPATCH', 'PAGE 2 of DISPATCH'];

function addressValidation(e) {
  const range = e && e.range;
  if (!range) {
    const migration = rowAddressValidation();
    const remaining = auditLegacyListsValidationRefs();
    return { migration: migration, remainingLegacyReferences: remaining.length };
  }
  const sheet = range.getSheet();
  if (!sheet) return false;

  const sheetName = sheet.getName();
  if (sheetName === 'PASSENGERS') {
    const intersectsProfileColumns = range.getColumn() <= 9 && range.getLastColumn() >= 1;
    if (range.getLastRow() >= 2 && intersectsProfileColumns) markPassengerCacheDirty_();
    return false;
  }

  if (ADDRESS_VALIDATION_SHEETS_.indexOf(sheetName) < 0) return false;
  if (range.getColumn() > 4 || range.getLastColumn() < 4 || range.getLastRow() < 2) return false;

  const firstRow = Math.max(2, range.getRow());
  const rowCount = range.getLastRow() - firstRow + 1;
  const passengers = sheet.getRange(firstRow, 4, rowCount, 1).getDisplayValues();

  passengers.forEach(function(row, index) {
    const targetRow = firstRow + index;
    const pickupCell = sheet.getRange(targetRow, 10);
    const dropoffCell = sheet.getRange(targetRow, 13);
    pickupCell.clearContent().clearDataValidations();
    dropoffCell.clearContent().clearDataValidations();

    const addresses = getPassengerAddressesFromCache_(row[0]);
    const rule = buildAddressValidationRule_(addresses);
    if (rule) {
      pickupCell.setDataValidation(rule);
      dropoffCell.setDataValidation(rule);
    }
  });
  return true;
}

function rowAddressValidation() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lookup = getPassengerCacheLookup_();
  const stats = [];

  ADDRESS_VALIDATION_SHEETS_.forEach(function(sheetName) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;
    const firstRow = 2;
    const rowCount = Math.max(1, sheet.getMaxRows() - firstRow + 1);
    const passengers = sheet.getRange(firstRow, 4, rowCount, 1).getDisplayValues();
    const pickupRules = [];
    const dropoffRules = [];

    passengers.forEach(function(row) {
      const record = lookup.get(normalizePassengerCacheKey_(row[0]));
      const rule = buildAddressValidationRule_(record ? record.addresses : []);
      pickupRules.push([rule]);
      dropoffRules.push([rule]);
    });

    sheet.getRange(firstRow, 10, rowCount, 1).setDataValidations(pickupRules);
    sheet.getRange(firstRow, 13, rowCount, 1).setDataValidations(dropoffRules);
    stats.push({ sheet: sheetName, rows: rowCount });
  });

  PropertiesService.getScriptProperties().setProperty('addressValdCount', String(Date.now()));
  Logger.log('ADDRESS_VALIDATION_MIGRATION ' + JSON.stringify({ sheets: stats, cachedPassengers: lookup.size }));
  return { sheets: stats, cachedPassengers: lookup.size };
}

function auditLegacyListsValidationRefs() {  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const issues = [];
  ADDRESS_VALIDATION_SHEETS_.forEach(function(sheetName) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;
    const rules = sheet.getRange(2, 10, Math.max(1, sheet.getMaxRows() - 1), 4).getDataValidations();
    rules.forEach(function(row, rowIndex) {
      row.forEach(function(rule, columnIndex) {
        if (!rule || rule.getCriteriaType() !== SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE) return;
        const criteria = rule.getCriteriaValues();
        const sourceRange = criteria && criteria[0];
        if (sourceRange && sourceRange.getSheet().getName() === 'lists') {
          issues.push(sheet.getName() + '!' + sheet.getRange(rowIndex + 2, columnIndex + 10).getA1Notation());
        }
      });
    });
  });
  Logger.log('LEGACY_LISTS_VALIDATION_REFS ' + JSON.stringify({ count: issues.length, sample: issues.slice(0, 20) }));
  return issues;
}

function toggleProtection(sheet, range, callback) {
  const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  const matched = protections.find(p => p.getRange().getA1Notation() === range.getA1Notation());

  let settings = null;

  if (matched) {
    settings = {
      editors: matched.getEditors(),
      domainEditors: matched.canDomainEdit()
    };
    matched.remove();
  }

  // Run the core action (e.g., sort)
  if (typeof callback === 'function') {
    callback();
  }

  // Reapply protection as RANGE-level protection
  const newProt = range.protect();
  newProt.setDescription("Auto-reprotected after protected action");

  if (settings) {
    if (settings.editors && settings.editors.length > 0) {
      newProt.addEditors(settings.editors);
    }
    if (settings.domainEditors) {
      newProt.setDomainEdit(true);
    }
  }
}







function sortDispatchTabA_Z() {
  const ss = SpreadsheetApp.openById("1oc_ac8XTmjcoUjy0l_vj6m5j4YYVFuRykybSHToDAME");
  const sheet = ss.getSheetByName("DISPATCH");
  const range = sheet.getRange("A2:AA100");

    range.sort([
      { column: 1, ascending: true },
      { column: 3, ascending: true }
    ]);
  // toggleProtection(sheet, range, () => {
  // });
}



function sortDispatchTabDriver() {
  
  var ss = SpreadsheetApp.openById("1oc_ac8XTmjcoUjy0l_vj6m5j4YYVFuRykybSHToDAME");
  var sheet= ss.getSheetByName("DISPATCH");
  var range = sheet.getRange("A2:AA");  // COULD UPDATE TO AA100
  
 range.sort([{column: 1, ascending: true}, {column: 21, ascending: true}]);
}



// ======================================       EXTRA DATA VALIDATION CODE        ========================================================

//function depDrop_(range, sourceRange){
//var rule = SpreadsheetApp.newDataValidation().requireValueInRange(sourceRange, true).build();
//range.setDataValidation(rule);
//}
//function onEdit (){
//var aCell = SpreadsheetApp.getActiveSheet().getActiveCell();
//var aColumn = aCell.getColumn();
//if (aColumn == 1 && SpreadsheetApp.getActiveSheet()){
//var range = SpreadsheetApp.getActiveSheet().getRange(aCell.getRow(), aColumn + 1);
//var sourceRange = SpreadsheetApp.getActiveSpreadsheet().getRangeByName(aCell.getValue());
//depDrop_(range, sourceRange);
//}
//else if (aColumn == 2 && SpreadsheetApp.getActiveSheet()){
//var range = SpreadsheetApp.getActiveSheet().getRange(aCell.getRow(), aColumn + 1);
//var sourceRange = SpreadsheetApp.getActiveSpreadsheet().getRangeByName(aCell.getValue());
//depDrop_(range, sourceRange);
//}




