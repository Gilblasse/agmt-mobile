function getVehicalDriversData(){
  // const drivers = dataFromSheet({cellRange:'A1:F40', sheetName: "drivers"})
  // const vehicals = dataFromSheet({cellRange:'B1:F50', sheetName: "vehicles"})
  const dispatch = dataFromSheet(fullPgProps.dispatch)

  console.log({dispatch})
  
  // const unique = [...new Set(data.map(d => d.DRIVER))]
}

function getPassengersData(){
  // const passengers = dataFromSheet({cellRange:'A1:F6000', sheetName: "ADD PASSENGERS", isKeep: 2})
  const addresses = dataFromSheet({
    cellRange:'E1:E6000', 
    sheetName: "ADD PASSENGERS", 
    list: ['rowNum'],
    isFormatted: false
  })

  // const uniqAddresses = uniqBy(addresses, 'Address')

  console.log({uniqAddresses})
}


async function updateTripsFirestoreDb(e){
  const rowStart = e.range.rowStart
  const sheetName = e.source.getActiveSheet().getName()
  
  if(sheetName === "DISPATCH"){
    const trips = rowFromSheet({
      cellRange:`A${rowStart}:Y${rowStart}`, 
      sheetName: "DISPATCH", 
      headerRange: "A1:Y1",
      list: ['Tomorrow','Phone','SIG', 'id', 'Chat', 'LICENSE PLATE', 'Vehicle Type', 'DRIVER LICENSE'],
    })

    var options = {
      'method' : 'post',
      'contentType': 'application/json',
      'payload' : JSON.stringify({...trips[0], rowStart})
    };
    
    const res = await UrlFetchApp.fetch(prodUrl, options);
    console.log(res.getResponseCode(), {...trips, rowStart})
  }
}
