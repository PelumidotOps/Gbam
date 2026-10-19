import {
  AssessedLeg,
  BetSlip,
  TrimOptions,
  TrimStrategy
} from '../models/types.js';

export interface TrimmedResult {
  keptLegs: AssessedLeg[];
  droppedLegs: AssessedLeg[];
  originalTotalOdds: number;
  newTotalOdds: number;
  cumulativeTrueProbability: number;
  averageLegProbability: number;
  summary: string;
}

export class TicketTrimmer {
  /**
   * Trims an assessed bet slip based on mathematical and risk options
   */
  public static trim(
    legs: AssessedLeg[],
    options: TrimOptions = { strategy: 'MAX_PROBABILITY' }
  ): TrimmedResult {
    if (!legs || legs.length === 0) {
      throw new Error('Cannot trim an empty list of bet legs.');
    }

    const originalOdds = Number(
      legs.reduce((acc, leg) => acc * leg.odds, 1).toFixed(2)
    );

    // Step 1: Filter out hard constraint violations
    let candidates = [...legs];

    // Filter by max individual leg odds
    if (options.maxLegOdds && options.maxLegOdds > 1.0) {
      candidates = candidates.filter(leg => leg.odds <= options.maxLegOdds!);
    }

    // Filter by minimum probability threshold
    if (options.minProbability !== undefined) {
      candidates = candidates.filter(
        leg => leg.assessment.trueProbability >= options.minProbability!
      );
    }

    // Filter by minimum expected value
    if (options.minExpectedValue !== undefined) {
      candidates = candidates.filter(
        leg => leg.assessment.expectedValue >= options.minExpectedValue!
      );
    }

    // Remove conflicting fixture selections unless explicitly allowed
    if (!options.allowConflictingFixtures) {
      candidates = this.deduplicateByFixture(candidates);
    }

    if (candidates.length === 0) {
      // If strict filters eliminated everything, fallback to the top 2 highest probability legs
      const sortedByProb = [...legs].sort(
        (a, b) => b.assessment.trueProbability - a.assessment.trueProbability
      );
      candidates = sortedByProb.slice(0, Math.min(2, legs.length));
    }

    // Step 2: Apply strategy sorting / selection
    let selected: AssessedLeg[] = [];

    switch (options.strategy) {
      case 'TARGET_ODDS':
        selected = this.optimizeForTargetOdds(
          candidates,
          options.targetOdds || 10.0,
          options.targetLegCount
        );
        break;

      case 'MAX_EXPECTED_VALUE':
        selected = this.selectTopByMetric(
          candidates,
          (a, b) => b.assessment.expectedValue - a.assessment.expectedValue,
          options.targetLegCount,
          options.targetOdds
        );
        break;

      case 'MIN_RISK':
      case 'MAX_PROBABILITY':
      default:
        selected = this.selectTopByMetric(
          candidates,
          (a, b) => b.assessment.trueProbability - a.assessment.trueProbability,
          options.targetLegCount,
          options.targetOdds
        );
        break;
    }

    // Determine dropped legs
    const selectedIds = new Set(
      selected.map(s => `${s.fixture.id}-${s.selection}-${s.marketType}`)
    );
    const dropped = legs.filter(
      l => !selectedIds.has(`${l.fixture.id}-${l.selection}-${l.marketType}`)
    );

    // Calculate metrics
    const newOdds = Number(
      selected.reduce((acc, leg) => acc * leg.odds, 1).toFixed(2)
    );
    const cumulativeProb = Number(
      selected
        .reduce((acc, leg) => acc * leg.assessment.trueProbability, 1)
        .toFixed(4)
    );
    const avgProb = Number(
      (
        selected.reduce((acc, leg) => acc + leg.assessment.trueProbability, 0) /
        (selected.length || 1)
      ).toFixed(4)
    );

    const summary =
      `Trimmed from ${legs.length} legs (${originalOdds}x) to ${selected.length} legs (${newOdds}x). ` +
      `Average leg probability: ${(avgProb * 100).toFixed(1)}%. ` +
      `Cumulative slip probability: ${(cumulativeProb * 100).toFixed(2)}%.`;

    return {
      keptLegs: selected,
      droppedLegs: dropped,
      originalTotalOdds: originalOdds,
      newTotalOdds: newOdds,
      cumulativeTrueProbability: cumulativeProb,
      averageLegProbability: avgProb,
      summary
    };
  }

  /**
   * Deduplicates by fixture ID, keeping the leg with higher probability
   */
  private static deduplicateByFixture(legs: AssessedLeg[]): AssessedLeg[] {
    const fixtureMap = new Map<string, AssessedLeg>();

    for (const leg of legs) {
      const existing = fixtureMap.get(leg.fixture.id);
      if (!existing || leg.assessment.trueProbability > existing.assessment.trueProbability) {
        fixtureMap.set(leg.fixture.id, leg);
      }
    }

    return Array.from(fixtureMap.values());
  }

  /**
   * Sorts by comparator and greedily includes legs until targetLegCount or targetOdds is reached
   */
  private static selectTopByMetric(
    candidates: AssessedLeg[],
    comparator: (a: AssessedLeg, b: AssessedLeg) => number,
    targetCount?: number,
    targetOdds?: number
  ): AssessedLeg[] {
    const sorted = [...candidates].sort(comparator);

    if (targetCount && targetCount > 0) {
      return sorted.slice(0, Math.min(targetCount, sorted.length));
    }

    if (targetOdds && targetOdds > 1.0) {
      const result: AssessedLeg[] = [];
      let currentOdds = 1.0;

      for (const leg of sorted) {
        if (result.length === 0 || currentOdds * leg.odds <= targetOdds * 1.25) {
          result.push(leg);
          currentOdds *= leg.odds;
          if (currentOdds >= targetOdds * 0.95) break;
        }
      }
      return result.length > 0 ? result : [sorted[0]];
    }

    return sorted;
  }

  /**
   * Knapsack Subset Solver:
   * Finds the combination of legs that lands closest to targetOdds while maximizing cumulative probability.
   */
  private static optimizeForTargetOdds(
    candidates: AssessedLeg[],
    targetOdds: number,
    targetCount?: number
  ): AssessedLeg[] {
    // If candidate set is small (<= 20), run combinatorial branch-and-bound
    if (candidates.length <= 18) {
      let bestCombination: AssessedLeg[] = [candidates[0]];
      let bestDistance = Infinity;
      let bestProb = -1;

      const totalSubsets = 1 << candidates.length;

      for (let mask = 1; mask < totalSubsets; mask++) {
        const subset: AssessedLeg[] = [];
        let odds = 1.0;
        let prob = 1.0;

        for (let i = 0; i < candidates.length; i++) {
          if ((mask & (1 << i)) !== 0) {
            subset.push(candidates[i]);
            odds *= candidates[i].odds;
            prob *= candidates[i].assessment.trueProbability;
          }
        }

        if (targetCount && subset.length !== targetCount) continue;

        const distance = Math.abs(odds - targetOdds);

        // Prioritize landing closest to target odds, breaking ties by highest probability
        if (distance < bestDistance) {
          bestDistance = distance;
          bestProb = prob;
          bestCombination = subset;
        } else if (Math.abs(distance - bestDistance) < 0.05 && prob > bestProb) {
          bestDistance = distance;
          bestProb = prob;
          bestCombination = subset;
        }
      }

      return bestCombination;
    }

    // For larger candidate sets, use probability-ranked greedy approach
    return this.selectTopByMetric(
      candidates,
      (a, b) => b.assessment.trueProbability - a.assessment.trueProbability,
      targetCount,
      targetOdds
    );
  }
}
