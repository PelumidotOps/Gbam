import { BetLeg, MarketType } from '../models/types.js';

export interface MarketAdjustmentRule {
  targetMarket: MarketType;
  targetSelection: string;
  oddsDiscountFactor: number; // e.g. 0.70 to adjust odds down when choosing a safer line
}

export class TicketEditor {
  /**
   * Downgrades high-risk markets to safer alternatives
   * e.g., OVER_2_5 -> OVER_1_5, MATCH_RESULT 'HOME' -> DOUBLE_CHANCE '1X'
   */
  public static downgradeLegToSaferMarket(leg: BetLeg): BetLeg {
    // 1. Over 2.5 Goals -> Over 1.5 Goals
    if (leg.marketType === 'OVER_UNDER_GOALS' && leg.selection.includes('2.5')) {
      return {
        ...leg,
        selection: 'OVER_1.5',
        odds: Number(Math.max(1.10, leg.odds * 0.72).toFixed(2))
      };
    }

    // 2. Straight Home Win -> Double Chance 1X
    if (leg.marketType === 'MATCH_RESULT' && (leg.selection === 'HOME' || leg.selection === '1')) {
      return {
        ...leg,
        marketType: 'DOUBLE_CHANCE',
        selection: '1X',
        odds: Number(Math.max(1.08, leg.odds * 0.65).toFixed(2))
      };
    }

    // 3. Straight Away Win -> Double Chance X2
    if (leg.marketType === 'MATCH_RESULT' && (leg.selection === 'AWAY' || leg.selection === '2')) {
      return {
        ...leg,
        marketType: 'DOUBLE_CHANCE',
        selection: 'X2',
        odds: Number(Math.max(1.08, leg.odds * 0.65).toFixed(2))
      };
    }

    // If already conservative or unmapped, return as-is
    return leg;
  }

  /**
   * Applies safety downgrades to all eligible legs in a ticket
   */
  public static makeTicketSafer(legs: BetLeg[]): BetLeg[] {
    return legs.map(leg => this.downgradeLegToSaferMarket(leg));
  }

  /**
   * Removes specific games by fixture IDs or team names
   */
  public static removeMatches(legs: BetLeg[], matchIdentifiers: string[]): BetLeg[] {
    const targets = new Set(matchIdentifiers.map(m => m.toLowerCase().trim()));

    return legs.filter(leg => {
      const matchId = leg.fixture.id.toLowerCase();
      const home = leg.fixture.homeTeam.toLowerCase();
      const away = leg.fixture.awayTeam.toLowerCase();

      return !targets.has(matchId) && !targets.has(home) && !targets.has(away);
    });
  }

  /**
   * Combines multiple bet slips into a single deduplicated ticket
   */
  public static combineTickets(...tickets: BetLeg[][]): BetLeg[] {
    const combinedMap = new Map<string, BetLeg>();

    for (const ticket of tickets) {
      for (const leg of ticket) {
        const key = leg.fixture.id;
        const existing = combinedMap.get(key);

        if (!existing || leg.odds > existing.odds) {
          combinedMap.set(key, leg);
        }
      }
    }

    return Array.from(combinedMap.values());
  }
}
