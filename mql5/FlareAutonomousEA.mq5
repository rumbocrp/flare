//+------------------------------------------------------------------+
//|                                           FlareAutonomousEA.mq5  |
//|              FLARE Phase 15 · Standalone MQL5 Expert Advisor     |
//|   Motor Momentum-Structure + EMA 8/21/50 + RSI 14 + Profit-Lock  |
//+------------------------------------------------------------------+
#property copyright "FLARE Quantitative Engine"
#property version   "1.50"
#property strict

#include <Trade\Trade.mqh>

input ENUM_TIMEFRAMES InpTimeframe       = PERIOD_M15; // Temporalidad de evaluación
input int             InpFastEma         = 8;          // EMA Rápida
input int             InpSlowEma         = 21;         // EMA Lenta
input int             InpTrendEma        = 50;         // EMA Estructural Institucional
input int             InpRsiPeriod       = 14;         // Periodo RSI
input double          InpLotSize         = 0.01;       // Tamaño de lote fijo
input double          InpStopLossPct     = 1.2;        // Stop Loss (%)
input double          InpTakeProfitPct   = 1.5;        // Take Profit (%)
input double          InpMaxDailyRiskPct = 3.0;        // Freno de pérdida diaria máxima (%)
input bool            InpUseProfitLock   = true;       // Activar Profit-Lock Breakeven al 50% TP
input ulong           InpMagicNumber     = 202615;     // Magic Number FLARE

CTrade   trade;
int      hFastEma, hSlowEma, hTrendEma, hRsi;
datetime lastClosedBarTime = 0;
double   dayStartEquity    = 0.0;
int      currentDayOfYear  = -1;

//+------------------------------------------------------------------+
//| Inicialización de indicadores nativos de MetaTrader 5            |
//+------------------------------------------------------------------+
int OnInit()
  {
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(30);

   hFastEma  = iMA(_Symbol, InpTimeframe, InpFastEma, 0, MODE_EMA, PRICE_CLOSE);
   hSlowEma  = iMA(_Symbol, InpTimeframe, InpSlowEma, 0, MODE_EMA, PRICE_CLOSE);
   hTrendEma = iMA(_Symbol, InpTimeframe, InpTrendEma, 0, MODE_EMA, PRICE_CLOSE);
   hRsi      = iRSI(_Symbol, InpTimeframe, InpRsiPeriod, PRICE_CLOSE);

   if(hFastEma == INVALID_HANDLE || hSlowEma == INVALID_HANDLE ||
      hTrendEma == INVALID_HANDLE || hRsi == INVALID_HANDLE)
     {
      Print("[FLARE Autonomous EA] Error inicializando handles de indicadores.");
      return(INIT_FAILED);
     }

   dayStartEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   Print("[FLARE Autonomous EA] Iniciado correctamente en ", _Symbol);
   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
//| Liberación de handles                                            |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   IndicatorRelease(hFastEma);
   IndicatorRelease(hSlowEma);
   IndicatorRelease(hTrendEma);
   IndicatorRelease(hRsi);
  }

//+------------------------------------------------------------------+
//| Verifica si existe una posición abierta por este EA              |
//+------------------------------------------------------------------+
bool HasOpenPosition()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(PositionSelectByTicket(ticket))
        {
         if(PositionGetInteger(POSITION_MAGIC) == (long)InpMagicNumber &&
            PositionGetString(POSITION_SYMBOL) == _Symbol)
            return true;
        }
     }
   return false;
  }

//+------------------------------------------------------------------+
//| Gestiona el Profit-Lock Breakeven (+22% TP) al avanzar 50% al TP |
//+------------------------------------------------------------------+
void ManageProfitLock()
  {
   if(!InpUseProfitLock)
      return;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(!PositionSelectByTicket(ticket))
         continue;
      if(PositionGetInteger(POSITION_MAGIC) != (long)InpMagicNumber ||
         PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;

      double entryPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      double currentSl  = PositionGetDouble(POSITION_SL);
      double currentTp  = PositionGetDouble(POSITION_TP);
      long   posType    = PositionGetInteger(POSITION_TYPE);

      if(currentTp <= 0.0)
         continue;

      if(posType == POSITION_TYPE_BUY)
        {
         double tpDist = currentTp - entryPrice;
         double bid    = SymbolInfoDouble(_Symbol, SYMBOL_BID);
         if(tpDist > 0.0 && (bid - entryPrice) >= (0.50 * tpDist))
           {
            double lockSl = NormalizeDouble(entryPrice + (0.22 * tpDist), _Digits);
            if(lockSl > currentSl + (_Point * 5))
              {
               trade.PositionModify(ticket, lockSl, currentTp);
               Print("[FLARE Autonomous EA] Profit-Lock (🔒) activado en BUY @ SL=", lockSl);
              }
           }
        }
      else if(posType == POSITION_TYPE_SELL)
        {
         double tpDist = entryPrice - currentTp;
         double ask    = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
         if(tpDist > 0.0 && (entryPrice - ask) >= (0.50 * tpDist))
           {
            double lockSl = NormalizeDouble(entryPrice - (0.22 * tpDist), _Digits);
            if(currentSl == 0.0 || lockSl < currentSl - (_Point * 5))
              {
               trade.PositionModify(ticket, lockSl, currentTp);
               Print("[FLARE Autonomous EA] Profit-Lock (🔒) activado en SELL @ SL=", lockSl);
              }
           }
        }
     }
  }

//+------------------------------------------------------------------+
//| Evaluación tick a tick (opera solo al cierre de vela confirmada) |
//+------------------------------------------------------------------+
void OnTick()
  {
   // 1. Verificar Profit-Lock en cada tick si hay posición abierta
   ManageProfitLock();

   // 2. Control de cambio de día y Freno de Riesgo Diario (Circuit Breaker)
   MqlDateTime dt;
   TimeCurrent(dt);
   if(dt.day_of_year != currentDayOfYear)
     {
      currentDayOfYear = dt.day_of_year;
      dayStartEquity   = AccountInfoDouble(ACCOUNT_EQUITY);
     }

   double currentEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   double dailyDrawdownPct = (dayStartEquity > 0.0)
                             ? ((dayStartEquity - currentEquity) / dayStartEquity) * 100.0
                             : 0.0;
   if(dailyDrawdownPct >= InpMaxDailyRiskPct)
      return; // Freno diario activado

   // 3. Filtro Anti-Repainting: evaluar señales solo cuando abre una nueva barra
   datetime currentBarTime = iTime(_Symbol, InpTimeframe, 0);
   if(currentBarTime == lastClosedBarTime)
      return;
   lastClosedBarTime = currentBarTime;

   if(HasOpenPosition())
      return;

   // 4. Leer valores de la última vela 100% cerrada (shift = 1) y las 3 previas
   double fast[2], slow[2], trend[2], rsiVal[2];
   MqlRates rates[5];

   if(CopyBuffer(hFastEma, 0, 1, 2, fast) < 2)   return;
   if(CopyBuffer(hSlowEma, 0, 1, 2, slow) < 2)   return;
   if(CopyBuffer(hTrendEma, 0, 1, 2, trend) < 2) return;
   if(CopyBuffer(hRsi, 0, 1, 2, rsiVal) < 2)     return;
   if(CopyRates(_Symbol, InpTimeframe, 1, 4, rates) < 4) return;

   // En CopyRates con asSeries por defecto false: rates[3] es la vela recién cerrada (shift 1)
   double cClose = rates[3].close;
   double cOpen  = rates[3].open;
   double prev3High = MathMax(rates[0].high, MathMax(rates[1].high, rates[2].high));
   double prev3Low  = MathMin(rates[0].low, MathMin(rates[1].low, rates[2].low));

   double fNow = fast[1], sNow = slow[1], tNow = trend[1], rNow = rsiVal[1];

   // 5. Lógica Momentum-Structure Breakout (idéntica a src/botEngine.ts)
   bool bullStructure = (fNow > sNow) && (sNow >= tNow) && (cClose > fNow);
   bool bearStructure = (fNow < sNow) && (sNow <= tNow) && (cClose < fNow);

   bool bullBreakout  = (cClose > cOpen) && (cClose > prev3High) && (rNow >= 45.0 && rNow <= 70.0);
   bool bearBreakout  = (cClose < cOpen) && (cClose < prev3Low)  && (rNow <= 55.0 && rNow >= 30.0);

   if(bullStructure && bullBreakout)
     {
      double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double sl  = NormalizeDouble(ask * (1.0 - InpStopLossPct / 100.0), _Digits);
      double tp  = NormalizeDouble(ask * (1.0 + InpTakeProfitPct / 100.0), _Digits);
      trade.Buy(InpLotSize, _Symbol, ask, sl, tp, "FLARE-Auto-BUY");
     }
   else if(bearStructure && bearBreakout)
     {
      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double sl  = NormalizeDouble(bid * (1.0 + InpStopLossPct / 100.0), _Digits);
      double tp  = NormalizeDouble(bid * (1.0 - InpTakeProfitPct / 100.0), _Digits);
      trade.Sell(InpLotSize, _Symbol, bid, sl, tp, "FLARE-Auto-SELL");
     }
  }
//+------------------------------------------------------------------+
