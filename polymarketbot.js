// Polymarket Telegram Monitoring Bot
// Install dependencies: npm install node-telegram-bot-api node-fetch@2
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');

// Load token from Railway environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

console.log("TOKEN EXISTS:", !!TELEGRAM_BOT_TOKEN);

// Initialize bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const TelegramBot = require("node-telegram-bot-api");
const fetch = require("node-fetch");

// ================= CONFIG =================
console.log("TOKEN EXISTS:", !!process.env.TELEGRAM_BOT_TOKEN);
const POLYMARKET_API_BASE = "https://gamma-api.polymarket.com";
const POLYMARKET_CLOB_API = "https://clob.polymarket.com";
// =========================================

// Init bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// In-memory storage
const walletHistory = new Map();
const suspiciousActivity = [];
const alertedUsers = new Set();

// Thresholds
const THRESHOLDS = {
  FRESH_WALLET_AGE_DAYS: 7,
  UNUSUAL_SIZE_MULTIPLIER: 10,
  MIN_TRADES_FOR_WIN_RATE: 10,
  HIGH_WIN_RATE_THRESHOLD: 0.75,
  NICHE_MARKET_VOLUME_MAX: 10000,
  REPEATED_ENTRIES_COUNT: 5
};

// ================= HELPERS =================
async function fetchMarkets() {
  try {
    const res = await fetch(
      `${POLYMARKET_API_BASE}/markets?limit=100&closed=false`
    );
    const data = await res.json();
    return Array.isArray(data)
      ? data
      : Array.isArray(data?.markets)
      ? data.markets
      : [];
  } catch {
    return [];
  }
}

async function fetchMarketTrades(conditionId) {
  try {
    const res = await fetch(
      `${POLYMARKET_CLOB_API}/trades?market=${conditionId}&limit=100`
    );
    const data = await res.json();
    return Array.isArray(data)
      ? data
      : Array.isArray(data?.data)
      ? data.data
      : [];
  } catch {
    return [];
  }
}

async function getWalletInfo(address) {
  try {
    const res = await fetch(
      `${POLYMARKET_CLOB_API}/data/trades?maker=${address}&limit=500`
    );
    const data = await res.json();
    return Array.isArray(data)
      ? data
      : Array.isArray(data?.data)
      ? data.data
      : [];
  } catch {
    return [];
  }
}

function calculateWalletStats(trades) {
  if (!Array.isArray(trades) || trades.length === 0) return null;

  const firstTrade = new Date(
    Math.min(...trades.map(t => new Date(t.timestamp)))
  );
  const walletAge =
    (Date.now() - firstTrade.getTime()) / (1000 * 60 * 60 * 24);

  let wins = 0;
  let totalVolume = 0;
  const marketFrequency = {};

  trades.forEach(t => {
    const size = parseFloat(t.size || 0);
    const price = parseFloat(t.price || 0);
    totalVolume += size * price;

    const market = t.market || t.asset_id;
    marketFrequency[market] = (marketFrequency[market] || 0) + 1;

    if (t.outcome === "won") wins++;
  });

  return {
    walletAge,
    totalTrades: trades.length,
    winRate: wins / trades.length,
    totalVolume,
    avgTradeSize: totalVolume / trades.length,
    marketFrequency
  };
}

function detectSuspiciousBehavior(stats, trade) {
  const flags = [];

  if (stats.walletAge < THRESHOLDS.FRESH_WALLET_AGE_DAYS) {
    flags.push({ type: "FRESH_WALLET", severity: "HIGH" });
  }

  if (
    stats.totalTrades >= THRESHOLDS.MIN_TRADES_FOR_WIN_RATE &&
    stats.winRate >= THRESHOLDS.HIGH_WIN_RATE_THRESHOLD
  ) {
    flags.push({ type: "HIGH_WIN_RATE", severity: "MEDIUM" });
  }

  const tradeSize =
    parseFloat(trade.size || 0) * parseFloat(trade.price || 0);

  if (tradeSize > stats.avgTradeSize * THRESHOLDS.UNUSUAL_SIZE_MULTIPLIER) {
    flags.push({ type: "UNUSUAL_SIZE", severity: "HIGH" });
  }

  return flags;
}

function formatAlert(alert) {
  return (
    `🚨 *Suspicious Activity*\n\n` +
    `Wallet: \`${alert.wallet}\`\n` +
    `Market: ${alert.market}\n` +
    `Type: ${alert.type}\n` +
    `Severity: ${alert.severity}\n` +
    `Win Rate: ${(alert.winRate * 100).toFixed(1)}%\n` +
    `Trades: ${alert.totalTrades}\n` +
    `Volume: $${alert.totalVolume.toFixed(2)}`
  );
}

// ================= CORE LOOP =================
async function monitorPolymarket() {
  console.log("Monitoring Polymarket...");

  const markets = await fetchMarkets();

  for (const market of markets) {
    const trades = await fetchMarketTrades(market.condition_id);
    if (!trades.length) continue;

    for (const trade of trades.slice(0, 10)) {
      const wallet = trade.maker || trade.trader_address;
      if (!wallet) continue;

      if (
        walletHistory.has(wallet) &&
        Date.now() - walletHistory.get(wallet).lastChecked < 3600000
      ) {
        continue;
      }

      const walletTrades = await getWalletInfo(wallet);
      const stats = calculateWalletStats(walletTrades);
      if (!stats) continue;

      const flags = detectSuspiciousBehavior(stats, trade);
      if (!flags.length) continue;

      const alert = {
        wallet,
        market: market.question,
        type: flags[0].type,
        severity: flags[0].severity,
        winRate: stats.winRate,
        totalTrades: stats.totalTrades,
        totalVolume: stats.totalVolume
      };

      suspiciousActivity.push(alert);

      for (const userId of alertedUsers) {
        try {
          await bot.sendMessage(userId, formatAlert(alert), {
            parse_mode: "Markdown"
          });
        } catch {}
      }

      walletHistory.set(wallet, {
        stats,
        lastChecked: Date.now()
      });
    }
  }
}

// ================= BOT COMMANDS =================
bot.onText(/\/start/, msg => {
  bot.sendMessage(
    msg.chat.id,
    "🤖 Polymarket Bot Online\n\nUse /alerts to subscribe."
  );
});

bot.onText(/\/alerts/, msg => {
  alertedUsers.add(msg.chat.id);
  bot.sendMessage(msg.chat.id, "✅ Alerts enabled");
});

bot.onText(/\/unsubscribe/, msg => {
  alertedUsers.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, "❌ Alerts disabled");
});

// ================= START =================
setInterval(() => {
  monitorPolymarket().catch(console.error);
}, 300000);

monitorPolymarket().catch(console.error);

console.log("Polymarket Telegram Bot started");


