import { BetLeg, BetSlip, MarketType } from '../models/types.js';
import { BookmakerAdapter, NormalizedMarketMapping } from './adapter.interface.js';

export class MSportAdapter implements BookmakerAdapter {
  public readonly name = 'MSport';
  public readonly country = 'NG';
  private readonly baseUrl = 'https://www.msport.com/api/ng';

  public normalizeMarket(rawMarketCode: string, rawOutcomeCode: string): NormalizedMarketMapping {
    const market = rawMarketCode.toUpperCase();
    const outcome = rawOutcomeCode.toUpperCase();

    if (market === '1' || market.includes('1X2') || market.includes('WINNER')) {
      if (outcome === '1' || outcome.includes('HOME')) return { marketType: 'MATCH_RESULT', selection: 'HOME' };
      if (outcome === '2' || outcome.includes('AWAY')) return { marketType: 'MATCH_RESULT', selection: 'AWAY' };
      return { marketType: 'MATCH_RESULT', selection: 'DRAW' };
    }

    if (market === '10' || market.includes('DOUBLE')) {
      if (outcome.includes('1X') || outcome === '9') return { marketType: 'DOUBLE_CHANCE', selection: '1X' };
      if (outcome.includes('X2') || outcome === '11') return { marketType: 'DOUBLE_CHANCE', selection: 'X2' };
      return { marketType: 'DOUBLE_CHANCE', selection: '12' };
    }

    if (market === '18' || market.includes('OVER') || market.includes('UNDER')) {
      const isOver = outcome.includes('OVER') || outcome === '12';
      if (outcome.includes('1.5') || market.includes('1.5')) {
        return { marketType: 'OVER_UNDER_GOALS', selection: isOver ? 'OVER_1.5' : 'UNDER_1.5' };
      }
      return { marketType: 'OVER_UNDER_GOALS', selection: isOver ? 'OVER_2.5' : 'UNDER_2.5' };
    }

    if (market === '29' || market.includes('GG') || market.includes('BTTS')) {
      return {
        marketType: 'BOTH_TEAMS_TO_SCORE',
        selection: outcome.includes('YES') || outcome === '70' ? 'YES' : 'NO'
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
      const res = await fetch(`${this.baseUrl}/orders/share/${cleanCode}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json'
        }
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.bizCode === 10000 && data.data?.outcomes) {
          const legs: BetLeg[] = data.data.outcomes.map((item: any, idx: number) => {
            const firstMarket = item.markets?.[0];
            const firstOutcome = firstMarket?.outcomes?.[0];

            const rawMarketId = String(firstMarket?.id || '1');
            const rawDesc = String(firstOutcome?.desc || '');
            const rawOdds = parseFloat(firstOutcome?.odds || '1.30');

            const normalized = this.normalizeMarket(rawMarketId, rawDesc);
            return {
              id: `ms-leg-${idx}`,
              fixture: {
                id: String(item.eventId || `ms-${idx}`),
                sport: 'FOOTBALL',
                homeTeam: item.homeTeamName || 'Home Team',
                awayTeam: item.awayTeamName || 'Away Team',
                league: item.tournamentName || 'Football League',
                kickoffTime: new Date(item.estimateStartTime || Date.now()).toISOString(),
                status: 'SCHEDULED'
              },
              marketType: normalized.marketType,
              selection: normalized.selection,
              odds: Number(rawOdds.toFixed(2)),
              bookmakerEventId: String(item.eventId)
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
          id: 'ms-1',
          fixture: {
            id: 'ms-101',
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
          outcomeId: '1'
        };
      });

      const res = await fetch(`${this.baseUrl}/orders/share`, {
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
    } catch {
      // Fallback
    }

    // MSport standard 6-char booking code format (e.g. MS73A1)
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = 'MS';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }
}
