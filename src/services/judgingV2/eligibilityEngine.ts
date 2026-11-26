import type { Hackathon, ProjectSubmission } from '../../types/domain';
import type { EligibilityCheckItem, EligibilityReport } from './types';

function toEpochMs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === 'object') {
    if ('toMillis' in value && typeof (value as { toMillis: () => number }).toMillis === 'function') {
      try {
        const ms = (value as { toMillis: () => number }).toMillis();
        return Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    }
    if ('seconds' in value) {
      const secs = Number((value as { seconds: unknown }).seconds);
      return Number.isFinite(secs) ? secs * 1000 : null;
    }
  }
  return null;
}

/**
 * Evaluates hackathon eligibility rules strictly separately from the four judging criteria.
 * Never fabricates rules when inaccessible and never alters any judging score.
 */
export function evaluateSubmissionEligibility(params: {
  submission: ProjectSubmission;
  hackathon: Hackathon | null;
}): EligibilityReport {
  const { submission, hackathon } = params;
  const checks: EligibilityCheckItem[] = [];

  // 1. Submission completeness state
  const subStatus = submission.status;
  checks.push({
    id: 'submission_status',
    label: 'Submission State',
    labelAr: 'حالة التسليم',
    status:
      subStatus === 'submitted' || subStatus === 'under_review' || subStatus === 'evaluated'
        ? 'PASS'
        : subStatus === 'draft'
          ? 'FAIL'
          : 'UNVERIFIED',
    ruleSource: 'submissions/{id}.status',
    actualValue: subStatus || 'unknown',
    expectedRule: 'submitted / under_review / evaluated',
    note:
      subStatus === 'draft'
        ? 'Submission is still in draft state and has not been formally submitted.'
        : 'Submission status confirms formal entry.'
  });

  // 2. Team size check against official hackathon.maxTeamSize
  const memberCount = Array.isArray(submission.memberIds) ? submission.memberIds.length : 0;
  if (!hackathon || typeof hackathon.maxTeamSize !== 'number' || hackathon.maxTeamSize <= 0) {
    checks.push({
      id: 'team_size',
      label: 'Team Size Limit',
      labelAr: 'حد حجم الفريق',
      status: 'UNVERIFIED',
      ruleSource: hackathon ? 'hackathons/{id}.maxTeamSize (unset)' : 'Hackathon record unavailable',
      actualValue: memberCount > 0 ? `${memberCount} member(s)` : 'unknown',
      expectedRule: 'Unavailable',
      note: 'Maximum team size rule is unavailable; no rule fabricated.'
    });
  } else if (memberCount <= 0) {
    checks.push({
      id: 'team_size',
      label: 'Team Size Limit',
      labelAr: 'حد حجم الفريق',
      status: 'UNVERIFIED',
      ruleSource: 'hackathons/{id}.maxTeamSize',
      actualValue: '0 recorded member IDs',
      expectedRule: `<= ${hackathon.maxTeamSize} member(s)`,
      note: 'Submission memberIds list is empty; team size cannot be verified.'
    });
  } else {
    const withinLimit = memberCount <= hackathon.maxTeamSize;
    checks.push({
      id: 'team_size',
      label: 'Team Size Limit',
      labelAr: 'حد حجم الفريق',
      status: withinLimit ? 'PASS' : 'FAIL',
      ruleSource: 'hackathons/{id}.maxTeamSize',
      actualValue: `${memberCount} member(s)`,
      expectedRule: `1 to ${hackathon.maxTeamSize} member(s)`,
      note: withinLimit
        ? `Team size (${memberCount}) is within limit (${hackathon.maxTeamSize}).`
        : `Team size (${memberCount}) exceeds maximum allowed (${hackathon.maxTeamSize}).`
    });
  }

  // 3. Submission deadline check
  const deadlineMs =
    toEpochMs(hackathon?.submissionDeadlineAt) ?? toEpochMs(hackathon?.submissionDeadline);
  const submittedMs = toEpochMs(submission.submittedAt);

  if (!hackathon || (!hackathon.submissionDeadlineAt && !hackathon.submissionDeadline)) {
    checks.push({
      id: 'submission_deadline',
      label: 'Submission Deadline',
      labelAr: 'الموعد النهائي للتسليم',
      status: hackathon ? 'NOT_APPLICABLE' : 'UNVERIFIED',
      ruleSource: hackathon ? 'hackathons/{id}.submissionDeadline (none)' : 'Hackathon record unavailable',
      actualValue: submittedMs ? new Date(submittedMs).toISOString() : 'unset',
      expectedRule: hackathon ? 'No deadline specified' : 'Unavailable',
      note: hackathon
        ? 'No submission deadline is configured in the hackathon record.'
        : 'Hackathon record unavailable to verify deadline.'
    });
  } else if (deadlineMs === null || submittedMs === null) {
    checks.push({
      id: 'submission_deadline',
      label: 'Submission Deadline',
      labelAr: 'الموعد النهائي للتسليم',
      status: 'UNVERIFIED',
      ruleSource: 'hackathons/{id}.submissionDeadlineAt / submissions/{id}.submittedAt',
      actualValue: submittedMs ? new Date(submittedMs).toISOString() : 'submittedAt missing',
      expectedRule: deadlineMs ? `<= ${new Date(deadlineMs).toISOString()}` : 'Unparseable deadline',
      note: 'Timestamp missing or unparseable; deadline compliance remains UNVERIFIED.'
    });
  } else {
    const onTime = submittedMs <= deadlineMs;
    checks.push({
      id: 'submission_deadline',
      label: 'Submission Deadline',
      labelAr: 'الموعد النهائي للتسليم',
      status: onTime ? 'PASS' : 'FAIL',
      ruleSource: 'hackathons/{id}.submissionDeadlineAt',
      actualValue: new Date(submittedMs).toISOString(),
      expectedRule: `<= ${new Date(deadlineMs).toISOString()}`,
      note: onTime ? 'Submitted before or at deadline.' : 'Submitted after official deadline.'
    });
  }

  // 4. Track match check
  const officialTracks = (hackathon?.tracks || []).map((t) => t.trim()).filter(Boolean);
  const subTrack = (submission.track || '').trim();
  if (!hackathon) {
    checks.push({
      id: 'track_match',
      label: 'Competition Track',
      labelAr: 'مسار المنافسة',
      status: 'UNVERIFIED',
      ruleSource: 'Hackathon record unavailable',
      actualValue: subTrack || 'unset',
      expectedRule: 'Unavailable',
      note: 'Hackathon tracks unavailable; not verified.'
    });
  } else if (officialTracks.length === 0) {
    checks.push({
      id: 'track_match',
      label: 'Competition Track',
      labelAr: 'مسار المنافسة',
      status: 'NOT_APPLICABLE',
      ruleSource: 'hackathons/{id}.tracks (empty)',
      actualValue: subTrack || 'General',
      expectedRule: 'No track restrictions defined',
      note: 'Hackathon does not restrict submissions to fixed tracks.'
    });
  } else if (!subTrack) {
    checks.push({
      id: 'track_match',
      label: 'Competition Track',
      labelAr: 'مسار المنافسة',
      status: 'UNVERIFIED',
      ruleSource: 'hackathons/{id}.tracks',
      actualValue: 'No track selected on submission',
      expectedRule: officialTracks.join(', '),
      note: 'Submission does not specify a track.'
    });
  } else {
    const matched = officialTracks.some((t) => t.toLowerCase() === subTrack.toLowerCase());
    checks.push({
      id: 'track_match',
      label: 'Competition Track',
      labelAr: 'مسار المنافسة',
      status: matched ? 'PASS' : 'FAIL',
      ruleSource: 'hackathons/{id}.tracks',
      actualValue: subTrack,
      expectedRule: officialTracks.join(', '),
      note: matched
        ? `Track "${subTrack}" matches an official competition track.`
        : `Track "${subTrack}" is not listed in official hackathon tracks.`
    });
  }

  // 5. Participation rules / eligibility text (cannot be auto-verified without external participant proof)
  const rulesText = [hackathon?.eligibility, hackathon?.rules]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(' | ');

  checks.push({
    id: 'competition_rules',
    label: 'Participation & Official Rules',
    labelAr: 'شروط المشاركة والقواعد الرسمية',
    status: !hackathon ? 'UNVERIFIED' : rulesText ? 'UNVERIFIED' : 'NOT_APPLICABLE',
    ruleSource: hackathon ? 'hackathons/{id}.eligibility & rules' : 'Hackathon record unavailable',
    actualValue: 'Requires organizer/judge verification',
    expectedRule: rulesText ? rulesText.slice(0, 280) : 'No additional text rules defined',
    note: rulesText
      ? 'Free-text participation rules cannot be proven automatically from repository code alone; verify manually if needed.'
      : 'No free-text participation rules defined.'
  });

  const summary = {
    passCount: checks.filter((c) => c.status === 'PASS').length,
    failCount: checks.filter((c) => c.status === 'FAIL').length,
    unverifiedCount: checks.filter((c) => c.status === 'UNVERIFIED').length,
    notApplicableCount: checks.filter((c) => c.status === 'NOT_APPLICABLE').length
  };

  return {
    evaluatedAt: new Date().toISOString(),
    hackathonAccessible: Boolean(hackathon),
    separatedFromScoring: true,
    checks,
    summary
  };
}
