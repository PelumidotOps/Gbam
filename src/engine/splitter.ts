import { BetLeg, SplitOptions } from '../models/types.js';

export interface SplitTicketResult<T extends BetLeg = BetLeg> {
  ticketIndex: number;
  legs: T[];
  totalOdds: number;
  legCount: number;
}

export class TicketSplitter {
  /**
   * Splits an array of bet legs into K balanced tickets
   */
  public static split<T extends BetLeg>(
    legs: T[],
    options: SplitOptions = { splitCount: 2, balanceOdds: true, allowOverlap: false }
  ): Array<SplitTicketResult<T>> {
    const { splitCount, balanceOdds } = options;

    if (!legs || legs.length < splitCount) {
      throw new Error(
        `Cannot split ${legs?.length || 0} legs into ${splitCount} tickets. Need at least ${splitCount} legs.`
      );
    }

    // Initialize buckets
    const buckets: T[][] = Array.from({ length: splitCount }, () => []);

    if (balanceOdds) {
      // Sort legs descending by odds
      const sorted = [...legs].sort((a, b) => b.odds - a.odds);

      // Snake / Serpentine round-robin distribution to balance odds
      // e.g. for 3 buckets: 0, 1, 2, 2, 1, 0, 0, 1, 2...
      let forward = true;
      let currentIndex = 0;

      for (const leg of sorted) {
        buckets[currentIndex].push(leg);

        if (forward) {
          if (currentIndex === splitCount - 1) {
            forward = false;
          } else {
            currentIndex++;
          }
        } else {
          if (currentIndex === 0) {
            forward = true;
          } else {
            currentIndex--;
          }
        }
      }
    } else {
      // Chunk sequentially
      const chunkSize = Math.ceil(legs.length / splitCount);
      for (let i = 0; i < legs.length; i++) {
        const bucketIndex = Math.min(Math.floor(i / chunkSize), splitCount - 1);
        buckets[bucketIndex].push(legs[i]);
      }
    }

    return buckets.map((ticketLegs, idx) => {
      const totalOdds = Number(
        ticketLegs.reduce((acc, l) => acc * l.odds, 1).toFixed(2)
      );
      return {
        ticketIndex: idx + 1,
        legs: ticketLegs,
        totalOdds,
        legCount: ticketLegs.length
      };
    });
  }
}
