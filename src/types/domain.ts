export type AccountRole = 'participant' | 'organizer' | 'judge' | 'sponsor';

export type ExperienceLevel = 'beginner' | 'intermediate' | 'advanced' | 'expert';

export type AvailabilityLevel = 'part_time' | 'full_time' | 'weekends_only';

export type TeamPreference = 'looking_for_team' | 'open_to_join' | 'already_have_team' | 'solo';

export interface UserProfile {
  uid: string;
  displayName: string;
  title: string;
  bio: string;
  skills: string[];
  experienceLevel: ExperienceLevel;
  interests: string[];
  preferredRoles: string[];
  preferredLanguages: string[];
  availability: AvailabilityLevel;
  teamPreference: TeamPreference;
  portfolioUrl: string;
  githubUrl: string;
  linkedinUrl: string;
  photoUrl: string;
  requestedRole: AccountRole;
  approvedRole: AccountRole;
  accountRole?: AccountRole;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface UserPrivateInfo {
  uid: string;
  email: string;
  notificationsEnabled: boolean;
  aiCloudConsent: boolean;
  preferredLocale: 'en' | 'ar';
  updatedAt?: unknown;
}

export interface RubricCriterion {
  id: string;
  name: string;
  description: string;
  weight: number;
}

export type HackathonMode = 'online' | 'in_person' | 'hybrid';
export type HackathonStatus = 'draft' | 'published' | 'judging' | 'completed';

export interface Hackathon {
  id: string;
  organizerId: string;
  organizerName: string;
  title: string;
  tagline: string;
  description: string;
  coverImageUrl: string;
  startDate: string;
  endDate: string;
  registrationDeadline: string;
  submissionDeadline: string;
  registrationDeadlineAt?: unknown;
  submissionDeadlineAt?: unknown;
  mode: HackathonMode;
  location: string;
  tracks: string[];
  technologies: string[];
  eligibility: string;
  rules: string;
  prizes: string[];
  sponsors: string[];
  rubric: RubricCriterion[];
  maxTeamSize: number;
  status: HackathonStatus;
  resultsPublished: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type RegistrationStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface HackathonRegistration {
  id: string;
  hackathonId: string;
  organizerId: string;
  userId: string;
  userName: string;
  userTitle: string;
  preferredTrack: string;
  motivation: string;
  status: RegistrationStatus;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type TeamStatus = 'forming' | 'locked' | 'submitted';

export interface Team {
  id: string;
  hackathonId: string;
  organizerId: string;
  registrationId?: string;
  name: string;
  description: string;
  leaderId: string;
  memberIds: string[];
  memberNames: string[];
  lookingForRoles: string[];
  track: string;
  status: TeamStatus;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface TeamMemberRecord {
  uid: string;
  displayName: string;
  roleInTeam: string;
  registrationId?: string;
  joinedAt?: unknown;
}

export type InvitationStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';

export interface TeamInvitation {
  id: string;
  teamId: string;
  teamName: string;
  hackathonId: string;
  fromUserId: string;
  fromUserName: string;
  toUserId: string;
  toUserName: string;
  roleOffered: string;
  message: string;
  status: InvitationStatus;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ProjectTask {
  id: string;
  title: string;
  assigneeName: string;
  status: 'todo' | 'in_progress' | 'done';
  dueDate: string;
}

export interface Project {
  id: string;
  hackathonId: string;
  organizerId: string;
  teamId: string;
  ownerId: string;
  memberIds: string[];
  title: string;
  problemStatement: string;
  proposedSolution: string;
  targetUsers: string;
  technologies: string[];
  roadmap: string[];
  tasks: ProjectTask[];
  notes: string;
  aiMentorApprovedSummary: string;
  status: 'ideation' | 'building' | 'submitted';
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type SubmissionStatus = 'draft' | 'submitted' | 'under_review' | 'evaluated';

export interface ProjectSubmission {
  id: string;
  hackathonId: string;
  organizerId: string;
  teamId: string;
  teamName: string;
  projectId: string;
  ownerId: string;
  memberIds: string[];
  memberNames: string[];
  title: string;
  shortDescription: string;
  fullDescription: string;
  problemStatement: string;
  proposedSolution: string;
  technologies: string[];
  githubUrl: string;
  demoUrl: string;
  videoUrl: string;
  screenshotUrls: string[];
  track: string;
  assignedJudgeIds?: string[];
  status: SubmissionStatus;
  submittedAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface JudgeAssignment {
  id: string;
  hackathonId: string;
  organizerId: string;
  judgeId: string;
  judgeName: string;
  assignedSubmissionIds: string[];
  conflictDeclared: boolean;
  conflictNotes: string;
  status: 'invited' | 'accepted' | 'declined';
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type ScoreScale = '0_to_10' | '0_to_100';

export interface CriterionScore {
  criterionId: string;
  criterionName: string;
  weight: number;
  score: number;
  scoreScale?: ScoreScale;
  convertedFromScale?: ScoreScale;
  originalScore?: number;
  comment: string;
}

export interface AIJudgeAnalysisReport {
  verifiedEvidence: string[];
  teamClaims: string[];
  missingEvidence: string[];
  technicalObservations: string[];
  potentialRisks: string[];
  suggestedQuestions: string[];
  repoInspectionStatus: string;
  inferenceSourceLabel: string;
  generatedAt: string;
}

export type EvaluationStatus = 'draft' | 'finalizing' | 'submitted';
export type EvaluationStorageSchema = 'v1_inline' | 'v2_subcollection';

export interface NormalizedEvaluationCriterionDoc {
  criterionId: string;
  evaluationId: string;
  hackathonId: string;
  submissionId: string;
  judgeId: string;
  criterionName: string;
  weight: number;
  score: number;
  scoreScale?: ScoreScale;
  comment: string;
  updatedAt?: unknown;
}

export interface Evaluation {
  id: string;
  hackathonId: string;
  organizerId: string;
  submissionId: string;
  judgeId: string;
  judgeName: string;
  criteriaScores: CriterionScore[];
  weightedTotal: number;
  scoreScale?: ScoreScale;
  convertedFromScale?: ScoreScale;
  scoredCriterionCount?: number;
  storageSchema?: EvaluationStorageSchema;
  conflictOfInterest: boolean;
  conflictReason: string;
  humanFeedback: string;
  aiReportSummary: string;
  aiInferenceSource: string;
  status: EvaluationStatus;
  submittedAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface RankedSubmissionResult {
  submissionId: string;
  teamId: string;
  teamName: string;
  projectTitle: string;
  track: string;
  averageScore: number;
  normalizedScore: number;
  judgeCount: number;
  disagreementSpread: number;
  anomalyFlag: boolean;
  rank: number;
  explanation: string;
}

export interface HackathonResults {
  hackathonId: string;
  organizerId: string;
  published: boolean;
  rankings: RankedSubmissionResult[];
  publishedAt?: unknown;
  updatedAt?: unknown;
}

export interface AppNotification {
  id: string;
  userId: string;
  type:
    | 'registration'
    | 'team_invitation'
    | 'team_accepted'
    | 'deadline'
    | 'submission'
    | 'judge_assignment'
    | 'evaluation'
    | 'results';
  title: string;
  message: string;
  link: string;
  read: boolean;
  createdAt?: unknown;
}

export interface AuditLogEntry {
  id: string;
  actorId: string;
  actorName: string;
  action: string;
  targetCollection: string;
  targetId: string;
  hackathonId: string;
  details: string;
  createdAt?: unknown;
}

export interface AIUsageRecord {
  id: string;
  userId: string;
  taskName: string;
  inferenceSource: string;
  requestedMode: string;
  modelId: string;
  durationMs: number;
  fallbackOccurred: boolean;
  status: string;
  createdAt?: unknown;
}

export type SponsorStatus = 'pending' | 'approved' | 'rejected';

export interface SponsorRecord {
  id: string;
  hackathonId: string;
  organizerId: string;
  sponsorUserId: string;
  organizationName: string;
  tier: 'platinum' | 'gold' | 'silver' | 'community';
  status: SponsorStatus;
  websiteUrl: string;
  notes: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}
