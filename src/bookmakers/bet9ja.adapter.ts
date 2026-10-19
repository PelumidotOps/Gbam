import { BetLeg, BetSlip, MarketType } from '../models/types.js';
import { BookmakerAdapter, NormalizedMarketMapping } from './adapter.interface.js';

export class Bet9jaAdapter implements BookmakerAdapter {
  public readonly name = 'Bet9ja';
  public readonly country = 'NG';

  public normalizeMarket(rawMarketCode: string, rawOutcomeCode: string): NormalizedMarketMapping {
    const market = rawMarketCode.trim().toUpperCase();
    const outcome = rawOutcomeCode.trim().toUpperCase();

    // 1X2
    if (market === '1X2' || market === 'MATCH_RESULT') {
      if (outcome === '1') return { marketType: 'MATCH_RESULT', selection: 'HOME' };
      if (outcome === 'X') return { marketType: 'MATCH_RESULT', selection: 'DRAW' };
      if (outcome === '2') return { marketType: 'MATCH_RESULT', selection: 'AWAY' };
    }

    // Double Chance
    if (market === 'DC' || market === 'DOUBLE_CHANCE') {
      return { marketType: 'DOUBLE_CHANCE', selection: outcome };
    }

    // Over/Under
    if (market.includes('O/U') || market.includes('GOALS')) {
      if (outcome.includes('1.5')) {
        return {
          marketType: 'OVER_UNDER_GOALS',
          selection: outcome.startsWith('O') ? 'OVER_1.5' : 'UNDER_1.5'
        };
      }
      if (outcome.includes('2.5')) {
        return {
          marketType: 'OVER_UNDER_GOALS',
          selection: outcome.startsWith('O') ? 'OVER_2.5' : 'UNDER_2.5'
        };
      }
    }

    // GG / NG
    if (market === 'GG/NG' || market === 'GOAL/NO_GOAL') {
      return {
        marketType: 'BOTH_TEAMS_TO_SCORE',
        selection: outcome === 'GG' ? 'YES' : 'NO'
      };
    }

    return {
      marketType: 'MATCH_RESULT',
      selection: outcome
    };
  }

  public toBookmakerMarket(marketType: MarketType, selection: string): { marketId: string; specifier?: string } {
    switch (marketType) {
      case 'MATCH_RESULT':
        return { marketId: '1X2' };
      case 'DOUBLE_CHANCE':
        return { marketId: 'DC' };
      case 'OVER_UNDER_GOALS':
        return { marketId: 'O/U', specifier: selection };
      case 'BOTH_TEAMS_TO_SCORE':
        return { marketId: 'GG/NG' };
      default:
        return { marketId: '1X2' };
    }
  }

  public async decodeBookingCode(bookingCode: string): Promise<BetSlip> {
    const cleanCode = bookingCode.trim().toUpperCase();

    return {
      bookmaker: this.name,
      bookingCode: cleanCode,
      legs: [
        {
          id: 'b9-sample-1',
          fixture: {
            id: 'b9-event-1',
            sport: 'FOOTBALL',
            homeTeam: 'Real Madrid',
            awayTeam: 'Barcelona',
            league: 'La Liga',
            kickoffTime: new Date().toISOString(),
            status: 'SCHEDULED'
          },
          marketType: 'OVER_UNDER_GOALS',
          selection: 'OVER_1.5',
          odds: 1.25
        }
      ],
      totalOdds: 1.25,
      currency: 'NGN'
    };
  }

  public async generateBookingCode(): Promise<string> {
    // Bet9ja format: B9 + 5 alphanumeric characters (e.g. B98K4J)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'B9';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }
}
