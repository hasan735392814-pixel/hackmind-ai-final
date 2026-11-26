import type { Hackathon, ProjectSubmission } from '../../types/domain';
import { validateRubricWeights } from './fairJudgingEngine';
import type {
  EvidenceRecord,
  HackathonRequirementItem,
  HackathonRequirementsBundle,
  MissingRequirementConfigItem,
  VerificationStatus
} from './evidenceTypes';

function splitRequirementClauses(rawText: string, maxClauses = 100): { clauses: string[]; truncated: boolean } {
  if (!rawText || !rawText.trim()) return { clauses: [], truncated: false };
  const lines = rawText
    .split(/\r?\n|(?<=[.!?])\s+(?=[A-Z0-9\u0600-\u06FF-])/)
    .map((line) => line.replace(/^[\s•*\-–—\d.)]+/, '').trim())
    .filter((line) => line.length >= 4);

  if (lines.length === 0 && rawText.trim().length > 0) {
    return { clauses: [rawText.trim()], truncated: false };
  }
  const unique = Array.from(new Set(lines));
  return {
    clauses: unique.slice(0, maxClauses),
    truncated: unique.length > maxClauses
  };
}

const PROHIBITED_PATTERN =
  /\b(prohibit|prohibited|forbidden|not allowed|disqualif|ban|banned|plagiari|no pre-built|must not)\b|ممنوع|يُمنع|يحظر|استبعاد|انتحال/i;

function isProhibitedClause(text: string): boolean {
  return PROHIBITED_PATTERN.test(text);
}

/**
 * Deterministically extracts actual hackathon requirements and rubric weights
 * from the active Hackathon document without inventing missing rules.
 */
export function extractHackathonRequirements(
  hackathon: Partial<Hackathon> | null | undefined,
  submission?: Partial<ProjectSubmission> | null
): HackathonRequirementsBundle {
  const extractedAt = new Date().toISOString();
  const hackathonId = hackathon?.id || submission?.hackathonId || 'unknown_hackathon';
  const hackathonTitle = hackathon?.title?.trim() || 'Unspecified Hackathon';

  const mandatoryRequirements: HackathonRequirementItem[] = [];
  const scoredCriteria: HackathonRequirementItem[] = [];
  const missingRequirementFields: MissingRequirementConfigItem[] = [];

  if (!hackathon) {
    missingRequirementFields.push({
      field: 'hackathon',
      status: 'BLOCKED',
      reason:
        'Hackathon configuration object was not found or is inaccessible. Cannot invent rules or eligibility criteria.'
    });
    return {
      hackathonId,
      hackathonTitle,
      extractedAt,
      mandatoryRequirements,
      scoredCriteria,
      rubricWeightSum: 0,
      rubricWeightsValid: false,
      missingRequirementFields
    };
  }

  // 1. Mandatory Eligibility
  if (hackathon.eligibility && hackathon.eligibility.trim()) {
    const { clauses, truncated } = splitRequirementClauses(hackathon.eligibility);
    clauses.forEach((clause, idx) => {
      mandatoryRequirements.push({
        id: `elig_${idx + 1}`,
        kind: isProhibitedClause(clause) ? 'prohibited_practice' : 'mandatory_eligibility',
        mandatory: true,
        title: `Eligibility Requirement #${idx + 1}`,
        exactWording: clause,
        sourceField: 'hackathon.eligibility'
      });
    });
    if (truncated) {
      missingRequirementFields.push({
        field: 'hackathon.eligibility',
        status: 'UNVERIFIED',
        reason: 'Eligibility text exceeded maximum parsed clause count; review full eligibility document manually.'
      });
    }
  } else {
    missingRequirementFields.push({
      field: 'hackathon.eligibility',
      status: 'UNVERIFIED',
      reason:
        'Hackathon eligibility rules are empty or not configured in hackathon metadata. Eligibility compliance cannot be assumed.'
    });
  }

  // 2. Mandatory Rules & Prohibited Practices
  if (hackathon.rules && hackathon.rules.trim()) {
    const { clauses, truncated } = splitRequirementClauses(hackathon.rules);
    clauses.forEach((clause, idx) => {
      const prohibited = isProhibitedClause(clause);
      mandatoryRequirements.push({
        id: `rule_${idx + 1}`,
        kind: prohibited ? 'prohibited_practice' : 'mandatory_submission',
        mandatory: true,
        title: prohibited ? `Prohibited Practice Rule #${idx + 1}` : `Competition Rule #${idx + 1}`,
        exactWording: clause,
        sourceField: 'hackathon.rules'
      });
    });
    if (truncated) {
      missingRequirementFields.push({
        field: 'hackathon.rules',
        status: 'UNVERIFIED',
        reason: 'Rules text exceeded maximum parsed clause count; review full rules document manually.'
      });
    }
  } else {
    missingRequirementFields.push({
      field: 'hackathon.rules',
      status: 'UNVERIFIED',
      reason:
        'Official competition rules and prohibited practices are not configured on the hackathon record.'
    });
  }

  // 3. Technology Requirements
  const techs = (hackathon.technologies || []).filter((t) => typeof t === 'string' && t.trim().length > 0);
  if (techs.length > 0) {
    mandatoryRequirements.push({
      id: 'tech_stack',
      kind: 'mandatory_technology',
      mandatory: true,
      title: 'Configured Hackathon Technologies',
      exactWording: techs.join(', '),
      sourceField: 'hackathon.technologies'
    });
  }

  // 4. Track Requirements
  const tracks = (hackathon.tracks || []).filter((t) => typeof t === 'string' && t.trim().length > 0);
  if (tracks.length > 0) {
    mandatoryRequirements.push({
      id: 'track_alignment',
      kind: 'mandatory_track',
      mandatory: true,
      title: 'Eligible Hackathon Tracks',
      exactWording: tracks.join(', '),
      sourceField: 'hackathon.tracks'
    });
  }

  // 5. Max Team Size
  if (typeof hackathon.maxTeamSize === 'number' && hackathon.maxTeamSize >= 1) {
    mandatoryRequirements.push({
      id: 'max_team_size',
      kind: 'mandatory_eligibility',
      mandatory: true,
      title: 'Maximum Team Size',
      exactWording: `Maximum ${hackathon.maxTeamSize} member(s) per team`,
      sourceField: 'hackathon.maxTeamSize'
    });
  }

  // 6. Submission Deadline
  if (hackathon.submissionDeadline && hackathon.submissionDeadline.trim()) {
    mandatoryRequirements.push({
      id: 'submission_deadline',
      kind: 'mandatory_submission',
      mandatory: true,
      title: 'Submission Deadline',
      exactWording: hackathon.submissionDeadline.trim(),
      sourceField: 'hackathon.submissionDeadline'
    });
  } else {
    missingRequirementFields.push({
      field: 'hackathon.submissionDeadline',
      status: 'UNVERIFIED',
      reason: 'Submission deadline timestamp is not configured on the hackathon record.'
    });
  }

  // 7. Scored Judging Rubric
  const rawRubric = Array.isArray(hackathon.rubric) ? hackathon.rubric : [];
  if (rawRubric.length === 0) {
    missingRequirementFields.push({
      field: 'hackathon.rubric',
      status: 'BLOCKED',
      reason:
        'Judging rubric criteria and weights are missing from the hackathon record. Authorized hackathon organizer configuration is required before final criterion scoring.'
    });
  } else {
    rawRubric.forEach((criterion, idx) => {
      scoredCriteria.push({
        id: criterion.id || `criterion_${idx + 1}`,
        kind: 'scored_rubric',
        mandatory: false,
        title: criterion.name?.trim() || `Criterion #${idx + 1}`,
        exactWording: criterion.description?.trim() || criterion.name?.trim() || '',
        sourceField: `hackathon.rubric[${idx}]`,
        weight: Number(criterion.weight || 0)
      });
    });
  }

  const weightCheck = validateRubricWeights(rawRubric);
  if (rawRubric.length > 0 && !weightCheck.valid) {
    missingRequirementFields.push({
      field: 'hackathon.rubric.weights',
      status: 'UNVERIFIED',
      reason: `Configured rubric weights sum to ${weightCheck.sum}% instead of 100%.`
    });
  }

  return {
    hackathonId,
    hackathonTitle,
    extractedAt,
    mandatoryRequirements,
    scoredCriteria,
    rubricWeightSum: weightCheck.sum,
    rubricWeightsValid: weightCheck.valid,
    missingRequirementFields
  };
}

function toEpochMs(value: unknown): number | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'object' && value !== null) {
    const maybeTs = value as { toMillis?: () => number; seconds?: number };
    if (typeof maybeTs.toMillis === 'function') {
      return maybeTs.toMillis();
    }
    if (typeof maybeTs.seconds === 'number') {
      return maybeTs.seconds * 1000;
    }
  }
  return null;
}

export function evaluateEligibilityChecks(params: {
  bundle: HackathonRequirementsBundle;
  hackathon: Partial<Hackathon> | null | undefined;
  submission: Partial<ProjectSubmission>;
  observedAt: string;
}): { overallStatus: VerificationStatus; checks: EvidenceRecord[] } {
  const { bundle, hackathon, submission, observedAt } = params;
  const checks: EvidenceRecord[] = [];

  if (!hackathon) {
    checks.push({
      id: 'elig_hackathon_missing',
      claimOrRequirement: 'Actual hackathon configuration & rules',
      verificationMethod: 'metadata_check',
      evidenceSource: 'hackathon (missing)',
      observedAt,
      observedResult:
        'Hackathon document unavailable; eligibility and rules cannot be fabricated or assumed.',
      status: 'BLOCKED',
      confidence: 'LOW',
      confidenceReason: 'Hackathon record was missing or inaccessible.',
      limitations: ['Request organizer/authorized hackathon document before finalizing compliance.']
    });
    return { overallStatus: 'BLOCKED', checks };
  }

  // Team size check
  const maxTeamSize = hackathon.maxTeamSize;
  const memberCount = Array.isArray(submission.memberIds) ? submission.memberIds.length : 0;
  if (typeof maxTeamSize === 'number' && maxTeamSize >= 1) {
    if (memberCount === 0) {
      checks.push({
        id: 'check_team_size',
        claimOrRequirement: `Team size <= ${maxTeamSize}`,
        verificationMethod: 'metadata_check',
        evidenceSource: 'hackathon.maxTeamSize vs submission.memberIds',
        observedAt,
        observedResult:
          'Submission memberIds array is empty; cannot confirm participant count against maxTeamSize.',
        status: 'UNVERIFIED',
        confidence: 'LOW',
        confidenceReason: 'No memberIds present on submission document.',
        limitations: ['Participant roster requires verification against team record.']
      });
    } else if (memberCount <= maxTeamSize) {
      checks.push({
        id: 'check_team_size',
        claimOrRequirement: `Team size <= ${maxTeamSize}`,
        verificationMethod: 'metadata_check',
        evidenceSource: 'hackathon.maxTeamSize & submission.memberIds',
        observedAt,
        observedResult: `Submission lists ${memberCount} member(s), within limit of ${maxTeamSize}.`,
        status: 'CODE_CONFIRMED',
        confidence: 'MEDIUM',
        confidenceReason: 'Verified directly from stored submission.memberIds length.',
        limitations: ['Roster integrity assumes Firestore team membership matches actual contributors.']
      });
    } else {
      checks.push({
        id: 'check_team_size',
        claimOrRequirement: `Team size <= ${maxTeamSize}`,
        verificationMethod: 'metadata_check',
        evidenceSource: 'hackathon.maxTeamSize & submission.memberIds',
        observedAt,
        observedResult: `CONTRADICTION: Submission lists ${memberCount} members, exceeding hackathon maxTeamSize of ${maxTeamSize}.`,
        status: 'CONTRADICTED',
        confidence: 'HIGH',
        confidenceReason: 'Numeric comparison against configured maxTeamSize failed.',
        limitations: []
      });
    }
  }

  // Track alignment check
  const allowedTracks = (hackathon.tracks || []).map((t) => t.trim()).filter(Boolean);
  if (allowedTracks.length > 0) {
    const subTrack = (submission.track || '').trim();
    const matched = allowedTracks.some((t) => t.toLowerCase() === subTrack.toLowerCase());
    if (!subTrack) {
      checks.push({
        id: 'check_track',
        claimOrRequirement: `Submitted track belongs to [${allowedTracks.join(', ')}]`,
        verificationMethod: 'metadata_check',
        evidenceSource: 'hackathon.tracks vs submission.track',
        observedAt,
        observedResult: 'Submission track field is empty.',
        status: 'UNVERIFIED',
        confidence: 'HIGH',
        confidenceReason: 'Missing submission.track field.',
        limitations: ['Organizer/judge should verify track assignment.']
      });
    } else if (matched) {
      checks.push({
        id: 'check_track',
        claimOrRequirement: `Submitted track belongs to [${allowedTracks.join(', ')}]`,
        verificationMethod: 'metadata_check',
        evidenceSource: 'hackathon.tracks & submission.track',
        observedAt,
        observedResult: `Track "${subTrack}" matches configured hackathon tracks.`,
        status: 'CODE_CONFIRMED',
        confidence: 'HIGH',
        confidenceReason: 'Exact case-insensitive match with hackathon.tracks.',
        limitations: ['Semantic alignment of implementation to track goals still requires rubric review.']
      });
    } else {
      checks.push({
        id: 'check_track',
        claimOrRequirement: `Submitted track belongs to [${allowedTracks.join(', ')}]`,
        verificationMethod: 'metadata_check',
        evidenceSource: 'hackathon.tracks vs submission.track',
        observedAt,
        observedResult: `Submission track "${subTrack}" does not match configured tracks (${allowedTracks.join(', ')}).`,
        status: 'CONTRADICTED',
        confidence: 'HIGH',
        confidenceReason: 'Configured hackathon tracks list does not include submitted track.',
        limitations: []
      });
    }
  }

  // Submission deadline check
  const deadlineMs =
    toEpochMs(hackathon.submissionDeadlineAt) ?? toEpochMs(hackathon.submissionDeadline);
  const submittedMs = toEpochMs(submission.submittedAt);
  if (deadlineMs !== null) {
    if (submittedMs === null) {
      checks.push({
        id: 'check_deadline',
        claimOrRequirement: `Submitted before deadline (${hackathon.submissionDeadline || 'configured timestamp'})`,
        verificationMethod: 'metadata_check',
        evidenceSource: 'hackathon.submissionDeadline vs submission.submittedAt',
        observedAt,
        observedResult:
          'Submission timestamp (submittedAt) is missing; timeliness cannot be verified automatically.',
        status: 'UNVERIFIED',
        confidence: 'LOW',
        confidenceReason: 'submission.submittedAt missing on payload.',
        limitations: ['Verify Firestore submission timestamp or audit log.']
      });
    } else if (submittedMs <= deadlineMs) {
      checks.push({
        id: 'check_deadline',
        claimOrRequirement: `Submitted before deadline (${new Date(deadlineMs).toISOString()})`,
        verificationMethod: 'metadata_check',
        evidenceSource: 'hackathon.submissionDeadline & submission.submittedAt',
        observedAt,
        observedResult: `Submitted at ${new Date(submittedMs).toISOString()}, before deadline ${new Date(deadlineMs).toISOString()}.`,
        status: 'CODE_CONFIRMED',
        confidence: 'HIGH',
        confidenceReason: 'Timestamp comparison against configured deadline succeeded.',
        limitations: ['Post-deadline GitHub commits should also be checked manually by judge if rules prohibit post-deadline pushes.']
      });
    } else {
      checks.push({
        id: 'check_deadline',
        claimOrRequirement: `Submitted before deadline (${new Date(deadlineMs).toISOString()})`,
        verificationMethod: 'metadata_check',
        evidenceSource: 'hackathon.submissionDeadline vs submission.submittedAt',
        observedAt,
        observedResult: `LATE SUBMISSION: submittedAt (${new Date(submittedMs).toISOString()}) is after deadline (${new Date(deadlineMs).toISOString()}).`,
        status: 'CONTRADICTED',
        confidence: 'HIGH',
        confidenceReason: 'submission.submittedAt exceeds configured hackathon deadline.',
        limitations: []
      });
    }
  }

  // Textual eligibility / rule clauses that require human or codebase confirmation
  for (const item of bundle.mandatoryRequirements) {
    if (
      item.id === 'max_team_size' ||
      item.id === 'track_alignment' ||
      item.id === 'submission_deadline'
    ) {
      continue;
    }
    checks.push({
      id: `req_${item.id}`,
      claimOrRequirement: item.exactWording,
      verificationMethod: 'metadata_check',
      evidenceSource: item.sourceField,
      observedAt,
      observedResult: `Requirement recorded from ${item.sourceField}; requires cross-reference against repo/submission evidence matrix.`,
      status: 'UNVERIFIED',
      confidence: 'LOW',
      confidenceReason: 'Policy/eligibility clause cannot be proven from hackathon text alone.',
      limitations: ['Verify compliance via repository evidence or organizer verification.']
    });
  }

  for (const missing of bundle.missingRequirementFields) {
    checks.push({
      id: `missing_${missing.field}`,
      claimOrRequirement: `Configured ${missing.field}`,
      verificationMethod: 'metadata_check',
      evidenceSource: missing.field,
      observedAt,
      observedResult: missing.reason,
      status: missing.status,
      confidence: 'LOW',
      confidenceReason: 'Configuration missing from Hackathon document.',
      limitations: [missing.reason]
    });
  }

  let overallStatus: VerificationStatus = 'CODE_CONFIRMED';
  if (checks.some((c) => c.status === 'CONTRADICTED')) {
    overallStatus = 'CONTRADICTED';
  } else if (checks.some((c) => c.status === 'BLOCKED')) {
    overallStatus = 'BLOCKED';
  } else if (checks.some((c) => c.status === 'UNVERIFIED')) {
    overallStatus = 'UNVERIFIED';
  }

  return { overallStatus, checks };
}
