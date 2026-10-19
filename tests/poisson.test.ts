import { describe, expect, it } from 'vitest';
import { PoissonModel } from '../src/stats/poisson.js';

describe('PoissonModel', () => {
  it('calculates single poisson probability correctly', () => {
    // For lambda = 2.0, P(X = 0) = e^(-2) approx 0.1353
    const p0 = PoissonModel.poissonProbability(2.0, 0);
    expect(p0).toBeCloseTo(0.1353, 3);

    // P(X = 2) for lambda = 2.0 is (2^2 * e^(-2)) / 2! = 2 * 0.1353 = 0.2707
    const p2 = PoissonModel.poissonProbability(2.0, 2);
    expect(p2).toBeCloseTo(0.2707, 3);
  });

  it('calculates match probabilities where 1X2 sums to 1.0', () => {
    const probs = PoissonModel.calculateMatchProbabilities({
      homeLambda: 2.2,
      awayLambda: 0.8
    });

    const sum1X2 = probs.homeWin + probs.draw + probs.awayWin;
    expect(sum1X2).toBeCloseTo(1.0, 4);

    // Strong home favorite should have homeWin > awayWin
    expect(probs.homeWin).toBeGreaterThan(0.60);
    expect(probs.awayWin).toBeLessThan(0.20);

    // Double chance 1X should be very high
    expect(probs.dc1X).toBeGreaterThan(0.80);

    // Over 0.5 match goals should exceed 90%
    expect(probs.over0_5).toBeGreaterThan(0.90);
  });

  it('correctly identifies heavy favorite scenarios with ~90% probability on safe markets', () => {
    // Elite home team (lambda 2.8) vs weak away team (lambda 0.4)
    const probs = PoissonModel.calculateMatchProbabilities({
      homeLambda: 2.8,
      awayLambda: 0.4
    });

    // Over 0.5 match goals should be > 95%
    expect(probs.over0_5).toBeGreaterThan(0.95);

    // Double chance 1X should be > 90%
    expect(probs.dc1X).toBeGreaterThan(0.90);

    // Over 1.5 match goals should be > 80%
    expect(probs.over1_5).toBeGreaterThan(0.80);
  });

  it('estimates realistic lambdas from historical goal averages', () => {
    const lambdas = PoissonModel.estimateLambdas({
      homeScoredAvg: 2.4,
      homeConcededAvg: 0.8,
      awayScoredAvg: 1.0,
      awayConcededAvg: 2.1,
      leagueAvgGoalsPerTeam: 1.35
    });

    expect(lambdas.homeLambda).toBeGreaterThan(2.0);
    expect(lambdas.awayLambda).toBeLessThan(1.0);
  });
});
