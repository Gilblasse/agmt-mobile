
function findEmptyRowInDispatcher(){
 var ss = SpreadsheetApp.getActiveSpreadsheet();
 var dispatcherView = ss.getSheetByName('DISPATCH');
 var dispatchViewColA = dispatcherView.getRange('A2:A100').getValues();
      
    for(i=0;i<dispatchViewColA.length;i++){
      if(dispatchViewColA[i][0] == ''){
        var firstEmptyRowIncolA = i+2;
//        Logger.log(firstEmptyRowIncolA);
        return String(firstEmptyRowIncolA);
      }
    }
}