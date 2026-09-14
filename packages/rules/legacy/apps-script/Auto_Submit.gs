// Schedule the trigger to execute at noon every day in the US/Pacific time zone
function createAuto(){
  var exeHour = 22;
  var exeMin = 15;
ScriptApp.newTrigger("autoSubmit")
  .timeBased()
  .atHour(exeHour)
  .nearMinute(exeMin)
  .everyDays(1)
  .inTimezone("America/New_York")
  .create();
}


// ******* AUTO SUBMIT BUTTON *******
function autoSubmit(){
  var currentTime = Utilities.formatDate(new Date(), 'America/New_York', "HH:mm:ss");
  Logger.log(currentTime);
    transfer();
     sortClients();
     DeleteNewEntries();
     clearDrivers();
     autoClearRows();
};


function deleteTrigger() {
  // Loop over all triggers and delete them
  var allTriggers = ScriptApp.getProjectTriggers();
  
  for (var i = 0; i < allTriggers.length; i++) {
    var triggerName = allTriggers[i].getHandlerFunction();
    
    if(String(triggerName) == "autoSubmit"){
      Logger.log(triggerName);
      ScriptApp.deleteTrigger(allTriggers[i]);
    }
  }
}