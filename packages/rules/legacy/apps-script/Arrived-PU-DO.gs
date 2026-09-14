
/*                 =================================
                      STAMP TIME FOR P/U_D/O COLUMN
                   =================================
*/

// PRODUCTION_STATUS_TRANSITION_TIMES_V13: preserve the first observed time for each driver stage.
function captureDriverStatusTransitions_() {
  const sheet = activeSpreadsheet_().getSheetByName('DISPATCH');
  if (!sheet) return { updated: 0 };
  const lastRow = Math.min(100, sheet.getLastRow());
  if (lastRow < 2) return { updated: 0 };

  const rowCount = lastRow - 1;
  const values = sheet.getRange(2, 1, rowCount, COLUMN.DISPATCH.COMPLETED_AT + 1).getValues();
  const activity = sheet.getRange(2, COLUMN.DISPATCH.PICKUP_IN_AT + 1, rowCount, 4).getValues();
  const now = new Date();
  let updated = 0;

  values.forEach(function(row, index) {
    if (!String(row[COLUMN.DISPATCH.PASSENGER] || '').trim()) return;
    const status = String(row[COLUMN.DISPATCH.STATUS] || '').toUpperCase().replace(/[^A-Z]/g, '');
    const stamps = activity[index]; // Z=Pickup In, AA=Arrived, AB=Intransit, AC=Completed
    let changed = false;

    if (!stamps[0] && row[COLUMN.DISPATCH.IN]) { stamps[0] = row[COLUMN.DISPATCH.IN]; changed = true; }
    if (!stamps[3] && row[COLUMN.DISPATCH.OUT]) { stamps[3] = row[COLUMN.DISPATCH.OUT]; changed = true; }
    if (status === 'PICKUPLOCATION' && !stamps[0]) { stamps[0] = now; changed = true; }
    if (status === 'INTRANSIT' && !stamps[2]) { stamps[2] = now; changed = true; }
    if (status === 'DROPOFFLOCATION' && !stamps[1]) { stamps[1] = now; changed = true; }
    if (status === 'COMPLETE' && !stamps[3]) { stamps[3] = now; changed = true; }
    if (changed) updated += 1;
  });

  if (updated) {
    sheet.getRange(2, COLUMN.DISPATCH.PICKUP_IN_AT + 1, rowCount, 4)
      .setValues(activity)
      .setNumberFormat('h:mm AM/PM');
  }
  return { updated: updated };
}

function arrivedPuDo() {
  return captureDriverStatusTransitions_();
}



/*                 =================================
                           ERASE TIMESTAMP
                   =================================
*/

function earseTime(e){
 var ss = SpreadsheetApp.openById("1oc_ac8XTmjcoUjy0l_vj6m5j4YYVFuRykybSHToDAME").getSheetByName("DISPATCH"); 
 var range = e.range;
// var rangeCol = range.getActiveCell();
  
  if(range.getColumn() == 21){
    range.offset(0, 6).clearContent();
    range.offset(0, 5).clearContent();
  }
}


/*                 =================================
                      SHOW AND HIDE P/U_D/O EDIT
                   =================================
*/

function showCol(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dispatch = ss.getSheetByName("DISPATCH");
  var col_28 = dispatch.getRange(1, 1, 1, 28);
  
    dispatch.showColumns(26);   // Z-AA, 2 columns 
    dispatch.showColumns(27);
  
}

function hideCol(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dispatch = ss.getSheetByName("DISPATCH");
  var col_28 = dispatch.getRange(1, 1, 1, 28);

    dispatch.hideColumns(26);   // Z-AA, 2 columns 
    dispatch.hideColumns(27);
}


function toggleCol(){
  var currentCount = PropertiesService.getScriptProperties().getProperty('toggleCount');
  var count = Number(currentCount) + 1;
  
  var toggleValue = PropertiesService.getScriptProperties().getProperty('hidden');
  
  PropertiesService.getScriptProperties().setProperty('toggleCount',count);
  
  if(toggleValue=='false'){
    Logger.log("Show");
    showCol();
    PropertiesService.getScriptProperties().setProperty('hidden', 'true');
  }else{
    Logger.log("Hide");
    hideCol();
    PropertiesService.getScriptProperties().setProperty('hidden', 'false');
  }
  
}