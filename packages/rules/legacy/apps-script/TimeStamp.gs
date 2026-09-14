function passengerReady(e) {
  const range = e && e.range;
  if (!range) return false;

  const sheet = range.getSheet();
  if (!sheet || sheet.getName() !== 'DISPATCH') return false;
  if (range.getNumRows() !== 1 || range.getNumColumns() !== 1) return false;

  const row = range.getRow();
  const column = range.getColumn();
  if (row < 2 || column !== 5) return false;

  const value = String(e.value != null ? e.value : range.getValue()).trim().toUpperCase();
  if (value !== 'READY') return false;

  sheet.getRange(row, 3).setValue(new Date());
  return true;
}

function TEST_passengerReadyUsesEventRange() {
  const writes = [];
  const mockSheet = {
    getName: function() { return 'DISPATCH'; },
    getRange: function(row, column) {
      return {
        setValue: function(value) {
          writes.push({ row: row, column: column, value: value });
          return this;
        }
      };
    }
  };
  const mockRange = {
    getSheet: function() { return mockSheet; },
    getNumRows: function() { return 1; },
    getNumColumns: function() { return 1; },
    getRow: function() { return 12; },
    getColumn: function() { return 5; },
    getValue: function() { return 'READY'; }
  };

  if (passengerReady() !== false) throw new Error('Missing events must be ignored.');
  if (passengerReady({ range: mockRange, value: 'READY' }) !== true) {
    throw new Error('READY event was not handled.');
  }
  if (writes.length !== 1 || writes[0].row !== 12 || writes[0].column !== 3) {
    throw new Error('READY timestamp was written to the wrong cell.');
  }
  if (!(writes[0].value instanceof Date)) throw new Error('READY timestamp must be a Date.');
  Logger.log('PASS: passengerReady uses the event range and writes C12.');
}