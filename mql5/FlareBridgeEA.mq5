//+------------------------------------------------------------------+
//|                                                FlareBridgeEA.mq5 |
//|                        FLARE Phase 15 · MetaTrader 5 Executor EA |
//|   Conecta MetaTrader 5 con el Backend FLARE (/api/mt5/signal)    |
//+------------------------------------------------------------------+
#property copyright "FLARE Quantitative Engine"
#property version   "1.50"
#property strict

#include <Trade\Trade.mqh>

input string InpServerUrl     = "http://localhost:3001/api/mt5/signal"; // URL del Backend FLARE
input int    InpPollSeconds   = 10;                                     // Intervalo de consulta (segundos)
input double InpLotSize       = 0.01;                                   // Lote fijo por operación (Demo)
input ulong  InpMagicNumber   = 202615;                                 // Magic Number único de FLARE
input int    InpSlippagePts   = 30;                                     // Deslizamiento máximo (puntos)

CTrade trade;
string lastExecutedSignalId = "";

//+------------------------------------------------------------------+
//| Inicialización del Expert Advisor                                |
//+------------------------------------------------------------------+
int OnInit()
  {
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(InpSlippagePts);
   EventSetTimer(InpPollSeconds);
   Print("[FLARE Bridge EA] Iniciado. Escuchando señales en: ", InpServerUrl);
   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
//| Desinicialización                                                |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

//+------------------------------------------------------------------+
//| Extractor ligero de campos JSON sin librerías externas           |
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
//| Cierra todas las posiciones abiertas por este MagicNumber        |
//+------------------------------------------------------------------+
void CloseAllByMagic()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(PositionSelectByTicket(ticket))
        {
         if(PositionGetInteger(POSITION_MAGIC) == (long)InpMagicNumber)
            trade.PositionClose(ticket);
        }
     }
  }

//+------------------------------------------------------------------+
//| Actualiza el Stop Loss a Profit-Lock si el backend lo indica     |
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
            Print("[FLARE Bridge EA] Profit-Lock (🔒) aplicado en BUY. Nuevo SL: ", normSl);
           }
         else if(posType == POSITION_TYPE_SELL && (currentSl == 0.0 || normSl < currentSl - (_Point * 5)))
           {
            trade.PositionModify(ticket, normSl, currentTp);
            Print("[FLARE Bridge EA] Profit-Lock (🔒) aplicado en SELL. Nuevo SL: ", normSl);
           }
        }
     }
  }

//+------------------------------------------------------------------+
//| Consulta periódica al Backend FLARE (/api/mt5/signal)            |
//+------------------------------------------------------------------+
void OnTimer()
  {
   char   postData[];
   char   result[];
   string resultHeaders;
   string requestUrl = InpServerUrl + "?terminal=MT5-Bridge&symbol=" + _Symbol;

   ResetLastError();
   int res = WebRequest("GET", requestUrl, "", 3000, postData, result, resultHeaders);

   if(res != 200)
     {
      Print("[FLARE Bridge EA] Error WebRequest HTTP=", res, " Err=", GetLastError(),
            " (Verifica Herramientas -> Opciones -> Asesores Expertos -> Permitir WebRequest para http://localhost:3001)");
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

   // 1. Si el Kill-Switch de Fase 14 o freno diario está activo, cerramos todo inmediatamente
   if(killSwitch == "true" || action == "CLOSE_ALL")
     {
      CloseAllByMagic();
      lastExecutedSignalId = signalId;
      return;
     }

   // 2. Si no hay posición en el backend, cerramos cualquier posición residual local
   if(action == "HOLD")
     {
      CloseAllByMagic();
      return;
     }

   // 3. Si el Profit-Lock (🔒) se activó en el backend, sincronizamos el SL en MT5
   if(breakevenArmed == "true" && stopPrice > 0.0)
     {
      SyncProfitLockStopPrice(stopPrice);
     }

   // 4. Evitar abrir dos veces la misma señal idempotente
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
         Print("[FLARE Bridge EA] Orden BUY ejecutada @ ", ask, " SL=", sl, " TP=", tp);
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
         Print("[FLARE Bridge EA] Orden SELL ejecutada @ ", bid, " SL=", sl, " TP=", tp);
        }
     }
  }
//+------------------------------------------------------------------+
