import { BetSlip } from '../models/types.js';
import { BookmakerAdapter } from './adapter.interface.js';
import { Bet9jaAdapter } from './bet9ja.adapter.js';
import { SportyBetAdapter } from './sportybet.adapter.js';

export class BookmakerRegistry {
  private static adapters: Map<string, BookmakerAdapter> = new Map();

  static {
    // Automatically register default adapters
    this.register(new SportyBetAdapter());
    this.register(new Bet9jaAdapter());
  }

  public static register(adapter: BookmakerAdapter): void {
    this.adapters.set(adapter.name.toLowerCase().trim(), adapter);
  }

  public static get(bookmakerName: string): BookmakerAdapter {
    const key = bookmakerName.toLowerCase().trim();
    const adapter = this.adapters.get(key);

    if (!adapter) {
      const available = Array.from(this.adapters.values()).map(a => a.name).join(', ');
      throw new Error(`Unsupported bookmaker: "${bookmakerName}". Available: ${available}`);
    }

    return adapter;
  }

  public static getAvailableBookmakers(): string[] {
    return Array.from(this.adapters.values()).map(a => a.name);
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
