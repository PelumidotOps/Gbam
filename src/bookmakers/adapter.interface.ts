import { BetLeg, BetSlip, MarketType } from '../models/types.js';

export interface NormalizedMarketMapping {
  marketType: MarketType;
  selection: string;
}

export interface BookmakerAdapter {
  readonly name: string;
  readonly country: string;

  /**
   * Decodes an external booking code into our canonical BetSlip format
   */
  decodeBookingCode(bookingCode: string): Promise<BetSlip>;

  /**
   * Generates a new booking code on this bookmaker platform from canonical BetLegs
   */
  generateBookingCode(legs: BetLeg[]): Promise<string>;

  /**
   * Normalizes bookmaker-specific market representations to canonical format
   */
  normalizeMarket(rawMarketCode: string, rawOutcomeCode: string): NormalizedMarketMapping;

  /**
   * Translates our canonical market representation into this bookmaker's raw identifiers
   */
  toBookmakerMarket(marketType: MarketType, selection: string): { marketId: string; specifier?: string };
}
