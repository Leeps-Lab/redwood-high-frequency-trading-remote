Redwood.factory("GroupManager", function () {
   var api = {};

   api.createGroupManager = function (groupArgs, sendFunction) {
      var groupManager = {};

      groupManager.initGroupManager = function(groupArgs){
         groupManager.marketFlag = groupArgs.mFlag; // LOCAL  = use local market (i.e. this.market)
                                                 // REMOTE = use remote market by making websockets connection
                                                 // DEBUG  = use debug market (i.e. this.debugMarket)

         groupManager.marketAlgorithms = {};   // reference to all market algorithms in this group, mapped by subject id ---> marketAlgorithms[subjectID]
         groupManager.market = {};             // reference to the market object for this group
         groupManager.dataStore = {};
         groupManager.period = groupArgs.period;
         groupManager.priceChanges = groupArgs.priceChanges;         // array of all price changes that will occur
         groupManager.investorArrivals = groupArgs.investorArrivals; // array of all investor arrivals that will occur
         groupManager.priceIndex = 0;                                // index of last price index to occur. start at 1 because start FP is handled differently
         groupManager.investorIndex = 0;                             // index of last investor arrival to occur
         groupManager.intervalPromise = null;                        // promise for canceling interval when experiment ends
         groupManager.timeouts = [];

         groupManager.groupNumber = groupArgs.groupNumber;
         groupManager.memberIDs = groupArgs.memberIDs; // array that contains id number for each subject in this group
         groupManager.syncFpArray = [];                // buffer that holds onto messages until received msg from all subjects
         groupManager.delay = 500;                     // # of milliseconds that will be delayed by latency simulation
         groupManager.fastDelay = 100;

         groupManager.syncFPArray = new SynchronizeArray(groupManager.memberIDs);
         groupManager.FPMsgList = [];
         groupManager.curMsgId = 1 + 500 * groupArgs.period;
         groupManager.debugArray = [];

         groupManager.isDebug = groupArgs.isDebug;     // indicates if message logger should be used
         groupManager.outboundMarketLog = "";          // string of debug info for messages outbound to market
         groupManager.inboundMarketLog = "";           // string of debug info for messages inbound from market
         groupManager.suppressMessages = false;
         groupManager.establishConnection();

      };

      groupManager.establishConnection = function(){
         // only open websockets connection if running in REMOTE mode
         if(groupManager.marketFlag === "REMOTE"/*ZACH, D/N MODIFY!*/){
            // remove later
            if(groupArgs.URI == null){
               console.log("remember to add the correct URI to your config file...");
               groupArgs.URI = "54.219.182.118";    //for testing purposes, default is california
            }
            // open websocket with market
            groupManager.marketURI = "ws://" + groupArgs.URI + ":800" + groupArgs.groupNum + "/";
            groupManager.socket = new WebSocket(groupManager.marketURI, ['binary', 'base64']);

            groupManager.socket.onopen = function(event) {
               console.log(printTime(getTime()), "Group", groupArgs.groupNum, "Connected to", groupArgs.URI);
            };

            // recieves messages from remote market
            groupManager.socket.onmessage = function(event) {
               
               // create reader to read "blob" object
               var reader = new FileReader();
               reader.addEventListener("loadend", function() {

                  // reader.result contains the raw ouch message as a DataBuffer, convert it to string
                  var ouchStr = String.fromCharCode.apply(null, new Uint8Array(reader.result));
                  //logStringAsNums(ouchStr);

                  // split the string in case messages are conjoined
                  var ouchMsgArray = splitMessages(ouchStr);

                  for(ouchMsg of ouchMsgArray){
                     // translate the message and pass it to the recieve function
                     groupManager.recvFromMarket(ouchToLeepsMsg(ouchMsg));
                  }
               });
               reader.readAsArrayBuffer(event.data);
               //reader.readAsText(event.data, "ASCII");
            };
         }
      }
      


      if(groupManager.marketFlag === "DEBUG"){
         
         // wrapper for debug market recieve function
         groupManager.recvFromDebugMarket = function(msg){

            //console.log("Recieved From Debug Market: " + msg);
            //console.log(ouchToLeepsMsg(msg));
            groupManager.recvFromMarket(ouchToLeepsMsg(msg));
         }

         // initialize debug market
         groupManager.debugMarket = new DebugMarket(groupManager.recvFromDebugMarket);
      }


      // wrapper for the redwood send function
      groupManager.rssend = function (key, value, period) {
         sendFunction(key, value, "admin", period, this.groupNumber);      //***** was by default sending to period 1
      };

      groupManager.sendToDataHistory = function (msg, uid) {
         if(!this.suppressMessages){
            this.dataStore.storeMsg(msg);
            this.rssend("To_Data_History_" + uid, msg, this.period); 
         }
      };

      groupManager.sendToAllDataHistories = function (msg) {
         if(!this.suppressMessages){
            this.dataStore.storeMsg(msg);
            this.rssend("To_All_Data_Histories", msg, this.period);
         }
      };

      // sends a message to all of the market algorithms in this group
      groupManager.sendToMarketAlgorithms = function (msg) {
         for (var memberID of this.memberIDs) {
            this.marketAlgorithms[memberID].recvFromGroupManager(msg);
         }
      };

      // receive a message from a single market algorithm in this group
      groupManager.recvFromMarketAlgorithm = function (msg) {
         // synchronized message in response to fundamental price change
         if (msg.protocol === "SYNC_FP") {
            //mark that this user sent msg
            this.syncFPArray.markReady(msg.msgData[0]);
            this.FPMsgList.push(msg);
	    //console.log(msg.msgData[0],"before sync",printTime(getTime()));

            // check if every user has sent a response
            if (this.syncFPArray.allReady()) {
               //console.log("after synced: ", printTime(getTime()));
               // shuffle the order of messages sitting in the arrays
               var indexOrder = this.getRandomMsgOrder(this.FPMsgList.length);

               // store player order for debugging purposes
               var playerOrder = [];

               // send msgs in new shuffled order
               for (var index of indexOrder) {
                  playerOrder.push(this.FPMsgList[index].msgData[0]);
                  for (var rmsg of this.FPMsgList[index].msgData[2]) {
                        //console.log(index,"sent to server @",printTime(getTime()));
			      this.sendToMarket(rmsg);
                  }
               }
               
               
               this.dataStore.storePlayerOrder(msg.timeStamp, playerOrder);

               // reset arrays for the next fundamental price change
               this.FPMsgList = [];
               this.syncFPArray = new SynchronizeArray(this.memberIDs);
            }
         }
         // general message that needs to be passed on to the exchange
         if (msg.protocol === "OUCH") {
            groupManager.sendToMarket(msg);
         }
      };

      // TODO setup arg for routing
      // Function for sending messages, will route msg to remote or local market based on this.marketFLag
      groupManager.sendToMarket = function (leepsMsg) {
         // console.log("Outbound Message", leepsMsg);                //debug OUCH messages
         if (leepsMsg.delay) {
               window.setTimeout(this.sendToRemoteMarket.bind(this), this.delay, leepsMsg);
         }
         else {
               window.setTimeout(this.sendToRemoteMarket.bind(this), this.fastDelay, leepsMsg); //fast have 100ms delay
         }
      };

      groupManager.sendToLocalMarket = function(leepsMsg){     //obsolete
         console.log("sending to local market");
         this.market.recvMessage(leepsMsg);
      }

      groupManager.sendToRemoteMarket = function(leepsMsg){
         var msg = leepsMsgToOuch(leepsMsg);
         // console.log(leepsMsg, printTime(leepsMsg.timeStamp));
         this.socket.send(msg);
         this.debugArray.push({msgId: leepsMsg.msgId, timeString: printTime(leepsMsg.timeStamp), msgType: leepsMsg.msgType, timeStamp: leepsMsg.timeStamp});   //push info to compare return msg from server
      }

      groupManager.sendToDebugMarket = function(leepsMsg){
         var msg = leepsMsgToOuch(leepsMsg);
         //console.log(msg);                                        //debug for outgoing message
         this.debugMarket.recvMessage(msg);
      }

      // handles a message from the market
      groupManager.recvFromMarket = function (msg) {
         // console.log("Inbound Message", msg);                //debug incoming ITCH messages
         if(msg.msgType === "C_TRA"){
            this.sendToMarketAlgorithms(msg);
         }
         else {
            //console.log(msg);
            if(msg.subjectID > 0) { //only care about non investors
               this.marketAlgorithms[msg.subjectID].recvFromGroupManager(msg);
            }
            else {
               this.sendToAllDataHistories(msg);            //added 7/20/17 for refactor
            }//dont want to push c_tra msgs
            this.debugArray.push({msgId: msg.msgId, timeString: printTime(msg.timeStamp), msgType: msg.msgType, timeStamp: msg.timeStamp}); //push info to compare server msg to redwood
         }
      };

      // handles message from subject and passes it on to market algorithm
      groupManager.recvFromSubject = function (msg) {

         // if this is a user message, handle it and don't send it to market
         if (msg.protocol === "USER") {
            var subjectID = msg.msgData[0];
            //console.log(msg, printTime(msg.timeStamp));
            // if(this.marketAlgorithms[subjectID].using_speed){                 //if fast send straight to graph
               this.sendToAllDataHistories(msg);
            // }
            // else{
            //    window.setTimeout(this.sendToAllDataHistories.bind(this), this.delay, msg);   //wait delay time to send to update graph
            // }
            // this.dataStore.storeMsg(msg);
            
            this.marketAlgorithms[subjectID].recvFromGroupManager(msg);       //send to market algorithms -> server

            if (msg.msgType == "UMAKER") this.dataStore.storeSpreadChange(msg.msgData[1], this.marketAlgorithms[subjectID].spread, msg.msgData[0]);
         }
      };

      // creates an array from 0 to size-1 that are shuffled in random order
      groupManager.getRandomMsgOrder = function (size) {

         // init indices from 0 to size-1
         var indices = [];
         var rand;
         var temp;
         for (var i = 0; i < size; i++) {
            indices.push(i);
         }

         // shuffle
         for (i = size - 1; i > 0; i--) {
            rand = Math.floor(Math.random() * size);
            temp = indices[i];
            indices[i] = indices[rand];
            indices[rand] = temp;
         }
         //console.log("indices: " + indices); 
         return indices;
      };

      groupManager.sendNextPriceChange = function () {
         // if current price is -1, end the game
         if (this.priceChanges[this.priceIndex][1] == -1) {
         //    this.rssend("end_game", this.groupNumber);
             return;
         }
         // console.log(this.priceChanges[this.priceIndex][1], this.priceIndex);
         var msg = new Message("ITCH", "FPC", [getTime(), this.priceChanges[this.priceIndex][1], this.priceIndex]);
         msg.delay = false;
         this.dataStore.storeMsg(msg);
         this.sendToMarketAlgorithms(msg);

         this.priceIndex++;

         if (this.priceIndex >= this.priceChanges.length) {
            console.log("reached end of price changes array");
            return;
         }

         window.setTimeout(this.sendNextPriceChange, (this.startTime + this.priceChanges[this.priceIndex][0] - getTime()) / 1000000);
      }.bind(groupManager);

      groupManager.sendNextInvestorArrival = function () {
         this.dataStore.investorArrivals.push([getTime() - this.startTime, this.investorArrivals[this.investorIndex][1] == 1 ? "BUY" : "SELL"]);
         // create the outside investor leeps message
         var msgType = this.investorArrivals[this.investorIndex][1] === 1 ? "EBUY" : "ESELL";
         if(msgType === "EBUY"){
            var msg2 = new OuchMessage("EBUY", 0, 214748.3647, true);      //changed 7/20/17 214748
         }
         else if(msgType === "ESELL"){
            var msg2 = new OuchMessage("ESELL", 0, 0, true);      //changed 7/20/17
         }
         msg2.msgId = this.curMsgId;
         this.curMsgId++;
         msg2.delay = false;
         this.sendToMarket(msg2);

         this.investorIndex++;

         if (this.investorIndex >= this.investorArrivals.length) {
            console.log("reached end of investors array");
            return;
         }

         this.timeouts.push(window.setTimeout(this.sendNextInvestorArrival, (this.startTime + this.investorArrivals[this.investorIndex][0] - getTime()) / 1000000));
      }.bind(groupManager);

      return groupManager;
   };

   return api;
});
