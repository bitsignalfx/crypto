require('dotenv').config();
const WebSocket = require('ws');
const { Telegraf } = require('telegraf');
const ti = require('technicalindicators');

// Konfigurasi bot Telegram
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// WebSocket Finnhub
const ws = new WebSocket(`wss://ws.finnhub.io?token=${process.env.FINNHUB_API_KEY}`);

// Variabel penyimpanan data harga
let prices = [];
let isTradeActive = false; // Bot berhenti analisis setelah sinyal terkirim

// Subscribe ke BTC/USD
ws.on('open', function open() {
    ws.send(JSON.stringify({ type: 'subscribe', symbol: 'BINANCE:BTCUSDT' }));
});

// Fungsi untuk mengirim pesan ke Telegram
async function sendTelegramMessage(message) {
    try {
        await bot.telegram.sendMessage(CHAT_ID, message);
    } catch (error) {
        console.error("Telegram Error:", error);
    }
}

// Fungsi menghitung indikator
function calculateIndicators(data) {
    const closePrices = data.map(item => item.close);

    const ema21 = ti.EMA.calculate({ period: 21, values: closePrices });
    const ema50 = ti.EMA.calculate({ period: 50, values: closePrices });
    const bb = ti.BollingerBands.calculate({ period: 20, values: closePrices, stdDev: 2 });
    const macd = ti.MACD.calculate({ 
        values: closePrices, 
        fastPeriod: 12, 
        slowPeriod: 26, 
        signalPeriod: 9, 
        SimpleMAOscillator: false, 
        SimpleMASignal: false 
    });
    const rsi = ti.RSI.calculate({ period: 14, values: closePrices });

    return {
        ema21: ema21[ema21.length - 1],
        ema50: ema50[ema50.length - 1],
        bbUpper: bb[bb.length - 1]?.upper,
        bbLower: bb[bb.length - 1]?.lower,
        macdHist: macd[macd.length - 1]?.histogram,
        rsi: rsi[rsi.length - 1]
    };
}

// Menentukan level support/resistance (sederhana)
function findSupportResistance(data) {
    const closePrices = data.map(item => item.close);
    const minPrice = Math.min(...closePrices);
    const maxPrice = Math.max(...closePrices);

    return { support: minPrice, resistance: maxPrice };
}

// Menentukan sinyal buy/sell
function checkForSignal(data) {
    const { ema21, ema50, bbUpper, bbLower, macdHist, rsi } = calculateIndicators(data);
    const { support, resistance } = findSupportResistance(data);
    const lastPrice = data[data.length - 1].close;

    if (!ema21 || !ema50 || !bbUpper || !bbLower || !macdHist || !rsi) return;

    let signal = null;
    let tp = null;
    let sl = null;

    // **BUY Signal**
    if (ema21 > ema50 && macdHist > 0 && rsi < 70 && lastPrice > support) {
        signal = "BUY";
        tp = lastPrice + 200;
        sl = lastPrice - 300;
    }

    // **SELL Signal**
    if (ema21 < ema50 && macdHist < 0 && rsi > 30 && lastPrice < resistance) {
        signal = "SELL";
        tp = lastPrice - 200;
        sl = lastPrice + 300;
    }

    // Kirim sinyal jika valid dan belum ada posisi aktif
    if (signal && !isTradeActive) {
        isTradeActive = true;
        sendTelegramMessage(`🚀 *BTCUSD ${signal} Signal*\n\n📉 Entry: ${lastPrice}\n🎯 TP: ${tp}\n🛑 SL: ${sl}`);
        
        // Pantau harga sampai TP atau SL tercapai
        monitorTrade(signal, tp, sl);
    }
}

// Pantau trade sampai TP/SL tercapai
function monitorTrade(signal, tp, sl) {
    const interval = setInterval(() => {
        if (prices.length === 0) return;

        const lastPrice = prices[prices.length - 1].close;

        if ((signal === "BUY" && lastPrice >= tp) || (signal === "SELL" && lastPrice <= tp)) {
            sendTelegramMessage(`✅ *BTCUSD ${signal} TP Hit!*\n\n📈 Price: ${lastPrice}`);
            isTradeActive = false;
            clearInterval(interval);
        } else if ((signal === "BUY" && lastPrice <= sl) || (signal === "SELL" && lastPrice >= sl)) {
            sendTelegramMessage(`❌ *BTCUSD ${signal} SL Hit!*\n\n📉 Price: ${lastPrice}`);
            isTradeActive = false;
            clearInterval(interval);
        }
    }, 5000); // Cek harga setiap 5 detik
}

// Event listener WebSocket
ws.on('message', function incoming(data) {
    const parsedData = JSON.parse(data);
    if (parsedData.type === "trade") {
        parsedData.data.forEach(trade => {
            prices.push({ time: trade.t, close: trade.p });

            // Simpan maksimal 100 data terakhir
            if (prices.length > 100) prices.shift();

            // Cek sinyal hanya jika ada cukup data
            if (prices.length >= 50 && !isTradeActive) {
                checkForSignal(prices);
            }
        });
    }
});

// Menjalankan bot Telegram
bot.launch();
