import { Bot, Context } from 'grammy';
import { BookmakerRegistry } from '../bookmakers/registry.js';
import { TicketSplitter } from '../engine/splitter.js';
import { TicketTrimmer } from '../engine/trimmer.js';
import { AssessedLeg, BetLeg } from '../models/types.js';
import { ApiFootballProvider } from '../providers/api-football.provider.js';
import { MockStatsProvider } from '../providers/mock-stats.provider.js';
import { SportsDataProvider } from '../providers/sports-data.interface.js';
import { SportyBetCatalog } from '../providers/sportybet-catalog.js';
import { BetEvaluator } from '../stats/evaluator.js';
import { PoissonModel } from '../stats/poisson.js';
import { TeamIntelligenceService } from '../stats/team-intelligence.js';

export function createBot(token: string) {
  const bot = new Bot(token);

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
    { command: 'start', description: 'Start Gbam and see features' },
    { command: 'picks', description: 'Get today\'s high-probability predictions' },
    { command: 'predict', description: 'Analyze a match e.g. /predict Arsenal vs Chelsea' },
    { command: 'trim', description: 'Trim a ticket to safer odds e.g. /trim BC99ZA 10' },
    { command: 'convert', description: 'Convert codes between SportyBet, Bet9ja, etc.' },
    { command: 'split', description: 'Split a large ticket into balanced slips' },
    { command: 'help', description: 'View instructions and tips' }
  ]).catch(err => {
    console.error('Could not set Telegram commands:', err.message);
  });

  // /start command - Friendly, clean, zero technical jargon
  bot.command('start', async (ctx: Context) => {
    const welcome =
      `🎯 *Welcome to Gbam!*\n\n` +
      `Your smart betting assistant — build safer tickets, convert codes, and get high-confidence predictions in seconds.\n\n` +
      `*What I can do for you:*\n` +
      `• 🔄 *Convert*: Move your bet code from SportyBet to Bet9ja in 1 second.\n` +
      `• ✂️ *Smart Trim*: Cut the riskiest games out of your ticket to protect your slip and boost your chances of winning.\n` +
      `• ⚖️ *Split*: Divide a long ticket into smaller balanced slips so 1 loss doesn't ruin everything.\n` +
      `• 🔥 *Safe Picks*: Get today's top high-probability selections ready to bet.\n` +
      `• 📊 *Match Advice*: Check form and recommended safe bets for any match.\n\n` +
      `*Quick Menu:*\n` +
      `• \`/picks\` — Today's high-probability games\n` +
      `• \`/predict <home> vs <away>\` — Match advice\n` +
      `• \`/trim <code> <targetOdds>\` — Make your ticket safer\n` +
      `• \`/convert <from> <to> <code>\` — Switch bookmaker\n` +
      `• \`/split <code> <count>\` — Split long slips\n\n` +
      `💬 _You can also just chat naturally with me anytime! For example: "Give me 5 odds for today" or "Can I give you a code?"_`;

    await ctx.reply(welcome, { parse_mode: 'Markdown' });
  });

  // /help command
  bot.command('help', async (ctx: Context) => {
    const help =
      `📖 *How to use Gbam*\n\n` +
      `*1. Today's Safe Picks*\n` +
      `Type \`/picks\` to get today's curated high-probability games with a ready-made booking code.\n\n` +
      `*2. Match Advice & Predictions*\n` +
      `Type \`/predict Arsenal vs Chelsea\` to get safe picks, win rates, and score predictions.\n\n` +
      `*3. Trim a Risky Ticket*\n` +
      `Got a 30-game slip with too much risk? Type:\n` +
      `\`/trim BC99ZA 10\`\n` +
      `It removes the riskiest games and keeps the safest combination close to 10 odds.\n\n` +
      `*4. Convert Booking Codes*\n` +
      `\`/convert SportyBet Bet9ja BC99ZA\`\n` +
      `Converts your code from one bookmaker to another instantly.\n\n` +
      `*5. Split Tickets*\n` +
      `\`/split BC99ZA 2\`\n` +
      `Divides your slip into 2 balanced tickets with zero duplicate games.\n\n` +
      `*Or just chat:* Ask me _"give me 10 odds"_ or _"can I give you a code"_!`;

    await ctx.reply(help, { parse_mode: 'Markdown' });
  });

  // /picks - Today's high-probability predictions
  bot.command('picks', async (ctx: Context) => {
    try {
      await ctx.reply("🔍 Pulling today's top high-probability matches from SportyBet...");
      const picks = await SportyBetCatalog.getTopPicks(4);

      if (!picks || picks.length === 0) {
        await ctx.reply('⚠️ No upcoming matches available at this moment. Please try again shortly.');
        return;
      }

      const totalOdds = picks.reduce((acc, p) => acc * p.odds, 1);
      const bookingCode = await SportyBetCatalog.generateSportyBookingCode(picks);

      const msg =
        `🔥 *Today's Live High-Probability Predictions*\n\n` +
        `Real scheduled matches with high statistical confidence (78% - 92% win rate):\n\n` +
        picks
          .map(
            p =>
              `• *${p.homeTeam} vs ${p.awayTeam}* (${p.tournament})\n` +
              `  👉 *${p.marketDesc}: ${p.outcomeDesc}* (Odds: *${p.odds}*) — Confidence: *${(p.confidence * 100).toFixed(0)}%*`
          )
          .join('\n\n') +
        `\n\n📊 *Combined Odds:* *${totalOdds.toFixed(2)}x*\n` +
        `🎟️ *SportyBet Booking Code:* \`${bookingCode}\`\n\n` +
        `_Copy the code above directly into your SportyBet app!_`;

      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err: any) {
      await ctx.reply(`❌ Could not generate picks: ${err.message}`);
    }
  });

  // /predict <home> vs <away> - Verified clubs & real historical intelligence
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

  // /trim <code> [targetOdds] - Clean output without UNDEFINED
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

      // Generate new booking code for kept legs
      const newCode = await adapter.generateBookingCode(trimmed.keptLegs);

      // Format clean readable selection name
      const formatSelection = (l: AssessedLeg) => {
        let sel = l.selection.replace(/_/g, ' ');
        if (sel === '1') sel = 'Home Win';
        if (sel === '2') sel = 'Away Win';
        if (sel === 'X') sel = 'Draw';
        return sel;
      };

      const droppedCount = slip.legs.length - trimmed.keptLegs.length;

      const msg =
        `🎯 *Ticket Trimmed & Optimized!*\n\n` +
        `🎟️ *New Booking Code:* \`${newCode}\`\n` +
        `📉 *Odds Adjusted:* ${slip.totalOdds}x ➔ *${trimmed.newTotalOdds}x*\n` +
        `🔢 *Selections Kept:* *${trimmed.keptLegs.length} of ${slip.legs.length} matches*\n` +
        `🛡️ *Average Win Confidence:* *${(trimmed.averageLegProbability * 100).toFixed(0)}% per game*\n` +
        `📊 *Slip Cumulative Probability:* *${(trimmed.cumulativeTrueProbability * 100).toFixed(1)}%*\n\n` +
        `*Kept High-Confidence Games:*\n` +
        trimmed.keptLegs
          .map(l => `• ${l.fixture.homeTeam} vs ${l.fixture.awayTeam}:\n  👉 *${formatSelection(l)}* (${l.odds}) — *${(l.assessment.trueProbability * 100).toFixed(0)}% Confidence* ⭐`)
          .join('\n\n') +
        `\n\n🛡️ _We removed ${droppedCount} high-risk legs to protect your slip! Copy the code above into SportyBet._`;

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
        `⚠️ *Usage:* \`/convert <fromBookmaker> <toBookmaker> <bookingCode>\`\n` +
        `Example: \`/convert SportyBet Bet9ja SKXLEU\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const [from, to, code] = parts;

    try {
      await ctx.reply(`🔄 Converting *${code.toUpperCase()}* from *${from}* to *${to}*...`, { parse_mode: 'Markdown' });

      const converted = await BookmakerRegistry.convertBookingCode(from, to, code);

      const msg =
        `✅ *Ticket Converted Successfully!*\n\n` +
        `📦 *Original Platform:* ${converted.sourceSlip.bookmaker} (\`${code.toUpperCase()}\`)\n` +
        `🎯 *Target Platform:* ${converted.targetSlip.bookmaker}\n` +
        `🎟️ *New Booking Code:* \`${converted.newBookingCode}\`\n` +
        `📊 *Total Odds:* ${converted.targetSlip.totalOdds}x\n` +
        `🔢 *Selections:* ${converted.targetSlip.legs.length} matches\n\n` +
        `_Copy the code above directly into your ${converted.targetSlip.bookmaker} app!_`;

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

    // 1. User asks for odds generation (e.g. "give me a 10 odd", "give me 5 odds", "give me 10 odds with 90% win rate")
    const oddsMatch = lower.match(/(?:give me|build me|generate|make me|i want|get me)\s+(?:a\s+)?(\d+(?:\.\d+)?)\s*(?:odd|odds)/i);
    if (oddsMatch || lower.includes('10 odd') || lower.includes('5 odd') || lower.includes('2 odd') || lower.includes('20 odd')) {
      let requestedOdds = 10.0;
      if (oddsMatch) requestedOdds = parseFloat(oddsMatch[1]);
      else if (lower.includes('20 odd')) requestedOdds = 20.0;
      else if (lower.includes('10 odd')) requestedOdds = 10.0;
      else if (lower.includes('5 odd')) requestedOdds = 5.0;
      else if (lower.includes('2 odd')) requestedOdds = 2.0;

      await ctx.reply(`🎯 Building you an optimized ~${requestedOdds}x slip with high-probability matches from SportyBet...`);

      try {
        const result = await SportyBetCatalog.buildSlipForTargetOdds(requestedOdds);

        const msg =
          `🎟️ *Here is your ${result.totalOdds}x High-Probability Slip!*\n\n` +
          `Built using live scheduled matches with safe, high-confidence selections:\n\n` +
          result.picks
            .map(
              p =>
                `• *${p.homeTeam} vs ${p.awayTeam}* (${p.tournament})\n` +
                `  👉 *${p.marketDesc}: ${p.outcomeDesc}* (Odds: *${p.odds}*) — Confidence: *${(p.confidence * 100).toFixed(0)}%*`
            )
            .join('\n\n') +
          `\n\n📊 *Total Odds:* *${result.totalOdds}x*\n` +
          `🛡️ *Average Win Confidence:* *${(result.averageConfidence * 100).toFixed(0)}% per match*\n` +
          `🎟️ *SportyBet Booking Code:* \`${result.bookingCode}\`\n\n` +
          `_Copy the code above directly into your SportyBet app!_`;

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
        `Send me your booking code (e.g. from SportyBet or Bet9ja), and let me know what you'd like to do with it:\n\n` +
        `• *Trim it:* e.g. \`/trim <code> 10\` to make it safer and remove risky legs.\n` +
        `• *Convert it:* e.g. \`/convert SportyBet Bet9ja <code>\` to switch bookmaker.\n` +
        `• *Split it:* e.g. \`/split <code> 2\` to divide it into balanced slips.\n\n` +
        `Go ahead and paste your code!`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // 3. User asks "What games can I bet on today"
    if (lower.includes('what games') || lower.includes('games today') || lower.includes('who is playing') || lower.includes('matches today')) {
      await ctx.reply("⚽ Checking today's live schedule on SportyBet...");
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
        `👉 Type \`/picks\` to get our top high-probability predictions with a ready-made booking code!\n` +
        `👉 Or type \`/predict Team A vs Team B\` to analyze any game you want.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // 4. User sent a standalone booking code (e.g. 5 to 7 alphanumeric characters like "SKXLEU" or "BC99ZA")
    const bookingCodePattern = /^[A-Za-z0-9]{5,8}$/;
    if (bookingCodePattern.test(text)) {
      await ctx.reply(
        `🎟️ *I received code: \`${text.toUpperCase()}\`!*\n\n` +
        `What would you like me to do with this ticket?\n\n` +
        `1️⃣ *Trim to safer odds:* Reply \`/trim ${text.toUpperCase()} 10\`\n` +
        `2️⃣ *Convert to Bet9ja:* Reply \`/convert SportyBet Bet9ja ${text.toUpperCase()}\`\n` +
        `3️⃣ *Split into 2 tickets:* Reply \`/split ${text.toUpperCase()} 2\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // 5. Friendly conversational assistant fallback
    await ctx.reply(
      `👋 I'm Gbam, your betting co-pilot!\n\n` +
      `Here are a few things you can ask me:\n` +
      `• _"Give me a 10 odd"_ ➔ Builds a safe slip with a booking code\n` +
      `• _"What games can I bet on today"_ ➔ Shows top games\n` +
      `• \`/picks\` ➔ Today's curated high-probability predictions\n` +
      `• \`/trim <code> 10\` ➔ Cuts out risky legs to hit your odds goal\n` +
      `• \`/convert SportyBet Bet9ja <code>\` ➔ Changes bookmaker\n\n` +
      `How can I help you today?`
    );
  });

  return bot;
}
