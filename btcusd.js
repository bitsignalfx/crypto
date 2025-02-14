const { Telegraf } = require("telegraf");
const WebSocket = require("ws");
const technicalindicators = require("technicalindicators");

// Konfigurasi Bot & Finnhub
const BOT_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN";
const FINNHUB_TOKEN = "YOUR_FINNHUB_WEBSOCKET_TOKEN";
const FREE_GROUP_ID = "-100XXXXXXXXX";  // Ganti dengan ID grup gratis
const PREMIUM_GROUP_ID = "-100XXXXXXXXX";  // Ganti dengan ID grup premium
const ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_TOKEN}`);

// Inisialisasi bot
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

// Fungsi untuk menghitung indikator teknikal
const calculateIndicators = () => {
  if (priceData.length < 200) return null;

  const closePrices = priceData.map((p) => p.close);
  const volumes = priceData.map((p) => p.volume);

  return {
    ema50: technicalindicators.EMA.calculate({ period: 50, values: closePrices }),
    ema200: technicalindicators.EMA.calculate({ period: 200, values: closePrices }),
    macd: technicalindicators.MACD.calculate({
      values: closePrices,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
    }),
    rsi: technicalindicators.RSI.calculate({ period: 14, values: closePrices }),
    obv: technicalindicators.OBV.calculate({ close: closePrices, volume: volumes }),
    rvol: calculateRelativeVolume(volumes),
  };
};

// Fungsi menghitung Relative Volume (RVOL)
const calculateRelativeVolume = (volumes) => {
  if (volumes.length < 50) return null;

  const currentVolume = volumes[volumes.length - 1];
  const avgVolume = volumes.slice(-50).reduce((a, b) => a + b, 0) / 50;

  return currentVolume / avgVolume;
};

// Fungsi menentukan sinyal beli/jual dengan filter OBV & RVOL
const detectSignal = () => {
  const indicators = calculateIndicators();
  if (!indicators) return null;

  const { ema50, ema200, macd, rsi, obv, rvol } = indicators;
  const lastEMA50 = ema50[ema50.length - 1];
  const lastEMA200 = ema200[ema200.length - 1];
  const lastMACD = macd[macd.length - 1];
  const lastRSI = rsi[rsi.length - 1];
  const lastOBV = obv[obv.length - 1];
  const prevOBV = obv[obv.length - 2];
  const lastRVOL = rvol;

  const obvConfirm = lastOBV > prevOBV;
  const rvolConfirm = lastRVOL > 1;

  if (lastEMA50 > lastEMA200 && lastMACD.histogram > 0 && lastRSI > 50 && obvConfirm && rvolConfirm) {
    return "BUY";
  }
  if (lastEMA50 < lastEMA200 && lastMACD.histogram < 0 && lastRSI < 50 && !obvConfirm && rvolConfirm) {
    return "SELL";
  }

  return null;
};

// Fungsi mengirim sinyal ke Telegram
const sendSignal = async (type) => {
  const signalCode = generateSignalCode();
  const lastPrice = priceData[priceData.length - 1].close;

  const pipValue = 1.0; // BTC/USD menggunakan pip = 1.0
  const tpPips = 200;
  const slPips = 300;

  const tp = type === "BUY" ? lastPrice + tpPips * pipValue : lastPrice - tpPips * pipValue;
  const sl = type === "BUY" ? lastPrice - slPips * pipValue : lastPrice + slPips * pipValue;

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

  // Update harga
  if (response.type === "trade") {
    response.data.forEach((trade) => {
      priceData.push({ close: trade.p, volume: trade.v });
      if (priceData.length > MAX_DATA_POINTS) priceData.shift();
    });

    if (isAnalyzing && !newsActive) {
      const signal = detectSignal();
      if (signal) sendSignal(signal);
    }
  }

  // Filter news dari Finnhub
  if (response.type === "news") {
    newsActive = true;
    console.log("📢 News detected, stopping analysis for 15 minutes...");
    setTimeout(() => (newsActive = false), 15 * 60 * 1000);
  }
});

// Fungsi reset analisis setelah sinyal selesai
const resetAnalysis = () => {
  lastSignal = null;
  setTimeout(() => {
    isAnalyzing = true;
    console.log("✅ Bot siap analisis lagi.");
  }, 2 * 60 * 1000);
};

// Perintah bot untuk cek status
bot.command("status", (ctx) => {
  ctx.reply(`🤖 Bot Aktif\n📊 Analisis: ${isAnalyzing ? "✅ ON" : "⏸️ PAUSE"}\n📰 News Filter: ${newsActive ? "🛑 Aktif" : "✅ Tidak Ada News"}`);
});

// Jalankan bot
bot.launch();
console.log("🚀 Bot berjalan...");
