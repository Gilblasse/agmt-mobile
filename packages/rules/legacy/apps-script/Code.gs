// MENU OPTIONS
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  const menu = ui.createMenu('AMAZING GRACE MOBILE TRANSPORT');

  menu
    .addItem('🚨 SUBMIT Button', 'submitButton')
    .addSeparator()
    .addItem('SORT Time', 'sortDispatchTabA_Z')
    .addItem('START TIMES', 'selectDate')
    .addItem('SEND START TIMES', 'selectedEmployee')
    .addSeparator()
    .addItem("Grant Access to Drivers App", "showAccessSidebar")
    .addSeparator()
    .addItem("📋 Trip List", "openPassengerTripList") // 👈 NEW MENU ITEM
    // .addItem("📋 Save Trips", "snapshotDispatchToLog")
    // .addItem('Restore Snapshot by Date', 'showRestoreDatePicker')
    .addSeparator()

  const assistanceMenu = ui.createMenu('Assistance')
    .addItem('Fix Dispatch / Drivers App', 'fixIt')
    .addItem('map it', 'mapIt')
    .addItem('Fix Drivers App', 'fixDrivers')
    .addSeparator()
    .addItem('Run LOG Cleanup Now', 'archiveAndCompactTripLog')
    .addItem('Schedule Weekly LOG Cleanup', 'installWeeklyLogCompactionTrigger')
    .addSeparator()
    .addItem('Enable Auto-Open Sidebar', 'installAutoOpenSidebarTrigger');

  const linksMenu = ui.createMenu('Links')
    .addItem('Staff', 'linkToStaffSheet')
    .addItem('Drivers App', 'linkToDriversApp')
    .addItem('Time Sheet', 'linkToTimeSheet')
    .addItem('Vehicles', 'linkToVehicles')
    .addItem('Submission Logs', 'linkToSubmissionLogs')

  menu.addSubMenu(assistanceMenu);
  menu.addSubMenu(linksMenu);

  menu.addToUi();

  // Auto-open the Passenger Trips sidebar on load (works once the installable
  // onOpen trigger is enabled; simple-trigger mode cannot show sidebars, so this
  // fails quietly in that case)
  try {
    openPassengerTripList();
  } catch (err) {
    Logger.log('Auto sidebar skipped: ' + err.message);
  }
}

// Installable onOpen handler — runs with full permissions, so it CAN show the sidebar.
function onOpenShowTripsSidebar_(e) {
  try {
    openPassengerTripList();
  } catch (err) {
    Logger.log('Auto sidebar failed: ' + err.message);
  }
}

function installAutopenSidebarTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(tr) {
    if (tr.getHandlerFunction() === 'onOpenShowTripsSidebar_') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('onOpenShowTripsSidebar_')
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onOpen()
    .create();
  SpreadsheetApp.getActiveSpreadsheet().toast('The Passenger Trips sidebar will now open automatically when this sheet loads.', 'Enabled');
  return 'installed';
}

const TZ = Session.getScriptTimeZone();


function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function redirectToLink(url, title = "Redirecting") {
  const html = HtmlService.createHtmlOutput(`
    <html>
      <body>
        <a id="redir" href="${url}" target="_blank">Redirecting...</a>
        <script>
          window.onload = function() {
            document.getElementById('redir').click();
            google.script.host.close();
          };
        </script>
      </body>
    </html>
  `).setWidth(10).setHeight(10);

  SpreadsheetApp.getUi().showModalDialog(html, title);
}


// function redirectToLink(url, title = "Redirecting") {
//   const html = HtmlService.createHtmlOutput(`
//     <script>
//       window.onload = function() {
//         window.open("${url}", "_blank");
//         google.script.host.close();
//       };
//     </script>
//     <p>Redirecting...</p>
//   `).setWidth(10).setHeight(10);

//   SpreadsheetApp.getUi().showModalDialog(html, title);
// }


function linkToDriversApp() {
  redirectToLink("https://docs.google.com/spreadsheets/d/13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA", "Drivers App");
}

function linkToSubmissionLogs() {
  redirectToLink("https://docs.google.com/spreadsheets/d/1nEAxrzYy4cRMw7NLEupYUEe0eB0wP11LyzDVA_kDm8Y", "Submission Logs");
}

function linkToTimeSheet() {
  redirectToLink("https://time-stamp-agmt.vercel.app/admin/dashboard", "Time Sheet");
}

function linkToStaffSheet() {
  redirectToLink("https://docs.google.com/spreadsheets/d/1W9gT2Tkifd9Mdh9q3ZGaR-4Q6E24S75AzGuRe10DrKE", "Staff Sheet");
}

function linkToVehicles() {
  redirectToLink("https://docs.google.com/spreadsheets/d/13ynJ0Q_pn-Ao4fcJTmpSswbAk8MRy-RMpCF3YnIm-Ug", "Vehicles");
}



function showAccessSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('EmailAccessSidebar')
    .setTitle('Drivers App Access')
    .setWidth(300);
  SpreadsheetApp.getUi().showSidebar(html);
}

function getCurrentEditorsAndViewers() {
  const file = SpreadsheetApp.openById("13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA");
  const editors = file.getEditors().map(user => user.getEmail());
  const viewers = file.getViewers().map(user => user.getEmail());
  return [...new Set([...editors, ...viewers])];
}


function getEmailList() {
  const sourceSheet = SpreadsheetApp.openById('1W9gT2Tkifd9Mdh9q3ZGaR-4Q6E24S75AzGuRe10DrKE');
  const firstSheet = sourceSheet.getSheets()[0];
  const data = firstSheet.getRange('E2:E41').getValues();
  const emails = data
    .flat()
    .filter(email => email && typeof email === 'string' && email.includes('@'));
  return [...new Set(emails)];
}

function grantAccessToEmails(data) {
  var sss = SpreadsheetApp.getActiveSpreadsheet();

  if (!data || !data.selectedEmails || !data.permissionType) {
    throw new Error("Missing required input. Please select emails and permission type.");
  }

  const { selectedEmails, permissionType } = data;

  const targetSS = SpreadsheetApp.openById("13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA");
  const docUrl = targetSS.getUrl();
  const docName = targetSS.getName();

  selectedEmails.forEach(email => {
    if (permissionType.toLowerCase() === "edit") {
      targetSS.addEditor(email);
    } else {
      targetSS.addViewer(email);
    }

    GmailApp.sendEmail(email, `Access to ${docName}`,
      `You have been granted ${permissionType.toUpperCase()} access to the spreadsheet.\n\n${docUrl}`);
  });

  sss.toast(`${JSON.stringify(selectedEmails)} has ${permissionType}`, "GRANTED")
}

function revokeAccessFromEmails(data) {
  if (!data || !data.selectedEmails) {
    throw new Error("No emails provided for revocation.");
  }

  const { selectedEmails } = data;
  const targetSS = SpreadsheetApp.openById("13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA");
  const docUrl = targetSS.getUrl();
  const docName = targetSS.getName();

  selectedEmails.forEach(email => {
    try {
      targetSS.removeEditor(email);
      GmailApp.sendEmail(email, `Access Removed from ${docName}`,
        `Your access to the spreadsheet has been revoked.\n\n${docUrl}`);
    } catch (e) {
      Logger.log(`Failed to remove editor: ${email} — ${e.message}`);
    }
  });
}



// ******* SUBMIT BUTTON

function submitButton(){
 snapshotDispatchToLog()

 var ui = SpreadsheetApp.getUi();
 var response = ui.alert('WARNING: All Todays trips (completed,canceled,no-show) will be submitted ', 'Would You Like To Proceed?',ui.ButtonSet.YES_NO);

  if (response == ui.Button.NO) {
    Logger.log('The user\'s name is %s.', response.NO);
  } else if (response == ui.Button.YES) {
    fixDispatch();
    transfer();
    sortClients();
    // DeleteNewEntries();
    clearRows();
    clearDriversStatus();
    markDateSubmitted_(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'));
  } else {
    Logger.log('The user clicked the close button in the dialog\'s title bar.');
  }

}

// Sidebar-callable manual submit (confirmation handled in the Passenger Trips sidebar)
// Mirrors submitButton() YES-path without the getUi() prompt, which cannot run from google.script.run.
function submitTripsFromSidebar(){
  snapshotDispatchToLog();
  fixDispatch();
  transfer();
  sortClients();
  clearRows();
  clearDriversStatus();
  markDateSubmitted_(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'));
  return true;
}



//1.  ******* TRANSFER      UPDATE RANGE TO Y100  !!!
function transfer() {
 var sss = SpreadsheetApp.getActiveSpreadsheet();
 var ss = sss.getSheetByName('DISPATCH');
 var range = ss.getRange('A2:Y100');
 var data = range.getValues();

 var rows = data.filter(function(row) {
   return row.some(function(cell) { return String(cell || '').trim() !== ''; });
 });
 if (!rows.length) return;

 var tss = SpreadsheetApp.openById("1nEAxrzYy4cRMw7NLEupYUEe0eB0wP11LyzDVA_kDm8Y");
 var ts = tss.getSheetByName('Year2019');
 ts.getRange(ts.getLastRow()+1, 1, rows.length, rows[0].length).setValues(rows);

 // CALLS SORT FUNCTION sortClients();
//  sortClients();
}




//3.  ******* CLEARS LOGS
function DeleteNewEntries() {
var ss = SpreadsheetApp.openById("1nEAxrzYy4cRMw7NLEupYUEe0eB0wP11LyzDVA_kDm8Y");
var sheet = ss.getSheetByName("Year2019");
var datarange = sheet.getDataRange();
var lastrow = sheet.getRange("AC1").getValue();
var values = datarange.getValues();// get all data in a 2D array
var subRow = lastrow-50;
var currentDate = Utilities.formatDate(new Date(), 'America/New_York', "MM-dd-yyyy");//today
var count=0;

  for (i=lastrow;i>=subRow;i--) {
    var statusArray = values[i-1][16];//values[i-1][0]
    var tempDate = Utilities.formatDate(new Date(), 'America/New_York', "MM-dd-yyyy");// arrays are 0 indexed so row1 = values[0] and col3 = [2]

    if(tempDate >= currentDate){
      if((statusArray == 'IN TRANSIT')||(statusArray == '')||(statusArray == 'IN ROUTE')||(statusArray == 'PICK UP LOCATION')||(statusArray == 'DROP OFF LOCATION')||(statusArray == 'WAITING')){
         sheet.getRange("A"+i+":Y"+i).clearContent();
      }
    }//closes if statement
  }//closes for loop
  sortClients();
}//closes function







//4.  ******* CLEAR ROWS (in dispatch & filter sheet)                          UPDATE RANGE TO COLUMN RANGE TO 101  !!!

function clearRows(){

var ss = SpreadsheetApp.openById("1oc_ac8XTmjcoUjy0l_vj6m5j4YYVFuRykybSHToDAME");
var sheet = ss.getSheetByName('DISPATCH');
var today = String(new Date()).slice(0,3);
var sheetRange = sheet.getRange(1, 1, 101, 26).getValues(); //2, 1, 49, 17   ( row, col, numRows, numCol )

  for(i=2;i<=100;i++){
    var cellDateArry = String(sheetRange[(i-1)][0]).slice(0,3);
    var statusArry = sheetRange[(i-1)][16];

      if((cellDateArry == today) && ((statusArry == 'CANCEL')||(statusArry == 'COMPLETE')||(statusArry == 'NO SHOW')||(statusArry == 'REASSIGN'))){
        sheet.getRange("A"+i+":E"+i).clearContent();
        sheet.getRange("I"+i+":J"+i).clearContent();
        sheet.getRange("M"+i+":M"+i).clearContent();
        sheet.getRange("R"+i+":R"+i).clearContent();
        sheet.getRange("U"+i+":U"+i).clearContent();
        sheet.getRange("P"+i+":P"+i).clearContent();
        sheet.getRange("Y"+i+":AA"+i).clearContent();
      }
  }; //loop
  sortDispatchTabA_Z();
  clearDriversStatus();
};



// ******* AUTO CLEAR ROWS                                       UPDATE RANGE COLUMN RANGE TO 101  !!!

function autoClearRows(){

var ss = SpreadsheetApp.openById("1oc_ac8XTmjcoUjy0l_vj6m5j4YYVFuRykybSHToDAME");
var sheet = ss.getSheetByName('DISPATCH');
var today = String(new Date()).slice(0,3);
var sheetRange = sheet.getRange(1, 1, 101, 26).getValues(); //2, 1, 49, 17   ( row, col, numRows, numCol )

  // Loop through all rows
  for(i=2;i<=100;i++){

    var cellDateArry = String(sheetRange[(i-1)][0]).slice(0,3);
    var statusArry = sheetRange[(i-1)][16];

      if((cellDateArry == today) && ((statusArry == 'CANCEL')||(statusArry == 'COMPLETE')||(statusArry == 'NO SHOW')||(statusArry == 'REASSIGN'))){
//        Logger.log(cellDateArry + ' | '+ today + ' | '+ statusArry + ' ' + '('+ i +')');
//        Logger.log("A"+i+":E"+i);
        sheet.getRange("A"+i+":E"+i).clearContent();
        sheet.getRange("I"+i+":J"+i).clearContent();
        sheet.getRange("M"+i+":M"+i).clearContent();
        sheet.getRange("R"+i+":R"+i).clearContent();
        sheet.getRange("U"+i+":U"+i).clearContent();
        sheet.getRange("P"+i+":P"+i).clearContent();
        sheet.getRange("Y"+i+":AA"+i).clearContent();
      }
  }; //loop
  sortDispatchTabA_Z();
  autoClearDriversStatus();
};











//5.  *******  CLEAR DRIVERS

function clearDrivers() {
//var ss = SpreadsheetApp.openById("1FpAqzX17kwMQiEKhRncjgY4mbcQcKf--4deVwuG-hhY");
  var ss = SpreadsheetApp.openById("13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA");

var sheets = ss.getSheets();

  for(var i=1;i<=sheets.length;i++){
  var sheetName = sheets[i-1].getName();
  var sheet = sheets[i-1];
  var miscSheet = sheets[i-1].getName().slice(0,5);
//    Logger.log(miscSheet);

    if ((sheetName == 'Schedule Links')||(sheetName == 'DATA')||(sheetName == 'MASTER DRIVERS DATA LINKED')||(sheetName == 'HOME')) {
//        Logger.log(sheetName+''+"skipped");

    } else if(miscSheet == "Sheet"){// Deletes extra sheets named Sheet1, Sheet2, ect...
//      Logger.log(sheetName+''+'misc');
        ss.deleteSheet(sheet);

    }else{

      var dataRange = sheet.getDataRange();
      var values = dataRange.getValues();

      for (var y = 0; y < values.length; y++) {
        var row = "";
        for (var j = 0; j < values[y].length; j++) {

          if ((values[y][j] == "COMPLETE")||(values[y][j-10] == "CANCEL")||(values[y][j] == "NO SHOW")||(values[y][j] == "CANCEL")) {
            row = values[y][j-6];
            var num = y+1;
            sheet.getRange("J"+num+":J"+num).clearContent().setNumberFormat("h:mm AM/PM");
            sheet.getRange("M"+num+":M"+num).clearContent().setNumberFormat("h:mm AM/PM");
            sheet.getRange("U"+num+":U"+num).clearContent().setNumberFormat("h:mm AM/PM");
            sheet.getRange("V"+num+":V"+num).clearContent().setNumberFormat("h:mm AM/PM");
          }
        }
      }// else forLoop
       };//else
   };//for loop
};//close function





/*   =============================================
               CLEAR DRIVERS STATUS
     =============================================
*/
function clearDriversStatus(){
//var ss = SpreadsheetApp.openById("1FpAqzX17kwMQiEKhRncjgY4mbcQcKf--4deVwuG-hhY");
  var ss = SpreadsheetApp.openById("13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA");
var sheets = ss.getSheets();

  for(var i=1;i<=sheets.length;i++){
  var sheetName = sheets[i-1].getName();
  var sheet = sheets[i-1];
  var miscSheet = sheets[i-1].getName().slice(0,5);
//    Logger.log(miscSheet);

    if ((sheetName == 'Schedule Links')||(sheetName == 'DATA')||(sheetName == 'MASTER DRIVERS DATA LINKED')||(sheetName == 'HOME')) {
//        Logger.log(sheetName+''+"skipped");

    }else if(miscSheet == "Sheet"){// Deletes extra sheets named Sheet1, Sheet2, ect...
//      Logger.log(sheetName+''+'misc');
        ss.deleteSheet(sheet);

    }else{

      var dataRange = sheet.getDataRange();
      var values = dataRange.getValues();

      for (var y = 0; y < values.length; y++) {
        var row = "";
        for (var j = 0; j < values[y].length; j++) {

          if ((values[y][j] == "COMPLETE")||(values[y][j-10] == "CANCEL")||(values[y][j] == "NO SHOW")||(values[y][j] == "CANCEL")) {
            row = values[y][j-6];
            var num = y+1;
            sheet.getRange("J"+num+":J"+num).clearContent().setNumberFormat("h:mm AM/PM");
            sheet.getRange("M"+num+":M"+num).clearContent().setNumberFormat("h:mm AM/PM");
            sheet.getRange("P"+num+":P"+num).clearContent();
          }
        }
      }// else forLoop

       };//else
   };//for loop
  sortDriversTime();
}//close function




// AUTO CLEAR DRIVERS STATUS
function autoClearDriversStatus(){
//var ss = SpreadsheetApp.openById("1FpAqzX17kwMQiEKhRncjgY4mbcQcKf--4deVwuG-hhY");
  var ss = SpreadsheetApp.openById("13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA");

var sheets = ss.getSheets();

  for(var i=1;i<=sheets.length;i++){
  var sheetName = sheets[i-1].getName();
  var sheet = sheets[i-1];
  var miscSheet = sheets[i-1].getName().slice(0,5);
//    Logger.log(miscSheet);

    if ((sheetName == 'Schedule Links')||(sheetName == 'DATA')||(sheetName == 'MASTER DRIVERS DATA LINKED')||(sheetName == 'HOME')) {
//        Logger.log(sheetName+''+"skipped");

    }else{

      var dataRange = sheet.getDataRange();
      var values = dataRange.getValues();

      for (var y = 0; y < values.length; y++) {
        var row = "";
        for (var j = 0; j < values[y].length; j++) {

          if ((values[y][j] == "COMPLETE")||(values[y][j-10] == "CANCEL")||(values[y][j] == "NO SHOW")||(values[y][j] == "CANCEL")) {
            row = values[y][j-6];
            var num = y+1;
            sheet.getRange("P"+num+":P"+num).clearContent();
          }
        }
      }// else forLoop

       };//else
   };//for loop
  autoSortDriversTime();
}//close function



// AUTO CLEAR DRIVERS STATUS
function clearTimes(){
//var ss = SpreadsheetApp.openById("1FpAqzX17kwMQiEKhRncjgY4mbcQcKf--4deVwuG-hhY");
  var ss = SpreadsheetApp.openById("13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA");

var sheets = ss.getSheets();

  for(var i=1;i<=sheets.length;i++){
  var sheetName = sheets[i-1].getName();
  var sheet = sheets[i-1];
  var miscSheet = sheets[i-1].getName().slice(0,5);
//    Logger.log(miscSheet);

    if ((sheetName == 'Schedule Links')||(sheetName == 'DATA')||(sheetName == 'MASTER DRIVERS DATA LINKED')||(sheetName == 'HOME')) {
//        Logger.log(sheetName+''+"skipped");

    }else{

      var dataRange = sheet.getDataRange();
      var values = dataRange.getValues();

      for (var y = 0; y < values.length; y++) {
        var row = "";
        for (var j = 0; j < values[y].length; j++) {

          if ((values[y][j] == "COMPLETE")||(values[y][j-10] == "CANCEL")||(values[y][j] == "NO SHOW")||(values[y][j] == "CANCEL")) {
            row = values[y][j-6];
            var num = y+1;
            sheet.getRange("J"+num+":J"+num).clearContent();
            sheet.getRange("M"+num+":M"+num).clearContent();
            sheet.getRange("P"+num+":P"+num).clearContent();
          }
        }
      }// else forLoop

       };//else
   };//for loop
}//close function





function clearDriversAllInput(){

    var ui = SpreadsheetApp.getUi();
    var response = ui.alert('All Completed,Canceld & No Show Staus with times will be Cleared on Drivers Side. Are You Sure?', ui.ButtonSet.YES_NO);
// var finished = ui.alert('COMPLETED', ui.Button.OK);

 // Process the user's response.
 if (response == ui.Button.NO) {
   Logger.log('The user\'s name is %s.', response.NO);

 } else if (response == ui.Button.YES) {
     clearDriversAllInput2();
//     finished;


//   Logger.log('The user\'s name is %s.', response.YES);
 } else {
   Logger.log('The user clicked the close button in the dialog\'s title bar.');
 }

}

function clearDriversAllInput2(){
//var ss = SpreadsheetApp.openById("1FpAqzX17kwMQiEKhRncjgY4mbcQcKf--4deVwuG-hhY");
  var ss = SpreadsheetApp.openById("13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA");

var sheets = ss.getSheets();

  for(var i=1;i<=sheets.length;i++){
  var sheetName = sheets[i-1].getName();
  var sheet = sheets[i-1];
  var miscSheet = sheets[i-1].getName().slice(0,5);
//    Logger.log(miscSheet);

    if ((sheetName == 'Schedule Links')||(sheetName == 'DATA')||(sheetName == 'MASTER DRIVERS DATA LINKED')||(sheetName == 'HOME')) {
//        Logger.log(sheetName+''+"skipped");

    } else if(miscSheet == "Sheet"){// Deletes extra sheets named Sheet1, Sheet2, ect...
//      Logger.log(sheetName+''+'misc');
        ss.deleteSheet(sheet);

    }else{

      var dataRange = sheet.getDataRange();
      var values = dataRange.getValues();

      for (var y = 0; y < values.length; y++) {
        var row = "";
        for (var j = 0; j < values[y].length; j++) {

          if ((values[y][j] == "COMPLETE")||(values[y][j-10] == "CANCEL")||(values[y][j] == "NO SHOW")||(values[y][j] == "CANCEL")) {
            row = values[y][j-6];
            var num = y+1;
            sheet.getRange("J"+num+":J"+num).clearContent();
            sheet.getRange("M"+num+":M"+num).clearContent();
            sheet.getRange("P"+num+":P"+num).clearContent();
            sheet.getRange("U"+num+":U"+num).clearContent();
            sheet.getRange("V"+num+":V"+num).clearContent();
          }
        }
      }// else forLoop

       };//else
   };//for loop
}


function sortDriversTime(){
//var ss = SpreadsheetApp.openById("1FpAqzX17kwMQiEKhRncjgY4mbcQcKf--4deVwuG-hhY");
  var ss = SpreadsheetApp.openById("13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA");

var sheets = ss.getSheets();

  for(var i=1;i<=sheets.length;i++){
  var sheetName = sheets[i-1].getName();
  var sheet = sheets[i-1];
  var miscSheet = sheets[i-1].getName().slice(0,5);
//    Logger.log(miscSheet);

    if ((sheetName == 'Schedule Links')||(sheetName == 'DATA')||(sheetName == 'MASTER DRIVERS DATA LINKED')||(sheetName == 'HOME')) {
//        Logger.log(sheetName+''+"skipped");

    }else{
       sheet.getRange("J6:J18").sort({column: 10, ascending: true}).setNumberFormat("h:mm AM/PM");
       sheet.getRange("M6:M18").sort({column: 13, ascending: true}).setNumberFormat("h:mm AM/PM");
       sheet.getRange("P6:P18").sort({column: 16, ascending: true});
       sheet.getRange("U6:U18").sort({column: 21, ascending: true}).setNumberFormat("h:mm AM/PM");
       sheet.getRange("V6:V18").sort({column: 22, ascending: true}).setNumberFormat("h:mm AM/PM");
       };//else
   };//for loop
//  nextStep();
}// close function



// AUTO SORT DRIVERS TIME
function autoSortDriversTime(){
//var ss = SpreadsheetApp.openById("1FpAqzX17kwMQiEKhRncjgY4mbcQcKf--4deVwuG-hhY");
  var ss = SpreadsheetApp.openById("13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA");

var sheets = ss.getSheets();

  for(var i=1;i<=sheets.length;i++){
  var sheetName = sheets[i-1].getName();
  var sheet = sheets[i-1];
  var miscSheet = sheets[i-1].getName().slice(0,5);
//    Logger.log(miscSheet);

    if ((sheetName == 'Schedule Links')||(sheetName == 'DATA')||(sheetName == 'MASTER DRIVERS DATA LINKED')||(sheetName == 'HOME')) {
//        Logger.log(sheetName+''+"skipped");

    }else{
       sheet.getRange("J6:J18").sort({column: 10, ascending: true}).setNumberFormat("h:mm AM/PM");
       sheet.getRange("M6:M18").sort({column: 13, ascending: true}).setNumberFormat("h:mm AM/PM");
       sheet.getRange("P6:P18").sort({column: 16, ascending: true});
       sheet.getRange("U6:U18").sort({column: 21, ascending: true}).setNumberFormat("h:mm AM/PM");
       sheet.getRange("V6:V18").sort({column: 22, ascending: true}).setNumberFormat("h:mm AM/PM");
       };//else
   };//for loop
  submitTime();
}// close function






function nextStep(){

    var ui = SpreadsheetApp.getUi();
    var response = ui.alert('Would You Like To Submit The TimeSheet?', ui.ButtonSet.YES_NO);
// var finished = ui.alert('COMPLETED', ui.Button.OK);

 // Process the user's response.
 if (response == ui.Button.NO) {
   Logger.log('The user\'s name is %s.', response.NO);

 } else if (response == ui.Button.YES) {
     submitTime();
//     finished;


//   Logger.log('The user\'s name is %s.', response.YES);
 } else {
   Logger.log('The user clicked the close button in the dialog\'s title bar.');
 }

}





//2.  ******* SORT LOGS
function sortClients() {

  var ss = SpreadsheetApp.openById("1nEAxrzYy4cRMw7NLEupYUEe0eB0wP11LyzDVA_kDm8Y");
  var sheet= ss.getSheetByName("Year2019");
  var range = sheet.getRange("A2:Y");


 range.sort([{column: 1, ascending: true}]);
// range.sort([{column: 1, ascending: true}, {column: 3, ascending: true}]);
 }
















//=========================================  SUBMIT NOTES BUTTON ========================================
//
//
//function clearNotes() {
////  copyNotes();
////  sortNotes();
//  clearTech();
// }
//
//
//function copyNotes() {
// var sss = SpreadsheetApp.getActiveSpreadsheet();
// var ss = sss.getSheetByName('NOTES');
// var range = ss.getRange('A4:D100');
// var data = range.getValues();
//
// var tss = SpreadsheetApp.openById("1VyXQ1kvLEwWaT4mnz0Gucx4bxpDp1KxBGP2B6iKdh-o")
// var ts = tss.getSheetByName('note logs');
// ts.getRange(ts.getLastRow()+1, 1, data.length, data[0].length).setValues(data);
//}
//
//
//
//function sortNotes() {
//
//  var ss = SpreadsheetApp.openById("1VyXQ1kvLEwWaT4mnz0Gucx4bxpDp1KxBGP2B6iKdh-o");
//  var sheet= ss.getSheetByName("note logs");
//  var range = sheet.getRange("A2:D");
//
// range.sort([{column: 1, ascending: true}]);
//}
//
//function clearTech(){
//  var app = SpreadsheetApp.getActiveSpreadsheet();
//  var activeSheet = app.getSheetByName("ASK A TECH");
//  activeSheet.getRange("B4:G100").clearContent();
// }






//======================================                       =============================================

// Transfers indivisual rows to Log sheet (it takes to long)->(its better to copy everything then clear certain rows).
//function pasteRow() {
// var sss = SpreadsheetApp.openById("1oc_ac8XTmjcoUjy0l_vj6m5j4YYVFuRykybSHToDAME");
// var ss = sss.getSheetByName('DISPATCH');
// var today = String(new Date()).slice(0,3);
//
//  // Loop through all rows
//  for(i=2;i<50;i++){
//    var rowDate = ss.getRange(i,1).getValue();
//    var status = ss.getRange(i,17).getValue();
//    var cellDate = String(rowDate).slice(0, 3);
//
//    // Today's date matches Cell date
//    if(cellDate == today){
//      if((status == 'CANCEL')||(status == 'COMPLETE')||(status == 'NO SHOW')){
//       var range = ss.getRange("A"+i+":Y"+i);
//       var data = range.getValues();
//
//       // If everything matches Paste row to Log Sheet
//       var tss = SpreadsheetApp.openById("14_v6veom5CI5ILYoY5V1KV2ttw8RqmFUrmVpsiiNkgk")
//       var ts = tss.getSheetByName('Log');
//       ts.getRange(ts.getLastRow()+1, 1, data.length, data[0].length).setValues(data);
//      }
//    };
//  };
//};



//  Old Clear Data
//var datarange = sheet.getDataRange();
//var lastrow = datarange.getLastRow();
//var values = datarange.getValues();// get all data in a 2D array
//
//var currentDate = new Date();//today
//
//  for (i=lastrow;i>=3;i--) {
//    var cellDate = values[i-1][0];// arrays are 0 indexed so row1 = values[0] and col3 = [2]
//
//    if (cellDate >= currentDate){
//       sheet.getRange("A"+i+":Y"+i).clearContent();
//    };
//
//  };

//
//function DeleteNewEntries() {
//var ss = SpreadsheetApp.openById("14_v6veom5CI5ILYoY5V1KV2ttw8RqmFUrmVpsiiNkgk");
//var sheet = ss.getSheetByName("Log");//assumes Live Events is the name of the sheet
//var datarange = sheet.getDataRange();
//var lastrow = datarange.getLastRow();
//var values = datarange.getValues();// get all data in a 2D array
//
//var currentDate = new Date();//today
//
//for (i=lastrow;i>=3;i--) {
//var tempDate = values[i-1][0];// arrays are 0 indexed so row1 = values[0] and col3 = [2]
//if ((tempDate!=NaN) && (tempDate >= currentDate))
//{
//  sheet.deleteRow(i);
//}//closes if
//}//closes for loop
//}//closes function

//******************************************************  MENU OPTIONS
//function onOpen() {
//     SpreadsheetApp.getUi().createMenu('My Menu')
//         .addItem('Clear', 'copyRange')
//         .addToUi();
// }


// BACK UP DELETE NEW ENTRIES () FUNCTION
//function DeleteNewEntries() {
//var ss = SpreadsheetApp.openById("14_v6veom5CI5ILYoY5V1KV2ttw8RqmFUrmVpsiiNkgk");
//var sheet = ss.getSheetByName("Log");//assumes Live Events is the name of the sheet
//var datarange = sheet.getDataRange();
//var lastrow = sheet.getRange("AC1").getValue(); // datarange.getLastRow();
//var values = datarange.getValues();// get all data in a 2D array
//var subRow = lastrow-50;
//var currentDate = new Date();//today
//
//  for (i=lastrow;i>=subRow;i--) {
////        Logger.log(lastrow);
//
//    var tempDate = values[i-1][0];// arrays are 0 indexed so row1 = values[0] and col3 = [2]
////    Logger.log(String(tempDate).slice(0, 15)+ ' / ' + String(currentDate).slice(0, 15));
////     Logger.log(tempDate + '| ' + currentDate);
//
//    if (String(tempDate).slice(0, 15) >= String(currentDate).slice(0, 15))
//    {
//     Logger.log(String(tempDate).slice(0, 15));
//      sheet.deleteRow(i);
//    }//closes if
//  }//closes for loop
//}//closes function
