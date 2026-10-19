import { z } from 'zod';

export const SportTypeSchema = z.enum(['FOOTBALL', 'BASKETBALL', 'TENNIS']);
export type SportType = z.infer<typeof SportTypeSchema>;

export const MarketTypeSchema = z.enum([
  'MATCH_RESULT', // 1X2
  'DOUBLE_CHANCE', // 1X, 12, X2
  'OVER_UNDER_GOALS', // Over/Under 0.5, 1.5, 2.5, 3.5, etc.
  'BOTH_TEAMS_TO_SCORE', // GG/NG (Yes/No)
  'DRAW_NO_BET', // 1 or 2 (refund on draw)
  'TEAM_TOTAL_GOALS',
  'HANDICAP'
]);
export type MarketType = z.infer<typeof MarketTypeSchema>;

export const FixtureSchema = z.object({
  id: z.string().min(1),
  sport: SportTypeSchema.default('FOOTBALL'),
  homeTeam: z.string().min(1),
  awayTeam: z.string().min(1),
  league: z.string().min(1),
  country: z.string().optional(),
  kickoffTime: z.string().datetime().or(z.date()),
  status: z.enum(['SCHEDULED', 'IN_PLAY', 'FINISHED', 'POSTPONED']).default('SCHEDULED')
});
export type Fixture = z.infer<typeof FixtureSchema>;

export const BetLegSchema = z.object({
  id: z.string().optional(),
  fixture: FixtureSchema,
  marketType: MarketTypeSchema,
  selection: z.string().min(1), // e.g. "HOME", "DRAW", "AWAY", "1X", "OVER_1_5", "YES"
  odds: z.number().positive().min(1.01),
  bookmakerEventId: z.string().optional(),
  bookmakerMarketId: z.string().optional(),
  specifier: z.string().optional(),
  outcomeId: z.string().optional()
});
export type BetLeg = z.infer<typeof BetLegSchema>;

export const BetSlipSchema = z.object({
  id: z.string().optional(),
  bookmaker: z.string().min(1), // e.g. "SportyBet", "Bet9ja"
  bookingCode: z.string().optional(),
  legs: z.array(BetLegSchema).min(1),
  totalOdds: z.number().positive(),
  stake: z.number().positive().optional(),
  currency: z.string().default('NGN')
});
export type BetSlip = z.infer<typeof BetSlipSchema>;

export const ConfidenceGradeSchema = z.enum(['A+', 'A', 'B', 'C', 'D', 'F']);
export type ConfidenceGrade = z.infer<typeof ConfidenceGradeSchema>;

export const ProbabilityAssessmentSchema = z.object({
  trueProbability: z.number().min(0).max(1), // Mathematically modeled probability
  impliedProbability: z.number().min(0).max(1), // 1 / Odds
  expectedValue: z.number(), // (TrueProb * Odds) - 1
  edge: z.number(), // TrueProb - ImpliedProb
  confidenceGrade: ConfidenceGradeSchema,
  isValueBet: z.boolean(),
  reasoning: z.array(z.string())
});
export type ProbabilityAssessment = z.infer<typeof ProbabilityAssessmentSchema>;

export interface AssessedLeg extends BetLeg {
  assessment: ProbabilityAssessment;
}

export const TrimStrategySchema = z.enum([
  'MAX_PROBABILITY', // Maximizes individual and cumulative probability
  'MAX_EXPECTED_VALUE', // Prioritizes legs with the highest mathematical edge (+EV)
  'TARGET_ODDS', // Optimizes to match a specific target odds threshold (e.g. 10x)
  'MIN_RISK' // Strict filtering (only picks with true probability >= threshold)
]);
export type TrimStrategy = z.infer<typeof TrimStrategySchema>;

export const TrimOptionsSchema = z.object({
  strategy: TrimStrategySchema.default('MAX_PROBABILITY').optional(),
  targetOdds: z.number().positive().optional(),
  targetLegCount: z.number().int().positive().optional(),
  minProbability: z.number().min(0).max(1).optional(),
  minExpectedValue: z.number().optional(),
  maxLegOdds: z.number().positive().optional(),
  allowConflictingFixtures: z.boolean().default(false).optional()
});
export type TrimOptions = z.infer<typeof TrimOptionsSchema>;

export const SplitOptionsSchema = z.object({
  splitCount: z.number().int().min(2).max(10),
  balanceOdds: z.boolean().default(true), // Distributes high and low odds evenly across split tickets
  allowOverlap: z.boolean().default(false)
});
export type SplitOptions = z.infer<typeof SplitOptionsSchema>;
