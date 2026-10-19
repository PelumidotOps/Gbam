import { describe, expect, it } from 'vitest';
import { TicketTrimmer } from '../src/engine/trimmer.js';
import { AssessedLeg } from '../src/models/types.js';

describe('TicketTrimmer', () => {
  const sampleAssessedLegs: AssessedLeg[] = [
    {
      id: 'leg-1',
      fixture: {
        id: 'fix-1',
        sport: 'FOOTBALL',
        homeTeam: 'Arsenal',
        awayTeam: 'Luton',
        league: 'EPL',
        kickoffTime: new Date().toISOString(),
        status: 'SCHEDULED'
      },
      marketType: 'MATCH_RESULT',
      selection: 'HOME',
      odds: 1.25,
      assessment: {
        trueProbability: 0.88,
        impliedProbability: 0.80,
        expectedValue: 0.10,
        edge: 0.08,
        confidenceGrade: 'A+',
        isValueBet: true,
        reasoning: ['Dominant home form']
      }
    },
    {
      id: 'leg-2',
      fixture: {
        id: 'fix-2',
        sport: 'FOOTBALL',
        homeTeam: 'Bayern',
        awayTeam: 'Bochum',
        league: 'Bundesliga',
        kickoffTime: new Date().toISOString(),
        status: 'SCHEDULED'
      },
      marketType: 'OVER_UNDER_GOALS',
      selection: 'OVER_1.5',
      odds: 1.15,
      assessment: {
        trueProbability: 0.92,
        impliedProbability: 0.869,
        expectedValue: 0.058,
        edge: 0.051,
        confidenceGrade: 'A+',
        isValueBet: true,
        reasoning: ['Over 90% goal expectation']
      }
    },
    {
      id: 'leg-3',
      fixture: {
        id: 'fix-3',
        sport: 'FOOTBALL',
        homeTeam: 'Everton',
        awayTeam: 'Brentford',
        league: 'EPL',
        kickoffTime: new Date().toISOString(),
        status: 'SCHEDULED'
      },
      marketType: 'MATCH_RESULT',
      selection: 'DRAW',
      odds: 3.40,
      assessment: {
        trueProbability: 0.28,
        impliedProbability: 0.294,
        expectedValue: -0.048,
        edge: -0.014,
        confidenceGrade: 'D',
        isValueBet: false,
        reasoning: ['High volatility coin toss']
      }
    },
    {
      id: 'leg-4',
      fixture: {
        id: 'fix-4',
        sport: 'FOOTBALL',
        homeTeam: 'Real Madrid',
        awayTeam: 'Alaves',
        league: 'La Liga',
        kickoffTime: new Date().toISOString(),
        status: 'SCHEDULED'
      },
      marketType: 'DOUBLE_CHANCE',
      selection: '1X',
      odds: 1.12,
      assessment: {
        trueProbability: 0.94,
        impliedProbability: 0.892,
        expectedValue: 0.052,
        edge: 0.048,
        confidenceGrade: 'A+',
        isValueBet: true,
        reasoning: ['Safe 1X line']
      }
    }
  ];

  it('filters out low-probability legs when minProbability is set to 0.85', () => {
    const result = TicketTrimmer.trim(sampleAssessedLegs, {
      strategy: 'MAX_PROBABILITY',
      minProbability: 0.85
    });

    // Leg 3 (probability 0.28) must be dropped
    expect(result.keptLegs.length).toBe(3);
    expect(result.droppedLegs.some(l => l.id === 'leg-3')).toBe(true);

    // Kept legs must all have trueProbability >= 0.85
    for (const leg of result.keptLegs) {
      expect(leg.assessment.trueProbability).toBeGreaterThanOrEqual(0.85);
    }
  });

  it('trims to a specific target count prioritizing highest probability', () => {
    const result = TicketTrimmer.trim(sampleAssessedLegs, {
      strategy: 'MAX_PROBABILITY',
      targetLegCount: 2
    });

    expect(result.keptLegs.length).toBe(2);
    // Highest probability legs are leg-4 (0.94) and leg-2 (0.92)
    expect(result.keptLegs.map(l => l.id)).toEqual(['leg-4', 'leg-2']);
  });

  it('optimizes target odds knapsack selection', () => {
    const result = TicketTrimmer.trim(sampleAssessedLegs, {
      strategy: 'TARGET_ODDS',
      targetOdds: 1.40
    });

    // 1.25 * 1.15 = 1.4375 approx 1.44 (very close to 1.40)
    expect(result.newTotalOdds).toBeGreaterThanOrEqual(1.20);
    expect(result.newTotalOdds).toBeLessThanOrEqual(1.70);
  });
});
