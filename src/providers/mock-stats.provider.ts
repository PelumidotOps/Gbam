import { Fixture } from '../models/types.js';
import { MatchLambda, PoissonModel } from '../stats/poisson.js';
import {
  HeadToHeadStats,
  SportsDataProvider,
  TeamStatistics
} from './sports-data.interface.js';

export class MockStatsProvider implements SportsDataProvider {
  public readonly name = 'MockStatsProvider';

  public async getUpcomingFixtures(): Promise<Fixture[]> {
    const today = new Date().toISOString();
    return [
      {
        id: 'fix-001',
        sport: 'FOOTBALL',
        homeTeam: 'Arsenal',
        awayTeam: 'Southampton',
        league: 'Premier League',
        country: 'England',
        kickoffTime: today,
        status: 'SCHEDULED'
      },
      {
        id: 'fix-002',
        sport: 'FOOTBALL',
        homeTeam: 'Bayern Munich',
        awayTeam: 'Augsburg',
        league: 'Bundesliga',
        country: 'Germany',
        kickoffTime: today,
        status: 'SCHEDULED'
      },
      {
        id: 'fix-003',
        sport: 'FOOTBALL',
        homeTeam: 'Real Madrid',
        awayTeam: 'Getafe',
        league: 'La Liga',
        country: 'Spain',
        kickoffTime: today,
        status: 'SCHEDULED'
      }
    ];
  }

  public async getTeamStatistics(teamId: string, isHome: boolean): Promise<TeamStatistics> {
    // Deterministic stats for testing based on team strength
    const isHeavyFavorite = ['Arsenal', 'Bayern Munich', 'Real Madrid', 'fix-001-home'].some(
      name => teamId.includes(name)
    );

    return {
      teamId,
      teamName: teamId,
      form: isHeavyFavorite ? 'WWWDW' : 'LLDWL',
      goalsScoredAverage: isHeavyFavorite ? (isHome ? 2.5 : 1.9) : 0.8,
      goalsConcededAverage: isHeavyFavorite ? 0.7 : (isHome ? 1.6 : 2.2),
      cleanSheetPercentage: isHeavyFavorite ? 0.55 : 0.15,
      failedToScorePercentage: isHeavyFavorite ? 0.08 : 0.40
    };
  }

  public async getHeadToHead(): Promise<HeadToHeadStats> {
    return {
      homeWins: 4,
      draws: 1,
      awayWins: 0,
      totalMatches: 5,
      averageGoals: 3.2
    };
  }

  public async getFixtureLambdas(fixture: Fixture): Promise<MatchLambda> {
    const homeStats = await this.getTeamStatistics(fixture.homeTeam, true);
    const awayStats = await this.getTeamStatistics(fixture.awayTeam, false);

    return PoissonModel.estimateLambdas({
      homeScoredAvg: homeStats.goalsScoredAverage,
      homeConcededAvg: homeStats.goalsConcededAverage,
      awayScoredAvg: awayStats.goalsScoredAverage,
      awayConcededAvg: awayStats.goalsConcededAverage
    });
  }
}
