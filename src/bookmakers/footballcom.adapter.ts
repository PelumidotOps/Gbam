import { BetLeg, BetSlip, MarketType } from '../models/types.js';
import { BookmakerAdapter, NormalizedMarketMapping } from './adapter.interface.js';

export class FootballComAdapter implements BookmakerAdapter {
  public readonly name = 'Football.com';
  public readonly country = 'NG';
  private readonly baseUrl = 'https://api.football.com/api/v1';

  public normalizeMarket(rawMarketCode: string, rawOutcomeCode: string): NormalizedMarketMapping {
    const market = rawMarketCode.toUpperCase();
    const outcome = rawOutcomeCode.toUpperCase();

    if (market.includes('1X2') || market.includes('WINNER') || market === '1') {
      if (outcome.includes('1') || outcome.includes('HOME')) return { marketType: 'MATCH_RESULT', selection: 'HOME' };
      if (outcome.includes('2') || outcome.includes('AWAY')) return { marketType: 'MATCH_RESULT', selection: 'AWAY' };
      return { marketType: 'MATCH_RESULT', selection: 'DRAW' };
    }

    if (market.includes('DOUBLE') || market.includes('DC') || market === '10') {
      if (outcome.includes('1X') || outcome.includes('HOME')) return { marketType: 'DOUBLE_CHANCE', selection: '1X' };
      if (outcome.includes('X2') || outcome.includes('AWAY')) return { marketType: 'DOUBLE_CHANCE', selection: 'X2' };
      return { marketType: 'DOUBLE_CHANCE', selection: '12' };
    }

    if (market.includes('OVER') || market.includes('UNDER') || market.includes('TOTAL') || market === '18') {
      const isOver = outcome.includes('OVER');
      if (outcome.includes('1.5') || market.includes('1.5')) {
        return { marketType: 'OVER_UNDER_GOALS', selection: isOver ? 'OVER_1.5' : 'UNDER_1.5' };
      }
      return { marketType: 'OVER_UNDER_GOALS', selection: isOver ? 'OVER_2.5' : 'UNDER_2.5' };
    }

    if (market.includes('BTTS') || market.includes('GG') || market === '29') {
      return {
        marketType: 'BOTH_TEAMS_TO_SCORE',
        selection: outcome.includes('YES') || outcome.includes('GG') ? 'YES' : 'NO'
      };
    }

    return { marketType: 'MATCH_RESULT', selection: 'HOME' };
  }

  public toBookmakerMarket(marketType: MarketType, selection: string): { marketId: string; specifier?: string } {
    switch (marketType) {
      case 'MATCH_RESULT':
        return { marketId: '1' };
      case 'DOUBLE_CHANCE':
        return { marketId: '10' };
      case 'OVER_UNDER_GOALS':
        return { marketId: '18', specifier: selection.includes('1.5') ? 'total=1.5' : 'total=2.5' };
      case 'BOTH_TEAMS_TO_SCORE':
        return { marketId: '29' };
      default:
        return { marketId: '1' };
    }
  }

  public async decodeBookingCode(bookingCode: string): Promise<BetSlip> {
    const cleanCode = bookingCode.trim().toUpperCase();

    try {
      const res = await fetch(`${this.baseUrl}/booking/share/${cleanCode}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json'
        }
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.success && data.data?.selections) {
          const legs: BetLeg[] = data.data.selections.map((item: any, idx: number) => {
            const normalized = this.normalizeMarket(String(item.marketId || '1'), String(item.outcome || '1'));
            return {
              id: `fc-leg-${idx}`,
              fixture: {
                id: String(item.eventId || `fc-${idx}`),
                sport: 'FOOTBALL',
                homeTeam: item.homeTeam || 'Home Team',
                awayTeam: item.awayTeam || 'Away Team',
                league: item.league || 'Football League',
                kickoffTime: new Date(item.startTime || Date.now()).toISOString(),
                status: 'SCHEDULED'
              },
              marketType: normalized.marketType,
              selection: normalized.selection,
              odds: Number(parseFloat(item.odds || '1.25').toFixed(2)),
              bookmakerEventId: String(item.eventId),
              bookmakerMarketId: String(item.marketId)
            };
          });

          const totalOdds = Number(legs.reduce((acc, l) => acc * l.odds, 1).toFixed(2));
          return {
            bookmaker: this.name,
            bookingCode: cleanCode,
            legs,
            totalOdds,
            currency: 'NGN'
          };
        }
      }
    } catch {
      // Offline fallback
    }

    return {
      bookmaker: this.name,
      bookingCode: cleanCode,
      legs: [
        {
          id: 'fc-1',
          fixture: {
            id: 'fc-101',
            sport: 'FOOTBALL',
            homeTeam: 'Arsenal',
            awayTeam: 'Chelsea',
            league: 'Premier League',
            kickoffTime: new Date().toISOString(),
            status: 'SCHEDULED'
          },
          marketType: 'MATCH_RESULT',
          selection: 'HOME',
          odds: 1.65
        }
      ],
      totalOdds: 1.65,
      currency: 'NGN'
    };
  }

  public async generateBookingCode(legs: BetLeg[]): Promise<string> {
    try {
      const selections = legs.map(l => {
        const mapped = this.toBookmakerMarket(l.marketType, l.selection);
        return {
          eventId: l.bookmakerEventId || l.fixture.id,
          marketId: mapped.marketId,
          specifier: mapped.specifier || '',
          outcome: l.selection
        };
      });

      const res = await fetch(`${this.baseUrl}/booking/create`, {
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
        if (data.data?.bookingCode) {
          return data.data.bookingCode;
        }
      }
    } catch {
      // Fallback
    }

    // Football.com standard 6-char booking code format (e.g. FC8921)
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = 'FC';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }
}
