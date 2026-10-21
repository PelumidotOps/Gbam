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

import crypto from 'crypto';
import { SubscriptionService } from '../services/subscription.service.js';

const subscriptionService = SubscriptionService.getInstance();
const bot = createBot(token);

// Lightweight HTTP server for Render / cloud platform health checks & Paystack webhooks
const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && (req.url === '/paystack/webhook' || req.url === '/webhook')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const signature = (req.headers['x-paystack-signature'] || '') as string;
      const secret = process.env.PAYSTACK_SECRET_KEY || '';
      const hash = crypto.createHmac('sha512', secret).update(body).digest('hex');

      if (hash !== signature) {
        console.warn('[Webhook] Rejected Paystack webhook: invalid signature');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }

      try {
        const payload = JSON.parse(body);
        if (payload.event === 'charge.success') {
          const data = payload.data || {};
          const meta = data.metadata || {};
          let telegramId = meta.telegramId ? Number(meta.telegramId) : 0;

          // Fallback parsing from email if metadata was omitted
          if (!telegramId && data.customer?.email) {
            const m = data.customer.email.match(/vip_(\d+)@/);
            if (m) telegramId = Number(m[1]);
          }

          if (telegramId) {
            const days = Number(meta.days) || 7;
            const planName = meta.planName || (days >= 90 ? '3 Months Pro VIP' : days >= 30 ? '1 Month VIP' : '1 Week Access');
            const reference = data.reference || 'WEBHOOK_PAY';

            const sub = subscriptionService.activateUser({
              telegramId,
              username: meta.username,
              days,
              plan: planName,
              paymentReference: reference,
            });

            console.log(`[Webhook] Activated VIP subscription for user ${telegramId} (${days} days, plan: ${planName})`);

            const expiryStr = new Date(sub.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
            await bot.api.sendMessage(
              telegramId,
              `🎉 *Payment Confirmed! VIP Access Unlocked!*\n\n` +
              `Thank you for subscribing to Gbam VIP!\n\n` +
              `💰 *Amount Paid:* ₦${((data.amount || 0) / 100).toLocaleString()}\n` +
              `⏳ *Duration:* ${days} Days\n` +
              `📅 *Valid Until:* ${expiryStr}\n` +
              `🔖 *Receipt Ref:* \`${reference}\`\n\n` +
              `You now have 100% full access to all prediction tiers, multi-platform booking codes, and betting intelligence tools.\n\n` +
              `👉 Tap /picks to view today's verified winning slips!`,
              { parse_mode: 'Markdown' }
            ).catch(err => console.error('[Webhook] Could not send Telegram confirmation DM:', err.message));
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success' }));
      } catch (err: any) {
        console.error('[Webhook] Error processing webhook payload:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal processing error' }));
      }
    });
    return;
  }

  // Default health check endpoint for Render keep-alive
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'G-BAM BOT', timestamp: new Date().toISOString() }));
});

server.listen(port, () => {
  console.log(`🌐 Health check & Webhook server listening on port ${port}`);
});

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
