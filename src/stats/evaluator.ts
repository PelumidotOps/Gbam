import {
  BetLeg,
  ConfidenceGrade,
  ProbabilityAssessment
} from '../models/types.js';
import { ModeledProbabilities, PoissonModel } from './poisson.js';

export class BetEvaluator {
  /**
   * Evaluates a single bet leg against modeled probabilities
   */
  public static evaluateLeg(
    leg: BetLeg,
    probs: ModeledProbabilities
  ): ProbabilityAssessment {
    // Market consensus fair probability derived from live bookmaker odds (removing margin)
    const marketFairProb = Math.min(0.96, Math.max(0.04, (1 / leg.odds) * 0.945));
    let trueProb = marketFairProb;

    if (probs) {
      const modelProb = this.resolveMarketProbability(leg, probs);
      if (modelProb > 0.05) {
        // Harmonize statistical model with market consensus fair probability
        trueProb = Number((0.60 * marketFairProb + 0.40 * modelProb).toFixed(4));
      }
    }

    const impliedProb = 1 / leg.odds;
    const expectedValue = trueProb * leg.odds - 1;
    const edge = trueProb - impliedProb;
    const isValueBet = expectedValue > 0.02; // At least +2% EV

    const confidenceGrade = this.assignGrade(trueProb, expectedValue);
    const reasoning = this.buildReasoning(leg, trueProb, impliedProb, expectedValue, edge);

    return {
      trueProbability: Number(trueProb.toFixed(4)),
      impliedProbability: Number(impliedProb.toFixed(4)),
      expectedValue: Number(expectedValue.toFixed(4)),
      edge: Number(edge.toFixed(4)),
      confidenceGrade,
      isValueBet,
      reasoning
    };
  }

  /**
   * Maps market type and selection string to the exact modeled probability
   */
  public static resolveMarketProbability(
    leg: BetLeg,
    probs: ModeledProbabilities
  ): number {
    const sel = leg.selection.trim().toUpperCase().replace(/[\s\.\-]+/g, '_');

    switch (leg.marketType) {
      case 'MATCH_RESULT':
        if (sel === 'HOME' || sel === '1' || sel.includes('HOME')) return probs.homeWin;
        if (sel === 'DRAW' || sel === 'X' || sel.includes('DRAW')) return probs.draw;
        if (sel === 'AWAY' || sel === '2' || sel.includes('AWAY')) return probs.awayWin;
        break;

      case 'DOUBLE_CHANCE':
        if (sel === '1X' || sel.includes('1X') || sel.includes('HOME_DRAW') || sel.includes('HOME_OR_DRAW')) return probs.dc1X;
        if (sel === 'X2' || sel.includes('X2') || sel.includes('DRAW_AWAY') || sel.includes('DRAW_OR_AWAY')) return probs.dcX2;
        if (sel === '12' || sel.includes('12') || sel.includes('HOME_AWAY') || sel.includes('HOME_OR_AWAY')) return probs.dc12;
        break;

      case 'OVER_UNDER_GOALS':
        if (sel.includes('OVER_0_5') || sel.includes('OVER_05')) return probs.over0_5;
        if (sel.includes('UNDER_0_5') || sel.includes('UNDER_05')) return probs.under0_5;
        if (sel.includes('OVER_1_5') || sel.includes('OVER_15')) return probs.over1_5;
        if (sel.includes('UNDER_1_5') || sel.includes('UNDER_15')) return probs.under1_5;
        if (sel.includes('OVER_2_5') || sel.includes('OVER_25')) return probs.over2_5;
        if (sel.includes('UNDER_2_5') || sel.includes('UNDER_25')) return probs.under2_5;
        if (sel.includes('OVER_3_5') || sel.includes('OVER_35')) return probs.over3_5;
        if (sel.includes('UNDER_3_5') || sel.includes('UNDER_35')) return probs.under3_5;
        break;

      case 'BOTH_TEAMS_TO_SCORE':
        if (sel === 'YES' || sel === 'GG' || sel.includes('YES')) return probs.bttsYes;
        if (sel === 'NO' || sel === 'NG' || sel.includes('NO')) return probs.bttsNo;
        break;

      case 'DRAW_NO_BET':
        if (sel === 'HOME' || sel === '1' || sel.includes('HOME')) return probs.dnbHome;
        if (sel === 'AWAY' || sel === '2' || sel.includes('AWAY')) return probs.dnbAway;
        break;
    }

    // Fallback: estimate from odds with standard 6% bookmaker vigorish assumption
    const fallbackProb = 1 / leg.odds * 0.94;
    return Math.max(0.01, Math.min(0.99, fallbackProb));
  }

  /**
   * Assigns an actionable confidence grade
   */
  private static assignGrade(prob: number, ev: number): ConfidenceGrade {
    if (prob >= 0.85 && ev >= 0.03) return 'A+';
    if (prob >= 0.80 && ev >= -0.02) return 'A';
    if (prob >= 0.70 && ev >= -0.05) return 'B';
    if (prob >= 0.55 && ev >= -0.10) return 'C';
    if (prob >= 0.40) return 'D';
    return 'F';
  }

  /**
   * Generates analytical human-readable bullet points
   */
  private static buildReasoning(
    leg: BetLeg,
    trueProb: number,
    impliedProb: number,
    ev: number,
    edge: number
  ): string[] {
    const notes: string[] = [];
    const pct = (val: number) => `${(val * 100).toFixed(1)}%`;

    notes.push(
      `Model True Probability: ${pct(trueProb)} vs Bookmaker Implied: ${pct(impliedProb)}`
    );

    if (edge > 0.05) {
      notes.push(`Significant positive edge (+${pct(edge)}) detected over bookmaker price.`);
    } else if (edge < -0.05) {
      notes.push(`Negative edge (${pct(edge)}). Odds are unfavorable relative to mathematical risk.`);
    }

    if (ev > 0.05) {
      notes.push(`Positive Expected Value (+${pct(ev)} EV) for long-term expectation.`);
    } else if (ev < -0.08) {
      notes.push(`Negative EV (${pct(ev)}). High bookmaker vigorish/tax.`);
    }

    if (trueProb >= 0.88) {
      notes.push('Qualifies for Ultra-High Probability / Low-Risk threshold.');
    }

    return notes;
  }

  /**
   * Computes fractional Kelly Criterion stake sizing recommendation
   * @param fraction Default 0.25 (Quarter Kelly for bankroll preservation)
   */
  public static calculateKellyStake(
    trueProbability: number,
    odds: number,
    fraction: number = 0.25
  ): number {
    const b = odds - 1;
    const p = trueProbability;
    const q = 1 - p;

    if (b <= 0) return 0;
    const fullKelly = (b * p - q) / b;

    if (fullKelly <= 0) return 0;
    const scaled = fullKelly * fraction;
    return Number(Math.min(0.05, Math.max(0, scaled)).toFixed(4)); // Cap single bet at 5% bankroll
  }
}
