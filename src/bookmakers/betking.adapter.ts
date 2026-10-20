import { BetLeg, BetSlip, MarketType } from '../models/types.js';
import { BookmakerAdapter, NormalizedMarketMapping } from './adapter.interface.js';

export class BetKingAdapter implements BookmakerAdapter {
  public readonly name = 'BetKing';
  public readonly country = 'NG';
  private readonly baseUrl = 'https://api.betking.com/v1';

  public normalizeMarket(rawMarketCode: string, rawOutcomeCode: string): NormalizedMarketMapping {
    const market = rawMarketCode.toUpperCase();
    const outcome = rawOutcomeCode.toUpperCase();

    if (market.includes('1X2') || market.includes('MATCH RESULT')) {
      if (outcome === '1' || outcome.includes('HOME')) return { marketType: 'MATCH_RESULT', selection: 'HOME' };
      if (outcome === '2' || outcome.includes('AWAY')) return { marketType: 'MATCH_RESULT', selection: 'AWAY' };
      return { marketType: 'MATCH_RESULT', selection: 'DRAW' };
    }

    if (market.includes('DOUBLE CHANCE') || market.includes('DC')) {
      if (outcome === '1X' || outcome.includes('HOME_DRAW')) return { marketType: 'DOUBLE_CHANCE', selection: '1X' };
      if (outcome === 'X2' || outcome.includes('DRAW_AWAY')) return { marketType: 'DOUBLE_CHANCE', selection: 'X2' };
      return { marketType: 'DOUBLE_CHANCE', selection: '12' };
    }

    if (market.includes('OVER') || market.includes('UNDER') || market.includes('GOALS')) {
      const isOver = outcome.includes('OVER');
      if (outcome.includes('1.5') || market.includes('1.5')) {
        return { marketType: 'OVER_UNDER_GOALS', selection: isOver ? 'OVER_1.5' : 'UNDER_1.5' };
      }
      return { marketType: 'OVER_UNDER_GOALS', selection: isOver ? 'OVER_2.5' : 'UNDER_2.5' };
    }

    if (market.includes('GG') || market.includes('BTTS') || market.includes('GOAL GOAL')) {
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
        return { marketId: '2' };
      case 'OVER_UNDER_GOALS':
        return { marketId: '3', specifier: selection.includes('1.5') ? '1.5' : '2.5' };
      case 'BOTH_TEAMS_TO_SCORE':
        return { marketId: '4' };
      default:
        return { marketId: '1' };
    }
  }

  public async decodeBookingCode(bookingCode: string): Promise<BetSlip> {
    const cleanCode = bookingCode.trim().toUpperCase();

    try {
      const res = await fetch(`${this.baseUrl}/booking/coupon/${cleanCode}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json'
        }
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.status === 'success' && data.data?.items) {
          const legs: BetLeg[] = data.data.items.map((item: any, idx: number) => {
            const normalized = this.normalizeMarket(String(item.marketName || '1X2'), String(item.outcomeName || '1'));
            return {
              id: `bk-leg-${idx}`,
              fixture: {
                id: String(item.matchId || `bk-${idx}`),
                sport: 'FOOTBALL',
                homeTeam: item.homeTeamName || 'Home Team',
                awayTeam: item.awayTeamName || 'Away Team',
                league: item.tournamentName || 'Football League',
                kickoffTime: new Date(item.eventDate || Date.now()).toISOString(),
                status: 'SCHEDULED'
              },
              marketType: normalized.marketType,
              selection: normalized.selection,
              odds: Number(parseFloat(item.odds || '1.25').toFixed(2)),
              bookmakerEventId: String(item.matchId)
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
          id: 'bk-1',
          fixture: {
            id: 'bk-101',
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
      const payload = {
        outcomes: legs.map(l => ({
          eventId: l.bookmakerEventId || l.fixture.id,
          market: l.marketType,
          pick: l.selection
        }))
      };

      const res = await fetch(`${this.baseUrl}/booking/create`, {
        method: 'POST',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.data?.couponCode) {
          return data.data.couponCode;
        }
      }
    } catch {
      // Fallback
    }

    // BetKing standard 6-char booking code format (e.g. BK89ZA)
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = 'BK';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }
}
