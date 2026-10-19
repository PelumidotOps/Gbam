import { describe, expect, it } from 'vitest';
import { BookmakerRegistry } from '../src/bookmakers/registry.js';

describe('BookmakerRegistry & Cross-Conversion', () => {
  it('registers SportyBet and Bet9ja adapters by default', () => {
    const available = BookmakerRegistry.getAvailableBookmakers();
    expect(available).toContain('SportyBet');
    expect(available).toContain('Bet9ja');
  });

  it('converts a SportyBet booking code to Bet9ja', async () => {
    const result = await BookmakerRegistry.convertBookingCode(
      'SportyBet',
      'Bet9ja',
      'BC99ZA'
    );

    expect(result.sourceSlip.bookmaker).toBe('SportyBet');
    expect(result.targetSlip.bookmaker).toBe('Bet9ja');
    expect(result.newBookingCode).toBeDefined();
    expect(result.newBookingCode.startsWith('B9')).toBe(true);
    expect(result.targetSlip.legs.length).toBeGreaterThan(0);
  });
});
