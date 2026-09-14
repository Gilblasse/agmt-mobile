class TripRouter {
  openPassengerTripList(date, flash) {
    const template = HtmlService.createTemplateFromFile('TripsPage');
    const initialDate = date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    template.initialDate = initialDate;
    template.flash = flash || '';
    let initialTrips = [];
    try { initialTrips = tripManager.getTripsByDate(initialDate); } catch (err) { Logger.log('Initial trips skipped: ' + err.message); }
    template.initialTrips = JSON.stringify(initialTrips);
    let tripDatesInfo = { dates: [], firstDate: '' };
    try { tripDatesInfo = getTripDatesInfo(); } catch (err) { Logger.log('Trip dates skipped: ' + err.message); }
    template.tripDatesInfo = JSON.stringify(tripDatesInfo);
    let initialSubmitted = false;
    try { initialSubmitted = isDateSubmitted_(initialDate); } catch (err) {}
    template.initialSubmitted = JSON.stringify(initialSubmitted);
    const html = template.evaluate()
      .setTitle('Passenger Trips')
      .setWidth(400);
    SpreadsheetApp.getUi().showSidebar(html);
  }

  showAddTripSidebar(date) {
    const template = HtmlService.createTemplateFromFile('AddTripPage');
    template.initialDate = date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    let formOptions = null;
    try { formOptions = getFormOptionsBundle(); } catch (err) { Logger.log('Form options preload skipped: ' + err.message); }
    template.formOptions = JSON.stringify(formOptions);
    const html = template.evaluate()
      .setTitle('Add Trip')
      .setWidth(400);
    SpreadsheetApp.getUi().showSidebar(html);
  }

  openEditTripSidebar() {
    const html = HtmlService.createHtmlOutputFromFile('EditTripPage')
      .setTitle('Edit Trip')
      .setWidth(400);
    SpreadsheetApp.getUi().showSidebar(html);
  }

  showEditTripSidebar(id, date) {
    const template = HtmlService.createTemplateFromFile('EditTripPage');
    template.tripId = id;
    template.tripDate = date;
    let initialTrip = null;
    try { initialTrip = getTripById(encodeURIComponent(String(id || '')), date); } catch (err) { Logger.log('Edit trip preload skipped: ' + err.message); }
    template.initialTrip = JSON.stringify(initialTrip || null);
    let editFormOptions = null;
    try { editFormOptions = getFormOptionsBundle(); } catch (err) { Logger.log('Form options preload skipped: ' + err.message); }
    template.formOptions = JSON.stringify(editFormOptions);
    const html = template.evaluate()
      .setTitle('Edit Trip')
      .setWidth(400);
    SpreadsheetApp.getUi().showSidebar(html);
  }

  showRestoreDatePicker() {
    const html = HtmlService.createHtmlOutputFromFile('DatePicker')
      .setWidth(300)
      .setHeight(180);
    SpreadsheetApp.getUi().showModalDialog(html, '📅 Restore Snapshot');
  }
}

const tripRouter = new TripRouter();

function openPassengerTripList(date, flash) { tripRouter.openPassengerTripList(date, flash); }
function showAddTripSidebar(date) { tripRouter.showAddTripSidebar(date); }
function openEditTripSidebar(id) { return tripRouter.openEditTripSidebar(id); }
function showEditTripSidebar(id, date) { tripRouter.showEditTripSidebar(id, date); }
function showRestoreDatePicker() { tripRouter.showRestoreDatePicker(); }


// Mobile / standalone entry point: serves the Passenger Trips page as a web app.
function doGet(e) {
  if (e && e.parameter && e.parameter.page === 'driver') return serveDriverApp_(e);
  const template = HtmlService.createTemplateFromFile('TripsPage');
  const initialDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  template.initialDate = initialDate;
  template.flash = '';
  let initialTrips = [];
  try { initialTrips = tripManager.getTripsByDate(initialDate); } catch (err) { Logger.log('Web trips preload skipped: ' + err.message); }
  template.initialTrips = JSON.stringify(initialTrips);
  let tripDatesInfo = { dates: [], firstDate: '' };
  try { tripDatesInfo = getTripDatesInfo(); } catch (err) { Logger.log('Web trip dates skipped: ' + err.message); }
  template.tripDatesInfo = JSON.stringify(tripDatesInfo);
  let initialSubmitted = false;
  try { initialSubmitted = isDateSubmitted_(initialDate); } catch (err) {}
  template.initialSubmitted = JSON.stringify(initialSubmitted);
  return template.evaluate()
    .setTitle('Passenger Trips')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
}