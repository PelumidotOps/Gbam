import { Fixture } from '../models/types.js';
import { MatchLambda } from '../stats/poisson.js';

export interface TeamStatistics {
  teamId: string;
  teamName: string;
  form: string; // e.g. "WWDLW"
  goalsScoredAverage: number;
  goalsConcededAverage: number;
  cleanSheetPercentage: number;
  failedToScorePercentage: number;
}

export interface HeadToHeadStats {
  homeWins: number;
  draws: number;
  awayWins: number;
  totalMatches: number;
  averageGoals: number;
}

export interface SportsDataProvider {
  readonly name: string;

  /**
   * Fetches upcoming fixtures for a league or date
   */
  getUpcomingFixtures(date?: string, leagueId?: string): Promise<Fixture[]>;

  /**
   * Fetches team stats for home and away sides
   */
  getTeamStatistics(teamId: string, isHome: boolean): Promise<TeamStatistics>;

  /**
   * Fetches H2H record between two teams
   */
  getHeadToHead(teamAId: string, teamBId: string): Promise<HeadToHeadStats>;

  /**
   * Computes or retrieves expected goals (lambdas) for a fixture
   */
  getFixtureLambdas(fixture: Fixture): Promise<MatchLambda>;
}
