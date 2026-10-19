import { Fixture } from '../models/types.js';
import { MatchLambda, PoissonModel } from '../stats/poisson.js';
import {
  HeadToHeadStats,
  SportsDataProvider,
  TeamStatistics
} from './sports-data.interface.js';

export interface ApiFootballConfig {
  apiKey: string;
  baseUrl?: string;
}

export class ApiFootballProvider implements SportsDataProvider {
  public readonly name = 'ApiFootballProvider';
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config?: Partial<ApiFootballConfig>) {
    this.apiKey = config?.apiKey || process.env.SPORTS_DATA_API_KEY || '';
    this.baseUrl = config?.baseUrl || process.env.SPORTS_DATA_API_URL || 'https://v3.football.api-sports.io';
  }

  private getHeaders(): Record<string, string> {
    if (!this.apiKey) {
      throw new Error(
        'SPORTS_DATA_API_KEY is not configured. Please set SPORTS_DATA_API_KEY in your .env file.'
      );
    }
    return {
      'x-apisports-key': this.apiKey,
      'Content-Type': 'application/json'
    };
  }

  public async getUpcomingFixtures(date?: string, leagueId?: string): Promise<Fixture[]> {
    const targetDate = date || new Date().toISOString().split('T')[0];
    const url = new URL(`${this.baseUrl}/fixtures`);
    url.searchParams.set('date', targetDate);
    if (leagueId) url.searchParams.set('league', leagueId);

    const res = await fetch(url.toString(), { headers: this.getHeaders() });
    if (!res.ok) {
      throw new Error(`API-Football error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as any;
    if (!data.response || !Array.isArray(data.response)) return [];

    return data.response.map((item: any) => ({
      id: String(item.fixture.id),
      sport: 'FOOTBALL' as const,
      homeTeam: item.teams.home.name,
      awayTeam: item.teams.away.name,
      league: item.league.name,
      country: item.league.country,
      kickoffTime: item.fixture.date,
      status: item.fixture.status.short === 'NS' ? 'SCHEDULED' : 'IN_PLAY'
    }));
  }

  public async getTeamStatistics(teamId: string, isHome: boolean): Promise<TeamStatistics> {
    // API-Football endpoint: /teams/statistics?season={current}&team={id}&league={id}
    // We compute goal averages from seasonal statistics
    const url = new URL(`${this.baseUrl}/teams/statistics`);
    url.searchParams.set('team', teamId);
    url.searchParams.set('season', String(new Date().getFullYear()));

    const res = await fetch(url.toString(), { headers: this.getHeaders() });
    if (!res.ok) {
      throw new Error(`API-Football team stats error: ${res.status}`);
    }

    const data = await res.json() as any;
    const stats = data.response;

    const scoredAvg = isHome
      ? parseFloat(stats?.goals?.for?.average?.home || '1.3')
      : parseFloat(stats?.goals?.for?.average?.away || '1.0');

    const concededAvg = isHome
      ? parseFloat(stats?.goals?.against?.average?.home || '1.0')
      : parseFloat(stats?.goals?.against?.average?.away || '1.4');

    return {
      teamId,
      teamName: stats?.team?.name || teamId,
      form: stats?.form || 'WWDLW',
      goalsScoredAverage: scoredAvg,
      goalsConcededAverage: concededAvg,
      cleanSheetPercentage: (stats?.clean_sheet?.total || 0) / (stats?.fixtures?.played?.total || 1),
      failedToScorePercentage: (stats?.failed_to_score?.total || 0) / (stats?.fixtures?.played?.total || 1)
    };
  }

  public async getHeadToHead(teamAId: string, teamBId: string): Promise<HeadToHeadStats> {
    const url = new URL(`${this.baseUrl}/fixtures/headtohead`);
    url.searchParams.set('h2h', `${teamAId}-${teamBId}`);

    const res = await fetch(url.toString(), { headers: this.getHeaders() });
    if (!res.ok) {
      throw new Error(`API-Football H2H error: ${res.status}`);
    }

    const data = await res.json() as any;
    const fixtures = data.response || [];

    let homeWins = 0;
    let awayWins = 0;
    let draws = 0;
    let totalGoals = 0;

    for (const fix of fixtures) {
      const hGoals = fix.goals.home || 0;
      const aGoals = fix.goals.away || 0;
      totalGoals += hGoals + aGoals;

      if (hGoals > aGoals) homeWins++;
      else if (aGoals > hGoals) awayWins++;
      else draws++;
    }

    return {
      homeWins,
      draws,
      awayWins,
      totalMatches: fixtures.length,
      averageGoals: fixtures.length > 0 ? totalGoals / fixtures.length : 2.5
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
