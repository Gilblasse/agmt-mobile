class AmazingGraceTransportSpreadsheetService {
  constructor(ids = ssIds) {
    this.ids = ids ||
    {};
  }

  openSpreadsheet(name) {
    const id = this.ids[name];
    return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  }

  getSheet(ssName, sheetName) {
    const ss = this.openSpreadsheet(ssName);
    return ss.getSheetByName(sheetName);
  }
}

const spreadsheetService = new AmazingGraceTransportSpreadsheetService();
