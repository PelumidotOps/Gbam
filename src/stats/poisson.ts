/**
 * Bivariate Poisson Match Modeling Engine
 * 
 * Computes exact match outcome probabilities based on team attacking and defending ratings
 * or expected goals (xG / lambda parameters).
 */

export interface MatchLambda {
  homeLambda: number; // Expected goals for home team
  awayLambda: number; // Expected goals for away team
}

export interface ModeledProbabilities {
  // 1X2 Match Result
  homeWin: number;
  draw: number;
  awayWin: number;

  // Double Chance
  dc1X: number;
  dcX2: number;
  dc12: number;

  // Over / Under Goals
  over0_5: number;
  under0_5: number;
  over1_5: number;
  under1_5: number;
  over2_5: number;
  under2_5: number;
  over3_5: number;
  under3_5: number;

  // Both Teams To Score (BTTS / GG / NG)
  bttsYes: number;
  bttsNo: number;

  // Draw No Bet (prob given non-draw)
  dnbHome: number;
  dnbAway: number;

  // Most probable exact scorelines [home, away, prob]
  topScores: Array<{ home: number; away: number; probability: number }>;
}

export class PoissonModel {
  private static readonly MAX_GOALS = 10;

  /**
   * Calculates log factorial using Ramanujan / lookup approximation
   */
  private static logFactorial(n: number): number {
    let result = 0;
    for (let i = 2; i <= n; i++) {
      result += Math.log(i);
    }
    return result;
  }

  /**
   * Computes P(X = k) for a Poisson distribution with parameter lambda
   */
  public static poissonProbability(lambda: number, k: number): number {
    if (lambda <= 0) return k === 0 ? 1 : 0;
    if (k < 0) return 0;

    // Use log-space calculation to prevent underflow/overflow:
    // log(P) = k * log(lambda) - lambda - log(k!)
    const logProb = k * Math.log(lambda) - lambda - this.logFactorial(k);
    return Math.exp(logProb);
  }

  /**
   * Simulates full scoreline matrix (up to MAX_GOALS x MAX_GOALS)
   * and derives all standard betting market probabilities.
   */
  public static calculateMatchProbabilities(lambdas: MatchLambda): ModeledProbabilities {
    const { homeLambda, awayLambda } = lambdas;

    if (homeLambda <= 0 || awayLambda <= 0) {
      throw new Error(`Lambdas must be positive numbers. Received home: ${homeLambda}, away: ${awayLambda}`);
    }

    // Precalculate Poisson probabilities for 0..MAX_GOALS
    const pHome: number[] = [];
    const pAway: number[] = [];

    for (let g = 0; g <= this.MAX_GOALS; g++) {
      pHome.push(this.poissonProbability(homeLambda, g));
      pAway.push(this.poissonProbability(awayLambda, g));
    }

    // Build bivariate probability matrix M[homeGoals][awayGoals]
    const matrix: number[][] = [];
    let homeWin = 0;
    let draw = 0;
    let awayWin = 0;

    let over0_5 = 0;
    let over1_5 = 0;
    let over2_5 = 0;
    let over3_5 = 0;

    let bttsYes = 0;

    const scoreList: Array<{ home: number; away: number; probability: number }> = [];

    for (let h = 0; h <= this.MAX_GOALS; h++) {
      matrix[h] = [];
      for (let a = 0; a <= this.MAX_GOALS; a++) {
        const prob = pHome[h] * pAway[a];
        matrix[h][a] = prob;

        scoreList.push({ home: h, away: a, probability: prob });

        // 1X2 distribution
        if (h > a) homeWin += prob;
        else if (h === a) draw += prob;
        else awayWin += prob;

        // Goals totals
        const totalGoals = h + a;
        if (totalGoals > 0.5) over0_5 += prob;
        if (totalGoals > 1.5) over1_5 += prob;
        if (totalGoals > 2.5) over2_5 += prob;
        if (totalGoals > 3.5) over3_5 += prob;

        // Both Teams to Score
        if (h > 0 && a > 0) bttsYes += prob;
      }
    }

    // Normalize 1X2 in case of truncated tail (negligible, but ensures exact sum = 1.0)
    const sum1X2 = homeWin + draw + awayWin;
    homeWin /= sum1X2;
    draw /= sum1X2;
    awayWin /= sum1X2;

    // Double chance
    const dc1X = Math.min(1, homeWin + draw);
    const dcX2 = Math.min(1, awayWin + draw);
    const dc12 = Math.min(1, homeWin + awayWin);

    // Draw no bet (relative probability conditional on a non-draw)
    const nonDraw = homeWin + awayWin;
    const dnbHome = nonDraw > 0 ? homeWin / nonDraw : 0.5;
    const dnbAway = nonDraw > 0 ? awayWin / nonDraw : 0.5;

    // Sort scorelines by highest probability
    scoreList.sort((a, b) => b.probability - a.probability);

    return {
      homeWin,
      draw,
      awayWin,
      dc1X,
      dcX2,
      dc12,
      over0_5,
      under0_5: Math.max(0, 1 - over0_5),
      over1_5,
      under1_5: Math.max(0, 1 - over1_5),
      over2_5,
      under2_5: Math.max(0, 1 - over2_5),
      over3_5,
      under3_5: Math.max(0, 1 - over3_5),
      bttsYes,
      bttsNo: Math.max(0, 1 - bttsYes),
      dnbHome,
      dnbAway,
      topScores: scoreList.slice(0, 5)
    };
  }

  /**
   * Estimates lambda parameters based on historical team statistics:
   * - homeScoredAvg, homeConcededAvg
   * - awayScoredAvg, awayConcededAvg
   * - leagueAverageGoalsPerTeam
   */
  public static estimateLambdas(params: {
    homeScoredAvg: number;
    homeConcededAvg: number;
    awayScoredAvg: number;
    awayConcededAvg: number;
    leagueAvgGoalsPerTeam?: number;
  }): MatchLambda {
    const leagueAvg = params.leagueAvgGoalsPerTeam || 1.35; // Standard European league benchmark

    // Home Attack Strength * Away Defence Weakness * League Average
    const homeAttackStrength = params.homeScoredAvg / leagueAvg;
    const awayDefenceWeakness = params.awayConcededAvg / leagueAvg;
    const homeLambda = Math.max(0.2, homeAttackStrength * awayDefenceWeakness * leagueAvg);

    // Away Attack Strength * Home Defence Weakness * League Average
    const awayAttackStrength = params.awayScoredAvg / leagueAvg;
    const homeDefenceWeakness = params.homeConcededAvg / leagueAvg;
    const awayLambda = Math.max(0.2, awayAttackStrength * homeDefenceWeakness * leagueAvg);

    return {
      homeLambda: Number(homeLambda.toFixed(2)),
      awayLambda: Number(awayLambda.toFixed(2))
    };
  }
}
