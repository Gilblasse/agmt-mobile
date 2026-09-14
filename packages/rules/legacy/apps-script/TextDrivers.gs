function sendSmsToStaff(driverName, {passenger, tripTime, notes, dispatchStatus }) {
  const sheet = SpreadsheetApp.openById("1W9gT2Tkifd9Mdh9q3ZGaR-4Q6E24S75AzGuRe10DrKE").getSheetByName("STAFF");
  const data = sheet.getDataRange().getValues();
  const ui = SpreadsheetApp.getUi();

  for (let i = 1; i < data.length; i++) { // skip header
    const name = data[i][0];     // Column A - DRIVER NAME
    const phone = data[i][3];    // Column D - PHONE
    const carrier = data[i][45]; // Column AT (index 45)

    if (!name || name !== driverName) continue;
    if (!phone || !carrier) continue;

    const smsEmail = getSmsEmail(phone, carrier);
    if (!smsEmail) continue;

    const message = `AMAZING GRACE ALERT !!! 
PLEASE Check DRIVERS APP:

Time: ${tripTime}
Name: ${passenger}
Status: ${dispatchStatus} 
Notes: ${notes}
`;

    try {
      SpreadsheetApp.getActiveSpreadsheet().toast(`${passenger} trip updated`,`🚨 SMS to ${driverName}`, 10);
      MailApp.sendEmail({
        to: smsEmail,
        subject: "",
        body: message
      });
    } catch (e) {
      Logger.log(`Failed to send to ${name}: ${e}`);
    }
  }
}


function getSmsEmail(phone, carrier) {
  const clean = String(phone).replace(/\D/g, ""); // Strip non-digits
  if (clean.length < 10) return null;

  const gateways = {
    "verizon": "vtext.com",
    "att": "txt.att.net",
    "t-mobile": "tmomail.net",
    "tmobile": "tmomail.net",
    "optimum": "tmomail.net",
    "sprint": "messaging.sprintpcs.com",
    "boost": "myboostmobile.com",
    "cricket": "sms.mycricket.com",
    "uscellular": "email.uscc.net",
    "googlefi": "msg.fi.google.com",
    "metropcs": "mymetropcs.com"
  };

  const domain = gateways[carrier.toLowerCase().trim()];
  return domain ? `${clean}@${domain}` : null;
}

function checkDispatchForUpdates(e) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("DISPATCH");
  const range = e.range;
  const row = range.getRow();
  const col = range.getColumn();

  if (sheet.getName() !== "DISPATCH") return;
  if (row < 2 || row > 100) return;
  if (![5, 25].includes(col)) return; // Only E or Y

  const rowData = sheet.getRange(row, 1, 1, 25).getValues()[0]; // A:Y
  const [dateCell, , timeRaw, passenger, dispatchStatus, , , , , , , , , , , , , , , , driverName] = rowData;
  const colY = rowData[COLUMN.DISPATCH.NOTES];
  const alertCol = 26; // Column Z

  if (!dateCell || !driverName || !timeRaw) return;

  const now = new Date();
  const todayStr = Utilities.formatDate(now, Session.getScriptTimeZone(), "MM/dd/yyyy");
  const rowDateStr = Utilities.formatDate(new Date(dateCell), Session.getScriptTimeZone(), "MM/dd/yyyy");

  if (todayStr !== rowDateStr) return;

  // Get full C:U for time range
  const allData = sheet.getRange("C2:U100").getValues();
  const timeRange = getDriverTimeRange(driverName, allData);
  if (!timeRange) return;

  const { start, end } = timeRange;
  if (now < start || now > end) return;

  const ui = SpreadsheetApp.getUi();

  // Format timeRaw
    let tripTime = "";
    if (timeRaw instanceof Date) {
      tripTime = Utilities.formatDate(timeRaw, Session.getScriptTimeZone(), "h:mm a");
    } else {
      tripTime = timeRaw.toString();
    }

  // === Keyword Logic (Column E) ===
  if (col === 5) {
    const value = sheet.getRange(row, col).getValue().toString().toUpperCase().trim();
    if (["CANCEL", "UPDATE TIME", "READY"].includes(value)) {
      sendSmsToStaff(driverName, {passenger, tripTime, notes: colY, dispatchStatus })
    }
  }

  // === Change Detection (Column Y) ===
  if (col === 25) {
    const props = PropertiesService.getScriptProperties();
    const cellKey = `dispatch_row${row}_colY`;
    const prev = props.getProperty(cellKey);
    const current = sheet.getRange(row, col).getValue();

    if (String(current) !== prev) {
      sendSmsToStaff(driverName, {passenger, tripTime, notes: colY, dispatchStatus })
      props.setProperty(cellKey, current);
    }
  }
}

function getDriverTimeRange(driverName, data) {
  const driverTimes = data
    .filter(row => row[18] === driverName && row[0]) // C: Time = row[0], U: Name = row[18]
    .map(row => parseTimeToDateObj(row[0]));

  if (driverTimes.length === 0) return null;

  const earliest = new Date(Math.min(...driverTimes));
  const latest = new Date(Math.max(...driverTimes));

  return {
    start: new Date(earliest.getTime() - 2 * 60 * 60000),  // 2 hours earlier
    end: new Date(latest.getTime() + 30 * 60000)           // 30 mins later
  };
}


function parseTimeToDateObj(timeInput) {
  const time = new Date(timeInput);
  const now = new Date();
  now.setHours(time.getHours());
  now.setMinutes(time.getMinutes());
  now.setSeconds(0);
  now.setMilliseconds(0);
  return now;
}
