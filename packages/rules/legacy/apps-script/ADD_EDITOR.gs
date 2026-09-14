function multiSheetProtection() {
//  var spreadsheet = SpreadsheetApp.openById("1FpAqzX17kwMQiEKhRncjgY4mbcQcKf--4deVwuG-hhY");      // Select Sheet
   var spreadsheet = SpreadsheetApp.openById("13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA"); 
  var sheetArry = [];
  var protectSheet = ['1','2','3','4','5','6','7','8','9'];                                       // Select Sheet tabs
  var sheets = spreadsheet.getSheets().filter(function(sheet){sheetArry.push(sheet.getName())});
  var applyProtection = [
    {range:'C6:I18',description:'Part Body Begin'},                                                        // Select Ranges to Protect
    {range:'K6:L18',description:'Part Body Mid'},
    {range:'N6:O18',description:'Part Body Mid 2nd'},
    {range:'Q6:AG18',description:'Part Body End'},
    {range:'C1:S5',description:'Header'}
  ]
  var protectRanges = [];
  var allowedUsers = ["nethelbert.blasse@gmail.com"]; // Select Non-Restricted Users  
  sheetArry.filter(function(sheet){
    if(protectSheet.indexOf(sheet) > -1){
      
       applyProtection.filter(function(obj){protectRanges.push(
            spreadsheet.getSheetByName(String(sheet)).getRange(obj.range).protect().setDescription(obj.description)
       )});
      
      protectRanges.filter(function(protectRange){
       protectRange.getEditors()
       .filter(function(editableUser){
                   allowedUsers
                      .indexOf(String(editableUser)) > -1 ? Logger.log(editableUser+" Keep"):protectRange
                      .removeEditor(editableUser);
        });
     });
    }else{ 
      Logger.log(sheet+" skip");
    }
  });
};//close function



function removeDriversProtectedRanges(){
  // Remove all range protections in the spreadsheet that the user has permission to edit.
//  var ss = SpreadsheetApp.openById("1FpAqzX17kwMQiEKhRncjgY4mbcQcKf--4deVwuG-hhY");
    var ss = SpreadsheetApp.openById("13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA");

  for(var num=1; num <=9; num++){
      var sheet = ss.getSheetByName(String(num));
      var protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
    
      for (var i = 0; i < protections.length; i++) {
        var protection = protections[i];
        if (protection.canEdit()) {
          protection.remove();
        }
     }
   }  
}




// ON ONE SHEET
function protectMultiple() {
  var ss = SpreadsheetApp.getActive();
  var applyProtection = [
    {range:'A1:D4',description:'Pro A-D'},
    {range:'F1:F4',description:'Pro F-F'},
    {range:'L1:O4',description:'Pro L-O'},
  ]
  var protectRanges = [];
  var allowedUsers = ["amazinggracemobiletransport@gmail.com","amazinggracetransport@gmail.com"];

  applyProtection.filter(function(obj){protectRanges.push(
    ss.getRange(obj.range).protect().setDescription(obj.description)
  )});
  
  protectRanges.filter(function(protectRange){
       protectRange.getEditors()
       .filter(function(editableUser){
                   allowedUsers
                      .indexOf(String(editableUser)) > -1 ? Logger.log(editableUser+" Keep"):protectRange
                      .removeEditor(editableUser);
      });
   });
};





function removeEditors() {
  // Remove all range protections in the spreadsheet that the user has permission to edit.
var ss = SpreadsheetApp.getActive();
var protections = ss.getProtections(SpreadsheetApp.ProtectionType.RANGE);

  for (var i = 0; i < protections.length; i++) {
    var protection = protections[i];
    var count = i+1;
    if (protection.canEdit()) {
      protection.remove();
    }
  }
}





function addEditor() {
  // Remove all range protections in the spreadsheet that the user has permission to edit.
var ss = SpreadsheetApp.getActive();
var protections = ss.getProtections(SpreadsheetApp.ProtectionType.RANGE);

  for (var i = 0; i < protections.length; i++) {
    var protection = protections[i];
    var count = i+1;
    if (protection.canEdit()) {
      Logger.log(protection.getEditors() +" "+ count);
    }
  }
}
