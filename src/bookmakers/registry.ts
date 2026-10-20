import { BetLeg, BetSlip } from '../models/types.js';
import { BookmakerAdapter } from './adapter.interface.js';
import { Bet9jaAdapter } from './bet9ja.adapter.js';
import { BetKingAdapter } from './betking.adapter.js';
import { FootballComAdapter } from './footballcom.adapter.js';
import { MSportAdapter } from './msport.adapter.js';
import { OneXBetAdapter } from './1xbet.adapter.js';
import { BetanoAdapter } from './betano.adapter.js';
import { SportyBetAdapter } from './sportybet.adapter.js';

export class BookmakerRegistry {
  private static adapters: Map<string, BookmakerAdapter> = new Map();

  static {
    // Automatically register all supported Nigerian platforms
    this.register(new SportyBetAdapter());
    this.register(new Bet9jaAdapter());
    this.register(new FootballComAdapter());
    this.register(new BetKingAdapter());
    this.register(new MSportAdapter());
    this.register(new OneXBetAdapter());
    this.register(new BetanoAdapter());
  }

  public static register(adapter: BookmakerAdapter): void {
    const primary = adapter.name.toLowerCase().trim();
    this.adapters.set(primary, adapter);

    // Register common aliases
    if (primary === 'football.com') {
      this.adapters.set('footballcom', adapter);
      this.adapters.set('football', adapter);
    } else if (primary === '1xbet') {
      this.adapters.set('1x', adapter);
      this.adapters.set('onexbet', adapter);
    } else if (primary === 'betking') {
      this.adapters.set('king', adapter);
    } else if (primary === 'sportybet') {
      this.adapters.set('sporty', adapter);
    } else if (primary === 'bet9ja') {
      this.adapters.set('9ja', adapter);
    }
  }

  public static get(bookmakerName: string): BookmakerAdapter {
    const key = bookmakerName.toLowerCase().replace(/[\s\.\-]+/g, '').trim();
    const directKey = bookmakerName.toLowerCase().trim();

    const adapter = this.adapters.get(directKey) || this.adapters.get(key);

    if (!adapter) {
      const available = Array.from(new Set(Array.from(this.adapters.values()).map(a => a.name))).join(', ');
      throw new Error(`Unsupported bookmaker: "${bookmakerName}". Available: ${available}`);
    }

    return adapter;
  }

  public static getAvailableBookmakers(): string[] {
    return Array.from(new Set(Array.from(this.adapters.values()).map(a => a.name)));
  }

  /**
   * Generates booking codes across multiple top Nigerian platforms simultaneously
   */
  public static async getMultiBookingCodes(
    legs: BetLeg[],
    targetPlatforms: string[] = ['SportyBet', 'Football.com', 'BetKing', 'MSport', 'Bet9ja']
  ): Promise<Record<string, string>> {
    const results: Record<string, string> = {};

    await Promise.all(
      targetPlatforms.map(async platform => {
        try {
          const adapter = this.get(platform);
          const code = await adapter.generateBookingCode(legs);
          results[adapter.name] = code;
        } catch {
          // If any single platform fails, skip it gracefully
        }
      })
    );

    return results;
  }

  /**
   * Cross-converts a booking code from one bookmaker to another
   */
  public static async convertBookingCode(
    fromBookmaker: string,
    toBookmaker: string,
    sourceCode: string
  ): Promise<{
    sourceSlip: BetSlip;
    targetSlip: BetSlip;
    newBookingCode: string;
  }> {
    const sourceAdapter = this.get(fromBookmaker);
    const targetAdapter = this.get(toBookmaker);

    // 1. Decode source booking code
    const sourceSlip = await sourceAdapter.decodeBookingCode(sourceCode);

    // 2. Generate new code on the target platform
    const newCode = await targetAdapter.generateBookingCode(sourceSlip.legs);

    const targetSlip: BetSlip = {
      ...sourceSlip,
      bookmaker: targetAdapter.name,
      bookingCode: newCode
    };

    return {
      sourceSlip,
      targetSlip,
      newBookingCode: newCode
    };
  }
}
