import type {
  Hackathon,
  HackathonRegistration,
  HackathonResults,
  JudgeAssignment,
  Project,
  ProjectSubmission,
  Team
} from '../types/domain';

export type SettledQueryResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

export interface OverviewStatsInput {
  publishedHackathons: SettledQueryResult<Hackathon[]>;
  organizerHackathons: SettledQueryResult<Hackathon[]>;
  registrations: SettledQueryResult<HackathonRegistration[]>;
  teams: SettledQueryResult<Team[]>;
  projects: SettledQueryResult<Project[]>;
  submissions: SettledQueryResult<ProjectSubmission[]>;
  assignments: SettledQueryResult<JudgeAssignment[]>;
  publishedResults: SettledQueryResult<HackathonResults[]>;
}

export interface StatQueryError {
  key: string;
  labelEn: string;
  labelAr: string;
  message: string;
}

export interface ResolvedOverviewStats {
  publishedHackathons: Hackathon[];
  publishedHackathonsCount: number | null;
  organizerHackathonsCount: number | null;
  registrationsCount: number | null;
  teamsCount: number | null;
  projectsCount: number | null;
  submissionsCount: number | null;
  assignmentsCount: number | null;
  publishedResults: HackathonResults[];
  queryErrors: StatQueryError[];
}

function extractErrorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function resolveOverviewStats(input: OverviewStatsInput): ResolvedOverviewStats {
  const queryErrors: StatQueryError[] = [];

  const unwrapArray = <T,>(
    res: SettledQueryResult<T[]>,
    key: string,
    labelEn: string,
    labelAr: string
  ): { items: T[]; count: number | null } => {
    if (res.status === 'fulfilled') {
      return { items: res.value, count: res.value.length };
    }
    queryErrors.push({
      key,
      labelEn,
      labelAr,
      message: extractErrorMessage(res.reason)
    });
    return { items: [], count: null };
  };

  const pub = unwrapArray(
    input.publishedHackathons,
    'publishedHackathons',
    'Published Hackathons',
    'الهاكاثونات المنشورة'
  );
  const org = unwrapArray(
    input.organizerHackathons,
    'organizerHackathons',
    'Organized Events',
    'الهاكاثونات التي أنظمها'
  );
  const regs = unwrapArray(
    input.registrations,
    'registrations',
    'My Registrations',
    'تسجيلاتي'
  );
  const tms = unwrapArray(input.teams, 'teams', 'Teams', 'الفرق');
  const projs = unwrapArray(input.projects, 'projects', 'Projects', 'المشاريع');
  const subs = unwrapArray(
    input.submissions,
    'submissions',
    'My Submissions',
    'تسليماتي'
  );
  const assigns = unwrapArray(
    input.assignments,
    'assignments',
    'Judge Assignments',
    'مهام التحكيم'
  );
  const pubRes = unwrapArray(
    input.publishedResults,
    'publishedResults',
    'Published Competition Rankings',
    'النتائج الرسمية المنشورة'
  );

  return {
    publishedHackathons: pub.items,
    publishedHackathonsCount: pub.count,
    organizerHackathonsCount: org.count,
    registrationsCount: regs.count,
    teamsCount: tms.count,
    projectsCount: projs.count,
    submissionsCount: subs.count,
    assignmentsCount: assigns.count,
    publishedResults: pubRes.items,
    queryErrors
  };
}
