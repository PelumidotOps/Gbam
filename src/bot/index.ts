import 'dotenv/config';
import http from 'http';
import { createBot } from './bot.js';

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('❌ Error: TELEGRAM_BOT_TOKEN is missing from your .env file.');
  console.error('👉 Create a bot with @BotFather on Telegram, get your token, and add it to .env:');
  console.error('   TELEGRAM_BOT_TOKEN=your_token_here\n');
  process.exit(1);
}

// Lightweight HTTP server for Render / cloud platform health checks & keep-alive
const port = process.env.PORT || 3000;
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'G-BAM BOT', timestamp: new Date().toISOString() }));
});

server.listen(port, () => {
  console.log(`🌐 Health check server listening on port ${port}`);
});

const bot = createBot(token);

// Global Error Handler to prevent process termination
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`[Gbam Bot Error] Update ${ctx?.update?.update_id}:`, err.error);
});

console.log('🚀 Gbam Telegram Bot is starting up...');

bot.start({
  onStart: (botInfo) => {
    console.log(`✅ Gbam Bot is live and listening on @${botInfo.username}`);
  }
});

// Handle graceful shutdowns
process.once('SIGINT', () => {
  console.log('Stopping bot...');
  server.close();
  bot.stop();
});

process.once('SIGTERM', () => {
  console.log('Stopping bot...');
  server.close();
  bot.stop();
});
