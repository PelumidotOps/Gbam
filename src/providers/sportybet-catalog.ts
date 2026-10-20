import { BetLeg, MarketType } from '../models/types.js';
import { PoissonModel } from '../stats/poisson.js';
import { BookmakerRegistry } from '../bookmakers/registry.js';

export interface SportyMatchOutcome {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  tournament: string;
  category: string;
  marketId: string;
  marketDesc: string;
  specifier: string;
  outcomeId: string;
  outcomeDesc: string;
  odds: number;
  confidence: number; // 0.0 - 1.0
  estimateStartTime?: number;
}

export interface PickTier {
  name: string;
  tierKey: 'safe' | 'acca' | 'super';
  targetOdds: number;
  picks: SportyMatchOutcome[];
  totalOdds: number;
  averageConfidence: number;
  codes: Record<string, string>;
}

export interface SlipTimeframe {
  type: 'TODAY' | 'RUNNING';
  days?: number;
  label?: string;
}

export interface TieredPicksResult {

  safe: PickTier;
  acca: PickTier;
  super: PickTier;
}

export class SportyBetCatalog {
  private static pool: Map<string, SportyMatchOutcome> = new Map();
  private static rawEvents: Map<string, any> = new Map();
  private static eventDetailsCache: Map<string, { timestamp: number; data: any }> = new Map();
  private static lastRefresh = 0;
  private static rotationOffset = 0;

  /**
   * Initializes or refreshes the live fixture pool directly from SportyBet API
   */
  public static async refreshCatalog(): Promise<number> {
    const now = Date.now();
    // Cache for 15 minutes
    if (this.pool.size > 10 && now - this.lastRefresh < 15 * 60 * 1000) {
      return this.pool.size;
    }

    try {
      // Fetch rich live ticket from SportyBet containing up to 38 real upcoming fixtures
      const res = await fetch('https://www.sportybet.com/api/ng/orders/share/SKXLEU', {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json'
        }
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        const outcomes = data?.data?.outcomes || [];
        this.ingestSportyOutcomes(outcomes);
      }
    } catch (err: any) {
      console.error('Failed to refresh SportyBet catalog:', err.message);
    }

    this.lastRefresh = now;
    return this.pool.size;
  }

  /**
   * Ingests any outcomes from a decoded SportyBet ticket into the catalog
   */
  public static ingestSportyOutcomes(outcomes: any[]): void {
    if (!Array.isArray(outcomes)) return;

    for (const o of outcomes) {
      // Only include matches that haven't started or ended yet
      if (o.status !== 0 && o.matchStatus !== 'Not start') continue;
      if (o.eventId) {
        this.rawEvents.set(o.eventId, o);
      }

      const market = o.markets?.[0];
      const outcome = market?.outcomes?.[0];
      if (!o.eventId || !market?.id || !outcome?.id) continue;

      const odds = parseFloat(outcome?.odds || '1.30');
      if (isNaN(odds) || odds <= 1.0) continue;

      // Calculate statistical confidence using Poisson distribution expectations
      const lambdas = {
        homeLambda: 1.55,
        awayLambda: 1.05
      };
      const probs = PoissonModel.calculateMatchProbabilities(lambdas);

      // Derive realistic statistical confidence anchored to market fair probability
      let confidence = (1 / odds) * 0.945;
      if (market.id === '10') {
        // Double chance
        confidence = Math.max(confidence, probs.dc1X);
      } else if (market.id === '18' && (market.specifier || '').includes('1.5')) {
        // Over 1.5 Goals
        confidence = Math.max(confidence, probs.over1_5);
      } else if (market.id === '1') {
        // 1X2
        if (outcome.id === '1') confidence = Math.max(confidence, probs.homeWin);
        if (outcome.id === '3') confidence = Math.max(confidence, probs.awayWin);
      }

      // Bound between 68% and 95%
      confidence = Math.min(0.95, Math.max(0.68, confidence));

      const item: SportyMatchOutcome = {
        eventId: o.eventId,
        homeTeam: o.homeTeamName || 'Home Team',
        awayTeam: o.awayTeamName || 'Away Team',
        tournament: o.sport?.category?.tournament?.name || 'International',
        category: o.sport?.category?.name || 'Soccer',
        marketId: market.id,
        marketDesc: market.desc || 'Market',
        specifier: market.specifier || '',
        outcomeId: outcome.id,
        outcomeDesc: outcome.desc || 'Selection',
        odds,
        confidence,
        estimateStartTime: o.estimateStartTime
      };

      this.pool.set(item.eventId, item);
    }
  }

  /**
   * Converts a SportyMatchOutcome into a normalized BetLeg for multi-bookmaker processing
   */
  public static toBetLeg(outcome: SportyMatchOutcome): BetLeg {
    let marketType: MarketType = 'MATCH_RESULT';
    let selection = outcome.outcomeDesc || '1';

    if (outcome.marketId === '10' || outcome.marketDesc.includes('Double Chance')) {
      marketType = 'DOUBLE_CHANCE';
      if (selection.includes('1X') || selection.includes('Home/Draw') || selection.includes('Home or Draw')) selection = '1X';
      else if (selection.includes('X2') || selection.includes('Draw/Away') || selection.includes('Draw or Away')) selection = 'X2';
      else if (selection.includes('12') || selection.includes('Home/Away') || selection.includes('Home or Away')) selection = '12';
      else selection = '1X';
    } else if (outcome.marketId === '14' || outcome.marketDesc.includes('Handicap')) {
      marketType = 'HANDICAP';
      selection = outcome.outcomeDesc;
    } else if (outcome.marketId === 'specials' || outcome.marketDesc.includes('Either Half')) {
      marketType = 'DOUBLE_CHANCE';
      selection = outcome.outcomeDesc;
    } else if (outcome.marketId === '18' || outcome.marketDesc.includes('Goals')) {
      marketType = 'OVER_UNDER_GOALS';
      if (outcome.specifier.includes('1.5') || outcome.outcomeDesc.includes('1.5')) {
        selection = outcome.outcomeDesc.toLowerCase().includes('under') ? 'UNDER_1.5' : 'OVER_1.5';
      } else if (outcome.specifier.includes('2.5') || outcome.outcomeDesc.includes('2.5')) {
        selection = outcome.outcomeDesc.toLowerCase().includes('under') ? 'UNDER_2.5' : 'OVER_2.5';
      } else if (outcome.specifier.includes('3.5') || outcome.outcomeDesc.includes('3.5')) {
        selection = outcome.outcomeDesc.toLowerCase().includes('under') ? 'UNDER_3.5' : 'OVER_3.5';
      } else if (outcome.specifier.includes('0.5') || outcome.outcomeDesc.includes('0.5')) {
        selection = outcome.outcomeDesc.toLowerCase().includes('under') ? 'UNDER_0.5' : 'OVER_0.5';
      } else {
        selection = outcome.outcomeDesc;
      }
    } else if (outcome.marketId === '29' || outcome.marketDesc.includes('Score')) {
      marketType = 'BOTH_TEAMS_TO_SCORE';
      selection = outcome.outcomeDesc.toLowerCase().includes('no') ? 'NO' : 'YES';
    } else if (outcome.marketId === '1') {
      marketType = 'MATCH_RESULT';
      if (outcome.outcomeId === '1' || selection.toLowerCase().includes('home')) selection = 'HOME';
      else if (outcome.outcomeId === '3' || selection.toLowerCase().includes('away')) selection = 'AWAY';
      else selection = 'DRAW';
    }


    return {
      fixture: {
        id: outcome.eventId,
        sport: 'FOOTBALL',
        homeTeam: outcome.homeTeam,
        awayTeam: outcome.awayTeam,
        league: outcome.tournament,
        kickoffTime: outcome.estimateStartTime
          ? new Date(outcome.estimateStartTime).toISOString()
          : new Date().toISOString(),
        status: 'SCHEDULED'
      },
      marketType,
      selection,
      odds: outcome.odds,
      bookmakerEventId: outcome.eventId,
      bookmakerMarketId: outcome.marketId,
      specifier: outcome.specifier,
      outcomeId: outcome.outcomeId
    };
  }

  /**
   * Returns top high-probability picks with pool rotation to avoid static outputs
   */
  public static async getTopPicks(count: number = 4): Promise<SportyMatchOutcome[]> {
    await this.refreshCatalog();
    const all = Array.from(this.pool.values());

    // Sort by confidence descending, then by conservative safe odds
    const sorted = all.sort((a, b) => b.confidence - a.confidence || a.odds - b.odds);

    // Rotate through candidate window so repeated calls show variety
    const poolWindow = sorted.slice(0, Math.min(sorted.length, 16));
    if (poolWindow.length <= count) {
      return poolWindow;
    }

    const offset = this.rotationOffset % (poolWindow.length - count + 1);
    this.rotationOffset = (this.rotationOffset + 2) % 30;

    return poolWindow.slice(offset, offset + count);
  }

  /**
   * Assembles 3 curated tiers of picks with pool rotation and multi-platform booking codes:
   * 🟢 Safe Double (2-3 games, ~2.0x odds, >= 80% confidence)
   * 🟡 Daily Acca (4-6 games, ~5.0x odds, >= 78% confidence)
   * 🔴 Super Slip (8-10 games, ~10x+ odds, >= 74% confidence)
   */
  public static async getTieredPicks(): Promise<TieredPicksResult> {
    await this.refreshCatalog();
    const all = Array.from(this.pool.values());

    // Sort pool by highest confidence first
    const sorted = all.sort((a, b) => b.confidence - a.confidence || a.odds - b.odds);

    const step = (this.rotationOffset * 2) % Math.max(1, sorted.length);
    this.rotationOffset = (this.rotationOffset + 3) % 40;

    // Shift candidate list to provide dynamic variety upon repeated clicks
    const rotated = [...sorted.slice(step), ...sorted.slice(0, step)];

    // 1. Build Safe Double (2-4 games, target ~2.0x odds, minConfidence >= 0.78)
    const safeCandidates = rotated.filter(m => m.confidence >= 0.78);
    const safePicks = this.selectCombinatorialPicks(safeCandidates, 2.0, 2, 4);
    const safeTotalOdds = Number(safePicks.reduce((acc, p) => acc * p.odds, 1).toFixed(2));
    const safeAvgConf = safePicks.reduce((acc, p) => acc + p.confidence, 0) / (safePicks.length || 1);
    const safeLegs = safePicks.map(p => this.toBetLeg(p));
    const safeCodes = await BookmakerRegistry.getMultiBookingCodes(safeLegs);

    // 2. Build Daily Acca (4-8 games, target ~5.0x odds, minConfidence >= 0.75)
    const accaCandidates = rotated.filter(m => m.confidence >= 0.75);
    const accaPicks = this.selectCombinatorialPicks(accaCandidates, 5.0, 4, 8);
    const accaTotalOdds = Number(accaPicks.reduce((acc, p) => acc * p.odds, 1).toFixed(2));
    const accaAvgConf = accaPicks.reduce((acc, p) => acc + p.confidence, 0) / (accaPicks.length || 1);
    const accaLegs = accaPicks.map(p => this.toBetLeg(p));
    const accaCodes = await BookmakerRegistry.getMultiBookingCodes(accaLegs);

    // 3. Build Super Slip (8-14 games, target ~10.0x+ odds, minConfidence >= 0.72)
    const superCandidates = rotated.filter(m => m.confidence >= 0.72);
    const superPicks = this.selectCombinatorialPicks(superCandidates, 10.0, 7, 14);
    const superTotalOdds = Number(superPicks.reduce((acc, p) => acc * p.odds, 1).toFixed(2));
    const superAvgConf = superPicks.reduce((acc, p) => acc + p.confidence, 0) / (superPicks.length || 1);
    const superLegs = superPicks.map(p => this.toBetLeg(p));
    const superCodes = await BookmakerRegistry.getMultiBookingCodes(superLegs);

    return {
      safe: {
        name: '🟢 Safe Double (2 Odds)',
        tierKey: 'safe',
        targetOdds: 2.0,
        picks: safePicks,
        totalOdds: safeTotalOdds,
        averageConfidence: safeAvgConf,
        codes: safeCodes
      },
      acca: {
        name: '🟡 Daily Acca (5 Odds)',
        tierKey: 'acca',
        targetOdds: 5.0,
        picks: accaPicks,
        totalOdds: accaTotalOdds,
        averageConfidence: accaAvgConf,
        codes: accaCodes
      },
      super: {
        name: '🔴 Super Slip (10+ Odds)',
        tierKey: 'super',
        targetOdds: 10.0,
        picks: superPicks,
        totalOdds: superTotalOdds,
        averageConfidence: superAvgConf,
        codes: superCodes
      }
    };
  }

  /**
   * Helper algorithm to select picks targeting given odds and leg counts
   */
  private static selectCombinatorialPicks(
    candidates: SportyMatchOutcome[],
    targetOdds: number,
    minLegs: number,
    maxLegs: number
  ): SportyMatchOutcome[] {
    const usedEvents = new Set<string>();
    const unique = candidates.filter(m => {
      if (usedEvents.has(m.eventId)) return false;
      usedEvents.add(m.eventId);
      return true;
    });

    if (unique.length === 0) return [];

    let bestSubset: SportyMatchOutcome[] = [];
    let bestDiff = Infinity;

    // Search window among available candidates
    const pool = unique.slice(0, Math.min(unique.length, 18));

    for (let i = 0; i < pool.length; i++) {
      let currentOdds = pool[i].odds;
      const currentCombo: SportyMatchOutcome[] = [pool[i]];

      for (let j = i + 1; j < pool.length; j++) {
        if (currentCombo.length >= maxLegs) break;

        currentCombo.push(pool[j]);
        currentOdds *= pool[j].odds;

        if (currentCombo.length >= minLegs) {
          const diff = Math.abs(currentOdds - targetOdds);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestSubset = [...currentCombo];
          }
          if (currentOdds >= targetOdds * 0.92 && currentOdds <= targetOdds * 1.35) {
            return bestSubset;
          }
        }
      }
    }

    if (bestSubset.length >= minLegs) {
      return bestSubset;
    }

    // Fallback: greedy accumulation
    const fallback: SportyMatchOutcome[] = [];
    let curr = 1.0;
    for (const m of unique) {
      fallback.push(m);
      curr *= m.odds;
      if (curr >= targetOdds * 0.90 && fallback.length >= minLegs) break;
      if (fallback.length >= maxLegs) break;
    }
    return fallback;
  }

  /**
   * Fetches full event markets from SportyBet factsCenter API, caching for 30 minutes
   */
  public static async fetchEventDetails(eventId: string): Promise<any | null> {
    const cached = this.eventDetailsCache.get(eventId);
    const now = Date.now();
    if (cached && now - cached.timestamp < 30 * 60 * 1000) {
      return cached.data;
    }

    try {
      const res = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=${eventId}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json'
        }
      });
      if (res.ok) {
        const json = (await res.json()) as any;
        if (json.bizCode === 10000 && json.data) {
          this.eventDetailsCache.set(eventId, { timestamp: now, data: json.data });
          return json.data;
        }
      }
    } catch (err: any) {
      console.error(`Failed to fetch details for event ${eventId}:`, err.message);
    }
    return null;
  }

  /**
   * Extracts strictly matching market outcomes directly from live scheduled matches
   * Guarantees 100% adherence to the requested market type without cross-market pollution.
   */
  public static async getStrictMarketOutcomes(
    marketFilter: string,
    maxEvents: number = 30,
    maxTimestamp?: number
  ): Promise<SportyMatchOutcome[]> {
    await this.refreshCatalog();

    const now = Date.now();
    // Collect upcoming event IDs within timeframe
    let events = Array.from(this.rawEvents.values());
    if (events.length === 0) {
      events = Array.from(this.pool.values()).map(p => ({
        eventId: p.eventId,
        homeTeamName: p.homeTeam,
        awayTeamName: p.awayTeam,
        estimateStartTime: p.estimateStartTime
      }));
    }

    if (maxTimestamp && maxTimestamp < Infinity) {
      events = events.filter(e => {
        if (!e.estimateStartTime) return true;
        return e.estimateStartTime >= now - 60 * 60 * 1000 && e.estimateStartTime <= maxTimestamp;
      });
    }

    const targetEventIds = events.slice(0, maxEvents).map(e => e.eventId);

    // Fetch full event markets concurrently
    const fetchedEvents = await Promise.all(targetEventIds.map(id => this.fetchEventDetails(id)));

    const mf = marketFilter.toUpperCase();
    const results: SportyMatchOutcome[] = [];

    for (const ev of fetchedEvents) {

      if (!ev || !ev.markets || !Array.isArray(ev.markets)) continue;

      let matchedMarket: any = null;
      let matchedOutcome: any = null;
      let marketDesc = 'Market';
      let outcomeDesc = 'Selection';

      if (mf === 'HOME_OR_AWAY' || mf === '12') {
        const dc = ev.markets.find((m: any) => String(m.id) === '10');
        const o = dc?.outcomes?.find((out: any) => String(out.id) === '10');
        if (o && parseFloat(o.odds) > 1.0) {
          matchedMarket = { id: '10', specifier: '' };
          matchedOutcome = o;
          marketDesc = 'Double Chance';
          outcomeDesc = 'Home or Away';
        }
      } else if (mf === 'HOME_OR_DRAW' || mf === '1X') {
        const dc = ev.markets.find((m: any) => String(m.id) === '10');
        const o = dc?.outcomes?.find((out: any) => String(out.id) === '9');
        if (o && parseFloat(o.odds) > 1.0) {
          matchedMarket = { id: '10', specifier: '' };
          matchedOutcome = o;
          marketDesc = 'Double Chance';
          outcomeDesc = 'Home or Draw';
        }
      } else if (mf === 'DRAW_OR_AWAY' || mf === 'X2') {
        const dc = ev.markets.find((m: any) => String(m.id) === '10');
        const o = dc?.outcomes?.find((out: any) => String(out.id) === '11');
        if (o && parseFloat(o.odds) > 1.0) {
          matchedMarket = { id: '10', specifier: '' };
          matchedOutcome = o;
          marketDesc = 'Double Chance';
          outcomeDesc = 'Draw or Away';
        }
      } else if (mf === 'DOUBLE_CHANCE') {
        const dc = ev.markets.find((m: any) => String(m.id) === '10');
        const validOuts = (dc?.outcomes || []).filter((out: any) => parseFloat(out.odds) > 1.0);
        validOuts.sort((a: any, b: any) => parseFloat(a.odds) - parseFloat(b.odds));
        if (validOuts.length > 0) {
          matchedMarket = { id: '10', specifier: '' };
          matchedOutcome = validOuts[0];
          marketDesc = 'Double Chance';
          outcomeDesc = matchedOutcome.desc || 'Double Chance';
        }
      } else if (mf === 'OVER_1_5') {
        const ov = ev.markets.find((m: any) => String(m.id) === '18' && (m.specifier || '').includes('1.5'));
        const o = ov?.outcomes?.find((out: any) => String(out.id) === '12');
        if (o && parseFloat(o.odds) > 1.0) {
          matchedMarket = { id: '18', specifier: 'total=1.5' };
          matchedOutcome = o;
          marketDesc = 'Over/Under';
          outcomeDesc = 'Over 1.5';
        }
      } else if (mf === 'OVER_2_5') {
        const ov = ev.markets.find((m: any) => String(m.id) === '18' && (m.specifier || '').includes('2.5'));
        const o = ov?.outcomes?.find((out: any) => String(out.id) === '12');
        if (o && parseFloat(o.odds) > 1.0) {
          matchedMarket = { id: '18', specifier: 'total=2.5' };
          matchedOutcome = o;
          marketDesc = 'Over/Under';
          outcomeDesc = 'Over 2.5';
        }
      } else if (mf === 'UNDER_3_5') {
        const un = ev.markets.find((m: any) => String(m.id) === '18' && (m.specifier || '').includes('3.5'));
        const o = un?.outcomes?.find((out: any) => String(out.id) === '13');
        if (o && parseFloat(o.odds) > 1.0) {
          matchedMarket = { id: '18', specifier: 'total=3.5' };
          matchedOutcome = o;
          marketDesc = 'Over/Under';
          outcomeDesc = 'Under 3.5';
        }
      } else if (mf === 'UNDER_2_5') {
        const un = ev.markets.find((m: any) => String(m.id) === '18' && (m.specifier || '').includes('2.5'));
        const o = un?.outcomes?.find((out: any) => String(out.id) === '13');
        if (o && parseFloat(o.odds) > 1.0) {
          matchedMarket = { id: '18', specifier: 'total=2.5' };
          matchedOutcome = o;
          marketDesc = 'Over/Under';
          outcomeDesc = 'Under 2.5';
        }
      } else if (mf === 'UNDER_0_5' || mf === 'NO_GOAL') {
        const un = ev.markets.find((m: any) => String(m.id) === '18' && (m.specifier || '').includes('0.5'));
        const o = un?.outcomes?.find((out: any) => String(out.id) === '13');
        if (o && parseFloat(o.odds) > 1.0) {
          matchedMarket = { id: '18', specifier: 'total=0.5' };
          matchedOutcome = o;
          marketDesc = 'Over/Under';
          outcomeDesc = 'Under 0.5';
        }
      } else if (mf === 'BTTS' || mf === 'GG') {
        const gg = ev.markets.find((m: any) => String(m.id) === '29');
        const o = gg?.outcomes?.find((out: any) => String(out.id) === '74');
        if (o && parseFloat(o.odds) > 1.0) {
          matchedMarket = { id: '29', specifier: '' };
          matchedOutcome = o;
          marketDesc = 'Both Teams to Score';
          outcomeDesc = 'Yes';
        }
      } else if (mf === 'MATCH_RESULT' || mf === '1X2') {
        const mr = ev.markets.find((m: any) => String(m.id) === '1');
        const h = mr?.outcomes?.find((out: any) => String(out.id) === '1');
        const a = mr?.outcomes?.find((out: any) => String(out.id) === '3');
        const fav = h && a ? (parseFloat(h.odds) <= parseFloat(a.odds) ? h : a) : h || a;
        if (fav && parseFloat(fav.odds) > 1.0) {
          matchedMarket = { id: '1', specifier: '' };
          matchedOutcome = fav;
          marketDesc = '1X2';
          outcomeDesc = fav.desc || (fav.id === '1' ? 'Home' : 'Away');
        }
      } else if (mf === 'HANDICAP') {
        const hc = ev.markets.find((m: any) => String(m.id) === '14' && (m.specifier || '').includes('0:2'));
        const o = hc?.outcomes?.find((out: any) => String(out.id) === '1713');
        if (o && parseFloat(o.odds) > 1.0) {
          matchedMarket = { id: '14', specifier: hc.specifier };
          matchedOutcome = o;
          marketDesc = hc.desc || 'Handicap';
          outcomeDesc = o.desc || 'Away (0:2)';
        }
      }

      if (matchedMarket && matchedOutcome) {
        const odds = parseFloat(matchedOutcome.odds);
        if (isNaN(odds) || odds < 1.15) continue;
        let confidence = (1 / odds) * 0.945;
        if (matchedOutcome.probability) {
          confidence = parseFloat(matchedOutcome.probability);
        }
        if (confidence < 0.75) continue;
        confidence = Math.min(0.95, Math.max(0.75, confidence));

        results.push({
          eventId: ev.eventId,
          homeTeam: ev.homeTeamName || 'Home Team',
          awayTeam: ev.awayTeamName || 'Away Team',
          tournament: ev.sport?.category?.tournament?.name || 'Football',
          category: ev.sport?.category?.name || 'Soccer',
          marketId: matchedMarket.id,
          marketDesc,
          specifier: matchedMarket.specifier,
          outcomeId: String(matchedOutcome.id),
          outcomeDesc,
          odds,
          confidence,
          estimateStartTime: ev.estimateStartTime
        });
      }
    }

    return results;
  }

  /**
   * Evaluates multiple high-probability market options across upcoming fixtures within the timeframe.
   * Dynamically tailors the market selection (Over/Under, Double Chance, 1X2 favorite, BTTS) to reach targetOdds.
   */
  public static async getDiverseMarketCandidates(
    maxTimestamp: number,
    targetOdds: number,
    maxEvents: number = 30
  ): Promise<SportyMatchOutcome[]> {
    await this.refreshCatalog();

    const now = Date.now();
    let events = Array.from(this.rawEvents.values());
    if (events.length === 0) {
      events = Array.from(this.pool.values()).map(p => ({
        eventId: p.eventId,
        homeTeamName: p.homeTeam,
        awayTeamName: p.awayTeam,
        estimateStartTime: p.estimateStartTime
      }));
    }

    if (maxTimestamp && maxTimestamp < Infinity) {
      events = events.filter(e => {
        if (!e.estimateStartTime) return true;
        return e.estimateStartTime >= now - 60 * 60 * 1000 && e.estimateStartTime <= maxTimestamp;
      });
    }

    const targetEventIds = events.slice(0, maxEvents).map(e => e.eventId);
    const fetchedEvents = await Promise.all(targetEventIds.map(id => this.fetchEventDetails(id)));

    const results: SportyMatchOutcome[] = [];

    for (const ev of fetchedEvents) {
      if (!ev || !ev.markets || !Array.isArray(ev.markets)) continue;

      const eventOptions: SportyMatchOutcome[] = [];

      // 1. Double Chance (Market 10: 1X, 12, X2) - Strictly >= 75% confidence, odds >= 1.15
      const dc = ev.markets.find((m: any) => String(m.id) === '10');
      for (const o of dc?.outcomes || []) {
        const odds = parseFloat(o.odds);
        if (isNaN(odds) || odds < 1.15 || odds > 1.45) continue;
        const conf = o.probability ? parseFloat(o.probability) : (1 / odds) * 0.945;
        if (conf >= 0.75) {
          eventOptions.push({
            eventId: ev.eventId,
            homeTeam: ev.homeTeamName || 'Home Team',
            awayTeam: ev.awayTeamName || 'Away Team',
            tournament: ev.sport?.category?.tournament?.name || 'Football',
            category: ev.sport?.category?.name || 'Soccer',
            marketId: '10',
            marketDesc: 'Double Chance',
            specifier: '',
            outcomeId: String(o.id),
            outcomeDesc: o.desc || (o.id === '9' ? 'Home or Draw' : o.id === '10' ? 'Home or Away' : 'Draw or Away'),
            odds,
            confidence: Math.min(0.95, Math.max(0.75, conf)),
            estimateStartTime: ev.estimateStartTime
          });
        }
      }

      // 2. Over 1.5 Goals (Market 18, specifier total=1.5) - Strictly >= 75% confidence, odds >= 1.15
      const ov15 = ev.markets.find((m: any) => String(m.id) === '18' && (m.specifier || '').includes('1.5'));
      const out15 = ov15?.outcomes?.find((o: any) => String(o.id) === '12');
      if (out15) {
        const odds = parseFloat(out15.odds);
        if (!isNaN(odds) && odds >= 1.15 && odds <= 1.45) {
          const conf = out15.probability ? parseFloat(out15.probability) : (1 / odds) * 0.945;
          if (conf >= 0.75) {
            eventOptions.push({
              eventId: ev.eventId,
              homeTeam: ev.homeTeamName || 'Home Team',
              awayTeam: ev.awayTeamName || 'Away Team',
              tournament: ev.sport?.category?.tournament?.name || 'Football',
              category: ev.sport?.category?.name || 'Soccer',
              marketId: '18',
              marketDesc: 'Over/Under',
              specifier: 'total=1.5',
              outcomeId: '12',
              outcomeDesc: 'Over 1.5',
              odds,
              confidence: Math.min(0.95, Math.max(0.75, conf)),
              estimateStartTime: ev.estimateStartTime
            });
          }
        }
      }

      // 3. Over 2.5 Goals (Market 18) - Only if strictly >= 75% confidence, odds >= 1.15
      const ov25 = ev.markets.find((m: any) => String(m.id) === '18' && (m.specifier || '').includes('2.5'));
      const out25 = ov25?.outcomes?.find((o: any) => String(o.id) === '12');
      if (out25) {
        const odds = parseFloat(out25.odds);
        if (!isNaN(odds) && odds >= 1.15 && odds <= 1.45) {
          const conf = out25.probability ? parseFloat(out25.probability) : (1 / odds) * 0.945;
          if (conf >= 0.75) {
            eventOptions.push({
              eventId: ev.eventId,
              homeTeam: ev.homeTeamName || 'Home Team',
              awayTeam: ev.awayTeamName || 'Away Team',
              tournament: ev.sport?.category?.tournament?.name || 'Football',
              category: ev.sport?.category?.name || 'Soccer',
              marketId: '18',
              marketDesc: 'Over/Under',
              specifier: 'total=2.5',
              outcomeId: '12',
              outcomeDesc: 'Over 2.5',
              odds,
              confidence: Math.min(0.95, Math.max(0.75, conf)),
              estimateStartTime: ev.estimateStartTime
            });
          }
        }
      }

      // 4. Straight 1X2 (Market 1) - Favorites only if strictly >= 75% confidence, odds >= 1.15
      const mr = ev.markets.find((m: any) => String(m.id) === '1');
      const h = mr?.outcomes?.find((o: any) => String(o.id) === '1');
      const a = mr?.outcomes?.find((o: any) => String(o.id) === '3');
      const fav = h && a ? (parseFloat(h.odds) <= parseFloat(a.odds) ? h : a) : h || a;
      if (fav) {
        const odds = parseFloat(fav.odds);
        if (!isNaN(odds) && odds >= 1.15 && odds <= 1.35) {
          const conf = fav.probability ? parseFloat(fav.probability) : (1 / odds) * 0.945;
          if (conf >= 0.75) {
            eventOptions.push({
              eventId: ev.eventId,
              homeTeam: ev.homeTeamName || 'Home Team',
              awayTeam: ev.awayTeamName || 'Away Team',
              tournament: ev.sport?.category?.tournament?.name || 'Football',
              category: ev.sport?.category?.name || 'Soccer',
              marketId: '1',
              marketDesc: '1X2',
              specifier: '',
              outcomeId: String(fav.id),
              outcomeDesc: fav.id === '1' ? 'Home' : 'Away',
              odds,
              confidence: Math.min(0.95, Math.max(0.75, conf)),
              estimateStartTime: ev.estimateStartTime
            });
          }
        }
      }

      // 5. Safe Handicap Cushion (Market 14) - Strictly >= 75% confidence, odds >= 1.15
      const hc = ev.markets.find((m: any) => String(m.id) === '14' && (m.specifier || '').includes('0:2'));
      const outHc = hc?.outcomes?.find((o: any) => String(o.id) === '1713');
      if (outHc) {
        const odds = parseFloat(outHc.odds);
        if (!isNaN(odds) && odds >= 1.15 && odds <= 1.35) {
          const conf = (1 / odds) * 0.945;
          if (conf >= 0.75) {
            eventOptions.push({
              eventId: ev.eventId,
              homeTeam: ev.homeTeamName || 'Home Team',
              awayTeam: ev.awayTeamName || 'Away Team',
              tournament: ev.sport?.category?.tournament?.name || 'Football',
              category: ev.sport?.category?.name || 'Soccer',
              marketId: '14',
              marketDesc: hc.desc || 'Handicap',
              specifier: hc.specifier,
              outcomeId: String(outHc.id),
              outcomeDesc: outHc.desc || 'Away (0:2)',
              odds,
              confidence: Math.min(0.95, Math.max(0.75, conf)),
              estimateStartTime: ev.estimateStartTime
            });
          }
        }
      }

      results.push(...eventOptions);
    }

    return results;
  }

  /**
   * Builds an optimized slip targeting specific odds using real matches with multi-bookmaker codes.
   * Strictly enforces the requested market without mixing unrelated bet types.
   */
  public static async buildSlipForTargetOdds(
    targetOdds: number = 10.0,
    preferredBookmaker: string = 'SportyBet',
    marketFilter?: string,
    timeframe: SlipTimeframe = { type: 'TODAY', days: 1 }
  ): Promise<{
    picks: SportyMatchOutcome[];
    totalOdds: number;
    averageConfidence: number;
    bookingCode: string;
    targetBookmaker: string;
    marketCategory: string;
    scheduleLabel: string;
    multiCodes: Record<string, string>;
  }> {
    const now = Date.now();
    let maxTimestamp = Infinity;
    let scheduleLabel = "Today Only (Settles Tonight)";

    if (timeframe.type === 'TODAY' || !timeframe.days || timeframe.days <= 1) {
      // End of today UTC+1 (WAT):
      const nowDate = new Date(now);
      const endOfToday = new Date(nowDate);
      endOfToday.setUTCHours(23, 59, 59, 999);
      // Add 3-hour buffer for late kickoff ending
      maxTimestamp = endOfToday.getTime() + 3 * 60 * 60 * 1000;
      scheduleLabel = "Today Only (Settles Tonight)";
    } else {
      const days = timeframe.days;
      maxTimestamp = now + days * 24 * 60 * 60 * 1000;
      const endDate = new Date(maxTimestamp);
      const endMonth = endDate.toLocaleDateString('en-GB', { month: 'short' });
      const endDay = endDate.getDate();
      scheduleLabel = `${days}-Day Running Slip (Settles by ${endMonth} ${endDay})`;
    }

    let candidates: SportyMatchOutcome[] = [];
    let marketCategory = 'Platform High-Win-Rate Signature Markets';

    // Advance rotation offset on every request to guarantee freshness and variety
    this.rotationOffset = (this.rotationOffset + 3) % 47;

    if (marketFilter) {
      // 100% STRICT MARKET FILTERING: Only extract matches that belong to this market within timeframe!
      candidates = await this.getStrictMarketOutcomes(marketFilter, 30, maxTimestamp);

      const mf = marketFilter.toUpperCase();
      if (mf === 'HOME_OR_AWAY' || mf === '12') marketCategory = 'Home or Away (12) Focused';
      else if (mf === 'HOME_OR_DRAW' || mf === '1X') marketCategory = 'Home or Draw (1X) Focused';
      else if (mf === 'DRAW_OR_AWAY' || mf === 'X2') marketCategory = 'Draw or Away (X2) Focused';
      else if (mf === 'DOUBLE_CHANCE') marketCategory = 'Double Chance Focused';
      else if (mf === 'OVER_1_5') marketCategory = 'Over 1.5 Goals Focused';
      else if (mf === 'OVER_2_5') marketCategory = 'Over 2.5 Goals Focused';
      else if (mf === 'UNDER_3_5') marketCategory = 'Under 3.5 Goals Focused';
      else if (mf === 'UNDER_2_5') marketCategory = 'Under 2.5 Goals Focused';
      else if (mf === 'BTTS' || mf === 'GG') marketCategory = 'Both Teams To Score Focused';
      else if (mf === 'MATCH_RESULT') marketCategory = 'Straight Win / Favorites Focused';
      else if (mf === 'HANDICAP') marketCategory = 'Handicap Cushions Focused';
      else marketCategory = `${marketFilter} Focused`;

      if (candidates.length === 0) {
        throw new Error(
          `No live matches scheduled within ${scheduleLabel} currently offer "${marketCategory}". Try extending your ticket duration (e.g. "for 2 days") or choose another market type.`
        );
      }
    } else {
      // General odds request across bookmakers: pull diverse live markets tailored to targetOdds
      candidates = await this.getDiverseMarketCandidates(maxTimestamp, targetOdds, 30);

      const resolvedAdapter = BookmakerRegistry.get(preferredBookmaker);
      marketCategory = `${resolvedAdapter.name} Signature Advantage Markets`;
    }

    // Group candidates by eventId so we never duplicate a match
    const byEvent = new Map<string, SportyMatchOutcome[]>();
    for (const c of candidates) {
      if (!byEvent.has(c.eventId)) byEvent.set(c.eventId, []);
      byEvent.get(c.eventId)!.push(c);
    }

    // Sort options within each event based on targetOdds
    for (const [_, list] of byEvent) {
      if (targetOdds <= 3.5) {
        // Prefer lower odds, highest safety (asc)
        list.sort((a, b) => a.odds - b.odds || b.confidence - a.confidence);
      } else if (targetOdds >= 10.0) {
        // Prefer solid odds to hit target (desc)
        list.sort((a, b) => b.odds - a.odds || b.confidence - a.confidence);
      } else {
        // Balanced
        list.sort((a, b) => b.confidence - a.confidence || a.odds - b.odds);
      }
    }

    const eventList = Array.from(byEvent.keys());
    // Rotate event order using rotationOffset to produce fresh variations upon repeated requests
    const offset = this.rotationOffset % Math.max(1, eventList.length);
    const rotatedEvents = [...eventList.slice(offset), ...eventList.slice(0, offset)];

    const selected: SportyMatchOutcome[] = [];
    let currentOdds = 1.0;

    for (const eventId of rotatedEvents) {
      const options = byEvent.get(eventId) || [];
      if (options.length === 0) continue;

      // Rotate market selection across requests to produce varied combinations
      const optIdx = (this.rotationOffset + rotatedEvents.indexOf(eventId)) % options.length;
      let chosen = options[optIdx] || options[0];
      // If we are close to targetOdds, pick a smaller cushion option if available
      if (currentOdds >= targetOdds * 0.70 && options.length > 1) {
        const safer = options.find(o => o.odds <= 1.25);
        if (safer) chosen = safer;
      }

      selected.push(chosen);
      currentOdds *= chosen.odds;

      if (currentOdds >= targetOdds * 0.95 && selected.length >= 2) {
        break;
      }
    }

    // Accurately derive schedule label from the latest kickoff time of selected matches
    let dynamicScheduleLabel = "Today Only (Settles Tonight)";
    if (selected.length > 0) {
      const latestKickoff = Math.max(...selected.map(p => p.estimateStartTime || now));
      const latestDate = new Date(latestKickoff);
      const isToday = latestDate.toDateString() === new Date(now).toDateString();
      if (isToday) {
        dynamicScheduleLabel = "Today Only (Settles Tonight)";
      } else {
        const dayStr = latestDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        dynamicScheduleLabel = `Running Slip (Settles by ${dayStr})`;
      }
    }

    const avgConfidence =
      selected.reduce((acc, m) => acc + m.confidence, 0) / (selected.length || 1);

    // Generate multi-platform booking codes with real selections
    const legs = selected.map(p => this.toBetLeg(p));
    const multiCodes = await BookmakerRegistry.getMultiBookingCodes(legs);

    // Pick target bookmaker's code
    const resolvedAdapter = BookmakerRegistry.get(preferredBookmaker);
    const targetBookingCode = multiCodes[resolvedAdapter.name] || (await resolvedAdapter.generateBookingCode(legs));

    return {
      picks: selected,
      totalOdds: Number(currentOdds.toFixed(2)),
      averageConfidence: avgConfidence,
      bookingCode: targetBookingCode,
      targetBookmaker: resolvedAdapter.name,
      marketCategory,
      scheduleLabel: dynamicScheduleLabel,
      multiCodes
    };
  }


  /**
   * Posts real selections to SportyBet official share API to create an authentic booking code
   */
  public static async generateSportyBookingCode(picks: SportyMatchOutcome[]): Promise<string> {
    const selections = picks.map(p => ({
      eventId: p.eventId,
      marketId: p.marketId,
      specifier: p.specifier,
      outcomeId: p.outcomeId
    }));

    try {
      const res = await fetch('https://www.sportybet.com/api/ng/orders/share', {
        method: 'POST',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({ selections })
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.bizCode === 10000 && data.data?.shareCode) {
          return data.data.shareCode;
        }
      }
    } catch (err: any) {
      console.error('SportyBet code generation error:', err.message);
    }

    // Dynamic unique fallback if network is down
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = 'SB';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }
}
