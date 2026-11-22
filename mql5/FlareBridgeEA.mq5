//+------------------------------------------------------------------+
//|                                                FlareBridgeEA.mq5 |
//|                    FLARE Operator Console · MetaTrader 5 EA v2.0 |
//|   Polls /api/mt5/signal and reports execution ACKs /api/mt5/ack  |
//+------------------------------------------------------------------+
#property copyright "FLARE Quantitative Engine"
#property version   "2.00"
#property strict

#include <Trade\Trade.mqh>

input string InpServerBaseUrl = "http://localhost:3001/api/mt5"; // Base URL of FLARE MT5 API
input string InpApiToken      = "";                              // Optional Bearer token (FLARE_API_TOKENS)
input string InpTerminalName  = "MT5-Bridge";                    // Terminal label shown in FLARE
input int    InpPollSeconds   = 10;                              // Poll interval (seconds)
input double InpLotSize       = 0.01;                            // Fixed lot size per trade
input ulong  InpMagicNumber   = 202615;                          // Unique FLARE Magic Number
input int    InpSlippagePts   = 30;                              // Maximum deviation (points)

CTrade trade;
string lastExecutedSignalId = "";
const string EA_VERSION = "2.00";

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(InpSlippagePts);
   EventSetTimer(InpPollSeconds);
   Print("[FLARE Bridge EA v", EA_VERSION, "] Started. Polling: ", InpServerBaseUrl, "/signal");
   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
//| Expert deinitialization                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

//+------------------------------------------------------------------+
//| Build Authorization header when InpApiToken is configured        |
//+------------------------------------------------------------------+
string BuildHeaders(const bool isJson)
  {
   string headers = "";
   if(isJson)
      headers += "Content-Type: application/json\r\n";
   if(StringLen(InpApiToken) > 0)
      headers += "Authorization: Bearer " + InpApiToken + "\r\n";
   return headers;
  }

//+------------------------------------------------------------------+
//| Escape strings safely for JSON payloads                          |
//+------------------------------------------------------------------+
string EscapeJson(const string raw)
  {
   string out = raw;
   StringReplace(out, "\\", "\\\\");
   StringReplace(out, "\"", "\\\"");
   StringReplace(out, "\r", " ");
   StringReplace(out, "\n", " ");
   return out;
  }

//+------------------------------------------------------------------+
//| Lightweight JSON field extractor                                 |
//+------------------------------------------------------------------+
string ExtractJsonValue(const string json, const string key)
  {
   string pattern = "\"" + key + "\":";
   int start = StringFind(json, pattern);
   if(start < 0)
      return "";
   start += StringLen(pattern);

   while(start < StringLen(json) && (StringGetCharacter(json, start) == ' '))
      start++;

   if(StringGetCharacter(json, start) == '\"')
     {
      start++;
      int end = StringFind(json, "\"", start);
      if(end < 0)
         return "";
      return StringSubstr(json, start, end - start);
     }
   else
     {
      int end = start;
      while(end < StringLen(json))
        {
         ushort ch = StringGetCharacter(json, end);
         if(ch == ',' || ch == '}' || ch == ' ' || ch == '\n' || ch == '\r')
            break;
         end++;
        }
      return StringSubstr(json, start, end - start);
     }
  }

//+------------------------------------------------------------------+
//| Serialize open MT5 positions for this MagicNumber                |
//+------------------------------------------------------------------+
string BuildPositionsJson()
  {
   string items = "[";
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(!PositionSelectByTicket(ticket))
         continue;
      if(PositionGetInteger(POSITION_MAGIC) != (long)InpMagicNumber)
         continue;

      string sym     = PositionGetString(POSITION_SYMBOL);
      long   posType = PositionGetInteger(POSITION_TYPE);
      string side    = (posType == POSITION_TYPE_BUY) ? "BUY" : "SELL";
      double vol     = PositionGetDouble(POSITION_VOLUME);
      double openPx  = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl      = PositionGetDouble(POSITION_SL);
      double tp      = PositionGetDouble(POSITION_TP);
      double profit  = PositionGetDouble(POSITION_PROFIT);

      if(count > 0)
         items += ",";
      items += StringFormat(
         "{\"ticket\":\"%I64u\",\"symbol\":\"%s\",\"side\":\"%s\",\"volume\":%.4f,\"openPrice\":%.5f,\"sl\":%.5f,\"tp\":%.5f,\"profit\":%.2f}",
         ticket, EscapeJson(sym), side, vol, openPx, sl, tp, profit
      );
      count++;
     }
   items += "]";
   return items;
  }

//+------------------------------------------------------------------+
//| Report execution acknowledgement back to FLARE (/api/mt5/ack)    |
//+------------------------------------------------------------------+
void SendExecutionAck(
   const string signalId,
   const string action,
   const string status,
   const ulong  ticket,
   const double fillPrice,
   const double volume,
   const string errorText
)
  {
   string ackUrl = InpServerBaseUrl + "/ack";
   string broker = AccountInfoString(ACCOUNT_COMPANY);
   string acct   = IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   string posJson = BuildPositionsJson();

   string body = "{";
   body += "\"signalId\":\"" + EscapeJson(signalId) + "\",";
   body += "\"terminal\":\"" + EscapeJson(InpTerminalName) + "\",";
   body += "\"eaVersion\":\"" + EA_VERSION + "\",";
   body += "\"symbol\":\"" + EscapeJson(_Symbol) + "\",";
   body += "\"action\":\"" + EscapeJson(action) + "\",";
   body += "\"status\":\"" + EscapeJson(status) + "\",";
   body += "\"broker\":\"" + EscapeJson(broker) + "\",";
   body += "\"account\":\"" + EscapeJson(acct) + "\",";
   if(ticket > 0)
      body += "\"ticket\":\"" + StringFormat("%I64u", ticket) + "\",";
   if(fillPrice > 0.0)
      body += "\"fillPrice\":" + DoubleToString(fillPrice, _Digits) + ",";
   if(volume > 0.0)
      body += "\"volume\":" + DoubleToString(volume, 4) + ",";
   if(StringLen(errorText) > 0)
      body += "\"error\":\"" + EscapeJson(errorText) + "\",";
   body += "\"positions\":" + posJson;
   body += "}";

   char postData[];
   int len = StringToCharArray(body, postData, 0, WHOLE_ARRAY, CP_UTF8);
   if(len > 0 && postData[len - 1] == 0)
      ArrayResize(postData, len - 1);

   char result[];
   string resultHeaders;
   int res = WebRequest("POST", ackUrl, BuildHeaders(true), 3000, postData, result, resultHeaders);
   if(res != 200)
     {
      Print("[FLARE Bridge EA] Failed to send ACK HTTP=", res, " Err=", GetLastError());
     }
  }

//+------------------------------------------------------------------+
//| Close all positions owned by this MagicNumber                    |
//+------------------------------------------------------------------+
int CloseAllByMagic()
  {
   int closed = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(PositionSelectByTicket(ticket))
        {
         if(PositionGetInteger(POSITION_MAGIC) == (long)InpMagicNumber)
           {
            if(trade.PositionClose(ticket))
               closed++;
           }
        }
     }
   return closed;
  }

//+------------------------------------------------------------------+
//| Sync Stop Loss to Profit-Lock when backend arms breakeven        |
//+------------------------------------------------------------------+
void SyncProfitLockStopPrice(const double backendStopPrice)
  {
   if(backendStopPrice <= 0.0)
      return;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(PositionSelectByTicket(ticket))
        {
         if(PositionGetInteger(POSITION_MAGIC) != (long)InpMagicNumber)
            continue;

         double currentSl = PositionGetDouble(POSITION_SL);
         double currentTp = PositionGetDouble(POSITION_TP);
         long posType     = PositionGetInteger(POSITION_TYPE);
         double normSl    = NormalizeDouble(backendStopPrice, _Digits);

         if(posType == POSITION_TYPE_BUY && normSl > currentSl + (_Point * 5))
           {
            trade.PositionModify(ticket, normSl, currentTp);
            Print("[FLARE Bridge EA] Profit-Lock applied on BUY. New SL: ", normSl);
           }
         else if(posType == POSITION_TYPE_SELL && (currentSl == 0.0 || normSl < currentSl - (_Point * 5)))
           {
            trade.PositionModify(ticket, normSl, currentTp);
            Print("[FLARE Bridge EA] Profit-Lock applied on SELL. New SL: ", normSl);
           }
        }
     }
  }

//+------------------------------------------------------------------+
//| Periodic poll against FLARE Backend (/api/mt5/signal)            |
//+------------------------------------------------------------------+
void OnTimer()
  {
   char   postData[];
   char   result[];
   string resultHeaders;
   string broker = AccountInfoString(ACCOUNT_COMPANY);
   string acct   = IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   string requestUrl = InpServerBaseUrl
      + "/signal?terminal=" + InpTerminalName
      + "&symbol=" + _Symbol
      + "&eaVersion=" + EA_VERSION
      + "&magic=" + StringFormat("%I64u", InpMagicNumber)
      + "&broker=" + broker
      + "&account=" + acct;

   ResetLastError();
   int res = WebRequest("GET", requestUrl, BuildHeaders(false), 3000, postData, result, resultHeaders);

   if(res != 200)
     {
      Print("[FLARE Bridge EA] WebRequest error HTTP=", res, " Err=", GetLastError(),
            " (Allow WebRequest for FLARE server in Tools -> Options -> Expert Advisors)");
      return;
     }

   string json = CharArrayToString(result);
   string signalId       = ExtractJsonValue(json, "signalId");
   string action         = ExtractJsonValue(json, "action");
   string killSwitch     = ExtractJsonValue(json, "killSwitchActive");
   string breakevenArmed = ExtractJsonValue(json, "breakevenArmed");
   double slPct          = StringToDouble(ExtractJsonValue(json, "stopLossPct"));
   double tpPct          = StringToDouble(ExtractJsonValue(json, "takeProfitPct"));
   double stopPrice      = StringToDouble(ExtractJsonValue(json, "stopPrice"));

   // 1. Kill-Switch or daily halt -> close all immediately & ACK
   if(killSwitch == "true" || action == "CLOSE_ALL")
     {
      int closed = CloseAllByMagic();
      if(signalId != "" && signalId != lastExecutedSignalId)
        {
         lastExecutedSignalId = signalId;
         SendExecutionAck(signalId, "CLOSE_ALL", closed > 0 ? "CLOSED" : "NOOP", 0, 0.0, 0.0, "");
        }
      return;
     }

   // 2. HOLD -> close any residual local position for this MagicNumber
   if(action == "HOLD")
     {
      int closed = CloseAllByMagic();
      if(closed > 0 && signalId != "")
        {
         SendExecutionAck(signalId, "HOLD", "CLOSED", 0, 0.0, 0.0, "");
        }
      return;
     }

   // 3. Sync Profit-Lock SL when backend arms breakeven
   if(breakevenArmed == "true" && stopPrice > 0.0)
     {
      SyncProfitLockStopPrice(stopPrice);
     }

   // 4. Deduplicate already-executed signal IDs
   if(signalId == "" || signalId == lastExecutedSignalId)
      return;

   if(action == "BUY")
     {
      CloseAllByMagic();
      double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double sl  = NormalizeDouble(ask * (1.0 - slPct / 100.0), _Digits);
      double tp  = NormalizeDouble(ask * (1.0 + tpPct / 100.0), _Digits);
      if(trade.Buy(InpLotSize, _Symbol, ask, sl, tp, "FLARE-Bridge-BUY"))
        {
         lastExecutedSignalId = signalId;
         ulong orderTicket = trade.ResultOrder();
         double fillPx = trade.ResultPrice() > 0.0 ? trade.ResultPrice() : ask;
         SendExecutionAck(signalId, "BUY", "EXECUTED", orderTicket, fillPx, InpLotSize, "");
         Print("[FLARE Bridge EA] BUY executed @ ", fillPx, " SL=", sl, " TP=", tp);
        }
      else
        {
         SendExecutionAck(signalId, "BUY", "ERROR", 0, 0.0, InpLotSize, trade.ResultRetcodeDescription());
        }
     }
   else if(action == "SELL")
     {
      CloseAllByMagic();
      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double sl  = NormalizeDouble(bid * (1.0 + slPct / 100.0), _Digits);
      double tp  = NormalizeDouble(bid * (1.0 - tpPct / 100.0), _Digits);
      if(trade.Sell(InpLotSize, _Symbol, bid, sl, tp, "FLARE-Bridge-SELL"))
        {
         lastExecutedSignalId = signalId;
         ulong orderTicket = trade.ResultOrder();
         double fillPx = trade.ResultPrice() > 0.0 ? trade.ResultPrice() : bid;
         SendExecutionAck(signalId, "SELL", "EXECUTED", orderTicket, fillPx, InpLotSize, "");
         Print("[FLARE Bridge EA] SELL executed @ ", fillPx, " SL=", sl, " TP=", tp);
        }
      else
        {
         SendExecutionAck(signalId, "SELL", "ERROR", 0, 0.0, InpLotSize, trade.ResultRetcodeDescription());
        }
     }
  }
//+------------------------------------------------------------------+
