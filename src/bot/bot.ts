import { Bot, Context } from 'grammy';
import { BookmakerRegistry } from '../bookmakers/registry.js';
import { TicketEditor } from '../engine/editor.js';
import { TicketSplitter } from '../engine/splitter.js';
import { TicketTrimmer } from '../engine/trimmer.js';
import { AssessedLeg, BetLeg } from '../models/types.js';
import { MockStatsProvider } from '../providers/mock-stats.provider.js';
import { BetEvaluator } from '../stats/evaluator.js';
import { PoissonModel } from '../stats/poisson.js';

export function createBot(token: string) {
  const bot = new Bot(token);
  const statsProvider = new MockStatsProvider();

  // /start command
  bot.command('start', async (ctx: Context) => {
    const welcome =
      `🎯 *Welcome to Gbam AI!*\n\n` +
      `Your intelligent betting slip engine & mathematical odds optimizer.\n\n` +
      `*What I can do for you:*\n` +
      `🔄 *Convert*: Cross-convert booking codes between SportyBet, Bet9ja, etc.\n` +
      `✂️ *Smart Trim*: Knapsack optimization to prune low-value legs and maximize win probability.\n` +
      `⚖️ *Split*: Partition huge slips into balanced tickets with 0 duplicate games.\n` +
      `📊 *Predict*: Calculate true Poisson probability and Expected Value (+EV).\n` +
      `🛡️ *Safe Mode*: Downgrade high-risk picks to safety nets (e.g. Over 2.5 ➔ Over 1.5).\n\n` +
      `*Commands:*\n` +
      `• \`/convert <from> <to> <code>\` — e.g. \`/convert sportybet bet9ja BC99ZA\`\n` +
      `• \`/trim <code> [targetOdds]\` — e.g. \`/trim BC99ZA 10\`\n` +
      `• \`/split <code> [ticketCount]\` — e.g. \`/split BC99ZA 2\`\n` +
      `• \`/predict <home> vs <away>\` — e.g. \`/predict Arsenal vs Chelsea\`\n\n` +
      `You can also just type in natural chat, e.g. _"convert BC99ZA to Bet9ja"_ or _"trim BC99ZA to 10 odds"_!`;

    await ctx.reply(welcome, { parse_mode: 'Markdown' });
  });

  // /help command
  bot.command('help', async (ctx: Context) => {
    const help =
      `📖 *Gbam Commands Guide*\n\n` +
      `*1. Booking Code Conversion:*\n` +
      `\`/convert SportyBet Bet9ja BC99ZA\`\n` +
      `Supported: SportyBet, Bet9ja (more coming soon).\n\n` +
      `*2. Mathematical Trimming:*\n` +
      `\`/trim BC99ZA 10\` (Trims to ~10x total odds with maximum probability)\n` +
      `\`/trim BC99ZA 85%\` (Keeps only picks with $\\ge 85\\%$ true probability)\n\n` +
      `*3. Ticket Splitting:*\n` +
      `\`/split BC99ZA 3\` (Splits slip into 3 balanced tickets)\n\n` +
      `*4. Match Prediction & EV:*\n` +
      `\`/predict Real Madrid vs Barcelona\``;

    await ctx.reply(help, { parse_mode: 'Markdown' });
  });

  // /convert <from> <to> <code>
  bot.command('convert', async (ctx: Context) => {
    const text = ctx.message?.text || '';
    const parts = text.split(/\s+/).slice(1);

    if (parts.length < 3) {
      await ctx.reply(
        `⚠️ *Usage:* \`/convert <fromBookmaker> <toBookmaker> <bookingCode>\`\n` +
        `Example: \`/convert SportyBet Bet9ja BC99ZA\``,
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

  // /trim <code> [targetOdds]
  bot.command('trim', async (ctx: Context) => {
    const text = ctx.message?.text || '';
    const parts = text.split(/\s+/).slice(1);

    if (parts.length < 1) {
      await ctx.reply(
        `⚠️ *Usage:* \`/trim <bookingCode> [targetOdds]\`\nExample: \`/trim BC99ZA 10\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const code = parts[0];
    const targetOdds = parts[1] ? parseFloat(parts[1]) : 10.0;

    try {
      await ctx.reply(`✂️ Analyzing and trimming ticket \`${code.toUpperCase()}\` to ~${targetOdds}x odds...`, {
        parse_mode: 'Markdown'
      });

      const adapter = BookmakerRegistry.get('SportyBet');
      const slip = await adapter.decodeBookingCode(code);

      // Assess each leg using statistical modeling
      const assessedLegs: AssessedLeg[] = [];
      for (const leg of slip.legs) {
        const lambdas = await statsProvider.getFixtureLambdas(leg.fixture);
        const probs = PoissonModel.calculateMatchProbabilities(lambdas);
        const assessment = BetEvaluator.evaluateLeg(leg, probs);
        assessedLegs.push({ ...leg, assessment });
      }

      // Run Knapsack Smart Trimmer
      const trimmed = TicketTrimmer.trim(assessedLegs, {
        strategy: 'TARGET_ODDS',
        targetOdds
      });

      // Generate new booking code for kept legs
      const newCode = await adapter.generateBookingCode(trimmed.keptLegs);

      const msg =
        `🎯 *Ticket Trimmed & Optimized!*\n\n` +
        `🎟️ *New Booking Code:* \`${newCode}\`\n` +
        `📉 *Odds:* ${slip.totalOdds}x ➔ *${trimmed.newTotalOdds}x*\n` +
        `🔢 *Legs Kept:* ${trimmed.keptLegs.length} of ${slip.legs.length}\n` +
        `📈 *Avg Leg Probability:* ${(trimmed.averageLegProbability * 100).toFixed(1)}%\n` +
        `💎 *Slip Win Probability:* ${(trimmed.cumulativeTrueProbability * 100).toFixed(2)}%\n\n` +
        `*Kept Selections:*\n` +
        trimmed.keptLegs.map(l => `• ${l.fixture.homeTeam} vs ${l.fixture.awayTeam}: *${l.selection}* (${l.odds}) [Grade: ${l.assessment.confidenceGrade}]`).join('\n') +
        `\n\n_Generated via Gbam Optimization Engine_`;

      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err: any) {
      await ctx.reply(`❌ *Trimming Failed:* ${err.message}`, { parse_mode: 'Markdown' });
    }
  });

  // /split <code> [count]
  bot.command('split', async (ctx: Context) => {
    const text = ctx.message?.text || '';
    const parts = text.split(/\s+/).slice(1);

    if (parts.length < 1) {
      await ctx.reply(
        `⚠️ *Usage:* \`/split <bookingCode> [numberOfTickets]\`\nExample: \`/split BC99ZA 2\``,
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
          `• Games: ${t.legCount}\n\n`;
      }

      responseMsg += `_All slips drafted using serpentine odds balancing with zero match overlap._`;

      await ctx.reply(responseMsg, { parse_mode: 'Markdown' });
    } catch (err: any) {
      await ctx.reply(`❌ *Split Failed:* ${err.message}`, { parse_mode: 'Markdown' });
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
      const fixture = {
        id: `pred-${Date.now()}`,
        sport: 'FOOTBALL' as const,
        homeTeam: home,
        awayTeam: away,
        league: 'General',
        kickoffTime: new Date().toISOString(),
        status: 'SCHEDULED' as const
      };

      const lambdas = await statsProvider.getFixtureLambdas(fixture);
      const probs = PoissonModel.calculateMatchProbabilities(lambdas);

      const msg =
        `📊 *Match Analysis & Poisson Simulation*\n` +
        `🏟️ *${home}* vs *${away}*\n\n` +
        `*1X2 Probabilities:*\n` +
        `• 🏠 ${home} Win: *${(probs.homeWin * 100).toFixed(1)}%*\n` +
        `• 🤝 Draw: *${(probs.draw * 100).toFixed(1)}%*\n` +
        `• ✈️ ${away} Win: *${(probs.awayWin * 100).toFixed(1)}%*\n\n` +
        `*High-Confidence Safety Markets:*\n` +
        `• 🛡️ Over 0.5 Match Goals: *${(probs.over0_5 * 100).toFixed(1)}%*\n` +
        `• 🛡️ Over 1.5 Match Goals: *${(probs.over1_5 * 100).toFixed(1)}%*\n` +
        `• 🛡️ Double Chance 1X: *${(probs.dc1X * 100).toFixed(1)}%*\n` +
        `• 🛡️ BTTS (Goal/Goal): *${(probs.bttsYes * 100).toFixed(1)}%*\n\n` +
        `🎯 *Model Goal Expectancy:* ${home} (${lambdas.homeLambda}) - ${away} (${lambdas.awayLambda})\n` +
        `⭐ *Top Exact Scoreline:* ${probs.topScores[0].home}-${probs.topScores[0].away} (${(probs.topScores[0].probability * 100).toFixed(1)}%)`;

      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err: any) {
      await ctx.reply(`❌ *Prediction Failed:* ${err.message}`, { parse_mode: 'Markdown' });
    }
  });

  // Natural Language Handler
  bot.on('message:text', async (ctx: Context) => {
    const text = ctx.message?.text?.trim() || '';

    // Ignore commands (handled above)
    if (text.startsWith('/')) return;

    // Pattern 1: "convert [code] to [bookmaker]"
    const convertMatch = text.match(/convert\s+([A-Za-z0-9_-]+)\s+to\s+([A-Za-z0-9_-]+)/i);
    if (convertMatch) {
      const code = convertMatch[1];
      const targetBookie = convertMatch[2];
      try {
        const converted = await BookmakerRegistry.convertBookingCode('SportyBet', targetBookie, code);
        await ctx.reply(
          `✅ Converted code *${code.toUpperCase()}* to *${converted.targetSlip.bookmaker}*!\n\n` +
          `🎟️ *New Code:* \`${converted.newBookingCode}\``,
          { parse_mode: 'Markdown' }
        );
        return;
      } catch (err: any) {
        await ctx.reply(`❌ Could not convert: ${err.message}`);
        return;
      }
    }

    // Pattern 2: "trim [code] to [odds]"
    const trimMatch = text.match(/trim\s+([A-Za-z0-9_-]+)\s+to\s+(\d+(?:\.\d+)?)/i);
    if (trimMatch) {
      const code = trimMatch[1];
      const targetOdds = parseFloat(trimMatch[2]);
      await ctx.reply(`✂️ Trimming \`${code.toUpperCase()}\` to ~${targetOdds}x odds... Use \`/trim ${code} ${targetOdds}\` for full details.`, {
        parse_mode: 'Markdown'
      });
      return;
    }

    // Default friendly fallback
    await ctx.reply(
      `👋 I received your message! You can send me:\n\n` +
      `• \`/convert SportyBet Bet9ja <code>\` to convert codes\n` +
      `• \`/trim <code> 10\` to optimize and prune risk\n` +
      `• \`/predict Arsenal vs Chelsea\` for mathematical match probabilities\n\n` +
      `Type \`/help\` for full documentation!`
    );
  });

  return bot;
}
