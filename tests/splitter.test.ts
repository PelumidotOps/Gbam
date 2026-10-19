import { describe, expect, it } from 'vitest';
import { TicketSplitter } from '../src/engine/splitter.js';
import { BetLeg } from '../src/models/types.js';

describe('TicketSplitter', () => {
  const dummyLegs: BetLeg[] = [
    {
      fixture: {
        id: 'f-1',
        sport: 'FOOTBALL',
        homeTeam: 'Team 1',
        awayTeam: 'Team 2',
        league: 'L1',
        kickoffTime: new Date().toISOString(),
        status: 'SCHEDULED'
      },
      marketType: 'MATCH_RESULT',
      selection: 'HOME',
      odds: 3.0
    },
    {
      fixture: {
        id: 'f-2',
        sport: 'FOOTBALL',
        homeTeam: 'Team 3',
        awayTeam: 'Team 4',
        league: 'L1',
        kickoffTime: new Date().toISOString(),
        status: 'SCHEDULED'
      },
      marketType: 'MATCH_RESULT',
      selection: 'HOME',
      odds: 2.5
    },
    {
      fixture: {
        id: 'f-3',
        sport: 'FOOTBALL',
        homeTeam: 'Team 5',
        awayTeam: 'Team 6',
        league: 'L1',
        kickoffTime: new Date().toISOString(),
        status: 'SCHEDULED'
      },
      marketType: 'MATCH_RESULT',
      selection: 'HOME',
      odds: 1.5
    },
    {
      fixture: {
        id: 'f-4',
        sport: 'FOOTBALL',
        homeTeam: 'Team 7',
        awayTeam: 'Team 8',
        league: 'L1',
        kickoffTime: new Date().toISOString(),
        status: 'SCHEDULED'
      },
      marketType: 'MATCH_RESULT',
      selection: 'HOME',
      odds: 1.2
    }
  ];

  it('splits 4 legs into 2 balanced tickets with no overlap', () => {
    const splitTickets = TicketSplitter.split(dummyLegs, {
      splitCount: 2,
      balanceOdds: true,
      allowOverlap: false
    });

    expect(splitTickets.length).toBe(2);
    expect(splitTickets[0].legs.length).toBe(2);
    expect(splitTickets[1].legs.length).toBe(2);

    // Verify zero duplicate fixtures across tickets
    const ticket1Ids = new Set(splitTickets[0].legs.map(l => l.fixture.id));
    for (const leg of splitTickets[1].legs) {
      expect(ticket1Ids.has(leg.fixture.id)).toBe(false);
    }

    // Snake drafting:
    // Sorted: 3.0, 2.5, 1.5, 1.2
    // Bucket 1: 3.0, 1.2 -> odds: 3.6
    // Bucket 2: 2.5, 1.5 -> odds: 3.75
    expect(splitTickets[0].totalOdds).toBeCloseTo(3.6, 1);
    expect(splitTickets[1].totalOdds).toBeCloseTo(3.75, 1);
  });
});
