function findEmail(selectedDriver,selectedDate){
var driversSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("drivers");
var names =  driversSheet.getRange(1, 1, 40,6).getValues();
  
  if((selectedDriver === "ChooseDriver") || (selectedDate === "Choose")){
     var errorObj = [{error:"Please Choose A Date. Then Select Driver"}];
     return errorObj;
  }
  Logger.log("FindEmail() selectedDriver = "+selectedDriver);
  Logger.log("FindEmail() selectedDate = "+selectedDate);
  
  
  for(var i=0; i<names.length; i++){
    
      var driverName = names[i][0];
//    Logger.log(driverName)
//    Logger.log("Checking Email Row"+names[i][5]);
    
      if(driverName === selectedDriver){
//        Logger.log("FindEmail() driverName = "+driverName);
          var email = names[i][5];
          var isEmail = isNaN(email.slice(0, 9));
                
        Logger.log("FindEmail() email = "+email);
//        Logger.log("FindEmail() email = "+selectedDate);

          var tripData = driversData(driverName,email,selectedDate,isEmail);
       }
   }
  
  return tripData;
}


function driversData(name,email,selectedDate,isEmail) {
  
  var dispatchSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("DISPATCH");
  var values = dispatchSheet.getRange(2, 1,95,29).getValues();
  var driversNamesForLinks = SpreadsheetApp.openById('13rpPjV3KOxfQw9W6ARA-KWSkxNI7qy6oqp4fwvlchlA').getSheetByName("Schedule Links").getRange(2, 7, 9,2);
  var tripDetails = [];
  var instance = 0;
  var tomorrowsDate = selectedDate;

// Logger.log(driversNamesForLinks.getValues().length);
  
//  Logger.log(Utilities.formatDate(new Date(values[1][0]), 'America/New_York', "HH:MM"));
  for(var i=0; i<values.length; i++){
    
    if(values[i][0] !== ""){
      var row = values[i]; 
//      Logger.log(row);
//      var dateCol = Utilities.formatDate(new Date(row[0]), 'America/New_York', "MM/dd/yyyy");
    
      var driver = row[20]
      startDate = String(row[0]).slice(0,10)
      startTime = String(row[28]).slice(16,21)
      car = row[17]
      status = row[4] 
      address = "1) From: "+row[9]+' &nbsp;&nbsp;||&nbsp;&nbsp; To: '+row[12];
      var colStartTime = Utilities.formatDate(new Date(row[1]), 'America/New_York', "HH:MM:SS");

       if((driver === name) && (instance === 0) && (startDate === tomorrowsDate) && (status !== "CANCEL")){
         
         // Find Link
         for(var i=1; i<=driversNamesForLinks.getValues().length; i++){
           var nameOfDriver = driversNamesForLinks.getCell(i, 1).getValue();
    
           if(name === nameOfDriver){
             var scheduleLink = driversNamesForLinks.getCell(i, 2).getValue();
           }
         }
         conisole.log({
          name:driver,
        day:startDate,
        start:startTime,
        car:car,
        trip:address,
        email:email,
        link:scheduleLink
         })
      instance = 1;
      tripDetails.push({
        name:driver,
        day:startDate,
        start:startTime,
        car:car,
        trip:address,
        email:email,
        link:scheduleLink
                       });
      
       }
    
    }

   } //Close Of Loop
  Logger.log(tripDetails);
  if((tripDetails[0].start == "") || (email == "")){
    var errorObj = [{error:"ERROR: Please Check "+tripDetails[0].name.split(" ")[0]+"'s Start Time or Email/SMS"}];
     return errorObj;
   }
  
sendEmail(email,tripDetails,isEmail);
return tripDetails
};


function sendEmail(email,obj,isEmail){
  Logger.log("sendEmail() Sending Email to: "+email);
  
  if(isEmail){
    // Email Friendly
     GmailApp.sendEmail( obj[0].email,"Amazing Grace Mobile Transport: [Your New Start Time]","this is a optional message",{
    htmlBody: "DO NOT REPLY: Refer all questions to dispatch<br><br><div style='font-size:18px'><strong>"+obj[0].name+"</strong> you're scheduled to work on <strong style='color:red'>" + obj[0].day +"</strong> at <strong style='color:red'>"+obj[0].start+".</strong><br>"+
              "Your Assigned Vehicle is <strong>"+obj[0].car+"</strong> <br><br><br>"+
    "<span style='text-decoration:underline'>Details Regarding First Trip:</span> <br>"+
    " "+obj[0].trip+"</div><br><br>For More Infromation View Your Full Schedule: <a href="+obj[0].link+">Click Here For Details</a>"
  }); 
  
  }else{
    //Mobile Friendly
    var message = "Start Time:"+obj[0].day+" @ "+obj[0].start+"   Vehicle:"+obj[0].car+"  Details:"+obj[0].link;
    MailApp.sendEmail( obj[0].email,"Amazing Grace Mobile Transport: [Your New Start Time]",message);  
  }
  
//Logger.log("recipient = "+obj[0].email+" day = "+obj[0].day+" start= "+obj[0].start+" car= "+obj[0].car+" link= "+obj[0].link);
}



function selectedEmployee(){
sortDispatchTabA_Z();
var htmlDlg = HtmlService.createTemplateFromFile('myHtml')
      .evaluate()
      .setSandboxMode(HtmlService.SandboxMode.IFRAME)
      .setWidth(450)
      .setHeight(250);
  SpreadsheetApp.getUi()
      .showModalDialog(htmlDlg, 'Email/SMS Start Times');
}



function chosenDate(selectedDate){
  
var dispatchSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("DISPATCH");
var values =  dispatchSheet.getRange("A2:U100").getValues();
var datesArry = [];
var driversArry = [];
  
//Logger.log(selectedDate);  
  for(var i=0; i<99;i++){
    var date = String(values[i][0]).slice(0,10);
    var driverName = values[i][20];
    
    if((selectedDate === date) && (driverName !== "")){
      driversArry.push(driverName);
    }    
   }
  
  
var uniqueDrivers = driversArry.filter(function(item, pos){
  return driversArry.indexOf(item)== pos; 
});
 return uniqueDrivers 
}











function selectDate(){
sortDispatchTabA_Z();
var htmlDlg = HtmlService.createTemplateFromFile('CreateStartTime')
      .evaluate()
      .setSandboxMode(HtmlService.SandboxMode.IFRAME)
      .setWidth(450)
      .setHeight(250);
  SpreadsheetApp.getUi()
      .showModalDialog(htmlDlg, 'Create Start Times');
}





function addBeginTime(dateSelectedByUser){
var dispatchSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("DISPATCH");
var values =  dispatchSheet.getRange("A2:U100").getValues();
var datesArry = [];
var driversArry = [];
var unique = [];
var baseLocation = "216 Church St Poughkeepise NY 12601";
    
  if(dateSelectedByUser=== "Choose"){
     var errorObj = [{error:"Please Choose A Date. Then Select Driver"}];
     return errorObj;
  }
  
  for(var i=0; i<99;i++){
    var row = i+2;
    var date = String(values[i][0]).slice(0,10);
    var driverName = values[i][20];
    var colDate = new Date(values[i][0]);
    var tripStatus = values[i][4];

    //         var mintuesString = retrieveMonth(new Date().getMonth())+" "+ new Date().getDate()+" " + mintues + " GMT-05:00 " + new Date().getYear();
//         var puTimeString = retrieveMonth(new Date().getMonth())+" "+ new Date().getDate()+" " + puTime + " GMT-05:00 " + new Date().getYear();
    
    if((driverName !== "") && (date === dateSelectedByUser) && (tripStatus !== "CANCEL") && (tripStatus !== "REASSIGN")){
      Logger.log("tripStatus = "+tripStatus)
      driversArry.push({name:driverName,row:row,date:date})
//      driversArry.push({name:driverName,row:row,puTime:puTime,start:startTime})
    }    
   }
  
  
  if(driversArry.length !== 0){
  
    driversArry.filter(function(obj,index){       
   var num = findWithAttr(unique, "name", obj.name);
          
    if(num === -1){
      unique.push(obj);
    }   
  });
      
  for(var i=0; i<unique.length;i++){
    var puLocation = dispatchSheet.getRange(unique[i].row, 10).getValue(); 
//    var mintues = 30;
    var mintues = parseInt(GOOGLEMAPS(baseLocation,puLocation,"minutes"));
    var time = dispatchSheet.getRange(unique[i].row, 3).getValue();
    var timeSec = new Date(time).setMinutes(new Date(time).getMinutes() - mintues);     
    var startTime = convertTime(new Date(timeSec));
    
    dispatchSheet.getRange(unique[i].row, 2).setValue(startTime);
//     Logger.log(startTime +" "+puLocation+" min="+mintues);
   }
    dispatchSheet.getRange("B2:B100").setNumberFormat("h:mm AM/PM");
  }// end of it statment
  
  return unique;
}










function getUni(){
var dispatchSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("DISPATCH");
var values =  dispatchSheet.getRange("A2:U100").getValues();
var unique = [];
var driversArry = [];
  
  
  for(var i=0; i<99;i++){
    var row = i+2;
    var date = String(values[i][0]).slice(0,10);
    var driverName = values[i][20];  
    
    driverName !== "" ? driversArry.push({name:driverName}) :null;
  }

                
  driversArry.filter(function(obj,index){
                
   var num = findWithAttr(unique, "name", obj.name)
          
    if(num === -1){
      unique.push(obj);
    }   
  });
  
  Logger.log(unique);
   
}




function findWithAttr(array, attr, value) {
    for(var i = 0; i < array.length; i += 1) {
        if(array[i][attr] === value) {
            return i;
        }
    }
    return -1;
}







function addZero(i) {
  if (i < 10) {
    i = "0" + i;
  }
  return i;
}

function convertTime(time) {
  var d = new Date(time);
  var h = addZero(d.getHours());
  var m = addZero(d.getMinutes());
  var s = addZero(d.getSeconds());
  return h + ":" + m + ":" + s;
}

function subtractTime(time,mintues){
  var d = new Date(time);
  var min = new Date(mintues).getMinutes();
  
  var h = addZero(d.getHours());
  var m = Math.abs(addZero(d.getMinutes()) - min);
  var s = addZero(d.getSeconds());
  
  
  return h + ":" + m + ":" + s;
}




function retrieveMonth(month){
  
  switch(month) {
  case 0:
    return "Jan";
    break;
  case 1:
    return "Feb";
    break;
  case 2:
    return "Mar";
    break;
  case 3:
    return "Apr";
    break;
  case 4:
    return "May";
    break;
  case 5:
    return "Jun";
    break;
  case 6:
    return "Jul";
    break;
  case 7:
    return "Aug";
    break;
  case 8:
    return "Sep";
    break;
   case 9:
    return "Oct";
    break;
  case 10:
    return "Nov";
    break;
  case 11:
    return "Dec";
    break;    
      
  }
}




















