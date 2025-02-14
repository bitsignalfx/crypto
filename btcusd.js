const { Telegraf } = require("telegraf");
const WebSocket = require("ws");
const technicalindicators = require("technicalindicators");

// Konfigurasi Bot & Finnhub
const BOT_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN";
const FINNHUB_TOKEN = "YOUR_FINNHUB_WEBSOCKET_TOKEN";
const FREE_GROUP_ID = "-100XXXXXXXXX";
const PREMIUM_GROUP_ID = "-100XXXXXXXXX";
const ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_TOKEN}`);
const bot = new Telegraf(BOT_TOKEN);

// Buffer data harga
let priceData = [];
const MAX_DATA_POINTS = 500;

// Variabel kontrol sinyal
let isAnalyzing = true;
let lastSignal = null;
let newsActive = false;

// Fungsi membuat kode sinyal unik
const generateSignalCode = () => `CR${Math.floor(1000 + Math.random() * 9000)}`;

// Fungsi menghitung ATR
const calculateATR = (period = 14) => {
  if (priceData.length < period) return null;
  const highs = priceData.map(p => p.high);
  const lows = priceData.map(p => p.low);
  const closes = priceData.map(p => p.close);
  return technicalindicators.ATR.calculate({ period, high: highs, low: lows, close: closes });
};

// Fungsi mengecek pola candlestick
const checkCandlestickPatterns = () => {
  if (priceData.length < 3) return null;
  const lastCandle = priceData[priceData.length - 1];
  const prevCandle = priceData[priceData.length - 2];

  if (lastCandle.close > lastCandle.open && prevCandle.close < prevCandle.open && lastCandle.close > prevCandle.open) {
    return "BULLISH_ENGULFING";
  }
  if (lastCandle.close < lastCandle.open && prevCandle.close > prevCandle.open && lastCandle.close < prevCandle.open) {
    return "BEARISH_ENGULFING";
  }
  return null;
};

// Fungsi menghitung indikator teknikal
const calculateIndicators = () => {
  if (priceData.length < 200) return null;

  const closePrices = priceData.map((p) => p.close);
  const volumes = priceData.map((p) => p.volume);
  const atr = calculateATR();

  return {
    ema50: technicalindicators.EMA.calculate({ period: 50, values: closePrices }),
    ema200: technicalindicators.EMA.calculate({ period: 200, values: closePrices }),
    macd: technicalindicators.MACD.calculate({ values: closePrices, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }),
    rsi: technicalindicators.RSI.calculate({ period: 14, values: closePrices }),
    obv: technicalindicators.OBV.calculate({ close: closePrices, volume: volumes }),
    atr: atr ? atr[atr.length - 1] : null,
  };
};

// Fungsi menentukan sinyal beli/jual dengan filter tambahan
const detectSignal = () => {
  const indicators = calculateIndicators();
  if (!indicators) return null;

  const { ema50, ema200, macd, rsi, obv, atr } = indicators;
  const lastEMA50 = ema50[ema50.length - 1];
  const lastEMA200 = ema200[ema200.length - 1];
  const lastMACD = macd[macd.length - 1];
  const lastRSI = rsi[rsi.length - 1];
  const lastOBV = obv[obv.length - 1];
  const prevOBV = obv[obv.length - 2];
  const candlePattern = checkCandlestickPatterns();

  const obvConfirm = lastOBV > prevOBV;
  const atrConfirm = atr && atr > 3;
  const candleConfirm = candlePattern === "BULLISH_ENGULFING" || candlePattern === "BEARISH_ENGULFING";

  if (lastEMA50 > lastEMA200 && lastMACD.histogram > 0 && lastRSI > 50 && obvConfirm && atrConfirm && candleConfirm) {
    return "BUY";
  }
  if (lastEMA50 < lastEMA200 && lastMACD.histogram < 0 && lastRSI < 50 && !obvConfirm && atrConfirm && candleConfirm) {
    return "SELL";
  }

  return null;
};

// Fungsi mengirim sinyal ke Telegram
const sendSignal = async (type) => {
  const signalCode = generateSignalCode();
  const lastPrice = priceData[priceData.length - 1].close;
  const atr = calculateATR();
  const atrMultiplier = 1.5;
  const tp = type === "BUY" ? lastPrice + (atr * atrMultiplier) : lastPrice - (atr * atrMultiplier);
  const sl = type === "BUY" ? lastPrice - (atr * atrMultiplier * 1.5) : lastPrice + (atr * atrMultiplier * 1.5);

  const message = `🔹 **Signal ${type} BTC/USD** 🔹
📌 Kode: ${signalCode}
📈 Entry: ${lastPrice.toFixed(2)}
🎯 TP: ${tp.toFixed(2)}
🛑 SL: ${sl.toFixed(2)}`;

  try {
    await bot.telegram.sendMessage(PREMIUM_GROUP_ID, message, { parse_mode: "Markdown" });
    if (!lastSignal) {
      await bot.telegram.sendMessage(FREE_GROUP_ID, message, { parse_mode: "Markdown" });
    }
    lastSignal = signalCode;
    isAnalyzing = false;
    console.log(`✅ Sinyal ${type} terkirim.`);
  } catch (error) {
    console.error("❌ Gagal mengirim sinyal:", error);
  }
};

// Event WebSocket Finnhub untuk harga & news
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "subscribe", symbol: "BINANCE:BTCUSDT" }));
  ws.send(JSON.stringify({ type: "subscribe", symbol: "economic_calendar" }));
});

ws.on("message", (data) => {
  const response = JSON.parse(data);

  if (response.type === "trade") {
    const latestTrade = response.data[response.data.length - 1];
    priceData.push({ close: latestTrade.p, volume: latestTrade.v, high: latestTrade.h, low: latestTrade.l });

    if (priceData.length > MAX_DATA_POINTS) priceData.shift();
    if (isAnalyzing && !newsActive) {
      const signal = detectSignal();
      if (signal) sendSignal(signal);
    }
  }

  if (response.type === "economic_calendar" && response.data.impact === "high") {
    newsActive = true;
    console.log("📢 High-impact news detected. Stopping analysis for 20 minutes...");
    setTimeout(() => (newsActive = false), 20 * 60 * 1000);
  }
});

// Jalankan bot
bot.launch();
console.log("🚀 Bot berjalan...");
