import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
const blueprintPath = path.resolve(process.cwd(), 'firebase-blueprint.json');

const rulesText = fs.readFileSync(rulesPath, 'utf8');
const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf8')) as {
  firestore: Record<string, unknown>;
};

describe('Firestore Security Rules & Dirty Dozen Invariants', () => {
  it('contains global default-deny catch-all rule', () => {
    expect(rulesText).toMatch(/match \/\{document=\*\*\} \{\s*allow read, write: if false;\s*\}/);
  });

  it('covers every top-level collection declared in firebase-blueprint.json', () => {
    const topCollections = new Set(
      Object.keys(blueprint.firestore).map((p) => p.split('/').filter(Boolean)[0])
    );
    for (const col of topCollections) {
      expect(rulesText).toContain(`match /${col}/`);
    }
  });

  it('forbids client writes to /admins and requires email_verified for standard writes', () => {
    expect(rulesText).toMatch(/match \/admins\/\{userId\}[\s\S]*allow create, update, delete: if false;/);
    expect(rulesText).toContain('request.auth.token.email_verified == true');
  });

  it('isolates private PII under /users/{userId}/private and prevents self-judging', () => {
    expect(rulesText).toMatch(/match \/private\/\{docId\}[\s\S]*isOwner\(userId\) \|\| isAdmin\(\)/);
    expect(rulesText).toContain('!(request.auth.uid in get(/databases/$(database)/documents/submissions/$(incoming().submissionId)).data.memberIds)');
  });

  it('never contains blanket allow list: if isSignedIn() or allow read, write: if true', () => {
    expect(rulesText).not.toMatch(/allow list:\s*if\s*isSignedIn\(\)\s*;/);
    expect(rulesText).not.toMatch(/allow read,\s*write:\s*if\s*true\s*;/);
    expect(rulesText).not.toMatch(/match \/hackathons\/\{hackathonId\}[\s\S]*allow list:\s*if\s*true\s*;/);
  });

  it('enforces server-side registration and submission deadlines and published-status locks', () => {
    expect(rulesText).toMatch(
      /match \/registrations\/\{registrationId\}[\s\S]*data\.status == 'published'[\s\S]*request\.time <= get\(.*hackathons.*registrationDeadlineAt/
    );
    expect(rulesText).toMatch(
      /match \/submissions\/\{submissionId\}[\s\S]*data\.status == 'published'[\s\S]*request\.time <= get\(.*hackathons.*submissionDeadlineAt/
    );
  });

  it('verifies parent hackathon organizerId and non-draft status on sponsor creation', () => {
    expect(rulesText).toMatch(
      /match \/sponsors\/\{sponsorId\}[\s\S]*data\.organizerId == incoming\(\)\.organizerId[\s\S]*data\.status in \['published', 'judging', 'completed'\]/
    );
  });

  it('guards resource != null and strictly scopes resource == null initial get on judgeAssignments, evaluations, and hackathonResults', () => {
    expect(rulesText).toMatch(
      /match \/judgeAssignments\/\{assignmentId\}[\s\S]*allow get:[\s\S]*resource != null && \(existing\(\)\.judgeId == request\.auth\.uid \|\| existing\(\)\.organizerId == request\.auth\.uid\)[\s\S]*resource == null && canOrganizerGetMissingAssignment\(assignmentId\)/
    );
    expect(rulesText).toMatch(
      /function canOrganizerGetMissingAssignment\(assignmentId\)[\s\S]*isApprovedOrganizerOrAdmin\(\)[\s\S]*isParentHackathonOrganizerForAssignment/
    );
    expect(rulesText).toMatch(
      /match \/evaluations\/\{evaluationId\}[\s\S]*allow get:[\s\S]*resource != null && \(existing\(\)\.judgeId == request\.auth\.uid \|\| existing\(\)\.organizerId == request\.auth\.uid\)[\s\S]*resource == null && canGetMissingEvaluation\(evaluationId\)/
    );
    expect(rulesText).toMatch(
      /function canGetMissingEvaluationCandidate\(evaluationId, subId, jId\)[\s\S]*assignedSubmissionIds[\s\S]*conflictDeclared == false[\s\S]*status == 'accepted'/
    );
    expect(rulesText).toMatch(
      /match \/hackathonResults\/\{hackathonId\}[\s\S]*allow get:[\s\S]*resource != null && existing\(\)\.published == true[\s\S]*resource != null && existing\(\)\.organizerId == request\.auth\.uid[\s\S]*resource == null &&[\s\S]*isApprovedOrganizerOrAdmin\(\) &&[\s\S]*exists\(\/databases\/\$\(database\)\/documents\/hackathons\/\$\(hackathonId\)\) &&[\s\S]*get\(\/databases\/\$\(database\)\/documents\/hackathons\/\$\(hackathonId\)\)\.data\.organizerId == request\.auth\.uid/
    );
    expect(rulesText).not.toMatch(/allow get:\s*if[^;]*resource == null\s*[;)]/);
  });

  it('keeps draft hackathons hidden from ordinary users and restricts create/publish/delete to approved organizers or admins', () => {
    expect(rulesText).toMatch(
      /match \/hackathons\/\{hackathonId\}[\s\S]*allow list:[\s\S]*resource\.data\.status in \['published', 'judging', 'completed'\][\s\S]*resource\.data\.organizerId == request\.auth\.uid \|\| isAdmin\(\)/
    );
    expect(rulesText).toMatch(
      /match \/hackathons\/\{hackathonId\}[\s\S]*allow create:[\s\S]*isApprovedOrganizerOrAdmin\(\)[\s\S]*incoming\(\)\.status in \['draft', 'published'\]/
    );
    expect(rulesText).toMatch(
      /match \/hackathons\/\{hackathonId\}[\s\S]*allow update:[\s\S]*isApprovedOrganizerOrAdmin\(\)[\s\S]*existing\(\)\.status == 'draft' && incoming\(\)\.status == 'published'/
    );
    expect(rulesText).toMatch(
      /match \/hackathons\/\{hackathonId\}[\s\S]*allow delete:[\s\S]*isApprovedOrganizerOrAdmin\(\) && existing\(\)\.organizerId == request\.auth\.uid && existing\(\)\.status == 'draft'/
    );
  });

  it('enforces exact userId, hackathonId, and approved status in registration verification and scopes missing registration get to caller UID', () => {
    expect(rulesText).toMatch(
      /function hasApprovedRegistrationDoc\(regId, hackathonId, uid\)[\s\S]*data\.userId == uid[\s\S]*data\.hackathonId == hackathonId[\s\S]*data\.status == 'approved'/
    );
    expect(rulesText).toMatch(
      /function canGetMissingOwnRegistration\(registrationId\)[\s\S]*isValidCompositeId\(registrationId\)[\s\S]*isValidId\(registrationId\[0 : registrationId\.size\(\) - suffix\.size\(\)\]\)/
    );
    expect(rulesText).toMatch(
      /match \/registrations\/\{registrationId\}[\s\S]*allow get:[\s\S]*resource != null[\s\S]*resource == null && canGetMissingOwnRegistration\(registrationId\)[\s\S]*allow create:[\s\S]*incoming\(\)\.status == 'approved'[\s\S]*allow update:[\s\S]*existing\(\)\.status in \['pending', 'withdrawn'\][\s\S]*incoming\(\)\.status == 'approved'/
    );
  });

  it('allows verified participants with canonical or explicit approved registrations to create teams atomically without extra organizer gates', () => {
    expect(rulesText).toMatch(
      /match \/teams\/\{teamId\}[\s\S]*allow create:[\s\S]*isVerifiedUser\(\)[\s\S]*isValidTeam\(incoming\(\)\)[\s\S]*incoming\(\)\.leaderId == request\.auth\.uid[\s\S]*incoming\(\)\.memberIds == \[request\.auth\.uid\][\s\S]*hasApprovedRegistration\(incoming\(\)\.hackathonId, request\.auth\.uid\)/
    );
    expect(rulesText).toMatch(
      /match \/members\/\{memberId\}[\s\S]*allow create:[\s\S]*isValidTeamMember\(incoming\(\)\)[\s\S]*memberId == request\.auth\.uid/
    );
    expect(rulesText).toMatch(
      /match \/teamJoinCodes\/\{verifierHash\}[\s\S]*allow create:[\s\S]*isVerifiedUser\(\)[\s\S]*isValidSha256Hex\(verifierHash\)[\s\S]*incoming\(\)\.leaderId == request\.auth\.uid/
    );
  });

  it('pins Firebase CLI deployment config to project hackmind-ai and (default) database while forbidding self-approval of rejected registrations', () => {
    const firebaseJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'firebase.json'), 'utf8')
    ) as { firestore?: { database?: string; rules?: string } };
    const firebaseRc = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), '.firebaserc'), 'utf8')
    ) as { projects?: { default?: string } };

    expect(firebaseJson.firestore?.database).toBe('(default)');
    expect(firebaseJson.firestore?.rules).toBe('firestore.rules');
    expect(firebaseRc.projects?.default).toBe('hackmind-ai');

    // Rejected status cannot be transitioned by participant self-update or deleted by participant
    expect(rulesText).toMatch(
      /match \/registrations\/\{registrationId\}[\s\S]*existing\(\)\.status in \['pending', 'withdrawn'\][\s\S]*incoming\(\)\.status == 'approved'[\s\S]*allow delete:[\s\S]*existing\(\)\.status in \['pending', 'withdrawn'\]/
    );
  });

  it('supports reusable join codes with optional expiresAt enforcement and organizer/leader revocation controls', () => {
    expect(rulesText).toMatch(
      /match \/private\/\{docId\}[\s\S]*incoming\(\)\.keys\(\)\.hasOnly\(\['verifierHash', 'leaderId', 'active', 'updatedAt', 'expiresAt'\]\)/
    );
    expect(rulesText).toMatch(
      /match \/joinClaims\/\{claimUid\}[\s\S]*request\.time <= get\(\/databases\/\$\(database\)\/documents\/teamJoinCodes\/[\s\S]*data\.expiresAt[\s\S]*request\.time <= get\(\/databases\/\$\(database\)\/documents\/teams\/\$\(teamId\)\/private\/joinCode\)\.data\.expiresAt/
    );
    expect(rulesText).toMatch(
      /match \/teamJoinCodes\/\{verifierHash\}[\s\S]*incoming\(\)\.keys\(\)\.hasOnly\(\['id', 'verifierHash', 'teamId', 'hackathonId', 'organizerId', 'leaderId', 'active', 'createdAt', 'expiresAt'\]\)[\s\S]*isApprovedOrganizerOrAdmin\(\)[\s\S]*incoming\(\)\.active == false[\s\S]*affectedKeys\(\)\.hasOnly\(\['active'\]\)/
    );
  });

  it('enforces normalized evaluation subcollection rules, empty parent inline criteriaScores, finalization rubric checks, COI invariants, and /criteria/{criterionId} validation', () => {
    expect(rulesText).toMatch(
      /function isValidEvaluationCriterionDoc\(data, evaluationId, criterionId\)[\s\S]*data\.keys\(\)\.hasAll\(\[\s*'criterionId', 'evaluationId', 'hackathonId', 'submissionId',\s*'judgeId', 'criterionName', 'weight', 'score', 'updatedAt'/
    );
    expect(rulesText).toContain('matchesAnyHackathonRubricItem(');
    expect(rulesText).toContain('data.criteriaScores.size() == 0');
    expect(rulesText).toMatch(
      /function isValidEvaluation\(data\)[\s\S]*!data\.conflictOfInterest \|\| \([\s\S]*data\.criteriaScores\.size\(\) == 0[\s\S]*data\.weightedTotal == 0[\s\S]*data\.conflictReason\.trim\(\)\.size\(\) >= 1/
    );
    expect(rulesText).toMatch(
      /data\.status in \['draft', 'finalizing', 'submitted'\]/
    );
    expect(rulesText).toMatch(
      /data\.status != 'submitted' \|\| data\.conflictOfInterest \|\| \(\('scoredCriterionCount' in data\) && data\.scoredCriterionCount >= 1\)/
    );
    expect(rulesText).toMatch(
      /match \/evaluations\/\{evaluationId\}[\s\S]*existing\(\)\.status in \['draft', 'finalizing'\][\s\S]*canFinalizeNonCoiEvaluation\(evaluationId,[\s\S]*match \/criteria\/\{criterionId\}[\s\S]*canMutateCriterionWithParent\(/
    );
  });
});


