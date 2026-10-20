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

    // Enforce default safety floor for trimming: prioritize legs with >= 70% confidence
    const minProb = options.minProbability ?? 0.70;
    const safeCandidates = candidates.filter(leg => leg.assessment.trueProbability >= minProb);
    if (safeCandidates.length >= 2) {
      candidates = safeCandidates;
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
   * Finds the combination of legs that lands closest to targetOdds while strictly maximizing cumulative win probability.
   */
  private static optimizeForTargetOdds(
    candidates: AssessedLeg[],
    targetOdds: number,
    targetCount?: number
  ): AssessedLeg[] {
    if (candidates.length === 0) return [];
    if (candidates.length === 1) return candidates;

    // Deduplicate by fixture ID and sort by true probability descending (safest first)
    const sorted = [...candidates].sort(
      (a, b) => b.assessment.trueProbability - a.assessment.trueProbability || a.odds - b.odds
    );

    // If explicit target leg count is requested, return top safest legs of that count
    if (targetCount && targetCount > 0) {
      return sorted.slice(0, Math.min(targetCount, sorted.length));
    }

    // Multi-seed heuristic knapsack:
    // Tests combinations starting from different top-tier seeds to find the optimal cumulative probability
    let bestCombination: AssessedLeg[] = [];
    let bestDiff = Infinity;
    let bestProb = -1;

    const seedCount = Math.min(sorted.length, 8);
    for (let s = 0; s < seedCount; s++) {
      const currentSlip: AssessedLeg[] = [];
      const usedFixtures = new Set<string>();
      let currentOdds = 1.0;

      // Add starting seed
      currentSlip.push(sorted[s]);
      usedFixtures.add(sorted[s].fixture.id);
      currentOdds *= sorted[s].odds;

      // Greedily add next safest available legs
      for (let i = 0; i < sorted.length; i++) {
        const candidate = sorted[i];
        if (usedFixtures.has(candidate.fixture.id)) continue;

        // Check if adding this leg would overshoot target odds too much
        if (currentOdds * candidate.odds <= targetOdds * 1.35 || currentOdds < targetOdds * 0.88) {
          currentSlip.push(candidate);
          usedFixtures.add(candidate.fixture.id);
          currentOdds *= candidate.odds;

          // If we reached near the target odds, this seed has achieved its goal
          if (currentOdds >= targetOdds * 0.90) {
            break;
          }
        }
      }

      // Calculate score for this combination
      const diff = Math.abs(currentOdds - targetOdds);
      const cumProb = currentSlip.reduce((acc, l) => acc * l.assessment.trueProbability, 1);

      // Prioritize proximity to target odds and higher cumulative probability
      if (
        (diff < bestDiff && (currentSlip.length >= 2 || targetOdds <= 1.5)) ||
        (Math.abs(diff - bestDiff) < 1.0 && cumProb > bestProb)
      ) {
        bestDiff = diff;
        bestProb = cumProb;
        bestCombination = [...currentSlip];
      }
    }

    // Guarantee that we don't return 1 leg if targetOdds > 2.0 and more candidates exist
    if (bestCombination.length <= 1 && sorted.length >= 2 && targetOdds > 1.8) {
      const fallback: AssessedLeg[] = [];
      let accOdds = 1.0;
      for (const l of sorted) {
        fallback.push(l);
        accOdds *= l.odds;
        if (accOdds >= targetOdds * 0.90 && fallback.length >= 2) break;
      }
      return fallback;
    }

    return bestCombination.length > 0 ? bestCombination : [sorted[0]];
  }
}
