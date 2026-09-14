/**
* Get Distance between 2 different addresses.
* @param start_address Address as string Ex. "300 N LaSalles St, Chicago, IL"
* @param end_address Address as string Ex. "900 N LaSalles St, Chicago, IL"
* @param return_type Return type as string Ex. "miles" or "kilometers" or "minutes" or "hours"
* @customfunction
*/

function GOOGLEMAPS(start_address,end_address,return_type) {

  var mapObj = Maps.newDirectionFinder();
  mapObj.setOrigin(start_address);
  mapObj.setDestination(end_address);
  var directions = mapObj.getDirections();
  
  
  var getTheLeg = directions["routes"][0]["legs"][0];
  
  var meters = getTheLeg["distance"]["value"];
  var todaysTime = Utilities.formatDate(new Date(), 'America/New_York', "HH:mm:ss");

  
  switch(return_type){ 
    case "miles":
      return meters * 0.000621371;                       //convert to miles and return
      break;
      
    case "minutes":
        var duration = getTheLeg["duration"]["value"];   // get duration in seconds
        return duration / 60;                            //convert to minutes and return
      break;
      
    case "hours":
        var duration = getTheLeg["duration"]["value"];  // get duration in seconds
        return duration / 60 / 60;                      //convert to hours and return
      break;      
      
    case "kilometers":
      return meters / 1000;                             //convert to Kilometers and return
      break;
      
      case "time":
        var duration = getTheLeg["duration"]["value"];   // get duration in seconds
      
//        var todaysTimeArry = todaysTime.split(":");      // minutes are worth 60 seconds. Hours are worth 60 minutes.
//        var seconds = (todaysTimeArry[0]) * 60 * 60 + (todaysTimeArry[1]) * 60 + (todaysTimeArry[2]);
//        var sumDuration = (duration + seconds)/60;
      
        var sec_num = parseInt((duration), 10); // don't forget the second param
    var hours   = Math.floor(sec_num / 3600);
    var minutes = Math.floor((sec_num - (hours * 3600)) / 60);
    var seconds = sec_num - (hours * 3600) - (minutes * 60);

    if (hours   < 10) {hours   = "0"+hours;}
    if (minutes < 10) {minutes = "0"+minutes;}
    if (seconds < 10) {seconds = "0"+seconds;}
    
      var time = String(hours)+':'+String(minutes)+':'+String(seconds);


      return time ; 
      break;
      
    default:
      return "Error: Wrong Unit Type";
   }
}





function mapIt() { // UpDATE LOOP TO 100
  var currentValue = PropertiesService.getScriptProperties().getProperty('mapItCount');
  var count = Number(currentValue) + 1;
  
  var ss = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("DISPATCH");
  var mark = '"';
  var today = Utilities.formatDate(new Date(), 'America/New_York', "MM-dd-yyyy").slice(3,5);
  
  PropertiesService.getScriptProperties().setProperty('mapItCount', count);
  
  for(var i=2; i<=100; ++i){
      var range = ss.getRange("P"+i+":P"+i);
      var start = range.offset(0, -6).getValue();// orgin address 
      var end = range.offset(0, -3).getValue(); // destination address
      var status = range.offset(0, 1).getValue(); // destination address
      var cellDate = String(ss.getRange("A"+i+":A"+i).getValue()).slice(8,10);
    
    if((range.getValue()=="") && (start!="") && (end!="") && (status!="CANCEL") && (cellDate==today)){                    // && (status=="COMPLETE")    
        range.setFormula("GOOGLEMAPS("+mark+start+mark+","+mark+end+mark+","+mark+"miles"+mark+")")
        .setNumberFormat("0.0");
    }else if(status=="CANCEL"){
      range.setValue("0.0").setNumberFormat("0.0");
    }
  } 
}