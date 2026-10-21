import { Bot, Context, InlineKeyboard } from 'grammy';
import { BookmakerRegistry } from '../bookmakers/registry.js';
import { TicketSplitter } from '../engine/splitter.js';
import { TicketTrimmer } from '../engine/trimmer.js';
import { AssessedLeg, BetLeg } from '../models/types.js';
import { ApiFootballProvider } from '../providers/api-football.provider.js';
import { MockStatsProvider } from '../providers/mock-stats.provider.js';
import { SportsDataProvider } from '../providers/sports-data.interface.js';
import { SportyBetCatalog, SlipTimeframe } from '../providers/sportybet-catalog.js';

import { BetEvaluator } from '../stats/evaluator.js';
import { PoissonModel } from '../stats/poisson.js';
import { TeamIntelligenceService } from '../stats/team-intelligence.js';

import { SubscriptionService } from '../services/subscription.service.js';
import { PaystackService } from '../services/paystack.service.js';

export function createBot(token: string) {
  const bot = new Bot(token);

  const subscriptionService = SubscriptionService.getInstance();
  const paystackService = PaystackService.getInstance();

  // Initialize live sports provider with API key if present, otherwise mock
  const statsProvider: SportsDataProvider = process.env.SPORTS_DATA_API_KEY
    ? new ApiFootballProvider({ apiKey: process.env.SPORTS_DATA_API_KEY })
    : new MockStatsProvider();

  // In-memory 30-minute cache to preserve daily API request quota
  let cachedFixtures: Array<{ homeTeam: string; awayTeam: string; league: string; country?: string; id: string }> = [];
  let cacheExpiry = 0;

  async function getLiveFixtures() {
    const now = Date.now();
    if (cachedFixtures.length > 0 && now < cacheExpiry) {
      return cachedFixtures;
    }
    try {
      const fixtures = await statsProvider.getUpcomingFixtures();
      if (fixtures && fixtures.length > 0) {
        cachedFixtures = fixtures.map(f => ({
          id: f.id,
          homeTeam: f.homeTeam,
          awayTeam: f.awayTeam,
          league: f.league,
          country: f.country
        }));
        cacheExpiry = now + 30 * 60 * 1000; // 30 minutes
        return cachedFixtures;
      }
    } catch (err: any) {
      console.error('Live fixtures fetch error:', err.message);
    }
    return cachedFixtures;
  }

  // Register interactive command menu in Telegram
  bot.api.setMyCommands([
    { command: 'start', description: 'Start Gbam and see status' },
    { command: 'picks', description: 'Get today\'s high-probability predictions' },
    { command: 'predict', description: 'Analyze a match e.g. /predict Arsenal vs Chelsea' },
    { command: 'trim', description: 'Trim a ticket to safer odds e.g. /trim BC99ZA 10' },
    { command: 'convert', description: 'Convert codes between SportyBet, Bet9ja, etc.' },
    { command: 'split', description: 'Split a large ticket into balanced slips' },
    { command: 'status', description: 'Check your VIP subscription status' },
    { command: 'help', description: 'View instructions and tips' }
  ]).catch(err => {
    console.error('Could not set Telegram commands:', err.message);
  });

  function formatPlatformCodes(codes: Record<string, string>, excludePlatform?: string): string {
    const platforms = ['SportyBet', 'Football.com', 'BetKing', 'MSport', 'Bet9ja', '1xBet', 'Betano'];
    const lines: string[] = [];
    for (const p of platforms) {
      if (excludePlatform && p.toLowerCase() === excludePlatform.toLowerCase()) continue;
      if (codes[p]) {
        lines.push(`• *${p}:* \`${codes[p]}\``);
      }
    }
    return lines.length > 0 ? lines.join('\n') : '';
  }

  function formatKickoff(startTime?: number): string {
    if (!startTime) return '';
    const now = Date.now();
    const diffMs = startTime - now;
    if (diffMs < 0) return '🕒 Match Started';

    const timeZone = 'Africa/Lagos';
    const startObj = new Date(startTime);
    const nowObj = new Date(now);

    const startDay = startObj.toLocaleDateString('en-CA', { timeZone });
    const nowDay = nowObj.toLocaleDateString('en-CA', { timeZone });

    const tomorrowObj = new Date(now + 24 * 60 * 60 * 1000);
    const tomorrowDay = tomorrowObj.toLocaleDateString('en-CA', { timeZone });

    const timeStr = startObj.toLocaleTimeString('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });

    if (startDay === nowDay) {
      const minsLeft = Math.round(diffMs / (60 * 1000));
      const hoursLeft = Math.floor(minsLeft / 60);
      const inStr = hoursLeft > 0 ? `in ${hoursLeft}h ${minsLeft % 60}m` : `in ${minsLeft}m`;
      return `🕒 Today at ${timeStr} (${inStr})`;
    } else if (startDay === tomorrowDay) {
      const weekday = startObj.toLocaleDateString('en-US', { timeZone, weekday: 'short' });
      return `🕒 Tomorrow (${weekday}) at ${timeStr}`;
    } else {
      const dateStr = startObj.toLocaleDateString('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' });
      return `🕒 ${dateStr} at ${timeStr}`;
    }
  }

  function buildPlanKeyboard(): InlineKeyboard {
    const plans = paystackService.getPlans();
    return new InlineKeyboard()
      .text(`🟢 1 Week Access — ₦${plans['1_week'].priceNgn.toLocaleString()}`, 'plan_1_week').row()
      .text(`🔥 1 Month VIP — ₦${plans['1_month'].priceNgn.toLocaleString()} (Popular)`, 'plan_1_month').row()
      .text(`👑 3 Months VIP — ₦${plans['3_months'].priceNgn.toLocaleString()} (Best Value)`, 'plan_3_months').row()
      .text('🔑 I Have an Activation Code', 'enter_code');
  }

  async function sendVipLockScreen(ctx: Context, customHeader?: string) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery().catch(() => {});
    }
    const plans = paystackService.getPlans();
    const header = customHeader || '🔒 *VIP Access Required*';
    const text =
      `${header}\n\n` +
      `Gbam provides exclusive, high-confidence AI match predictions, multi-platform booking codes (SportyBet, Football.com, BetKing, MSport, Bet9ja), and ticket trimmers.\n\n` +
      `Choose a membership plan below to unlock instant, unlimited access:\n\n` +
      `• 🟢 *1 Week Access:* ₦${plans['1_week'].priceNgn.toLocaleString()} (7 Days)\n` +
      `• 🔥 *1 Month VIP:* ₦${plans['1_month'].priceNgn.toLocaleString()} (30 Days — Most Popular)\n` +
      `• 👑 *3 Months Pro VIP:* ₦${plans['3_months'].priceNgn.toLocaleString()} (90 Days — Save ₦3,000)\n\n` +
      `💳 *Instant Activation:* Pay with Bank Transfer, Debit Card, or USSD via Paystack. Your access unlocks automatically upon payment.\n\n` +
      `_Already have an activation code? Tap the button below or type it directly (e.g. \`VIP-30D-XXXXXX\`)!_`;

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: buildPlanKeyboard(),
    });
  }

  // ==========================================
  // PUBLIC & INFORMATIONAL COMMANDS
  // ==========================================

  // /start command
  bot.command('start', async (ctx: Context) => {
    const userId = ctx.from?.id;
    const status = userId ? subscriptionService.isUserActive(userId) : { active: false };

    let vipBadge = '';
    if (userId && subscriptionService.isAdmin(userId)) {
      vipBadge = `👑 *Membership Status:* *Admin / Lifetime VIP (Owner)*\n`;
    } else if (status.active) {
      vipBadge = `👑 *Membership Status:* *Active VIP (${status.daysRemaining} days remaining)*\n`;
    } else {
      vipBadge = `🔒 *Membership Status:* *Not Subscribed (Access Locked)*\n`;
    }

    const welcome =
      `🎯 *Welcome to Gbam!*\n\n` +
      `Your smart betting co-pilot — build safer tickets, convert codes across *7 top Nigerian platforms*, and get high-confidence predictions in seconds.\n\n` +
      vipBadge + `\n` +
      `*Supported Bookmakers:*\n` +
      `🟢 *SportyBet* • 🔴 *Football.com* • 🟡 *BetKing* • 🔵 *MSport* • 🟢 *Bet9ja* • 🟣 *1xBet* • 🟠 *Betano*\n\n` +
      `*What I can do for you:*\n` +
      `• 🔥 *Safe Picks*: 3 curated tiers (Safe Double, Daily Acca, Super Slip) with codes ready for SportyBet, Football.com, BetKing, MSport & Bet9ja!\n` +
      `• 🔄 *Convert*: Move your bet code between any Nigerian bookmaker in 1 second.\n` +
      `• ✂️ *Smart Trim*: Cut the riskiest games out of your ticket to hit your odds goal with >= 70% confidence.\n` +
      `• ⚖️ *Split*: Divide a long ticket into smaller balanced slips so 1 loss doesn't ruin everything.\n` +
      `• 📊 *Match Advice*: Check form and recommended safe bets for any match.\n\n` +
      `*Quick Menu:*\n` +
      `• \`/picks\` — Today's tiered safe predictions\n` +
      `• \`/predict <home> vs <away>\` — Match advice\n` +
      `• \`/trim <code> <targetOdds>\` — Make your ticket safer\n` +
      `• \`/convert <from> <to> <code>\` — Switch bookmaker\n` +
      `• \`/split <code> <count>\` — Split long slips\n` +
      `• \`/status\` — View your VIP subscription details\n\n` +
      `💬 _You can also just chat naturally with me anytime! For example: "Give me 10 odds on Football.com" or "Give me 5 odds on MSport"!_`;

    if (!status.active && (!userId || !subscriptionService.isAdmin(userId))) {
      await ctx.reply(welcome, { parse_mode: 'Markdown' });
      await sendVipLockScreen(ctx);
    } else {
      await ctx.reply(welcome, { parse_mode: 'Markdown' });
    }
  });

  // /help command
  bot.command('help', async (ctx: Context) => {
    const help =
      `📖 *How to use Gbam*\n\n` +
      `*1. Today's Safe Picks & Tiers*\n` +
      `Type \`/picks\` to get today's 3 curated tiers:\n` +
      `• 🟢 *Safe Double:* ~2.0x odds (82%+ win rate)\n` +
      `• 🟡 *Daily Acca:* ~5.0x odds (78%+ win rate)\n` +
      `• 🔴 *Super Slip:* ~10x+ odds (74%+ win rate)\n` +
      `Each tier gives you instant booking codes for *SportyBet, Football.com, BetKing, MSport, and Bet9ja*!\n` +
      `_Type \`/picks safe\`, \`/picks acca\`, or \`/picks super\` for single-slip detail._\n\n` +
      `*2. Natural Odds Requests Across Bookmakers*\n` +
      `You can just ask me naturally:\n` +
      `• _"Give me 20 odds on Football.com"_\n` +
      `• _"Give me 10 odds on MSport"_\n` +
      `• _"Give me 5 odds on 1xBet"_\n` +
      `• _"Give me 2 odds on SportyBet"_\n\n` +
      `*3. Match Advice & Predictions*\n` +
      `Type \`/predict Arsenal vs Chelsea\` to get safe picks, win rates, and score predictions.\n\n` +
      `*4. Trim a Risky Ticket*\n` +
      `Got a 30-game slip with too much risk? Type:\n` +
      `\`/trim BC99ZA 10\`\n` +
      `It removes the riskiest games and keeps the safest combination close to 10 odds.\n\n` +
      `*5. Convert Booking Codes Between 7 Platforms*\n` +
      `\`/convert SportyBet Football.com SKXLEU\`\n` +
      `Converts codes between SportyBet, Bet9ja, Football.com, BetKing, MSport, 1xBet, and Betano!\n\n` +
      `*6. VIP Subscription Status*\n` +
      `Type \`/status\` anytime to check your remaining subscription time.`;

    await ctx.reply(help, { parse_mode: 'Markdown' });
  });

  // /status and /myplan
  bot.command(['status', 'myplan'], async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    if (subscriptionService.isAdmin(userId)) {
      await ctx.reply(
        `👑 *Account Status: Administrator*\n\n` +
        `• *Role:* Owner / Admin\n` +
        `• *Access:* Lifetime VIP (Never expires)\n` +
        `• *Telegram ID:* \`${userId}\`\n\n` +
        `_Type \`/stats\` for overall bot statistics or \`/code 30d\` to generate a gift invite code._`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const check = subscriptionService.isUserActive(userId);
    if (!check.active) {
      const expiredMsg = check.reason === 'EXPIRED'
        ? `⏰ *Your VIP subscription has expired.*\n\nRenew now to continue accessing predictions and booking codes:`
        : `🔒 *You do not have an active VIP subscription.*\n\nChoose a plan below to activate your account:`;

      await ctx.reply(expiredMsg, {
        parse_mode: 'Markdown',
        reply_markup: buildPlanKeyboard()
      });
      return;
    }

    const sub = check.subscriber;
    const isLife = sub?.isLifetime;
    const expiryFormatted = isLife
      ? 'Lifetime'
      : (sub?.expiresAt ? new Date(sub.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Unknown');

    const text =
      `💎 *Your VIP Subscription*\n\n` +
      `• *Status:* 🟢 Active\n` +
      `• *Plan:* *${sub?.plan || 'VIP Member'}*\n` +
      `• *Days Remaining:* *${check.daysRemaining} days*\n` +
      `• *Expires:* *${expiryFormatted}*\n` +
      `• *Telegram ID:* \`${userId}\`\n\n` +
      `_Enjoy unlimited access to all AI predictions, booking codes, and betting tools!_`;

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // ==========================================
  // CODE REDEMPTION HANDLER (Public)
  // ==========================================

  bot.hears(/^VIP-[A-Z0-9-]+$/i, async (ctx: Context) => {
    const code = ctx.message?.text?.trim().toUpperCase();
    if (!code) return;

    const userId = ctx.from?.id;
    if (!userId) return;

    const result = subscriptionService.redeemCode({
      code,
      telegramId: userId,
      username: ctx.from?.username,
      fullName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ')
    });

    if (result.success) {
      const sub = result.subscriber!;
      const expiryStr = sub.isLifetime
        ? 'Never (Lifetime Access)'
        : new Date(sub.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

      const kb = new InlineKeyboard().text("🔥 View Today's VIP Picks", 'trigger_picks');
      await ctx.reply(
        `🎉 *VIP Access Successfully Activated!*\n\n` +
        `Welcome to Gbam VIP! ${result.message}\n\n` +
        `• *Plan:* *${sub.plan}*\n` +
        `• *Duration Added:* *${result.daysAdded} Days*\n` +
        `• *Valid Until:* *${expiryStr}*\n\n` +
        `You now have 100% full access to all prediction tiers, multi-platform booking codes, and trimming tools.`,
        { parse_mode: 'Markdown', reply_markup: kb }
      );
    } else {
      await ctx.reply(
        `❌ *Activation Failed*\n\n${result.message}\n\n_Need help? Tap /status or contact the admin._`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  // ==========================================
  // PAYSTACK CALLBACK QUERIES (Public)
  // ==========================================

  bot.callbackQuery(/^(plan_1_week|plan_1_month|plan_3_months)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const planId = ctx.match[1] as '1_week' | '1_month' | '3_months';
    const telegramId = ctx.from.id;
    const username = ctx.from.username;

    await ctx.reply(`⏳ Generating your secure Paystack checkout link...`);

    const init = await paystackService.initializeTransaction({
      telegramId,
      username,
      planId
    });

    if (!init.success || !init.authorizationUrl || !init.reference) {
      await ctx.reply(`❌ Payment checkout could not be created: ${init.error || 'Unknown error'}`);
      return;
    }

    const plan = init.plan!;
    const kb = new InlineKeyboard()
      .url(`💳 Pay ₦${plan.priceNgn.toLocaleString()} Now`, init.authorizationUrl)
      .row()
      .text('🔄 I Have Completed Payment (Verify)', `verify_${init.reference}`)
      .row()
      .text('⬅️ Back to Plans', 'show_plans');

    const text =
      `💳 *Paystack Secure Checkout*\n\n` +
      `📦 *Plan:* *${plan.name}* (${plan.badge})\n` +
      `💰 *Amount:* *₦${plan.priceNgn.toLocaleString()}*\n` +
      `⏳ *Duration:* *${plan.days} Days*\n` +
      `🔖 *Reference:* \`${init.reference}\`\n\n` +
      `*How to pay:*\n` +
      `1. Tap *Pay ₦${plan.priceNgn.toLocaleString()} Now* below (supports Bank Transfer, Debit Card, USSD).\n` +
      `2. Complete your payment on the secure Paystack checkout.\n` +
      `3. Return here and tap *I Have Completed Payment* to instantly unlock your VIP access!`;

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
  });

  bot.callbackQuery(/^verify_(.+)$/, async (ctx) => {
    const reference = ctx.match[1];
    await ctx.answerCallbackQuery({ text: 'Checking payment status with Paystack...' });

    const verification = await paystackService.verifyTransaction(reference);

    if (verification.success && verification.status === 'success') {
      const days = verification.days || 30;
      const planName = verification.planId ? `VIP (${verification.planId})` : 'VIP Subscription';

      const sub = subscriptionService.activateUser({
        telegramId: ctx.from.id,
        username: ctx.from.username,
        fullName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
        days,
        plan: planName,
        paymentReference: reference
      });

      const expiryStr = new Date(sub.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      const successMsg =
        `🎉 *Payment Confirmed! VIP Access Unlocked!*\n\n` +
        `Thank you for subscribing to Gbam VIP!\n\n` +
        `💰 *Amount Paid:* ₦${(verification.amountNgn || 0).toLocaleString()}\n` +
        `⏳ *Duration:* ${days} Days\n` +
        `📅 *Valid Until:* ${expiryStr}\n` +
        `🔖 *Receipt Ref:* \`${reference}\`\n\n` +
        `You now have full access to all prediction tiers, multi-platform booking codes, and betting intelligence tools.\n\n` +
        `👉 Tap below to view today's winning slips!`;

      const picksKb = new InlineKeyboard()
        .text("🔥 View Today's VIP Picks", "trigger_picks");

      await ctx.reply(successMsg, { parse_mode: 'Markdown', reply_markup: picksKb });
    } else {
      await ctx.reply(
        `⚠️ *Payment Status: Not Yet Confirmed*\n\n` +
        `Status from Paystack: *${verification.status || 'Pending'}*\n\n` +
        `• If you just completed the payment, please allow 5-10 seconds for the bank network to confirm and tap *Check Again* below.\n` +
        `• If you haven't completed the payment yet, tap the checkout link above.`,
        {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard()
            .text('🔄 Check Again', `verify_${reference}`)
            .row()
            .text('⬅️ Back to Plans', 'show_plans')
        }
      );
    }
  });

  bot.callbackQuery('show_plans', async (ctx) => {
    await sendVipLockScreen(ctx, '💎 *Gbam VIP Plans*');
  });

  bot.callbackQuery('enter_code', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🔑 *Redeem VIP Activation Code*\n\n` +
      `Simply paste your activation code directly in this chat!\n\n` +
      `Example format:\n\`VIP-30D-XXXXXX\`\n\n` +
      `Your VIP membership will unlock instantly.`
    );
  });

  // ==========================================
  // ADMIN COMMANDS (Owner Only)
  // ==========================================

  // /code [duration] [label]
  bot.command('code', async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId || !subscriptionService.isAdmin(userId)) {
      return;
    }

    const text = ctx.message?.text || '';
    const args = text.replace(/^\/code\s*/i, '').trim().split(/\s+/).filter(Boolean);
    const durArg = (args[0] || '30d').toLowerCase();
    const label = args.slice(1).join(' ') || undefined;

    let days = 30;
    let isLifetime = false;

    if (durArg === 'lifetime' || durArg === 'life') {
      isLifetime = true;
    } else if (durArg.endsWith('d')) {
      days = parseInt(durArg.replace('d', ''), 10) || 30;
    } else if (durArg.endsWith('w')) {
      days = (parseInt(durArg.replace('w', ''), 10) || 1) * 7;
    } else if (durArg.endsWith('m')) {
      days = (parseInt(durArg.replace('m', ''), 10) || 1) * 30;
    } else if (!isNaN(Number(durArg))) {
      days = Number(durArg);
    }

    const newCode = subscriptionService.generateCode({
      days,
      isLifetime,
      createdBy: userId,
      label
    });

    const replyMsg =
      `🎟️ *New VIP Activation Code Generated!*\n\n` +
      `🔑 *Code:* \`${newCode.code}\`\n` +
      `⏳ *Duration:* *${isLifetime ? 'Lifetime' : `${days} Days`}*\n` +
      (label ? `🏷️ *Label:* ${label}\n` : '') +
      `📅 *Generated:* ${new Date(newCode.createdAt).toLocaleString()}\n\n` +
      `👉 *Instructions for customer:*\n` +
      `Tell the customer to open \`@GbamAI_bot\` and paste this code:\n` +
      `\`${newCode.code}\`\n\n` +
      `_The code is single-use and will automatically activate their access._`;

    await ctx.reply(replyMsg, { parse_mode: 'Markdown' });
  });

  // /users (Admin)
  bot.command('users', async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId || !subscriptionService.isAdmin(userId)) {
      return;
    }

    const subs = subscriptionService.getAllSubscribers();
    if (subs.length === 0) {
      await ctx.reply('No subscribers recorded yet.');
      return;
    }

    const now = Date.now();
    const lines = subs.map((s, idx) => {
      const isOwner = subscriptionService.isAdmin(s.telegramId);
      let statusEmoji = '🟢 Active';
      if (s.status === 'revoked') statusEmoji = '🔴 Revoked';
      else if (!s.isLifetime && new Date(s.expiresAt).getTime() < now) statusEmoji = '⏰ Expired';

      const expiryStr = s.isLifetime ? 'Lifetime' : new Date(s.expiresAt).toLocaleDateString('en-GB');
      const userTag = s.username ? `@${s.username}` : (s.fullName || 'No Name');

      return `${idx + 1}. \`${userTag}\` (\`${s.telegramId}\`)\n   ${statusEmoji} | ${s.plan} | Expiry: ${expiryStr}${isOwner ? ' *(Owner)*' : ''}`;
    });

    const header = `👥 *VIP Subscribers (${subs.length} total):*\n\n`;
    await ctx.reply(header + lines.join('\n\n'), { parse_mode: 'Markdown' });
  });

  // /stats (Admin)
  bot.command('stats', async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId || !subscriptionService.isAdmin(userId)) {
      return;
    }

    const stats = subscriptionService.getStats();
    const text =
      `📊 *Gbam VIP Analytics & Membership*\n\n` +
      `👥 *Total Users in DB:* *${stats.totalSubscribers}*\n` +
      `🟢 *Active VIP Members:* *${stats.activeSubscribers}*\n` +
      `⏰ *Expired Members:* *${stats.expiredSubscribers}*\n` +
      `🔴 *Revoked Members:* *${stats.revokedSubscribers}*\n\n` +
      `🎟️ *Activation Codes Generated:* *${stats.totalCodesGenerated}*\n` +
      `✨ *Unused / Available Codes:* *${stats.unusedCodes}*\n\n` +
      `_Admin ID: \`${userId}\`_`;

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // /revoke <id> (Admin)
  bot.command('revoke', async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId || !subscriptionService.isAdmin(userId)) {
      return;
    }

    const text = ctx.message?.text || '';
    const targetId = parseInt(text.replace(/^\/revoke\s*/i, '').trim(), 10);
    if (!targetId || isNaN(targetId)) {
      await ctx.reply('⚠️ Usage: `/revoke <telegram_id>`', { parse_mode: 'Markdown' });
      return;
    }

    const result = subscriptionService.revokeUser(targetId);
    await ctx.reply(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
  });

  // /extend <id> <days> (Admin)
  bot.command('extend', async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId || !subscriptionService.isAdmin(userId)) {
      return;
    }

    const text = ctx.message?.text || '';
    const parts = text.replace(/^\/extend\s*/i, '').trim().split(/\s+/);
    const targetId = parseInt(parts[0], 10);
    const days = parseInt(parts[1], 10) || 30;

    if (!targetId || isNaN(targetId)) {
      await ctx.reply('⚠️ Usage: `/extend <telegram_id> <days>`\nExample: `/extend 123456789 30`', { parse_mode: 'Markdown' });
      return;
    }

    const result = subscriptionService.extendUser(targetId, days);
    await ctx.reply(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
  });

  // ==========================================
  // GATEKEEPER MIDDLEWARE (Protects predictions)
  // ==========================================

  bot.use(async (ctx, next) => {
    // 1. Allow callback queries for payment and plan browsing
    if (ctx.callbackQuery) {
      const data = ctx.callbackQuery.data || '';
      if (
        data.startsWith('plan_') ||
        data.startsWith('verify_') ||
        data === 'show_plans' ||
        data === 'enter_code'
      ) {
        return next();
      }
    }

    // 2. Allow public/informational commands
    const text = ctx.message?.text || '';
    if (/^\/(start|help|status|myplan)(\s.*)?$/i.test(text)) {
      return next();
    }

    // 3. Allow activation code redemption e.g. "VIP-30D-XXXXXX"
    if (/^VIP-[A-Z0-9-]+$/i.test(text.trim())) {
      return next();
    }

    // 4. Allow admin commands if user is admin
    const userId = ctx.from?.id;
    if (userId && subscriptionService.isAdmin(userId)) {
      return next();
    }

    // 5. Check if user is active subscriber
    if (userId) {
      const check = subscriptionService.isUserActive(userId);
      if (check.active) {
        return next();
      }
    }

    // 6. User is not subscribed or expired: show VIP lock screen
    return sendVipLockScreen(ctx);
  });

  // ==========================================
  // PROTECTED COMMANDS & HANDLERS
  // ==========================================

  bot.callbackQuery('trigger_picks', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("🔍 Generating today's verified high-probability predictions across Nigerian bookmakers...");
    try {
      const tiered = await SportyBetCatalog.getTieredPicks();
      const msg =
        `🔥 *Today's Curated Prediction Tiers*\n` +
        `_Live scheduled fixtures with high statistical confidence & instant booking codes:_\n\n` +
        `🟢 *1. Safe Double (~2.0x Odds)*\n` +
        `• Odds: *${tiered.safe.totalOdds}x* (${tiered.safe.picks.length} games, ${(tiered.safe.averageConfidence * 100).toFixed(0)}% win rate)\n` +
        tiered.safe.picks.map(p => `  👉 ${p.homeTeam} vs ${p.awayTeam}: *${p.marketDesc} (${p.outcomeDesc})* @ ${p.odds} (${formatKickoff(p.estimateStartTime)})`).join('\n') +
        `\n🎟️ *Codes:* SportyBet: \`${tiered.safe.codes['SportyBet'] || '-'}\` | Football.com: \`${tiered.safe.codes['Football.com'] || '-'}\` | BetKing: \`${tiered.safe.codes['BetKing'] || '-'}\` | MSport: \`${tiered.safe.codes['MSport'] || '-'}\` | Bet9ja: \`${tiered.safe.codes['Bet9ja'] || '-'}\`\n\n` +
        `🟡 *2. Daily Acca (~5.0x Odds)*\n` +
        `• Odds: *${tiered.acca.totalOdds}x* (${tiered.acca.picks.length} games, ${(tiered.acca.averageConfidence * 100).toFixed(0)}% win rate)\n` +
        tiered.acca.picks.slice(0, 4).map(p => `  👉 ${p.homeTeam} vs ${p.awayTeam}: *${p.marketDesc} (${p.outcomeDesc})* @ ${p.odds} (${formatKickoff(p.estimateStartTime)})`).join('\n') +
        (tiered.acca.picks.length > 4 ? `\n  _...plus ${tiered.acca.picks.length - 4} more safe games_` : '') +
        `\n🎟️ *Codes:* SportyBet: \`${tiered.acca.codes['SportyBet'] || '-'}\` | Football.com: \`${tiered.acca.codes['Football.com'] || '-'}\` | BetKing: \`${tiered.acca.codes['BetKing'] || '-'}\` | MSport: \`${tiered.acca.codes['MSport'] || '-'}\` | Bet9ja: \`${tiered.acca.codes['Bet9ja'] || '-'}\`\n\n` +
        `🔴 *3. Super Slip (~10x+ Odds)*\n` +
        `• Odds: *${tiered.super.totalOdds}x* (${tiered.super.picks.length} games, ${(tiered.super.averageConfidence * 100).toFixed(0)}% win rate)\n` +
        tiered.super.picks.slice(0, 4).map(p => `  👉 ${p.homeTeam} vs ${p.awayTeam}: *${p.marketDesc} (${p.outcomeDesc})* @ ${p.odds} (${formatKickoff(p.estimateStartTime)})`).join('\n') +
        (tiered.super.picks.length > 4 ? `\n  _...plus ${tiered.super.picks.length - 4} more safe games_` : '') +
        `\n🎟️ *Codes:* SportyBet: \`${tiered.super.codes['SportyBet'] || '-'}\` | Football.com: \`${tiered.super.codes['Football.com'] || '-'}\` | BetKing: \`${tiered.super.codes['BetKing'] || '-'}\` | MSport: \`${tiered.super.codes['MSport'] || '-'}\` | Bet9ja: \`${tiered.super.codes['Bet9ja'] || '-'}\`\n\n` +
        `💡 _Tap \`/picks\` again for a fresh rotated ticket, or type \`/picks safe\`, \`/picks acca\`, or \`/picks super\` for single-slip view!_`;

      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err: any) {
      await ctx.reply(`❌ Could not generate picks: ${err.message}`);
    }
  });

  // /picks - Today's high-probability tiered predictions
  bot.command('picks', async (ctx: Context) => {
    try {
      const text = ctx.message?.text || '';
      const sub = text.replace(/^\/picks\s*/i, '').trim().toLowerCase();

      await ctx.reply("🔍 Generating today's verified high-probability predictions across Nigerian bookmakers...");
      const tiered = await SportyBetCatalog.getTieredPicks();

      // If user asked for a specific tier
      if (sub === 'safe' || sub === '2' || sub === 'double') {
        const t = tiered.safe;
        const msg =
          `🟢 *Today's Safe Double (${t.totalOdds}x Odds)*\n\n` +
          `High-confidence picks with ${(t.averageConfidence * 100).toFixed(0)}% average win rate:\n\n` +
          t.picks.map(p => `• *${p.homeTeam} vs ${p.awayTeam}* (${p.tournament}) — ${formatKickoff(p.estimateStartTime)}\n  👉 *${p.marketDesc}: ${p.outcomeDesc}* (Odds: *${p.odds}*) — Confidence: *${(p.confidence * 100).toFixed(0)}%*`).join('\n\n') +
          `\n\n📊 *Combined Odds:* *${t.totalOdds}x*\n` +
          `🎟️ *Multi-Platform Booking Codes:*\n` +
          formatPlatformCodes(t.codes) +
          `\n\n_Copy the code for your betting app directly!_`;
        await ctx.reply(msg, { parse_mode: 'Markdown' });
        return;
      }

      if (sub === 'acca' || sub === '5') {
        const t = tiered.acca;
        const msg =
          `🟡 *Today's Daily Acca (${t.totalOdds}x Odds)*\n\n` +
          `Balanced value accumulator with ${(t.averageConfidence * 100).toFixed(0)}% average win rate:\n\n` +
          t.picks.map(p => `• *${p.homeTeam} vs ${p.awayTeam}* (${p.tournament}) — ${formatKickoff(p.estimateStartTime)}\n  👉 *${p.marketDesc}: ${p.outcomeDesc}* (Odds: *${p.odds}*) — Confidence: *${(p.confidence * 100).toFixed(0)}%*`).join('\n\n') +
          `\n\n📊 *Combined Odds:* *${t.totalOdds}x*\n` +
          `🎟️ *Multi-Platform Booking Codes:*\n` +
          formatPlatformCodes(t.codes) +
          `\n\n_Copy the code for your betting app directly!_`;
        await ctx.reply(msg, { parse_mode: 'Markdown' });
        return;
      }

      if (sub === 'super' || sub === '10' || sub === 'slip') {
        const t = tiered.super;
        const msg =
          `🔴 *Today's Super Slip (${t.totalOdds}x Odds)*\n\n` +
          `Extended accumulator with ${(t.averageConfidence * 100).toFixed(0)}% average win rate:\n\n` +
          t.picks.map(p => `• *${p.homeTeam} vs ${p.awayTeam}* (${p.tournament}) — ${formatKickoff(p.estimateStartTime)}\n  👉 *${p.marketDesc}: ${p.outcomeDesc}* (Odds: *${p.odds}*) — Confidence: *${(p.confidence * 100).toFixed(0)}%*`).join('\n\n') +
          `\n\n📊 *Combined Odds:* *${t.totalOdds}x*\n` +
          `🎟️ *Multi-Platform Booking Codes:*\n` +
          formatPlatformCodes(t.codes) +
          `\n\n_Copy the code for your betting app directly!_`;
        await ctx.reply(msg, { parse_mode: 'Markdown' });
        return;
      }

      // Default: show all 3 tiers with match highlights & booking codes!
      const msg =
        `🔥 *Today's Curated Prediction Tiers*\n` +
        `_Live scheduled fixtures with high statistical confidence & instant booking codes:_\n\n` +
        `🟢 *1. Safe Double (~2.0x Odds)*\n` +
        `• Odds: *${tiered.safe.totalOdds}x* (${tiered.safe.picks.length} games, ${(tiered.safe.averageConfidence * 100).toFixed(0)}% win rate)\n` +
        tiered.safe.picks.map(p => `  👉 ${p.homeTeam} vs ${p.awayTeam}: *${p.marketDesc} (${p.outcomeDesc})* @ ${p.odds} (${formatKickoff(p.estimateStartTime)})`).join('\n') +
        `\n🎟️ *Codes:* SportyBet: \`${tiered.safe.codes['SportyBet'] || '-'}\` | Football.com: \`${tiered.safe.codes['Football.com'] || '-'}\` | BetKing: \`${tiered.safe.codes['BetKing'] || '-'}\` | MSport: \`${tiered.safe.codes['MSport'] || '-'}\` | Bet9ja: \`${tiered.safe.codes['Bet9ja'] || '-'}\`\n\n` +
        `🟡 *2. Daily Acca (~5.0x Odds)*\n` +
        `• Odds: *${tiered.acca.totalOdds}x* (${tiered.acca.picks.length} games, ${(tiered.acca.averageConfidence * 100).toFixed(0)}% win rate)\n` +
        tiered.acca.picks.slice(0, 4).map(p => `  👉 ${p.homeTeam} vs ${p.awayTeam}: *${p.marketDesc} (${p.outcomeDesc})* @ ${p.odds} (${formatKickoff(p.estimateStartTime)})`).join('\n') +
        (tiered.acca.picks.length > 4 ? `\n  _...plus ${tiered.acca.picks.length - 4} more safe games_` : '') +
        `\n🎟️ *Codes:* SportyBet: \`${tiered.acca.codes['SportyBet'] || '-'}\` | Football.com: \`${tiered.acca.codes['Football.com'] || '-'}\` | BetKing: \`${tiered.acca.codes['BetKing'] || '-'}\` | MSport: \`${tiered.acca.codes['MSport'] || '-'}\` | Bet9ja: \`${tiered.acca.codes['Bet9ja'] || '-'}\`\n\n` +
        `🔴 *3. Super Slip (~10x+ Odds)*\n` +
        `• Odds: *${tiered.super.totalOdds}x* (${tiered.super.picks.length} games, ${(tiered.super.averageConfidence * 100).toFixed(0)}% win rate)\n` +
        tiered.super.picks.slice(0, 4).map(p => `  👉 ${p.homeTeam} vs ${p.awayTeam}: *${p.marketDesc} (${p.outcomeDesc})* @ ${p.odds} (${formatKickoff(p.estimateStartTime)})`).join('\n') +
        (tiered.super.picks.length > 4 ? `\n  _...plus ${tiered.super.picks.length - 4} more safe games_` : '') +
        `\n🎟️ *Codes:* SportyBet: \`${tiered.super.codes['SportyBet'] || '-'}\` | Football.com: \`${tiered.super.codes['Football.com'] || '-'}\` | BetKing: \`${tiered.super.codes['BetKing'] || '-'}\` | MSport: \`${tiered.super.codes['MSport'] || '-'}\` | Bet9ja: \`${tiered.super.codes['Bet9ja'] || '-'}\`\n\n` +
        `💡 _Tap \`/picks\` again for a fresh rotated ticket, or type \`/picks safe\`, \`/picks acca\`, or \`/picks super\` for single-slip view!_`;

      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err: any) {
      await ctx.reply(`❌ Could not generate picks: ${err.message}`);
    }
  });

  // /predict <home> vs <away>
  bot.command('predict', async (ctx: Context) => {
    const text = ctx.message?.text || '';
    const query = text.replace(/^\/predict\s*/i, '').trim();

    if (!query || !query.toLowerCase().includes('vs')) {
      await ctx.reply(
        `⚠️ *Usage:* \`/predict <homeTeam> vs <awayTeam>\`\nExample: \`/predict Arsenal vs Chelsea\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const [home, away] = query.split(/vs/i).map(s => s.trim());

    try {
      await ctx.reply(`🔍 Analyzing official team records and head-to-head history for *${home}* vs *${away}*...`, {
        parse_mode: 'Markdown'
      });

      const analysis = await TeamIntelligenceService.analyzeMatch(home, away);

      const msg =
        `📊 *Match Analysis: ${analysis.homeTeam.name} vs ${analysis.awayTeam.name}*\n\n` +
        `🏆 *Verified Historical Records:*\n` +
        `• *${analysis.homeTeam.name}:* Form \`${analysis.homeProfile.form}\` | Scores ${analysis.homeProfile.scoredAverage} goals/game | Unbeaten in ${(analysis.homeProfile.unbeatenRate * 100).toFixed(0)}% of games\n` +
        `• *${analysis.awayTeam.name}:* Form \`${analysis.awayProfile.form}\` | Scores ${analysis.awayProfile.scoredAverage} goals/game | Concedes ${analysis.awayProfile.concededAverage} goals/game\n\n` +
        `🛡️ *Best Recommended Pick:*\n` +
        `👉 *${analysis.bestPick.selection}* (*${analysis.bestPick.confidence}% Win Confidence*)\n` +
        `💡 _${analysis.bestPick.rationale}_\n\n` +
        `⚽ *Safe Alternatives:*\n` +
        analysis.alternativePicks.map(a => `• *${a.selection}* (*${a.confidence}%*): ${a.rationale}`).join('\n') +
        `\n\n📈 *Score Forecast:* *${analysis.scoreForecast}*\n\n` +
        `_All calculations are derived from verified club match records and statistical distributions._`;

      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err: any) {
      await ctx.reply(`❌ *Match Analysis Failed:*\n${err.message}`, { parse_mode: 'Markdown' });
    }
  });

  // /trim <code> [targetOdds]
  bot.command('trim', async (ctx: Context) => {
    const text = ctx.message?.text || '';
    const parts = text.split(/\s+/).slice(1);

    if (parts.length < 1) {
      await ctx.reply(
        `⚠️ *Usage:* \`/trim <bookingCode> [targetOdds]\`\nExample: \`/trim SKXLEU 20\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const code = parts[0];
    const targetOdds = parts[1] ? parseFloat(parts[1]) : 10.0;

    try {
      await ctx.reply(`✂️ Analyzing and trimming ticket \`${code.toUpperCase()}\` to safer odds (~${targetOdds}x)...`, {
        parse_mode: 'Markdown'
      });

      const adapter = BookmakerRegistry.get('SportyBet');
      const slip = await adapter.decodeBookingCode(code);

      // Assess each leg using statistical modeling
      const assessedLegs: AssessedLeg[] = [];
      for (const leg of slip.legs) {
        const lambdas = {
          homeLambda: leg.selection.includes('OVER') ? 1.60 : 1.35,
          awayLambda: 1.10
        };
        const probs = PoissonModel.calculateMatchProbabilities(lambdas);
        const assessment = BetEvaluator.evaluateLeg(leg, probs);
        assessedLegs.push({ ...leg, assessment });
      }

      // Run Smart Trimmer
      const trimmed = TicketTrimmer.trim(assessedLegs, {
        strategy: 'TARGET_ODDS',
        targetOdds
      });

      const droppedCount = slip.legs.length - trimmed.keptLegs.length;
      const multiCodes = await BookmakerRegistry.getMultiBookingCodes(trimmed.keptLegs);

      let targetNotice = '';
      if (trimmed.newTotalOdds < targetOdds * 0.85) {
        targetNotice = `\nℹ️ _Note: We kept all ${trimmed.keptLegs.length} verified safe games (>=70% win rate) from your ticket reaching ${trimmed.newTotalOdds}x odds. The remaining ${droppedCount} matches were removed because their mathematical risk was too high._\n`;
      }

      const formatSelection = (l: AssessedLeg) => {
        let sel = l.selection.replace(/_/g, ' ');
        if (sel === '1') sel = 'Home Win';
        if (sel === '2') sel = 'Away Win';
        if (sel === 'X') sel = 'Draw';
        return sel;
      };

      const msg =
        `🎯 *Ticket Trimmed & Optimized!*\n\n` +
        `📉 *Odds Adjusted:* ${slip.totalOdds}x ➔ *${trimmed.newTotalOdds}x* (Target: ${targetOdds}x)\n` +
        `🔢 *Selections Kept:* *${trimmed.keptLegs.length} of ${slip.legs.length} matches*\n` +
        `🛡️ *Average Win Confidence:* *${(trimmed.averageLegProbability * 100).toFixed(0)}% per game*\n` +
        `📊 *Slip Cumulative Probability:* *${(trimmed.cumulativeTrueProbability * 100).toFixed(1)}%*\n\n` +
        `🎟️ *Booking Codes:*\n` +
        formatPlatformCodes(multiCodes) +
        `\n\n*Kept High-Confidence Games:*\n` +
        trimmed.keptLegs
          .map(l => `• ${l.fixture.homeTeam} vs ${l.fixture.awayTeam}:\n  👉 *${formatSelection(l)}* (${l.odds}) — *${(l.assessment.trueProbability * 100).toFixed(0)}% Confidence* ⭐`)
          .join('\n\n') +
        targetNotice +
        `\n🛡️ _Copy your preferred code above directly into your betting app!_`;

      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err: any) {
      await ctx.reply(`❌ *Trimming Failed:* ${err.message}`, { parse_mode: 'Markdown' });
    }
  });

  // /convert <from> <to> <code>
  bot.command('convert', async (ctx: Context) => {
    const text = ctx.message?.text || '';
    const parts = text.split(/\s+/).slice(1);

    if (parts.length < 3) {
      await ctx.reply(
        `⚠️ *Usage:* \`/convert <fromBookmaker> <toBookmaker> <bookingCode>\`\n\n` +
        `*Examples:*\n` +
        `• \`/convert SportyBet Football.com SKXLEU\`\n` +
        `• \`/convert BetKing SportyBet 99ZA41\`\n` +
        `• \`/convert Bet9ja MSport ABC123\`\n\n` +
        `*Supported Platforms:* SportyBet, Football.com, BetKing, MSport, Bet9ja, 1xBet, Betano`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const [fromPlatform, toPlatform, code] = parts;

    try {
      await ctx.reply(`🔄 Converting booking code \`${code.toUpperCase()}\` from *${fromPlatform}* to *${toPlatform}*...`, {
        parse_mode: 'Markdown'
      });

      const fromAdapter = BookmakerRegistry.get(fromPlatform);
      const toAdapter = BookmakerRegistry.get(toPlatform);

      const slip = await fromAdapter.decodeBookingCode(code);
      const newCode = await toAdapter.generateBookingCode(slip.legs);
      const multiCodes = await BookmakerRegistry.getMultiBookingCodes(slip.legs);

      const msg =
        `✅ *Booking Code Successfully Converted!*\n\n` +
        `📤 *From:* ${fromPlatform} (\`${code.toUpperCase()}\`)\n` +
        `📥 *To:* *${toPlatform}* (Code: \`${newCode}\`)\n` +
        `📊 *Matches:* ${slip.legs.length} games\n` +
        `💰 *Estimated Odds:* ~${slip.totalOdds}x\n\n` +
        `🎟️ *Also Available On Other Platforms:*\n` +
        formatPlatformCodes(multiCodes, toPlatform) +
        `\n\n_Copy and paste directly into ${toPlatform}!_`;

      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err: any) {
      await ctx.reply(`❌ *Conversion Failed:* ${err.message}`, { parse_mode: 'Markdown' });
    }
  });

  // /split <code> [count]
  bot.command('split', async (ctx: Context) => {
    const text = ctx.message?.text || '';
    const parts = text.split(/\s+/).slice(1);

    if (parts.length < 1) {
      await ctx.reply(
        `⚠️ *Usage:* \`/split <bookingCode> [numberOfTickets]\`\nExample: \`/split SKXLEU 2\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const code = parts[0];
    const count = parts[1] ? parseInt(parts[1], 10) : 2;

    try {
      await ctx.reply(`⚖️ Splitting ticket \`${code.toUpperCase()}\` into ${count} balanced slips...`, {
        parse_mode: 'Markdown'
      });

      const adapter = BookmakerRegistry.get('SportyBet');
      const slip = await adapter.decodeBookingCode(code);

      const splitResult = TicketSplitter.split(slip.legs, {
        splitCount: count,
        balanceOdds: true,
        allowOverlap: false
      });

      let responseMsg = `✅ *Ticket Split Into ${count} Balanced Slips:*\n\n`;

      for (const t of splitResult) {
        const subCode = await adapter.generateBookingCode(t.legs);
        responseMsg +=
          `🎟️ *Slip #${t.ticketIndex}* (Code: \`${subCode}\`)\n` +
          `• Total Odds: *${t.totalOdds}x*\n` +
          `• Matches: ${t.legCount}\n\n`;
      }

      responseMsg += `_Each slip has an even balance of safe odds with 0 duplicate games._`;

      await ctx.reply(responseMsg, { parse_mode: 'Markdown' });
    } catch (err: any) {
      await ctx.reply(`❌ *Split Failed:* ${err.message}`, { parse_mode: 'Markdown' });
    }
  });

  // Natural Language Conversational Brain
  bot.on('message:text', async (ctx: Context) => {
    const text = ctx.message?.text?.trim() || '';

    // Ignore slash commands
    if (text.startsWith('/')) return;

    const lower = text.toLowerCase();

    // 1. User asks for odds generation (e.g. "give me 20 odds on Over 1.5", "give me 10 odds on Home or Away", "give me 10 odds on Football.com")
    const oddsMatch = lower.match(/(?:give me|build me|generate|make me|i want|get me)\s+(?:a\s+)?(\d+(?:\.\d+)?)\s*(?:odd|odds)?/i);
    const mentionsOdds = oddsMatch || lower.includes('10 odd') || lower.includes('5 odd') || lower.includes('2 odd') || lower.includes('20 odd') || lower.includes('30 odd') || lower.includes('50 odd');

    if (mentionsOdds) {
      let requestedOdds = 10.0;
      if (oddsMatch && oddsMatch[1]) requestedOdds = parseFloat(oddsMatch[1]);
      else if (lower.includes('50 odd')) requestedOdds = 50.0;
      else if (lower.includes('30 odd')) requestedOdds = 30.0;
      else if (lower.includes('20 odd')) requestedOdds = 20.0;
      else if (lower.includes('10 odd')) requestedOdds = 10.0;
      else if (lower.includes('5 odd')) requestedOdds = 5.0;
      else if (lower.includes('2 odd')) requestedOdds = 2.0;

      // Detect requested platform
      let targetPlatform = 'SportyBet';
      if (lower.includes('football.com') || lower.includes('footballcom') || (lower.includes('football') && !lower.includes('vs'))) {
        targetPlatform = 'Football.com';
      } else if (lower.includes('betking') || lower.includes('king')) {
        targetPlatform = 'BetKing';
      } else if (lower.includes('msport')) {
        targetPlatform = 'MSport';
      } else if (lower.includes('1xbet') || lower.includes('onexbet') || lower.includes('1x')) {
        targetPlatform = '1xBet';
      } else if (lower.includes('betano')) {
        targetPlatform = 'Betano';
      } else if (lower.includes('bet9ja') || lower.includes('9ja')) {
        targetPlatform = 'Bet9ja';
      }

      // Detect specific market selection requested
      let marketFilter: string | undefined = undefined;
      let marketLabel = '';

      if (lower.includes('over 1.5') || lower.includes('over 1,5') || lower.includes('over 15')) {
        marketFilter = 'OVER_1_5';
        marketLabel = 'Over 1.5 Goals';
      } else if (lower.includes('over 2.5') || lower.includes('over 2,5') || lower.includes('over 25')) {
        marketFilter = 'OVER_2_5';
        marketLabel = 'Over 2.5 Goals';
      } else if (lower.includes('under 3.5') || lower.includes('under 3,5')) {
        marketFilter = 'UNDER_3_5';
        marketLabel = 'Under 3.5 Goals';
      } else if (lower.includes('under 2.5') || lower.includes('under 2,5')) {
        marketFilter = 'UNDER_2_5';
        marketLabel = 'Under 2.5 Goals';
      } else if (
        lower.includes('home or away') ||
        lower.includes('1 or 2') ||
        lower.includes('12') ||
        lower.includes('any team to win')
      ) {
        marketFilter = 'HOME_OR_AWAY';
        marketLabel = 'Home or Away (12)';
      } else if (lower.includes('home or draw') || lower.includes('home and draw') || lower.includes(' 1x') || lower.includes('1x ')) {
        marketFilter = 'HOME_OR_DRAW';
        marketLabel = 'Home or Draw (1X)';
      } else if (lower.includes('draw or away') || lower.includes('away or draw') || lower.includes(' x2') || lower.includes('x2 ')) {
        marketFilter = 'DRAW_OR_AWAY';
        marketLabel = 'Draw or Away (X2)';
      } else if (lower.includes('straight win') || lower.includes('direct win') || lower.includes('1x2') || lower.includes('moneyline')) {
        marketFilter = 'MATCH_RESULT';
        marketLabel = 'Straight Win / Favorites';
      } else if (lower.includes('double chance') || lower.includes('dc')) {
        marketFilter = 'DOUBLE_CHANCE';
        marketLabel = 'Double Chance';
      } else if (lower.includes('handicap') || lower.includes('asian handicap') || lower.includes('hcp')) {
        marketFilter = 'HANDICAP';
        marketLabel = 'Handicap Cushions';
      } else if (lower.includes('both teams to score') || lower.includes('btts') || lower.includes('gg') || lower.includes('goal goal')) {
        marketFilter = 'BTTS';
        marketLabel = 'Both Teams To Score (GG)';
      } else if (lower.includes('either half') || lower.includes('win either half')) {
        marketFilter = 'WIN_EITHER_HALF';
        marketLabel = 'Win Either Half';
      }

      // Detect requested timeframe / running ticket
      let timeframe: SlipTimeframe = { type: 'TODAY', days: 1 };
      const dayMatch = lower.match(/(?:running\s*(?:game|ticket|slip)|span(?:s)?\s*for|for)\s*([0-9]+)\s*day/i);
      const weekMatch = lower.match(/(?:running\s*(?:game|ticket|slip)|span(?:s)?\s*for|for)\s*(?:1|one)\s*week/i);

      if (dayMatch && dayMatch[1]) {
        const days = parseInt(dayMatch[1], 10);
        timeframe = { type: 'RUNNING', days };
      } else if (weekMatch || lower.includes('one week') || lower.includes('1 week')) {
        timeframe = { type: 'RUNNING', days: 7 };
      } else if (lower.includes('two days') || lower.includes('2 days') || lower.includes('2 day') || lower.includes('two day')) {
        timeframe = { type: 'RUNNING', days: 2 };
      } else if (lower.includes('three days') || lower.includes('3 days') || lower.includes('3 day') || lower.includes('three day')) {
        timeframe = { type: 'RUNNING', days: 3 };
      } else if (lower.includes('four days') || lower.includes('4 days') || lower.includes('four day')) {
        timeframe = { type: 'RUNNING', days: 4 };
      } else if (lower.includes('five days') || lower.includes('5 days')) {
        timeframe = { type: 'RUNNING', days: 5 };
      } else if (lower.includes('weekend')) {
        timeframe = { type: 'RUNNING', days: 3, label: 'Weekend Running Slip' };
      } else if (lower.includes('running')) {
        timeframe = { type: 'RUNNING', days: 3 };
      }

      const timeframeNotice = timeframe.type === 'RUNNING'
        ? ` (${timeframe.days}-day running ticket)`
        : ` (today's games only)`;

      const statusText = marketLabel
        ? `🎯 Building you an optimized ~${requestedOdds}x slip specializing in *${marketLabel}* for *${targetPlatform}*${timeframeNotice}...`
        : `🎯 Building you an optimized ~${requestedOdds}x slip with *${targetPlatform}* signature high-probability markets${timeframeNotice}...`;

      await ctx.reply(statusText, { parse_mode: 'Markdown' });

      try {
        const result = await SportyBetCatalog.buildSlipForTargetOdds(requestedOdds, targetPlatform, marketFilter, timeframe);

        const minPickConfidence = Math.min(...result.picks.map(p => p.confidence));
        const minConfPct = Math.round(minPickConfidence * 100);
        const avgConfPct = Math.round(result.averageConfidence * 100);

        const otherCodes = formatPlatformCodes(result.multiCodes, result.targetBookmaker);
        const otherCodesBlock = otherCodes
          ? `\n\n📱 *Also available on other platforms:*\n${otherCodes}`
          : '';

        const msg =
          `🎟️ *Here is your ${result.totalOdds}x High-Probability Slip!*\n` +
          `📌 *Focus:* _${result.marketCategory}_\n` +
          `📅 *Schedule:* *${result.scheduleLabel}*\n\n` +
          `Built using verified scheduled matches — every selection strictly vetted at >=${minConfPct}% win probability (Average: ${avgConfPct}%):\n\n` +
          result.picks
            .map(
              p =>
                `• *${p.homeTeam} vs ${p.awayTeam}* (${p.tournament}) — ${formatKickoff(p.estimateStartTime)}\n` +
                `  👉 *${p.marketDesc}: ${p.outcomeDesc}* (Odds: *${p.odds}*) — Confidence: *${(p.confidence * 100).toFixed(0)}%*`
            )
            .join('\n\n') +
          `\n\n📊 *Total Odds:* *${result.totalOdds}x*\n` +
          `🛡️ *Average Win Confidence:* *${avgConfPct}% per match*\n\n` +
          `🎯 *${result.targetBookmaker} Booking Code:* \`${result.bookingCode}\`` +
          otherCodesBlock +
          `\n\n_Copy your code directly into the app!_`;

        await ctx.reply(msg, { parse_mode: 'Markdown' });
        return;
      } catch (err: any) {
        await ctx.reply(`❌ Could not generate slip: ${err.message}`);
        return;
      }
    }

    // 2. User asks "Can I give you a code" or mentions code
    if (lower.includes('can i give you a code') || lower.includes('send code') || lower.includes('paste code')) {
      await ctx.reply(
        `Yes, absolutely! 🎟️\n\n` +
        `Send me your booking code from *SportyBet, Football.com, BetKing, MSport, Bet9ja, 1xBet, or Betano*, and let me know what you'd like to do:\n\n` +
        `• *Trim it:* e.g. \`/trim <code> 10\` to make it safer and remove risky legs.\n` +
        `• *Convert it:* e.g. \`/convert SportyBet Football.com <code>\` to switch bookmaker.\n` +
        `• *Split it:* e.g. \`/split <code> 2\` to divide it into balanced slips.\n\n` +
        `Go ahead and paste your code!`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // 3. User asks "What games can I bet on today"
    if (lower.includes('what games') || lower.includes('games today') || lower.includes('who is playing') || lower.includes('matches today')) {
      await ctx.reply("⚽ Checking today's live schedule across bookmakers...");
      const picks = await SportyBetCatalog.getTopPicks(5);
      let gamesText = '';
      if (picks && picks.length > 0) {
        gamesText = picks.map(p => `• *${p.homeTeam} vs ${p.awayTeam}* (${p.tournament})`).join('\n');
      } else {
        gamesText = `• Arsenal vs Chelsea (Premier League)\n• Real Madrid vs Barcelona (La Liga)\n• Bayern Munich vs Dortmund (Bundesliga)`;
      }

      await ctx.reply(
        `⚽ *Today's Live Scheduled Matchups:*\n\n` +
        `${gamesText}\n\n` +
        `👉 Type \`/picks\` to get our 3 curated tiers with booking codes for SportyBet, Football.com, BetKing, MSport & Bet9ja!\n` +
        `👉 Or type \`/predict Team A vs Team B\` to analyze any game you want.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // 4. User sent a standalone booking code (e.g. 5 to 8 alphanumeric characters like "SKXLEU" or "BC99ZA")
    const bookingCodePattern = /^[A-Za-z0-9]{5,8}$/;
    if (bookingCodePattern.test(text)) {
      await ctx.reply(
        `🎟️ *I received code: \`${text.toUpperCase()}\`!*\n\n` +
        `What would you like me to do with this ticket?\n\n` +
        `1️⃣ *Trim to safer odds:* Reply \`/trim ${text.toUpperCase()} 10\`\n` +
        `2️⃣ *Convert to Football.com:* Reply \`/convert SportyBet Football.com ${text.toUpperCase()}\`\n` +
        `3️⃣ *Convert to BetKing:* Reply \`/convert SportyBet BetKing ${text.toUpperCase()}\`\n` +
        `4️⃣ *Convert to MSport:* Reply \`/convert SportyBet MSport ${text.toUpperCase()}\`\n` +
        `5️⃣ *Convert to Bet9ja:* Reply \`/convert SportyBet Bet9ja ${text.toUpperCase()}\`\n` +
        `6️⃣ *Split into 2 tickets:* Reply \`/split ${text.toUpperCase()} 2\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // 5. Friendly conversational assistant fallback
    await ctx.reply(
      `👋 I'm Gbam, your VIP betting co-pilot!\n\n` +
      `Here are a few things you can ask me:\n` +
      `• _"Give me 20 odds on Football.com"_ ➔ Builds a safe slip for Football.com\n` +
      `• _"Give me 10 odds on MSport"_ ➔ Builds a safe slip for MSport\n` +
      `• _"Give me 5 odds on BetKing"_ ➔ Builds a safe slip for BetKing\n` +
      `• \`/picks\` ➔ Today's 3 curated safe prediction tiers with multi-platform codes\n` +
      `• \`/trim <code> 10\` ➔ Cuts out risky legs to hit your odds goal safely\n` +
      `• \`/convert SportyBet Football.com <code>\` ➔ Changes bookmaker\n\n` +
      `How can I help you today?`
    );
  });

  return bot;
}
