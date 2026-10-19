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
    const trueProb = this.resolveMarketProbability(leg, probs);
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
    const sel = leg.selection.trim().toUpperCase();

    switch (leg.marketType) {
      case 'MATCH_RESULT':
        if (sel === 'HOME' || sel === '1') return probs.homeWin;
        if (sel === 'DRAW' || sel === 'X') return probs.draw;
        if (sel === 'AWAY' || sel === '2') return probs.awayWin;
        break;

      case 'DOUBLE_CHANCE':
        if (sel === '1X' || sel === 'HOME_DRAW') return probs.dc1X;
        if (sel === 'X2' || sel === 'DRAW_AWAY') return probs.dcX2;
        if (sel === '12' || sel === 'HOME_AWAY') return probs.dc12;
        break;

      case 'OVER_UNDER_GOALS':
        if (sel.includes('OVER_0.5') || sel.includes('OVER_0_5')) return probs.over0_5;
        if (sel.includes('UNDER_0.5') || sel.includes('UNDER_0_5')) return probs.under0_5;
        if (sel.includes('OVER_1.5') || sel.includes('OVER_1_5')) return probs.over1_5;
        if (sel.includes('UNDER_1.5') || sel.includes('UNDER_1_5')) return probs.under1_5;
        if (sel.includes('OVER_2.5') || sel.includes('OVER_2_5')) return probs.over2_5;
        if (sel.includes('UNDER_2.5') || sel.includes('UNDER_2_5')) return probs.under2_5;
        if (sel.includes('OVER_3.5') || sel.includes('OVER_3_5')) return probs.over3_5;
        if (sel.includes('UNDER_3.5') || sel.includes('UNDER_3_5')) return probs.under3_5;
        break;

      case 'BOTH_TEAMS_TO_SCORE':
        if (sel === 'YES' || sel === 'GG') return probs.bttsYes;
        if (sel === 'NO' || sel === 'NG') return probs.bttsNo;
        break;

      case 'DRAW_NO_BET':
        if (sel === 'HOME' || sel === '1') return probs.dnbHome;
        if (sel === 'AWAY' || sel === '2') return probs.dnbAway;
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
