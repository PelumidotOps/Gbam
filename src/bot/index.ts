import 'dotenv/config';
import { createBot } from './bot.js';

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('❌ Error: TELEGRAM_BOT_TOKEN is missing from your .env file.');
  console.error('👉 Create a bot with @BotFather on Telegram, get your token, and add it to .env:');
  console.error('   TELEGRAM_BOT_TOKEN=your_token_here\n');
  process.exit(1);
}

const bot = createBot(token);

console.log('🚀 Gbam Telegram Bot is starting up...');

bot.start({
  onStart: (botInfo) => {
    console.log(`✅ Gbam Bot is live and listening on @${botInfo.username}`);
  }
});

// Handle graceful shutdowns
process.once('SIGINT', () => {
  console.log('Stopping bot...');
  bot.stop();
});

process.once('SIGTERM', () => {
  console.log('Stopping bot...');
  bot.stop();
});
