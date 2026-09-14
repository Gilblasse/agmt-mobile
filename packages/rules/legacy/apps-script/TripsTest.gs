function TEST_sidebarCudDispatchSyncSuite() {
  TEST_sidebarFormsRouteCudThroughDispatchSync();
  TEST_tripActivityStatusSelectionIsolated();
  TEST_groupedTripSectionsCanCollapseIsolated();
  TEST_dispatchEditRefreshesPassengerTripsIsolated();
  TEST_sidebarCreateSyncsLogAndDispatchIsolated();
  TEST_sidebarCreateStopsAtDispatchRowLimitIsolated();
  TEST_sidebarUpdateSyncsLogAndDispatchIsolated();
  TEST_sidebarDeleteSyncsLogAndDispatchIsolated();
  TEST_dispatchRowToTripObjectStatusAndNotes();
  Logger.log('PASS: complete sidebar CUD and Dispatch synchronization suite.');
}



function TEST_tripActivityStatusSelectionIsolated() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const suffix = Date.now() + '_' + Math.floor(Math.random() * 100000);
  const dispatchSheet = ss.insertSheet('__TRIP_ACTIVITY_' + suffix);
  const tripKeyID = 'activity-' + Utilities.getUuid();

  try {
    if (dispatchSheet.getMaxColumns() < 32) {
      dispatchSheet.insertColumnsAfter(dispatchSheet.getMaxColumns(), 32 - dispatchSheet.getMaxColumns());
    }

    dispatchSheet.getRange(2, COLUMN.DISPATCH.TIME + 1)
      .setValue(new Date(1899, 11, 30, 8, 15, 0))
      .setNumberFormat('h:mm AM/PM');
    dispatchSheet.getRange(2, COLUMN.DISPATCH.TRIP_KEY_ID + 1).setValue(tripKeyID);
    dispatchSheet.getRange(2, COLUMN.DISPATCH.IN + 1)
      .setValue(new Date(1899, 11, 30, 9, 3, 0))
      .setNumberFormat('h:mm AM/PM');
    dispatchSheet.getRange(2, COLUMN.DISPATCH.OUT + 1)
      .setValue(new Date(1899, 11, 30, 9, 42, 0))
      .setNumberFormat('h:mm AM/PM');
    SpreadsheetApp.flush();

    const service = {
      getSheet: function() { return dispatchSheet; }
    };
    const sidebarService = new SidebarTripService(service, {});
    const activity = sidebarService.getActivity(tripKeyID);
    const missing = sidebarService.getActivity('missing-trip-key');

    assertPassengerTripsTest_(activity && activity.found === true,
      'Matched Dispatch trip activity was not found.');
    assertPassengerTripsTest_(String(activity.scheduledTime).indexOf('8:15') !== -1,
      'Scheduled time was not returned as a display value.');
    assertPassengerTripsTest_(String(activity.pickupArrival).indexOf('9:03') !== -1,
      'Dispatch IN time was not returned as pickup arrival.');
    assertPassengerTripsTest_(String(activity.dropoffArrival).indexOf('9:42') !== -1,
      'Dispatch OUT time was not returned as drop-off arrival.');
    assertPassengerTripsTest_(missing && missing.found === false,
      'A missing Dispatch trip should return found=false.');

    const source = HtmlService.createTemplateFromFile('TripsPage').getRawContent();
    assertPassengerTripsTest_(source.indexOf('.getTripActivity(trip.tripKeyID)') !== -1,
      'Passenger Trips status control is not routed to live Dispatch activity.');
    assertPassengerTripsTest_(source.indexOf("setAttribute('aria-expanded', 'false')") !== -1,
      'Passenger Trips status control is missing its accessible expanded state.');

    Logger.log('PASS: status selection loads Dispatch IN/OUT arrival details on demand.');
  } finally {
    ss.deleteSheet(dispatchSheet);
  }
}



function TEST_groupedTripSectionsCanCollapseIsolated() {
  const source = HtmlService.createTemplateFromFile('TripsPage').getRawContent();

  assertPassengerTripsTest_(source.indexOf("createTripSection('driver'") !== -1,
    'Driver grouping does not use grouped trip sections.');
  assertPassengerTripsTest_(source.indexOf("createTripSection('status'") !== -1,
    'Status grouping does not use grouped trip sections.');
  assertPassengerTripsTest_(source.indexOf("createTripSection('transport'") !== -1,
    'Transport grouping does not use grouped trip sections.');
  assertPassengerTripsTest_(source.indexOf("className = type + '-header trip-section-toggle'") !== -1,
    'Grouped trip section headers are not interactive controls.');
  assertPassengerTripsTest_(source.indexOf("header.setAttribute('aria-expanded', expanded ? 'true' : 'false')") !== -1,
    'Grouped trip sections do not expose their expanded state.');
  assertPassengerTripsTest_(source.indexOf('body.hidden = !expanded') !== -1,
    'Grouped trip sections do not hide and reveal their trip content.');

  Logger.log('PASS: Driver, Status, and Transport groups can expand and collapse independently.');
}


function TEST_dispatchEditRefreshesPassengerTripsIsolated() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const suffix = Date.now() + '_' + Math.floor(Math.random() * 100000);
  const logSheet = ss.insertSheet('__DISPATCH_EDIT_LOG_' + suffix);
  const dispatchSheet = ss.insertSheet('__DISPATCH_EDIT_SHEET_' + suffix);
  const dateKey = '2099-06-08';
  const tripKeyID = 'dispatch-edit-' + Utilities.getUuid();

  try {
    logSheet.getRange('A1:B1').setValues([['Date', 'Trips']]);
    if (dispatchSheet.getMaxColumns() < 32) {
      dispatchSheet.insertColumnsAfter(dispatchSheet.getMaxColumns(), 32 - dispatchSheet.getMaxColumns());
    }

    const service = {
      getSheet: function(scope, sheetName) {
        return sheetName === 'LOG' ? logSheet : dispatchSheet;
      }
    };
    const manager = new TripManager(service, logManager);
    const sidebarService = new SidebarTripService(service, manager);
    sidebarService.create({
      tripKeyID: tripKeyID,
      id: '',
      date: dateKey,
      time: '08:30',
      passenger: 'Original, Passenger',
      invoice: 'ORIGINAL-INV',
      pickup: 'Original Pickup',
      dropoff: 'Original Dropoff',
      vehicle: 'Original Vehicle',
      driver: 'Original Driver',
      notes: 'Original note'
    });

    dispatchSheet.getRange(2, COLUMN.DISPATCH.PASSENGER + 1)
      .setValue('Updated, Passenger');
    dispatchSheet.getRange(2, COLUMN.DISPATCH.INVOICE + 1)
      .setValue('UPDATED-INV');
    dispatchSheet.getRange(2, COLUMN.DISPATCH.VEHICLE + 1)
      .setValue('Updated Vehicle');
    SpreadsheetApp.flush();

    const result = manager.onDispatchSheetEdit({
      range: dispatchSheet.getRange(2, COLUMN.DISPATCH.PASSENGER + 1, 1,
        COLUMN.DISPATCH.VEHICLE - COLUMN.DISPATCH.PASSENGER + 1),
      source: {
        getSheetByName: function() { return dispatchSheet; }
      }
    });

    invalidateTripsCache_([dateKey]);
    const saved = manager.getTripsByDate(dateKey);
    assertPassengerTripsTest_(result && result.updated === 1,
      'The Dispatch edit handler did not report one matched trip update.');
    assertPassengerTripsTest_(saved.length === 1 && saved[0].tripKeyID === tripKeyID,
      'The Dispatch edit did not preserve the matched sidebar trip.');
    assertPassengerTripsTest_(saved[0].passenger === 'Updated, Passenger',
      'The sidebar data did not receive the Dispatch passenger edit.');
    assertPassengerTripsTest_(saved[0].invoice === 'UPDATED-INV',
      'The sidebar data did not receive the Dispatch invoice edit.');
    assertPassengerTripsTest_(saved[0].vehicle === 'Updated Vehicle',
      'The sidebar data did not receive the Dispatch vehicle edit.');

    Logger.log('PASS: matched Dispatch edits refresh Passenger Trips data.');
  } finally {
    invalidateTripsCache_([dateKey]);
    ss.deleteSheet(dispatchSheet);
    ss.deleteSheet(logSheet);
  }
}

function TEST_sidebarFormsRouteCudThroughDispatchSync() {
  const addSource = HtmlService.createTemplateFromFile('AddTripPage').getRawContent();
  const editSource = HtmlService.createTemplateFromFile('EditTripPage').getRawContent();

  assertPassengerTripsTest_(addSource.indexOf('.addTripsFromSidebar(tripsToSave)') !== -1,
    'Add Trip form does not route ordinary creates through Dispatch synchronization.');
  assertPassengerTripsTest_(addSource.indexOf('.createRecurringTripsFromSidebar(parent, expandedDates)') !== -1,
    'Add Trip form does not route standing-order creates through Dispatch synchronization.');
  assertPassengerTripsTest_(editSource.indexOf('tripKeyID: currentTrip ? currentTrip.tripKeyID') !== -1,
    'Edit Trip form does not preserve tripKeyID.');
  assertPassengerTripsTest_(editSource.indexOf('.updateTripFromSidebar(trip)') !== -1,
    'Edit Trip form does not route updates through Dispatch synchronization.');
  assertPassengerTripsTest_(editSource.indexOf('.deleteTripFromSidebar(tripKeyID, date)') !== -1,
    'Edit Trip form does not route deletes through Dispatch synchronization.');
  assertPassengerTripsTest_(editSource.indexOf('.deleteRecurringTripsFromSidebar(currentTrip.recurringId, selected)') !== -1,
    'Edit Trip form does not route recurring deletes through Dispatch synchronization.');
  assertPassengerTripsTest_(editSource.indexOf('.snapshotDispatchToLog()') === -1,
    'Edit Trip form still runs a redundant full Dispatch snapshot after delete.');

  Logger.log('PASS: sidebar forms route CUD through Dispatch synchronization.');
}


function TEST_sidebarDeleteSyncsLogAndDispatchIsolated() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const suffix = Date.now() + '_' + Math.floor(Math.random() * 100000);
  const logSheet = ss.insertSheet('__SIDEBAR_DELETE_LOG_' + suffix);
  const dispatchSheet = ss.insertSheet('__SIDEBAR_DELETE_DISPATCH_' + suffix);
  const dateKey = '2099-04-06';
  const tripKeyID = 'sidebar-delete-' + Utilities.getUuid();

  try {
    logSheet.getRange('A1:B1').setValues([['Date', 'Trips']]);
    if (dispatchSheet.getMaxColumns() < 32) {
      dispatchSheet.insertColumnsAfter(dispatchSheet.getMaxColumns(), 32 - dispatchSheet.getMaxColumns());
    }
    dispatchSheet.getRange(2, 6).setFormula('=IF(D2="","",D2&"-profile")');
    dispatchSheet.getRange(2, 24).setFormula('=IF(D2="","",K2&"-legacy")');

    const service = {
      getSheet: function(scope, sheetName) {
        return sheetName === 'LOG' ? logSheet : dispatchSheet;
      }
    };
    const manager = new TripManager(service, logManager);
    const sidebarService = new SidebarTripService(service, manager);
    const trip = {
      tripKeyID: tripKeyID,
      id: 'legacy-delete-id',
      date: dateKey,
      time: '11:45',
      passenger: 'Delete, Passenger',
      invoice: 'DELETE-INV',
      pickup: 'Delete Pickup',
      dropoff: 'Delete Dropoff',
      status: 'READY',
      vehicle: 'Delete Vehicle',
      driver: 'Delete Driver',
      notes: 'Delete me',
      returnOf: '',
      recurringId: ''
    };

    sidebarService.create(trip);
    sidebarService.delete(tripKeyID, dateKey);

    invalidateTripsCache_([dateKey]);
    assertPassengerTripsTest_(manager.getTripsByDate(dateKey).length === 0,
      'Sidebar delete did not remove the trip from LOG.');
    const keyMatches = dispatchSheet.getRange(2, COLUMN.DISPATCH.TRIP_KEY_ID + 1,
      dispatchSheet.getMaxRows() - 1, 1).createTextFinder(tripKeyID).matchEntireCell(true).findAll();
    assertPassengerTripsTest_(keyMatches.length === 0,
      'Sidebar delete left the trip key on DISPATCH.');
    const row = dispatchSheet.getRange(2, 1, 1, 32).getValues()[0];
    assertPassengerTripsTest_(!row[COLUMN.DISPATCH.PASSENGER] && !row[COLUMN.DISPATCH.NOTES],
      'Sidebar delete left trip content on DISPATCH.');
    assertPassengerTripsTest_(dispatchSheet.getRange('F2').getFormula() !== '',
      'Sidebar delete removed a passenger-profile formula.');
    assertPassengerTripsTest_(dispatchSheet.getRange('X2').getFormula() !== '',
      'Sidebar delete removed the legacy ID formula.');

    Logger.log('PASS: sidebar delete synchronized LOG and DISPATCH.');
  } finally {
    invalidateTripsCache_([dateKey]);
    ss.deleteSheet(dispatchSheet);
    ss.deleteSheet(logSheet);
  }
}


function TEST_sidebarUpdateSyncsLogAndDispatchIsolated() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const suffix = Date.now() + '_' + Math.floor(Math.random() * 100000);
  const logSheet = ss.insertSheet('__SIDEBAR_UPDATE_LOG_' + suffix);
  const dispatchSheet = ss.insertSheet('__SIDEBAR_UPDATE_DISPATCH_' + suffix);
  const originalDate = '2099-03-04';
  const updatedDate = '2099-03-05';
  const tripKeyID = 'sidebar-update-' + Utilities.getUuid();

  try {
    logSheet.getRange('A1:B1').setValues([['Date', 'Trips']]);
    if (dispatchSheet.getMaxColumns() < 32) {
      dispatchSheet.insertColumnsAfter(dispatchSheet.getMaxColumns(), 32 - dispatchSheet.getMaxColumns());
    }
    dispatchSheet.getRange(2, 6).setFormula('=IF(D2="","",D2&"-profile")');
    dispatchSheet.getRange(2, 24).setFormula('=IF(D2="","",K2&"-legacy")');

    const service = {
      getSheet: function(scope, sheetName) {
        return sheetName === 'LOG' ? logSheet : dispatchSheet;
      }
    };
    const manager = new TripManager(service, logManager);
    const sidebarService = new SidebarTripService(service, manager);
    const originalTrip = {
      tripKeyID: tripKeyID,
      id: 'legacy-update-id',
      date: originalDate,
      time: '08:00',
      passenger: 'Original, Passenger',
      invoice: 'OLD-INV',
      pickup: 'Old Pickup',
      dropoff: 'Old Dropoff',
      status: 'READY',
      vehicle: 'Old Vehicle',
      driver: 'Old Driver',
      notes: 'Old note',
      returnOf: '',
      recurringId: ''
    };

    sidebarService.create(originalTrip);
    const updatedTrip = Object.assign({}, originalTrip, {
      date: updatedDate,
      time: '10:30',
      passenger: 'Updated, Passenger',
      invoice: 'NEW-INV',
      pickup: 'New Pickup',
      dropoff: 'New Dropoff',
      status: 'UPDATE TIME',
      vehicle: 'New Vehicle',
      driver: 'New Driver',
      notes: 'Updated from sidebar',
      returnOf: 'parent-id',
      recurringId: 'standing-id'
    });
    sidebarService.update(updatedTrip);

    invalidateTripsCache_([originalDate, updatedDate]);
    assertPassengerTripsTest_(manager.getTripsByDate(originalDate).length === 0,
      'Sidebar update left the trip on its original LOG date.');
    const saved = manager.getTripsByDate(updatedDate);
    assertPassengerTripsTest_(saved.length === 1 && saved[0].notes === 'Updated from sidebar',
      'Sidebar update did not persist the moved trip in LOG.');

    const keyMatches = dispatchSheet.getRange(2, COLUMN.DISPATCH.TRIP_KEY_ID + 1,
      dispatchSheet.getMaxRows() - 1, 1).createTextFinder(tripKeyID).matchEntireCell(true).findAll();
    assertPassengerTripsTest_(keyMatches.length === 1,
      'Sidebar update duplicated the DISPATCH row.');
    const rowNumber = keyMatches[0].getRow();
    const row = dispatchSheet.getRange(rowNumber, 1, 1, 32).getValues()[0];
    assertPassengerTripsTest_(Utils.formatDateString(row[COLUMN.DISPATCH.DATE]) === updatedDate,
      'Sidebar update did not move the DISPATCH date.');
    assertPassengerTripsTest_(row[COLUMN.DISPATCH.PASSENGER] === 'Updated, Passenger',
      'Sidebar update did not update the DISPATCH passenger.');
    assertPassengerTripsTest_(row[COLUMN.DISPATCH.TODAY] === 'UPDATE TIME',
      'Sidebar update did not update the DISPATCH status override.');
    assertPassengerTripsTest_(row[COLUMN.DISPATCH.NOTES] === 'Updated from sidebar',
      'Sidebar update did not update the DISPATCH notes.');
    assertPassengerTripsTest_(dispatchSheet.getRange(rowNumber, 6).getFormula() !== '',
      'Sidebar update overwrote a passenger-profile formula.');
    assertPassengerTripsTest_(dispatchSheet.getRange(rowNumber, 24).getFormula() !== '',
      'Sidebar update overwrote the legacy ID formula.');

    Logger.log('PASS: sidebar update synchronized LOG and DISPATCH.');
  } finally {
    invalidateTripsCache_([originalDate, updatedDate]);
    ss.deleteSheet(dispatchSheet);
    ss.deleteSheet(logSheet);
  }
}



function TEST_sidebarCreateSyncsLogAndDispatchIsolated() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const suffix = Date.now() + '_' + Math.floor(Math.random() * 100000);
  const logSheet = ss.insertSheet('__SIDEBAR_LOG_' + suffix);
  const dispatchSheet = ss.insertSheet('__SIDEBAR_DISPATCH_' + suffix);
  const dateKey = '2099-02-03';
  const tripKeyID = 'sidebar-create-' + Utilities.getUuid();

  try {
    logSheet.getRange('A1:B1').setValues([['Date', 'Trips']]);
    if (dispatchSheet.getMaxColumns() < 32) {
      dispatchSheet.insertColumnsAfter(dispatchSheet.getMaxColumns(), 32 - dispatchSheet.getMaxColumns());
    }
    dispatchSheet.getRange(2, 6).setFormula('=IF(D2="","",D2&"-profile")');
    dispatchSheet.getRange(2, 24).setFormula('=IF(D2="","",K2&"-legacy")');

    const service = {
      getSheet: function(scope, sheetName) {
        return sheetName === 'LOG' ? logSheet : dispatchSheet;
      }
    };
    const manager = new TripManager(service, logManager);
    const sidebarService = new SidebarTripService(service, manager);
    const trip = {
      tripKeyID: tripKeyID,
      id: 'legacy-create-id',
      date: dateKey,
      time: '09:15',
      passenger: 'Test, Passenger',
      transport: 'Wheelchair',
      phone: '555-0100',
      medicaid: 'MED-1',
      invoice: 'INV-1',
      pickup: 'One Test Way',
      dropoff: 'Two Test Way',
      status: 'READY',
      vehicle: 'Vehicle 1',
      driver: 'Driver 1',
      notes: 'Created from sidebar',
      returnOf: '',
      recurringId: ''
    };

    sidebarService.create(trip);

    const saved = manager.getTripsByDate(dateKey);
    assertPassengerTripsTest_(saved.length === 1 && saved[0].tripKeyID === tripKeyID,
      'Sidebar create did not persist the trip to LOG.');

    const row = dispatchSheet.getRange(2, 1, 1, 32).getValues()[0];
    assertPassengerTripsTest_(row[COLUMN.DISPATCH.TRIP_KEY_ID] === tripKeyID,
      'Sidebar create did not place the trip key on DISPATCH.');
    assertPassengerTripsTest_(row[COLUMN.DISPATCH.PASSENGER] === 'Test, Passenger',
      'Sidebar create did not place the passenger on DISPATCH.');
    assertPassengerTripsTest_(row[COLUMN.DISPATCH.TODAY] === 'READY',
      'Sidebar create did not place the status override on DISPATCH.');
    assertPassengerTripsTest_(row[COLUMN.DISPATCH.NOTES] === 'Created from sidebar',
      'Sidebar create did not place the notes on DISPATCH.');
    assertPassengerTripsTest_(dispatchSheet.getRange('F2').getFormula() !== '',
      'Sidebar create overwrote a passenger-profile formula.');
    assertPassengerTripsTest_(dispatchSheet.getRange('X2').getFormula() !== '',
      'Sidebar create overwrote the legacy ID formula.');

    Logger.log('PASS: sidebar create synchronized LOG and DISPATCH.');
  } finally {
    invalidateTripsCache_([dateKey]);
    ss.deleteSheet(dispatchSheet);
    ss.deleteSheet(logSheet);
  }
}


function TEST_sidebarCreateStopsAtDispatchRowLimitIsolated() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const suffix = Date.now() + '_' + Math.floor(Math.random() * 100000);
  const logSheet = ss.insertSheet('__SIDEBAR_CAP_LOG_' + suffix);
  const dispatchSheet = ss.insertSheet('__SIDEBAR_CAP_DISPATCH_' + suffix);
  const dateKey = '2099-05-07';
  const tripKeyID = 'sidebar-cap-' + Utilities.getUuid();

  try {
    logSheet.getRange('A1:B1').setValues([['Date', 'Trips']]);
    if (dispatchSheet.getMaxColumns() < 32) {
      dispatchSheet.insertColumnsAfter(dispatchSheet.getMaxColumns(), 32 - dispatchSheet.getMaxColumns());
    }
    if (dispatchSheet.getMaxRows() > 100) {
      dispatchSheet.deleteRows(101, dispatchSheet.getMaxRows() - 100);
    } else if (dispatchSheet.getMaxRows() < 100) {
      dispatchSheet.insertRowsAfter(dispatchSheet.getMaxRows(), 100 - dispatchSheet.getMaxRows());
    }

    const occupied = Array.from({ length: 99 }, function(_, index) {
      return ['Occupied Passenger ' + index, 'occupied-key-' + index];
    });
    dispatchSheet.getRange(2, COLUMN.DISPATCH.PASSENGER + 1, 99, 1)
      .setValues(occupied.map(function(row) { return [row[0]]; }));
    dispatchSheet.getRange(2, COLUMN.DISPATCH.TRIP_KEY_ID + 1, 99, 1)
      .setValues(occupied.map(function(row) { return [row[1]]; }));

    const service = {
      getSheet: function(scope, sheetName) {
        return sheetName === 'LOG' ? logSheet : dispatchSheet;
      }
    };
    const manager = new TripManager(service, logManager);
    const sidebarService = new SidebarTripService(service, manager);
    const result = sidebarService.create({
      tripKeyID: tripKeyID,
      id: 'legacy-cap-id',
      date: dateKey,
      time: '12:15',
      passenger: 'Overflow, Passenger',
      pickup: 'Overflow Pickup',
      dropoff: 'Overflow Dropoff'
    });

    invalidateTripsCache_([dateKey]);
    const saved = manager.getTripsByDate(dateKey);
    assertPassengerTripsTest_(saved.length === 1 && saved[0].tripKeyID === tripKeyID,
      'The capped trip was not retained in LOG.');
    assertPassengerTripsTest_(result.dispatchRows.length === 0,
      'The capped trip was unexpectedly written to DISPATCH.');
    assertPassengerTripsTest_(result.dispatchSkipped === 1,
      'The capped trip was not reported as skipped for DISPATCH.');
    assertPassengerTripsTest_(dispatchSheet.getMaxRows() === 100,
      'Sidebar create added a DISPATCH row beyond row 100.');
    const match = dispatchSheet.getRange(2, COLUMN.DISPATCH.TRIP_KEY_ID + 1, 99, 1)
      .createTextFinder(tripKeyID).matchEntireCell(true).findNext();
    assertPassengerTripsTest_(!match,
      'The capped trip key was found in DISPATCH.');

    Logger.log('PASS: sidebar create retained LOG data and stopped at DISPATCH row 100.');
  } finally {
    invalidateTripsCache_([dateKey]);
    ss.deleteSheet(dispatchSheet);
    ss.deleteSheet(logSheet);
  }
}

class TripsTest {
  deleteStandingOrderOnDates() {
    const ss = SpreadsheetApp.create('DeleteStandingOrderTest');
    const logSheet = ss.getSheets()[0];
    logSheet.setName('LOG');
    logSheet.getRange('A1:B1').setValues([['Date', 'Trips']]);

    const service = new SpreadsheetService({ Dispatcher: ss.getId() });
    const manager = new TripManager(service, logManager);

    const standingOrder = {
      pattern: encodeDatePattern(
        '2024-06-01',
        '2024-06-02',
        ['SAT', 'SUN']
      ),
      withReturnTrip: true,
      returnTime: '1899-12-30T14:40:00Z'
    };

    const soMap = {};
    const soKey = 'so1';
    soMap[soKey] = standingOrder;
    manager.updateStandingOrderMap(soMap);

    const baseTrip = {
      date: '2024-06-01',
      time: '09:00',
      passenger: 'Test Passenger',
      transport: 'Test Transport',
      phone: '555-0000',
      medicaid: 'MED123',
      invoice: 'test',
      pickup: 'Home',
      dropoff: 'Clinic',
      status: '',
      vehicle: '',
      driver: '',
      notes: 'This is a TEST !!!',
      returnOf: 'orig',
      recurringId: soKey
    };
    const trip1 = Object.assign({ id: 't1', date: '2024-06-01' }, baseTrip);
    const trip2 = Object.assign({ id: 't2', date: '2024-06-02' }, baseTrip);

    manager.addTripToLog(trip1);
    manager.addTripToLog(trip2);

    manager.deleteStandingOrderOnDates(soKey, ['2024-06-01', '2024-06-02']);

    const remaining = manager.getAllTrips();
    if (remaining.length !== 0) {
      throw new Error('Trips were not removed from log sheet');
    }

    if (manager.getStandingOrderMap()[soKey]) {
      throw new Error('Standing order template not deleted');
    } else {
      Logger.log('testDeleteStandingOrderOnDates passed');
    }

    DriveApp.getFileById(ss.getId()).setTrashed(true);
  }

  backSyncLogObjectsUsesTripKeyID() {
    const ss = SpreadsheetApp.create('BackSyncLogObjectsTest');
    const sheet = ss.getSheets()[0];
    sheet.setName('LOG');
    sheet.getRange('A1:B1').setValues([['Date', 'Trips']]);

    const service = new SpreadsheetService({ Dispatcher: ss.getId() });
    const manager = new TripManager(service, logManager);

    const trip = {
      id: 't1',
      tripKeyID: 'key123',
      date: '2024-07-01',
      time: '10:00',
      passenger: 'P',
      transport: 'V',
      phone: '555',
      medicaid: 'M',
      invoice: 'I',
      pickup: 'A',
      dropoff: 'B',
      status: '',
      vehicle: '',
      driver: '',
      notes: '',
      returnOf: '',
      recurringId: ''
    };

    const map = new Map([['wrong', trip]]);
    sheet.appendRow(['2024-07-01', serializeTripMap(map)]);

    backSyncLogObjects();

    const updated = deserializeTripMap(sheet.getRange(2, 2).getValue());
    const key = Array.from(updated.keys())[0];
    if (key !== 'key123') {
      throw new Error('backSyncLogObjects did not persist tripKeyID');
    } else {
      Logger.log('testBackSyncLogObjectsUsesTripKeyID passed');
    }

    DriveApp.getFileById(ss.getId()).setTrashed(true);
  }

  dispatchRowToTripObjectStatusAndNotes() {
    const row = Array(32).fill('');
    row[0] = '2024-07-04';
    row[2] = '08:00';
    row[3] = 'Passenger';
    row[5] = 'Wheelchair';
    row[6] = '555';
    row[7] = 'MED';
    row[8] = 'INV';
    row[9] = 'Pickup';
    row[10] = 'key1';
    row[12] = 'Dropoff';
    row[16] = 'COMPLETE';
    row[17] = 'Vehicle';
    row[20] = 'Driver';
    row[23] = 'id1';
    row[24] = 'note';

    const trip = dispatchRowToTripObject(row);
    const expected = ['Passenger', 'Wheelchair', '555', 'MED', 'INV', 'Pickup', 'Dropoff', 'Vehicle', 'Driver', 'COMPLETE', 'note'];
    const actual = [trip.passenger, trip.transport, trip.phone, trip.medicaid, trip.invoice, trip.pickup, trip.dropoff, trip.vehicle, trip.driver, trip.status, trip.notes];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error('DISPATCH column mapping is incorrect: ' + JSON.stringify(actual));
    }
    Logger.log('testDispatchRowToTripObjectStatusAndNotes passed');
  }

  testOnEdit() {
    tripManager.testOnEdit();
  }

  showAddTripSidebar(date) {
    tripRouter.showAddTripSidebar(date);
  }

  openEditTripSidebar(id) {
    tripRouter.openEditTripSidebar(id);
  }

  showEditTripSidebar(id, date) {
    tripRouter.showEditTripSidebar(id, date);
  }

  openPassengerTripList(date) {
    tripRouter.openPassengerTripList(date);
  }

  showRestoreDatePicker() {
    tripRouter.showRestoreDatePicker();
  }
}

const tripsTest = new TripsTest();

function TEST_deleteStandingOrderOnDates() { tripsTest.deleteStandingOrderOnDates(); }
function TEST_onEdit() { tripsTest.testOnEdit(); }
function TEST_showAddTripSidebar(date) { tripsTest.showAddTripSidebar(date); }
function TEST_openEditTripSidebar(id) { tripsTest.openEditTripSidebar(id); }
function TEST_showEditTripSidebar(id, date) { tripsTest.showEditTripSidebar(id, date); }
function TEST_openPassengerTripList(date) { tripsTest.openPassengerTripList(date); }
function TEST_showRestoreDatePicker() { tripsTest.showRestoreDatePicker(); }
function TEST_backSyncLogObjectsUsesTripKeyID() { tripsTest.backSyncLogObjectsUsesTripKeyID(); }
function TEST_dispatchRowToTripObjectStatusAndNotes() { tripsTest.dispatchRowToTripObjectStatusAndNotes(); }


function assertPassengerTripsTest_(condition, message) {
  if (!condition) throw new Error(message || 'Passenger trip assertion failed.');
}

function TEST_tripCrudRoundTripIsolated() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = '__TRIP_CRUD_TEST_' + Date.now();
  const sheet = ss.insertSheet(sheetName);
  sheet.hideSheet();
  const service = { getSheet: function() { return sheet; } };
  const manager = new TripManager(service, logManager);
  const dateKey = '2099-01-02';
  const tripKeyID = 'test-' + Utilities.getUuid();
  try {
    manager.addTripToLog({
      tripKeyID: tripKeyID,
      id: 'legacy-test-id',
      date: dateKey,
      time: '09:15',
      passenger: 'Test, Passenger',
      pickup: 'One Test Way',
      dropoff: 'Two Test Way',
      driver: 'Driver One'
    });
    let trips = manager.getTripsByDate(dateKey);
    assertPassengerTripsTest_(trips.length === 1, 'Add did not create exactly one trip.');
    trips[0].driver = 'Driver Two';
    manager.updateTripInLog(trips[0]);
    invalidateTripsCache_([dateKey]);
    trips = manager.getTripsByDate(dateKey);
    assertPassengerTripsTest_(trips[0].driver === 'Driver Two', 'Update did not persist.');
    manager.deleteTripFromLog(tripKeyID, dateKey);
    invalidateTripsCache_([dateKey]);
    trips = manager.getTripsByDate(dateKey);
    assertPassengerTripsTest_(trips.length === 0, 'Delete did not remove the trip.');
    Logger.log('PASS: isolated add/update/delete round trip.');
  } finally {
    clearTripDateRowIndex_(sheet);
    ss.deleteSheet(sheet);
  }
}

function TEST_tripIndexesMatchLog() {
  const result = validateTripIndexAgainstLog();
  if (result.issues.length) Logger.log('TRIP_INDEX_ISSUES ' + JSON.stringify(result.issues.slice(0, 10)));
  assertPassengerTripsTest_(result.issues.length === 0, 'TRIP_INDEX has ' + result.issues.length + ' stale rows.');
  Logger.log('PASS: ' + result.indexedTrips + ' indexed trips match LOG.');
}

function TEST_passengerCacheHasRecords() {
  const lookup = getPassengerCacheLookup_();
  assertPassengerTripsTest_(lookup.size > 0, 'Passenger cache is empty.');
  Logger.log('PASS: passenger cache contains ' + lookup.size + ' profiles.');
}

function TEST_sidebarIndexedReadPerformance() {
  const todayKey = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  invalidateTripsCache_([todayKey]);
  const startedAt = Date.now();
  const trips = getTripsByDate(todayKey);
  const elapsed = Date.now() - startedAt;
  assertPassengerTripsTest_(elapsed < 2000, 'Indexed trip read took ' + elapsed + ' ms.');
  Logger.log('PASS: indexed read returned ' + trips.length + ' trips in ' + elapsed + ' ms.');
}