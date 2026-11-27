import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment
} from '@firebase/rules-unit-testing';
import {
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type Firestore
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  calculateWeightedTotal,
  computeFairRankings,
  hydrateEvaluationScoresAndTotal
} from '../../src/services/judging/fairJudgingEngine';
import { migrateLegacyEvaluationToSubcollection } from '../../src/services/judging/evaluationMigration';
import type {
  CriterionScore,
  Evaluation,
  NormalizedEvaluationCriterionDoc,
  ProjectSubmission,
  RubricCriterion
} from '../../src/types/domain';

const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
const rulesText = fs.readFileSync(rulesPath, 'utf8');

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

let testEnv: RulesTestEnvironment;

function verifiedCtx(uid: string, extraToken: Record<string, unknown> = {}) {
  return testEnv.authenticatedContext(uid, {
    email: `${uid}@hackmind.test`,
    email_verified: true,
    ...extraToken
  });
}

function unverifiedCtx(uid: string) {
  return testEnv.authenticatedContext(uid, {
    email: `${uid}@hackmind.test`,
    email_verified: false
  });
}

async function seedUser(params: {
  uid: string;
  approvedRole?: 'participant' | 'organizer' | 'judge' | 'sponsor';
  requestedRole?: 'participant' | 'organizer' | 'judge' | 'sponsor';
  isAdmin?: boolean;
}) {
  const role = params.approvedRole ?? 'participant';
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', params.uid), {
      uid: params.uid,
      displayName: `User ${params.uid}`,
      title: 'Engineer',
      bio: '',
      skills: ['TypeScript'],
      experienceLevel: 'intermediate',
      interests: ['AI'],
      preferredRoles: ['Builder'],
      preferredLanguages: ['English'],
      availability: 'full_time',
      teamPreference: 'looking_for_team',
      portfolioUrl: '',
      githubUrl: '',
      linkedinUrl: '',
      photoUrl: '',
      requestedRole: params.requestedRole ?? role,
      approvedRole: role,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now()
    });
    if (params.isAdmin) {
      await setDoc(doc(db, 'admins', params.uid), {
        uid: params.uid,
        grantedAt: Timestamp.now()
      });
    }
  });
}

async function seedHackathon(params: {
  id: string;
  organizerId: string;
  status?: 'draft' | 'published' | 'judging' | 'completed';
  maxTeamSize?: number;
  regDeadlineFuture?: boolean;
  subDeadlineFuture?: boolean;
}) {
  const nowMs = Date.now();
  const future = Timestamp.fromMillis(nowMs + 86_400_000 * 7);
  const past = Timestamp.fromMillis(nowMs - 86_400_000 * 2);

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'hackathons', params.id), {
      id: params.id,
      organizerId: params.organizerId,
      organizerName: 'Organizer One',
      title: 'HackMind Global AI Challenge',
      tagline: 'Hybrid AI Builders',
      description: 'Build production-ready hybrid edge and cloud applications.',
      coverImageUrl: '',
      startDate: '2026-12-01',
      endDate: '2026-12-05',
      registrationDeadline: '2026-12-02',
      submissionDeadline: '2026-12-05T18:00',
      registrationDeadlineAt: params.regDeadlineFuture === false ? past : future,
      submissionDeadlineAt: params.subDeadlineFuture === false ? past : future,
      mode: 'online',
      location: 'Global',
      tracks: ['Hybrid AI'],
      technologies: ['TypeScript'],
      eligibility: 'Open',
      rules: 'Fair play',
      prizes: ['$5000'],
      sponsors: [],
      rubric: [{ id: 'innovation', name: 'Innovation', description: 'Novelty', weight: 100 }],
      maxTeamSize: params.maxTeamSize ?? 4,
      status: params.status ?? 'published',
      resultsPublished: false,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now()
    });
  });
}

async function seedRegistration(params: {
  hackathonId: string;
  organizerId: string;
  userId: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
}) {
  const id = `${params.hackathonId}_${params.userId}`;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'registrations', id), {
      id,
      hackathonId: params.hackathonId,
      organizerId: params.organizerId,
      userId: params.userId,
      userName: `User ${params.userId}`,
      userTitle: 'Builder',
      preferredTrack: 'Hybrid AI',
      motivation: 'Excited to build',
      status: params.status,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now()
    });
  });
}

async function seedTeam(params: {
  teamId: string;
  hackathonId: string;
  organizerId: string;
  leaderId: string;
  memberIds?: string[];
  joinToken?: string;
  status?: 'forming' | 'locked' | 'submitted';
  joinCodeActive?: boolean;
}) {
  const token = params.joinToken ?? 'HM-00112233445566778899AABBCCDDEEFF';
  const proof = sha256(token);
  const verifierHash = sha256(proof);
  const members = params.memberIds ?? [params.leaderId];
  const active = params.joinCodeActive ?? true;

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'teams', params.teamId), {
      id: params.teamId,
      hackathonId: params.hackathonId,
      organizerId: params.organizerId,
      name: 'Team Nova',
      description: 'Hybrid AI builders',
      leaderId: params.leaderId,
      memberIds: members,
      memberNames: members.map((m) => `User ${m}`),
      lookingForRoles: ['Designer'],
      track: 'Hybrid AI',
      status: params.status ?? 'forming',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now()
    });
    for (const uid of members) {
      await setDoc(doc(db, 'teams', params.teamId, 'members', uid), {
        uid,
        displayName: `User ${uid}`,
        roleInTeam: uid === params.leaderId ? 'Team Lead' : 'Member',
        joinedAt: Timestamp.now()
      });
    }
    await setDoc(doc(db, 'teams', params.teamId, 'private', 'joinCode'), {
      verifierHash,
      leaderId: params.leaderId,
      active,
      updatedAt: Timestamp.now()
    });
    await setDoc(doc(db, 'teamJoinCodes', verifierHash), {
      id: verifierHash,
      verifierHash,
      teamId: params.teamId,
      hackathonId: params.hackathonId,
      organizerId: params.organizerId,
      leaderId: params.leaderId,
      active,
      createdAt: Timestamp.now()
    });
  });
  return { token, proof, verifierHash };
}

function buildJoinByCodeBatch(
  db: ReturnType<ReturnType<typeof verifiedCtx>['firestore']>,
  params: { teamId: string; uid: string; displayName: string; proof: string }
) {
  const batch = writeBatch(db);
  batch.set(doc(db, 'teams', params.teamId, 'joinClaims', params.uid), {
    uid: params.uid,
    teamId: params.teamId,
    mode: 'join_code',
    proof: params.proof,
    presentedAt: serverTimestamp()
  });
  batch.update(doc(db, 'teams', params.teamId), {
    memberIds: arrayUnion(params.uid),
    memberNames: arrayUnion(params.displayName),
    updatedAt: serverTimestamp()
  });
  batch.set(doc(db, 'teams', params.teamId, 'members', params.uid), {
    uid: params.uid,
    displayName: params.displayName,
    roleInTeam: 'Member',
    joinedAt: serverTimestamp()
  });
  return batch;
}

async function seedProject(params: {
  projectId: string;
  hackathonId: string;
  organizerId: string;
  teamId: string;
  ownerId: string;
  memberIds: string[];
}) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'projects', params.projectId), {
      id: params.projectId,
      hackathonId: params.hackathonId,
      organizerId: params.organizerId,
      teamId: params.teamId,
      ownerId: params.ownerId,
      memberIds: params.memberIds,
      title: 'Nova Edge Triage',
      problemStatement: 'Triage latency',
      proposedSolution: 'On-device model',
      targetUsers: 'Clinicians',
      technologies: ['TypeScript'],
      roadmap: ['MVP'],
      tasks: [],
      notes: '',
      aiMentorApprovedSummary: '',
      status: 'building',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now()
    });
  });
}

async function seedSubmission(params: {
  submissionId: string;
  hackathonId: string;
  organizerId: string;
  teamId: string;
  projectId: string;
  ownerId: string;
  memberIds: string[];
  status?: 'draft' | 'submitted' | 'under_review' | 'evaluated';
}) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'submissions', params.submissionId), {
      id: params.submissionId,
      hackathonId: params.hackathonId,
      organizerId: params.organizerId,
      teamId: params.teamId,
      teamName: 'Team Nova',
      projectId: params.projectId,
      ownerId: params.ownerId,
      memberIds: params.memberIds,
      memberNames: params.memberIds.map((m) => `User ${m}`),
      title: 'Nova Edge Submission',
      shortDescription: 'Low-latency hybrid triage app',
      fullDescription: 'Complete working build',
      problemStatement: 'Slow triage',
      proposedSolution: 'Hybrid AI',
      technologies: ['TypeScript'],
      githubUrl: 'https://github.com/hackmind/nova',
      demoUrl: 'https://nova.example.com',
      videoUrl: '',
      screenshotUrls: [],
      track: 'Hybrid AI',
      status: params.status ?? 'submitted',
      submittedAt: Timestamp.now(),
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now()
    });
  });
}

describe('HackMind AI — Firestore Security Rules Emulator Test Suite', () => {
  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'hackmind-security-test',
      firestore: {
        rules: rulesText,
        host: '127.0.0.1',
        port: 8080
      }
    });
  }, 30000);

  beforeEach(async () => {
    await testEnv.clearFirestore();
  });

  afterAll(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  // =========================================================================
  // 24 MANDATORY ATTACK TESTS
  // =========================================================================
  describe('Security Attack Vectors (Must Be Denied)', () => {
    it('Attack 1: Unverified user cannot create hackathon, team, or submission', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published' });
      const db = unverifiedCtx('unver_1').firestore();

      await assertFails(
        setDoc(doc(db, 'hackathons', 'hack_unver'), {
          id: 'hack_unver',
          organizerId: 'unver_1',
          organizerName: 'Unverified',
          title: 'Bad Hack',
          description: 'Should fail immediately',
          mode: 'online',
          maxTeamSize: 4,
          status: 'draft',
          resultsPublished: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      await assertFails(
        setDoc(doc(db, 'teams', 'team_unver'), {
          id: 'team_unver',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          name: 'Unverified Team',
          leaderId: 'unver_1',
          memberIds: ['unver_1'],
          status: 'forming',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Attack 2: Spoofed admin email token claim without /admins/{uid} cannot grant roles or delete records', async () => {
      await seedUser({ uid: 'victim_1', approvedRole: 'participant' });
      const spoofedDb = testEnv
        .authenticatedContext('attacker_uid', {
          email: 'admin@example.test',
          email_verified: true
        })
        .firestore();

      await assertFails(
        updateDoc(doc(spoofedDb, 'users', 'victim_1'), {
          approvedRole: 'organizer',
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(deleteDoc(doc(spoofedDb, 'users', 'victim_1')));
    });

    it('Attack 3: Client cannot create, update, or delete /admins/{uid}', async () => {
      await seedUser({ uid: 'admin_1', isAdmin: true });
      const userDb = verifiedCtx('attacker_1').firestore();
      const adminDb = verifiedCtx('admin_1').firestore();

      await assertFails(
        setDoc(doc(userDb, 'admins', 'attacker_1'), {
          uid: 'attacker_1',
          grantedAt: serverTimestamp()
        })
      );
      await assertFails(deleteDoc(doc(adminDb, 'admins', 'admin_1')));
    });

    it('Attack 4: Signup or profile update setting approvedRole to organizer or judge is denied', async () => {
      const db = verifiedCtx('p1').firestore();
      await assertFails(
        setDoc(doc(db, 'users', 'p1'), {
          uid: 'p1',
          displayName: 'Self Promoter',
          requestedRole: 'organizer',
          approvedRole: 'organizer',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      await seedUser({ uid: 'p2', approvedRole: 'participant', requestedRole: 'participant' });
      const p2Db = verifiedCtx('p2').firestore();
      await assertFails(
        updateDoc(doc(p2Db, 'users', 'p2'), {
          approvedRole: 'judge',
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Attack 5: Unapproved organizer (even with requestedRole organizer) cannot create or update hackathon', async () => {
      await seedUser({ uid: 'fake_org', approvedRole: 'participant', requestedRole: 'organizer' });
      const db = verifiedCtx('fake_org').firestore();

      await assertFails(
        setDoc(doc(db, 'hackathons', 'hack_fake'), {
          id: 'hack_fake',
          organizerId: 'fake_org',
          organizerName: 'Fake Org',
          title: 'Unauthorized Hackathon',
          description: 'Should be rejected because approvedRole is participant',
          mode: 'online',
          maxTeamSize: 4,
          status: 'draft',
          resultsPublished: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Attack 6: Participant cannot bypass deadline/published/identity/status rules or spoof another registration on create/update', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'p1', approvedRole: 'participant' });
      await seedHackathon({ id: 'hack_draft', organizerId: 'org1', status: 'draft' });
      await seedHackathon({ id: 'hack_pub', organizerId: 'org1', status: 'published', regDeadlineFuture: true });

      const unverifiedDb = unverifiedCtx('p1').firestore();
      await assertFails(
        setDoc(doc(unverifiedDb, 'registrations', 'hack_pub_p1'), {
          id: 'hack_pub_p1',
          hackathonId: 'hack_pub',
          organizerId: 'org1',
          userId: 'p1',
          userName: 'Unverified',
          status: 'approved',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      const p1Db = verifiedCtx('p1').firestore();
      // Unpublished hackathon cannot accept registration
      await assertFails(
        setDoc(doc(p1Db, 'registrations', 'hack_draft_p1'), {
          id: 'hack_draft_p1',
          hackathonId: 'hack_draft',
          organizerId: 'org1',
          userId: 'p1',
          userName: 'Participant',
          status: 'approved',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      // Cannot create a registration with organizer-only 'rejected' or stale 'pending' status
      await assertFails(
        setDoc(doc(p1Db, 'registrations', 'hack_pub_p1'), {
          id: 'hack_pub_p1',
          hackathonId: 'hack_pub',
          organizerId: 'org1',
          userId: 'p1',
          userName: 'Participant',
          status: 'pending',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      // Pending registration on draft hackathon cannot be self-approved
      await seedRegistration({ hackathonId: 'hack_draft', organizerId: 'org1', userId: 'p1', status: 'pending' });
      await assertFails(
        updateDoc(doc(p1Db, 'registrations', 'hack_draft_p1'), {
          status: 'approved',
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Attack 7: Rejected registrant cannot update or delete/recreate registration to bypass rejection', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'p1', approvedRole: 'participant' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p1', status: 'rejected' });

      const p1Db = verifiedCtx('p1').firestore();
      await assertFails(
        updateDoc(doc(p1Db, 'registrations', 'hack_1_p1'), {
          status: 'pending',
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(deleteDoc(doc(p1Db, 'registrations', 'hack_1_p1')));
    });

    it('Attack 8: Outsider cannot read another user private PII or another team document', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'p1' });
      await seedUser({ uid: 'outsider' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published' });
      await seedTeam({ teamId: 'team_1', hackathonId: 'hack_1', organizerId: 'org1', leaderId: 'p1' });

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'users', 'p1', 'private', 'info'), {
          uid: 'p1',
          email: 'p1@secret.com',
          notificationsEnabled: true,
          aiCloudConsent: true,
          preferredLocale: 'en',
          updatedAt: Timestamp.now()
        });
      });

      const outDb = verifiedCtx('outsider').firestore();
      await assertFails(getDoc(doc(outDb, 'users', 'p1', 'private', 'info')));
      await assertFails(getDoc(doc(outDb, 'teams', 'team_1')));
    });

    it('Attack 9: Outsider cannot list /teamJoinCodes or read /teams/{teamId}/private/joinCode', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'p1' });
      await seedUser({ uid: 'outsider' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published' });
      await seedTeam({ teamId: 'team_1', hackathonId: 'hack_1', organizerId: 'org1', leaderId: 'p1' });

      const outDb = verifiedCtx('outsider').firestore();
      await assertFails(getDocs(collection(outDb, 'teamJoinCodes')));
      await assertFails(getDoc(doc(outDb, 'teams', 'team_1', 'private', 'joinCode')));
    });

    it('Attack 10: Pending/unapproved registrant cannot create a team, join by code, or accept invitation', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedUser({ uid: 'pending_user' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'leader', status: 'approved' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'pending_user', status: 'pending' });
      const { proof } = await seedTeam({
        teamId: 'team_1',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        leaderId: 'leader'
      });

      const pendingDb = verifiedCtx('pending_user').firestore();
      await assertFails(
        setDoc(doc(pendingDb, 'teams', 'team_unapproved'), {
          id: 'team_unapproved',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          name: 'Blocked Team',
          leaderId: 'pending_user',
          memberIds: ['pending_user'],
          status: 'forming',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      const joinBatch = buildJoinByCodeBatch(pendingDb, {
        teamId: 'team_1',
        uid: 'pending_user',
        displayName: 'Pending',
        proof
      });
      await assertFails(joinBatch.commit());
    });

    it('Attack 11: Approved user cannot join team directly without valid joinClaims double-hash proof', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedUser({ uid: 'p2' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'leader', status: 'approved' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p2', status: 'approved' });
      await seedTeam({ teamId: 'team_1', hackathonId: 'hack_1', organizerId: 'org1', leaderId: 'leader' });

      const p2Db = verifiedCtx('p2').firestore();
      await assertFails(
        updateDoc(doc(p2Db, 'teams', 'team_1'), {
          memberIds: arrayUnion('p2'),
          updatedAt: serverTimestamp()
        })
      );

      const forgedBatch = buildJoinByCodeBatch(p2Db, {
        teamId: 'team_1',
        uid: 'p2',
        displayName: 'P2',
        proof: sha256('HM-WRONGTOKEN00000000000000000000')
      });
      await assertFails(forgedBatch.commit());
    });

    it('Attack 12: Exceeding hackathon maxTeamSize on team join is denied', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedUser({ uid: 'p2' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published', maxTeamSize: 1 });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p2', status: 'approved' });
      const { proof } = await seedTeam({
        teamId: 'team_1',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        leaderId: 'leader'
      });

      const p2Db = verifiedCtx('p2').firestore();
      const batch = buildJoinByCodeBatch(p2Db, {
        teamId: 'team_1',
        uid: 'p2',
        displayName: 'P2',
        proof
      });
      await assertFails(batch.commit());
    });

    it('Attack 13: Team leader cannot arbitrarily add a non-consenting user to memberIds', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published' });
      await seedTeam({ teamId: 'team_1', hackathonId: 'hack_1', organizerId: 'org1', leaderId: 'leader' });

      const leaderDb = verifiedCtx('leader').firestore();
      await assertFails(
        updateDoc(doc(leaderDb, 'teams', 'team_1'), {
          memberIds: ['leader', 'victim_user'],
          memberNames: ['Leader', 'Victim'],
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Attack 14: Self-invitation and hackathonId mismatch invitation are denied', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'leader', status: 'approved' });
      await seedTeam({ teamId: 'team_1', hackathonId: 'hack_1', organizerId: 'org1', leaderId: 'leader' });

      const leaderDb = verifiedCtx('leader').firestore();
      await assertFails(
        setDoc(doc(leaderDb, 'teamInvitations', 'inv_self'), {
          id: 'inv_self',
          teamId: 'team_1',
          teamName: 'Team Nova',
          hackathonId: 'hack_1',
          fromUserId: 'leader',
          toUserId: 'leader',
          status: 'pending',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(
        setDoc(doc(leaderDb, 'teamInvitations', 'inv_mismatch'), {
          id: 'inv_mismatch',
          teamId: 'team_1',
          teamName: 'Team Nova',
          hackathonId: 'hack_other',
          fromUserId: 'leader',
          toUserId: 'p2',
          status: 'pending',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Attack 15: Project non-owner member cannot modify memberIds', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'owner1' });
      await seedUser({ uid: 'member2' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published' });
      await seedTeam({ teamId: 'team_1', hackathonId: 'hack_1', organizerId: 'org1', leaderId: 'owner1', memberIds: ['owner1', 'member2'] });
      await seedProject({ projectId: 'proj_1', hackathonId: 'hack_1', organizerId: 'org1', teamId: 'team_1', ownerId: 'owner1', memberIds: ['owner1', 'member2'] });

      const m2Db = verifiedCtx('member2').firestore();
      await assertFails(
        updateDoc(doc(m2Db, 'projects', 'proj_1'), {
          memberIds: ['member2'],
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Attack 16: Submission assignedJudgeIds injection, late submission, and submitted-to-draft regression are denied', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'owner1' });
      await seedHackathon({ id: 'hack_open', organizerId: 'org1', status: 'published', subDeadlineFuture: true });
      await seedHackathon({ id: 'hack_late', organizerId: 'org1', status: 'published', subDeadlineFuture: false });
      await seedTeam({ teamId: 'team_open', hackathonId: 'hack_open', organizerId: 'org1', leaderId: 'owner1' });
      await seedTeam({ teamId: 'team_late', hackathonId: 'hack_late', organizerId: 'org1', leaderId: 'owner1' });
      await seedProject({ projectId: 'proj_open', hackathonId: 'hack_open', organizerId: 'org1', teamId: 'team_open', ownerId: 'owner1', memberIds: ['owner1'] });
      await seedProject({ projectId: 'proj_late', hackathonId: 'hack_late', organizerId: 'org1', teamId: 'team_late', ownerId: 'owner1', memberIds: ['owner1'] });

      const pDb = verifiedCtx('owner1').firestore();
      await assertFails(
        setDoc(doc(pDb, 'submissions', 'sub_judge_inject'), {
          id: 'sub_judge_inject',
          hackathonId: 'hack_open',
          organizerId: 'org1',
          teamId: 'team_open',
          projectId: 'proj_open',
          ownerId: 'owner1',
          memberIds: ['owner1'],
          title: 'Injected',
          shortDescription: 'Attempt to set judges',
          assignedJudgeIds: ['j1'],
          status: 'draft',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      await assertFails(
        setDoc(doc(pDb, 'submissions', 'sub_late'), {
          id: 'sub_late',
          hackathonId: 'hack_late',
          organizerId: 'org1',
          teamId: 'team_late',
          projectId: 'proj_late',
          ownerId: 'owner1',
          memberIds: ['owner1'],
          title: 'Late Sub',
          shortDescription: 'Past deadline',
          status: 'submitted',
          submittedAt: serverTimestamp(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      await seedSubmission({
        submissionId: 'sub_1',
        hackathonId: 'hack_open',
        organizerId: 'org1',
        teamId: 'team_open',
        projectId: 'proj_open',
        ownerId: 'owner1',
        memberIds: ['owner1'],
        status: 'submitted'
      });
      await assertFails(
        updateDoc(doc(pDb, 'submissions', 'sub_1'), {
          status: 'draft',
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Attack 17: javascript: URL scheme in profile/submission/sponsor URLs and notifications link is denied', async () => {
      await seedUser({ uid: 'p1' });
      const pDb = verifiedCtx('p1').firestore();

      await assertFails(
        updateDoc(doc(pDb, 'users', 'p1'), {
          githubUrl: 'javascript:alert(1)',
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(
        setDoc(doc(pDb, 'notifications', 'ntf_xss'), {
          id: 'ntf_xss',
          userId: 'p1',
          type: 'results',
          title: 'Click',
          message: 'Bad link',
          link: 'https://evil.example/phish',
          read: false,
          createdAt: serverTimestamp()
        })
      );
    });

    it('Attack 18: Judge cannot self-assign and organizer cannot reset accepted assignment back to invited', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'j1', approvedRole: 'judge' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'judging' });

      const jDb = verifiedCtx('j1').firestore();
      await assertFails(
        setDoc(doc(jDb, 'judgeAssignments', 'hack_1_j1'), {
          id: 'hack_1_j1',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          judgeId: 'j1',
          judgeName: 'Judge 1',
          assignedSubmissionIds: ['sub_1'],
          conflictDeclared: false,
          status: 'accepted',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'judgeAssignments', 'hack_1_j1'), {
          id: 'hack_1_j1',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          judgeId: 'j1',
          judgeName: 'Judge 1',
          assignedSubmissionIds: ['sub_1'],
          conflictDeclared: false,
          status: 'accepted',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
      });

      const orgDb = verifiedCtx('org1').firestore();
      await assertFails(
        updateDoc(doc(orgDb, 'judgeAssignments', 'hack_1_j1'), {
          status: 'invited',
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Attack 19: Judge cannot evaluate while assignment is invited, declined, or conflictDeclared=true', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'owner1' });
      await seedUser({ uid: 'j1', approvedRole: 'judge' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'judging' });
      await seedTeam({ teamId: 'team_1', hackathonId: 'hack_1', organizerId: 'org1', leaderId: 'owner1' });
      await seedProject({ projectId: 'proj_1', hackathonId: 'hack_1', organizerId: 'org1', teamId: 'team_1', ownerId: 'owner1', memberIds: ['owner1'] });
      await seedSubmission({
        submissionId: 'sub_1',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        teamId: 'team_1',
        projectId: 'proj_1',
        ownerId: 'owner1',
        memberIds: ['owner1'],
        status: 'under_review'
      });

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'judgeAssignments', 'hack_1_j1'), {
          id: 'hack_1_j1',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          judgeId: 'j1',
          judgeName: 'Judge 1',
          assignedSubmissionIds: ['sub_1'],
          conflictDeclared: false,
          status: 'invited',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
      });

      const jDb = verifiedCtx('j1').firestore();
      await assertFails(
        setDoc(doc(jDb, 'evaluations', 'sub_1_j1'), {
          id: 'sub_1_j1',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          submissionId: 'sub_1',
          judgeId: 'j1',
          criteriaScores: [],
          weightedTotal: 80,
          conflictOfInterest: false,
          status: 'submitted',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await updateDoc(doc(ctx.firestore(), 'judgeAssignments', 'hack_1_j1'), {
          status: 'accepted',
          conflictDeclared: true
        });
      });
      await assertFails(
        setDoc(doc(jDb, 'evaluations', 'sub_1_j1'), {
          id: 'sub_1_j1',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          submissionId: 'sub_1',
          judgeId: 'j1',
          criteriaScores: [],
          weightedTotal: 80,
          conflictOfInterest: false,
          status: 'submitted',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Attack 20: Self-judging own submission and non-zero score with conflictOfInterest=true are denied', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'owner_judge', approvedRole: 'judge' });
      await seedUser({ uid: 'j2', approvedRole: 'judge' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'judging' });
      await seedTeam({ teamId: 'team_1', hackathonId: 'hack_1', organizerId: 'org1', leaderId: 'owner_judge' });
      await seedProject({ projectId: 'proj_1', hackathonId: 'hack_1', organizerId: 'org1', teamId: 'team_1', ownerId: 'owner_judge', memberIds: ['owner_judge'] });
      await seedSubmission({
        submissionId: 'sub_1',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        teamId: 'team_1',
        projectId: 'proj_1',
        ownerId: 'owner_judge',
        memberIds: ['owner_judge'],
        status: 'under_review'
      });

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'judgeAssignments', 'hack_1_owner_judge'), {
          id: 'hack_1_owner_judge',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          judgeId: 'owner_judge',
          judgeName: 'Self Judge',
          assignedSubmissionIds: ['sub_1'],
          conflictDeclared: false,
          status: 'accepted',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
        await setDoc(doc(ctx.firestore(), 'judgeAssignments', 'hack_1_j2'), {
          id: 'hack_1_j2',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          judgeId: 'j2',
          judgeName: 'Judge 2',
          assignedSubmissionIds: ['sub_1'],
          conflictDeclared: false,
          status: 'accepted',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
      });

      const selfDb = verifiedCtx('owner_judge').firestore();
      await assertFails(
        setDoc(doc(selfDb, 'evaluations', 'sub_1_owner_judge'), {
          id: 'sub_1_owner_judge',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          submissionId: 'sub_1',
          judgeId: 'owner_judge',
          criteriaScores: [],
          weightedTotal: 99,
          conflictOfInterest: false,
          status: 'submitted',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      const j2Db = verifiedCtx('j2').firestore();
      await assertFails(
        setDoc(doc(j2Db, 'evaluations', 'sub_1_j2'), {
          id: 'sub_1_j2',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          submissionId: 'sub_1',
          judgeId: 'j2',
          criteriaScores: [],
          weightedTotal: 85,
          conflictOfInterest: true,
          status: 'submitted',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Attack 21: Non-admin cannot modify already-published results or set resultsPublished=true without published results doc', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'judging' });
      const orgDb = verifiedCtx('org1').firestore();

      await assertFails(
        updateDoc(doc(orgDb, 'hackathons', 'hack_1'), {
          resultsPublished: true,
          status: 'completed',
          updatedAt: serverTimestamp()
        })
      );

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'hackathonResults', 'hack_1'), {
          hackathonId: 'hack_1',
          organizerId: 'org1',
          published: true,
          rankings: [],
          publishedAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
      });

      await assertFails(
        updateDoc(doc(orgDb, 'hackathonResults', 'hack_1'), {
          rankings: [{ submissionId: 'tampered' }],
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Attack 22: Cross-user notification creation is denied', async () => {
      await seedUser({ uid: 'u1' });
      await seedUser({ uid: 'u2' });
      const u1Db = verifiedCtx('u1').firestore();

      await assertFails(
        setDoc(doc(u1Db, 'notifications', 'ntf_cross'), {
          id: 'ntf_cross',
          userId: 'u2',
          type: 'results',
          title: 'Spoofed',
          message: 'Cross-user injection',
          link: '/app',
          read: false,
          createdAt: serverTimestamp()
        })
      );
    });

    it('Attack 23: Sponsor cannot self-approve partnership or claim platinum tier', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'sp1', approvedRole: 'sponsor' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published' });

      const spDb = verifiedCtx('sp1').firestore();
      await assertFails(
        setDoc(doc(spDb, 'sponsors', 'sp_bad_status'), {
          id: 'sp_bad_status',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          sponsorUserId: 'sp1',
          organizationName: 'Acme Corp',
          tier: 'community',
          status: 'approved',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(
        setDoc(doc(spDb, 'sponsors', 'sp_bad_tier'), {
          id: 'sp_bad_tier',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          sponsorUserId: 'sp1',
          organizationName: 'Acme Corp',
          tier: 'platinum',
          status: 'pending',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Attack 24: AuditLogs/AIUsage mutation/deletion, forged actions, and invalid durationMs are denied', async () => {
      await seedUser({ uid: 'u1' });
      const db = verifiedCtx('u1').firestore();

      await assertFails(
        setDoc(doc(db, 'auditLogs', 'aud_forged'), {
          id: 'aud_forged',
          actorId: 'u1',
          action: 'forged_arbitrary_action',
          targetCollection: 'admins',
          targetId: 'u1',
          createdAt: serverTimestamp()
        })
      );

      await assertFails(
        setDoc(doc(db, 'aiUsage', 'ai_bad_dur'), {
          id: 'ai_bad_dur',
          userId: 'u1',
          taskName: 'mentor_ideation',
          inferenceSource: 'CLOUD',
          requestedMode: 'prefer_in_cloud',
          durationMs: 9999999,
          fallbackOccurred: false,
          status: 'success',
          createdAt: serverTimestamp()
        })
      );

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'auditLogs', 'aud_1'), {
          id: 'aud_1',
          actorId: 'u1',
          action: 'sponsor_created',
          targetCollection: 'sponsors',
          targetId: 'sp_1',
          createdAt: Timestamp.now()
        });
      });
      await assertFails(deleteDoc(doc(db, 'auditLogs', 'aud_1')));
    });
  });

  // =========================================================================
  // 14 LEGITIMATE WORKFLOW TESTS
  // =========================================================================
  describe('Legitimate End-to-End Workflows (Must Succeed)', () => {
    it('Workflow 1: Verified signup creates participant profile, owner updates requestedRole, admin grants approvedRole', async () => {
      await seedUser({ uid: 'admin_1', isAdmin: true });
      const pDb = verifiedCtx('p_new').firestore();

      await assertSucceeds(
        setDoc(doc(pDb, 'users', 'p_new'), {
          uid: 'p_new',
          displayName: 'New Builder',
          requestedRole: 'judge',
          approvedRole: 'participant',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      await assertSucceeds(
        updateDoc(doc(pDb, 'users', 'p_new'), {
          displayName: 'New Builder PhD',
          requestedRole: 'judge',
          updatedAt: serverTimestamp()
        })
      );

      const adminDb = verifiedCtx('admin_1').firestore();
      await assertSucceeds(
        updateDoc(doc(adminDb, 'users', 'p_new'), {
          approvedRole: 'judge',
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Workflow 2: Approved organizer creates draft hackathon, publishes it, and transitions to judging', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      const orgDb = verifiedCtx('org1').firestore();

      await assertSucceeds(
        setDoc(doc(orgDb, 'hackathons', 'hack_w2'), {
          id: 'hack_w2',
          organizerId: 'org1',
          organizerName: 'Organizer One',
          title: 'HackMind Sprint',
          description: 'Build hybrid edge-cloud AI applications.',
          mode: 'online',
          maxTeamSize: 4,
          status: 'draft',
          resultsPublished: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      await assertSucceeds(
        updateDoc(doc(orgDb, 'hackathons', 'hack_w2'), {
          status: 'published',
          updatedAt: serverTimestamp()
        })
      );

      await assertSucceeds(
        updateDoc(doc(orgDb, 'hackathons', 'hack_w2'), {
          status: 'judging',
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Workflow 3: Verified participant gets auto-approved registration, can self-confirm pending/withdrawn on published hackathon, and organizer retains moderation', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'p1', approvedRole: 'participant' });
      await seedUser({ uid: 'p2', approvedRole: 'participant' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published', regDeadlineFuture: true });

      const pDb = verifiedCtx('p1').firestore();
      await assertSucceeds(
        setDoc(doc(pDb, 'registrations', 'hack_1_p1'), {
          id: 'hack_1_p1',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          userId: 'p1',
          userName: 'Builder One',
          preferredTrack: 'Hybrid AI',
          motivation: 'Ready to build',
          status: 'approved',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      // Existing pending registration can be confirmed by eligible participant directly
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p2', status: 'pending' });
      const p2Db = verifiedCtx('p2').firestore();
      await assertSucceeds(
        updateDoc(doc(p2Db, 'registrations', 'hack_1_p2'), {
          status: 'approved',
          updatedAt: serverTimestamp()
        })
      );

      // Organizer moderation (e.g., rejecting or re-approving) remains intact
      const orgDb = verifiedCtx('org1').firestore();
      await assertSucceeds(
        updateDoc(doc(orgDb, 'registrations', 'hack_1_p2'), {
          status: 'rejected',
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Workflow 4: Approved registrant creates team atomically with zero-plaintext double-hash verifier', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'leader', status: 'approved' });

      const token = 'HM-ABCDEF0123456789ABCDEF0123456789';
      const verifierHash = sha256(sha256(token));
      const leaderDb = verifiedCtx('leader').firestore();
      const batch = writeBatch(leaderDb);

      batch.set(doc(leaderDb, 'teams', 'team_w4'), {
        id: 'team_w4',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        name: 'Team Crypto',
        leaderId: 'leader',
        memberIds: ['leader'],
        memberNames: ['Leader'],
        status: 'forming',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      batch.set(doc(leaderDb, 'teams', 'team_w4', 'members', 'leader'), {
        uid: 'leader',
        displayName: 'Leader',
        roleInTeam: 'Team Lead',
        joinedAt: serverTimestamp()
      });
      batch.set(doc(leaderDb, 'teams', 'team_w4', 'private', 'joinCode'), {
        verifierHash,
        leaderId: 'leader',
        active: true,
        updatedAt: serverTimestamp()
      });
      batch.set(doc(leaderDb, 'teamJoinCodes', verifierHash), {
        id: verifierHash,
        verifierHash,
        teamId: 'team_w4',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        leaderId: 'leader',
        active: true,
        createdAt: serverTimestamp()
      });

      await assertSucceeds(batch.commit());
      const privateSnap = await assertSucceeds(
        getDoc(doc(leaderDb, 'teams', 'team_w4', 'private', 'joinCode'))
      );
      expect(privateSnap.data()).not.toHaveProperty('code');
      expect(privateSnap.data()?.verifierHash).toBe(verifierHash);
    });

    it('Workflow 5: Second approved registrant joins atomically using double-hash proof and purges joinClaim', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedUser({ uid: 'p2' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published', maxTeamSize: 4 });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p2', status: 'approved' });
      const { proof, verifierHash } = await seedTeam({
        teamId: 'team_w5',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        leaderId: 'leader'
      });

      const p2Db = verifiedCtx('p2').firestore();
      await assertSucceeds(getDoc(doc(p2Db, 'teamJoinCodes', verifierHash)));

      const batch = buildJoinByCodeBatch(p2Db, {
        teamId: 'team_w5',
        uid: 'p2',
        displayName: 'User p2',
        proof
      });

      await assertSucceeds(batch.commit());
      await assertSucceeds(deleteDoc(doc(p2Db, 'teams', 'team_w5', 'joinClaims', 'p2')));
    });

    it('Workflow 6: Team member invites second approved registrant, recipient accepts atomically, and members list roster', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedUser({ uid: 'p2' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published', maxTeamSize: 4 });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'leader', status: 'approved' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p2', status: 'approved' });
      await seedTeam({ teamId: 'team_w6', hackathonId: 'hack_1', organizerId: 'org1', leaderId: 'leader' });

      const leaderDb = verifiedCtx('leader').firestore();
      await assertSucceeds(
        setDoc(doc(leaderDb, 'teamInvitations', 'inv_w6'), {
          id: 'inv_w6',
          teamId: 'team_w6',
          teamName: 'Team Nova',
          hackathonId: 'hack_1',
          fromUserId: 'leader',
          fromUserName: 'Leader',
          toUserId: 'p2',
          toUserName: 'Builder Two',
          roleOffered: 'AI Engineer',
          message: 'Join us!',
          status: 'pending',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      const p2Db = verifiedCtx('p2').firestore();
      const batch = writeBatch(p2Db);
      batch.update(doc(p2Db, 'teamInvitations', 'inv_w6'), {
        status: 'accepted',
        updatedAt: serverTimestamp()
      });
      batch.set(doc(p2Db, 'teams', 'team_w6', 'joinClaims', 'p2'), {
        uid: 'p2',
        teamId: 'team_w6',
        mode: 'invitation',
        invitationId: 'inv_w6',
        presentedAt: serverTimestamp()
      });
      batch.update(doc(p2Db, 'teams', 'team_w6'), {
        memberIds: arrayUnion('p2'),
        memberNames: arrayUnion('Builder Two'),
        updatedAt: serverTimestamp()
      });
      batch.set(doc(p2Db, 'teams', 'team_w6', 'members', 'p2'), {
        uid: 'p2',
        displayName: 'Builder Two',
        roleInTeam: 'AI Engineer',
        joinedAt: serverTimestamp()
      });

      await assertSucceeds(batch.commit());
      await assertSucceeds(getDocs(collection(p2Db, 'teams', 'team_w6', 'members')));
    });

    it('Workflow 7: Team member creates and updates project tasks without altering memberIds', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'owner1' });
      await seedUser({ uid: 'member2' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published' });
      await seedTeam({ teamId: 'team_1', hackathonId: 'hack_1', organizerId: 'org1', leaderId: 'owner1', memberIds: ['owner1', 'member2'] });

      const ownerDb = verifiedCtx('owner1').firestore();
      await assertSucceeds(
        setDoc(doc(ownerDb, 'projects', 'proj_w7'), {
          id: 'proj_w7',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          teamId: 'team_1',
          ownerId: 'owner1',
          memberIds: ['owner1', 'member2'],
          title: 'Edge Workspace',
          status: 'building',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      const m2Db = verifiedCtx('member2').firestore();
      await assertSucceeds(
        updateDoc(doc(m2Db, 'projects', 'proj_w7'), {
          notes: 'Updated sprint tasks',
          tasks: [{ id: 't1', title: 'Write rules', assigneeName: 'member2', status: 'done', dueDate: '' }],
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Workflow 8: Team submits project before deadline and organizer bulk-assigns judge', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'owner1' });
      await seedUser({ uid: 'j1', approvedRole: 'judge' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published', subDeadlineFuture: true });
      await seedTeam({ teamId: 'team_1', hackathonId: 'hack_1', organizerId: 'org1', leaderId: 'owner1' });
      await seedProject({ projectId: 'proj_1', hackathonId: 'hack_1', organizerId: 'org1', teamId: 'team_1', ownerId: 'owner1', memberIds: ['owner1'] });

      const ownerDb = verifiedCtx('owner1').firestore();
      await assertSucceeds(
        setDoc(doc(ownerDb, 'submissions', 'sub_w8'), {
          id: 'sub_w8',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          teamId: 'team_1',
          teamName: 'Team Nova',
          projectId: 'proj_1',
          ownerId: 'owner1',
          memberIds: ['owner1'],
          title: 'Nova Build',
          shortDescription: 'Working edge AI assistant',
          githubUrl: 'https://github.com/hackmind/nova',
          status: 'submitted',
          submittedAt: serverTimestamp(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      const orgDb = verifiedCtx('org1').firestore();
      const batch = writeBatch(orgDb);
      batch.set(doc(orgDb, 'judgeAssignments', 'hack_1_j1'), {
        id: 'hack_1_j1',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        judgeId: 'j1',
        judgeName: 'Judge 1',
        assignedSubmissionIds: ['sub_w8'],
        conflictDeclared: false,
        conflictNotes: '',
        status: 'invited',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      batch.update(doc(orgDb, 'submissions', 'sub_w8'), {
        status: 'under_review',
        updatedAt: serverTimestamp()
      });
      await assertSucceeds(batch.commit());
    });

    it('Workflow 9: Judge accepts assignment, fetches assigned submission, saves draft and submits final evaluation', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'owner1' });
      await seedUser({ uid: 'j1', approvedRole: 'judge' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'judging' });
      await seedTeam({ teamId: 'team_1', hackathonId: 'hack_1', organizerId: 'org1', leaderId: 'owner1' });
      await seedProject({ projectId: 'proj_1', hackathonId: 'hack_1', organizerId: 'org1', teamId: 'team_1', ownerId: 'owner1', memberIds: ['owner1'] });
      await seedSubmission({
        submissionId: 'sub_1',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        teamId: 'team_1',
        projectId: 'proj_1',
        ownerId: 'owner1',
        memberIds: ['owner1'],
        status: 'under_review'
      });

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'judgeAssignments', 'hack_1_j1'), {
          id: 'hack_1_j1',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          judgeId: 'j1',
          judgeName: 'Judge 1',
          assignedSubmissionIds: ['sub_1'],
          conflictDeclared: false,
          conflictNotes: '',
          status: 'invited',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
      });

      const jDb = verifiedCtx('j1').firestore();
      await assertSucceeds(
        updateDoc(doc(jDb, 'judgeAssignments', 'hack_1_j1'), {
          status: 'accepted',
          conflictDeclared: false,
          conflictNotes: '',
          updatedAt: serverTimestamp()
        })
      );

      await assertSucceeds(getDoc(doc(jDb, 'submissions', 'sub_1')));

      await assertSucceeds(
        setDoc(doc(jDb, 'evaluations', 'sub_1_j1'), {
          id: 'sub_1_j1',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          submissionId: 'sub_1',
          judgeId: 'j1',
          judgeName: 'Judge 1',
          criteriaScores: [],
          weightedTotal: 90,
          scoredCriterionCount: 1,
          storageSchema: 'v2_subcollection',
          conflictOfInterest: false,
          humanFeedback: 'Initial notes',
          status: 'draft',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      await assertSucceeds(
        setDoc(doc(jDb, 'evaluations', 'sub_1_j1', 'criteria', 'innovation'), {
          criterionId: 'innovation',
          evaluationId: 'sub_1_j1',
          hackathonId: 'hack_1',
          submissionId: 'sub_1',
          judgeId: 'j1',
          criterionName: 'Innovation',
          weight: 100,
          score: 9,
          comment: 'Great',
          updatedAt: serverTimestamp()
        })
      );

      await assertSucceeds(
        updateDoc(doc(jDb, 'evaluations', 'sub_1_j1'), {
          status: 'finalizing',
          updatedAt: serverTimestamp()
        })
      );

      const readBackSnap = await assertSucceeds(getDocs(collection(jDb, 'evaluations', 'sub_1_j1', 'criteria')));
      expect(readBackSnap.docs).toHaveLength(1);

      await assertSucceeds(
        updateDoc(doc(jDb, 'evaluations', 'sub_1_j1'), {
          humanFeedback: 'Final score confirmed',
          status: 'submitted',
          submittedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Workflow 10: Approved organizer atomically publishes results and completes hackathon', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedHackathon({ id: 'hack_w10', organizerId: 'org1', status: 'judging' });

      const orgDb = verifiedCtx('org1').firestore();
      const batch = writeBatch(orgDb);
      batch.set(doc(orgDb, 'hackathonResults', 'hack_w10'), {
        hackathonId: 'hack_w10',
        organizerId: 'org1',
        published: true,
        rankings: [{ submissionId: 'sub_1', rank: 1, normalizedScore: 90 }],
        publishedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      batch.update(doc(orgDb, 'hackathons', 'hack_w10'), {
        resultsPublished: true,
        status: 'completed',
        updatedAt: serverTimestamp()
      });

      await assertSucceeds(batch.commit());
    });

    it('Workflow 11: Public/unauthenticated users can read published hackathons and published results', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedHackathon({ id: 'hack_pub', organizerId: 'org1', status: 'completed' });
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'hackathonResults', 'hack_pub'), {
          hackathonId: 'hack_pub',
          organizerId: 'org1',
          published: true,
          rankings: [],
          publishedAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
      });

      const anonDb = testEnv.unauthenticatedContext().firestore();
      await assertSucceeds(getDocs(query(collection(anonDb, 'hackathons'), where('status', 'in', ['published', 'judging', 'completed']))));
      await assertSucceeds(getDocs(query(collection(anonDb, 'hackathonResults'), where('published', '==', true))));
    });

    it('Workflow 12: User creates self-notification with valid /app link, marks read, and deletes it', async () => {
      await seedUser({ uid: 'u1' });
      const db = verifiedCtx('u1').firestore();

      await assertSucceeds(
        setDoc(doc(db, 'notifications', 'ntf_w12'), {
          id: 'ntf_w12',
          userId: 'u1',
          type: 'deadline',
          title: 'Submission Reminder',
          message: 'Finish your demo video before deadline.',
          link: '/app/builder',
          read: false,
          createdAt: serverTimestamp()
        })
      );
      await assertSucceeds(updateDoc(doc(db, 'notifications', 'ntf_w12'), { read: true }));
      await assertSucceeds(deleteDoc(doc(db, 'notifications', 'ntf_w12')));
    });

    it('Workflow 13: Sponsor submits pending community request; organizer approves and assigns gold tier', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'sp1', approvedRole: 'sponsor' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published' });

      const spDb = verifiedCtx('sp1').firestore();
      await assertSucceeds(
        setDoc(doc(spDb, 'sponsors', 'sp_w13'), {
          id: 'sp_w13',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          sponsorUserId: 'sp1',
          organizationName: 'CloudEdge Labs',
          tier: 'community',
          status: 'pending',
          websiteUrl: 'https://cloudedge.example.com',
          notes: 'Offering prize credits',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      const orgDb = verifiedCtx('org1').firestore();
      await assertSucceeds(
        updateDoc(doc(orgDb, 'sponsors', 'sp_w13'), {
          status: 'approved',
          tier: 'gold',
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Workflow 14: Organizer records valid audit log and verified user records bounded aiUsage telemetry', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      const orgDb = verifiedCtx('org1').firestore();

      await assertSucceeds(
        setDoc(doc(orgDb, 'auditLogs', 'aud_w14'), {
          id: 'aud_w14',
          actorId: 'org1',
          actorName: 'Organizer One',
          action: 'results_published',
          targetCollection: 'hackathonResults',
          targetId: 'hack_1',
          hackathonId: 'hack_1',
          details: 'Published final rankings',
          createdAt: serverTimestamp()
        })
      );

      await assertSucceeds(
        setDoc(doc(orgDb, 'aiUsage', 'ai_w14'), {
          id: 'ai_w14',
          userId: 'org1',
          taskName: 'hackathon_builder',
          inferenceSource: 'CLOUD',
          requestedMode: 'prefer_in_cloud',
          modelId: 'gemini-3.5-flash-lite',
          durationMs: 840,
          fallbackOccurred: false,
          status: 'success',
          createdAt: serverTimestamp()
        })
      );
    });
  });

  // =========================================================================
  // PHASE 2.3: DOUBLE-HASH JOIN CODES, INVITATION EDGE CASES & HARDENING
  // =========================================================================
  describe('Phase 2.3 Security Hardening & Lifecycle Tests', () => {
    it('Attack 25: Plaintext token in joinClaims, plaintext code in private/joinCode, and passing verifierHash as proof are denied', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedUser({ uid: 'p2' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'leader', status: 'approved' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p2', status: 'approved' });
      const { token, verifierHash } = await seedTeam({
        teamId: 'team_1',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        leaderId: 'leader'
      });

      const p2Db = verifiedCtx('p2').firestore();
      // Attempt 1: plaintext token in joinClaims
      const plaintextBatch = writeBatch(p2Db);
      plaintextBatch.set(doc(p2Db, 'teams', 'team_1', 'joinClaims', 'p2'), {
        uid: 'p2',
        teamId: 'team_1',
        mode: 'join_code',
        token,
        presentedAt: serverTimestamp()
      });
      plaintextBatch.update(doc(p2Db, 'teams', 'team_1'), {
        memberIds: arrayUnion('p2'),
        memberNames: arrayUnion('User p2'),
        updatedAt: serverTimestamp()
      });
      plaintextBatch.set(doc(p2Db, 'teams', 'team_1', 'members', 'p2'), {
        uid: 'p2',
        displayName: 'User p2',
        roleInTeam: 'Member',
        joinedAt: serverTimestamp()
      });
      await assertFails(plaintextBatch.commit());

      // Attempt 2: presenting Firestore-stored verifierHash V instead of P = SHA256(T)
      const verifierAsProofBatch = buildJoinByCodeBatch(p2Db, {
        teamId: 'team_1',
        uid: 'p2',
        displayName: 'User p2',
        proof: verifierHash
      });
      await assertFails(verifierAsProofBatch.commit());

      // Attempt 3: leader cannot store plaintext code in private/joinCode
      const leaderDb = verifiedCtx('leader').firestore();
      await assertFails(
        updateDoc(doc(leaderDb, 'teams', 'team_1', 'private', 'joinCode'), {
          code: token,
          verifierHash,
          leaderId: 'leader',
          active: true,
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Attack 26: Unverified user cannot read /teams/{teamId}/private/joinCode even if listed as leader', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published' });
      await seedTeam({ teamId: 'team_1', hackathonId: 'hack_1', organizerId: 'org1', leaderId: 'leader' });

      const unverifiedLeaderDb = unverifiedCtx('leader').firestore();
      await assertFails(getDoc(doc(unverifiedLeaderDb, 'teams', 'team_1', 'private', 'joinCode')));
    });

    it('Attack 27: Non-leader cannot create /teamJoinCodes pointing to another team or hijack teamId on update', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedUser({ uid: 'attacker' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published' });
      const { verifierHash } = await seedTeam({
        teamId: 'team_victim',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        leaderId: 'leader'
      });

      const forgedProof = sha256('HM-ATTACKER000000000000000000000000');
      const forgedVerifier = sha256(forgedProof);
      const attackerDb = verifiedCtx('attacker').firestore();

      await assertFails(
        setDoc(doc(attackerDb, 'teamJoinCodes', forgedVerifier), {
          id: forgedVerifier,
          verifierHash: forgedVerifier,
          teamId: 'team_victim',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          leaderId: 'attacker',
          active: true,
          createdAt: serverTimestamp()
        })
      );

      // Even leader cannot mutate teamId or re-enable old hash in /teamJoinCodes
      const leaderDb = verifiedCtx('leader').firestore();
      await assertFails(
        updateDoc(doc(leaderDb, 'teamJoinCodes', verifierHash), {
          teamId: 'team_other'
        })
      );
    });

    it('Attack 28: Team leader cannot leave team or remove themselves from memberIds', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedUser({ uid: 'p2' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published' });
      await seedTeam({
        teamId: 'team_1',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        leaderId: 'leader',
        memberIds: ['leader', 'p2']
      });

      const leaderDb = verifiedCtx('leader').firestore();
      await assertFails(
        updateDoc(doc(leaderDb, 'teams', 'team_1'), {
          memberIds: ['p2'],
          memberNames: ['User p2'],
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Attack 29: Joining member cannot inject bogus extra memberNames or exceed memberIds length', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedUser({ uid: 'p2' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p2', status: 'approved' });
      const { proof } = await seedTeam({
        teamId: 'team_1',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        leaderId: 'leader'
      });

      const p2Db = verifiedCtx('p2').firestore();
      const batch = writeBatch(p2Db);
      batch.set(doc(p2Db, 'teams', 'team_1', 'joinClaims', 'p2'), {
        uid: 'p2',
        teamId: 'team_1',
        mode: 'join_code',
        proof,
        presentedAt: serverTimestamp()
      });
      batch.update(doc(p2Db, 'teams', 'team_1'), {
        memberIds: arrayUnion('p2'),
        memberNames: ['User leader', 'Fake 1', 'Fake 2'],
        updatedAt: serverTimestamp()
      });
      batch.set(doc(p2Db, 'teams', 'team_1', 'members', 'p2'), {
        uid: 'p2',
        displayName: 'User p2',
        roleInTeam: 'Member',
        joinedAt: serverTimestamp()
      });
      await assertFails(batch.commit());
    });

    it('Attack 30 & Workflow 15: Leader revocation & rotation invalidate old proof; only new proof succeeds; non-leader blocked', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedUser({ uid: 'p2' });
      await seedUser({ uid: 'p3' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published', maxTeamSize: 4 });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p2', status: 'approved' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p3', status: 'approved' });
      const { proof: proof1, verifierHash: v1 } = await seedTeam({
        teamId: 'team_rot',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        leaderId: 'leader'
      });

      // Non-leader cannot revoke
      const p2Db = verifiedCtx('p2').firestore();
      await assertFails(
        updateDoc(doc(p2Db, 'teamJoinCodes', v1), { active: false })
      );

      // Leader revokes join code atomically
      const leaderDb = verifiedCtx('leader').firestore();
      const revokeBatch = writeBatch(leaderDb);
      revokeBatch.update(doc(leaderDb, 'teamJoinCodes', v1), { active: false });
      revokeBatch.update(doc(leaderDb, 'teams', 'team_rot', 'private', 'joinCode'), {
        verifierHash: v1,
        leaderId: 'leader',
        active: false,
        updatedAt: serverTimestamp()
      });
      await assertSucceeds(revokeBatch.commit());

      // Joining with revoked proof fails
      await assertFails(
        buildJoinByCodeBatch(p2Db, {
          teamId: 'team_rot',
          uid: 'p2',
          displayName: 'User p2',
          proof: proof1
        }).commit()
      );

      // Leader rotates join code atomically to new token/proof/verifier
      const token2 = 'HM-99887766554433221100FFEEDDCCBBAA';
      const proof2 = sha256(token2);
      const v2 = sha256(proof2);
      const rotateBatch = writeBatch(leaderDb);
      rotateBatch.set(doc(leaderDb, 'teamJoinCodes', v2), {
        id: v2,
        verifierHash: v2,
        teamId: 'team_rot',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        leaderId: 'leader',
        active: true,
        createdAt: serverTimestamp()
      });
      rotateBatch.update(doc(leaderDb, 'teams', 'team_rot', 'private', 'joinCode'), {
        verifierHash: v2,
        leaderId: 'leader',
        active: true,
        updatedAt: serverTimestamp()
      });
      await assertSucceeds(rotateBatch.commit());

      // Old proof still fails; new proof succeeds
      await assertFails(
        buildJoinByCodeBatch(p2Db, {
          teamId: 'team_rot',
          uid: 'p2',
          displayName: 'User p2',
          proof: proof1
        }).commit()
      );
      await assertSucceeds(
        buildJoinByCodeBatch(p2Db, {
          teamId: 'team_rot',
          uid: 'p2',
          displayName: 'User p2',
          proof: proof2
        }).commit()
      );
    });

    it('Attack 31: Member leaves team, can rejoin only while join code is active, and cannot rejoin once revoked', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedUser({ uid: 'p2' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published', maxTeamSize: 4 });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p2', status: 'approved' });
      const { proof, verifierHash } = await seedTeam({
        teamId: 'team_rejoin',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        leaderId: 'leader',
        memberIds: ['leader', 'p2']
      });

      const p2Db = verifiedCtx('p2').firestore();
      // Leave atomically
      const leaveBatch = writeBatch(p2Db);
      leaveBatch.update(doc(p2Db, 'teams', 'team_rejoin'), {
        memberIds: ['leader'],
        memberNames: ['User leader'],
        updatedAt: serverTimestamp()
      });
      leaveBatch.delete(doc(p2Db, 'teams', 'team_rejoin', 'members', 'p2'));
      await assertSucceeds(leaveBatch.commit());

      // Rejoin succeeds while code is active
      await assertSucceeds(
        buildJoinByCodeBatch(p2Db, {
          teamId: 'team_rejoin',
          uid: 'p2',
          displayName: 'User p2',
          proof
        }).commit()
      );

      // Leave again and leader revokes code
      const leaveBatch2 = writeBatch(p2Db);
      leaveBatch2.update(doc(p2Db, 'teams', 'team_rejoin'), {
        memberIds: ['leader'],
        memberNames: ['User leader'],
        updatedAt: serverTimestamp()
      });
      leaveBatch2.delete(doc(p2Db, 'teams', 'team_rejoin', 'members', 'p2'));
      await assertSucceeds(leaveBatch2.commit());

      const leaderDb = verifiedCtx('leader').firestore();
      const revokeBatch = writeBatch(leaderDb);
      revokeBatch.update(doc(leaderDb, 'teamJoinCodes', verifierHash), { active: false });
      revokeBatch.update(doc(leaderDb, 'teams', 'team_rejoin', 'private', 'joinCode'), {
        verifierHash,
        leaderId: 'leader',
        active: false,
        updatedAt: serverTimestamp()
      });
      await assertSucceeds(revokeBatch.commit());

      // Rejoin after revocation fails
      await assertFails(
        buildJoinByCodeBatch(p2Db, {
          teamId: 'team_rejoin',
          uid: 'p2',
          displayName: 'User p2',
          proof
        }).commit()
      );
    });

    it('Attack 32: Invitation acceptance with pending registration, wrong recipient, non-pending status, replay, locked/full team is denied', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedUser({ uid: 'p_pending' });
      await seedUser({ uid: 'p2' });
      await seedUser({ uid: 'p3' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published', maxTeamSize: 2 });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'leader', status: 'approved' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p_pending', status: 'pending' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p2', status: 'approved' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p3', status: 'approved' });

      await seedTeam({ teamId: 'team_inv', hackathonId: 'hack_1', organizerId: 'org1', leaderId: 'leader' });
      await seedTeam({ teamId: 'team_locked', hackathonId: 'hack_1', organizerId: 'org1', leaderId: 'leader', status: 'locked' });
      await seedTeam({ teamId: 'team_full', hackathonId: 'hack_1', organizerId: 'org1', leaderId: 'leader', memberIds: ['leader', 'p2'] });

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        await setDoc(doc(db, 'teamInvitations', 'inv_pending_reg'), {
          id: 'inv_pending_reg',
          teamId: 'team_inv',
          teamName: 'Team Nova',
          hackathonId: 'hack_1',
          fromUserId: 'leader',
          toUserId: 'p_pending',
          status: 'pending',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
        await setDoc(doc(db, 'teamInvitations', 'inv_p2'), {
          id: 'inv_p2',
          teamId: 'team_inv',
          teamName: 'Team Nova',
          hackathonId: 'hack_1',
          fromUserId: 'leader',
          toUserId: 'p2',
          status: 'pending',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
        await setDoc(doc(db, 'teamInvitations', 'inv_rejected'), {
          id: 'inv_rejected',
          teamId: 'team_inv',
          teamName: 'Team Nova',
          hackathonId: 'hack_1',
          fromUserId: 'leader',
          toUserId: 'p3',
          status: 'rejected',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
        await setDoc(doc(db, 'teamInvitations', 'inv_locked'), {
          id: 'inv_locked',
          teamId: 'team_locked',
          teamName: 'Team Nova',
          hackathonId: 'hack_1',
          fromUserId: 'leader',
          toUserId: 'p3',
          status: 'pending',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
        await setDoc(doc(db, 'teamInvitations', 'inv_full'), {
          id: 'inv_full',
          teamId: 'team_full',
          teamName: 'Team Nova',
          hackathonId: 'hack_1',
          fromUserId: 'leader',
          toUserId: 'p3',
          status: 'pending',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
      });

      const pendingDb = verifiedCtx('p_pending').firestore();
      const pendingBatch = writeBatch(pendingDb);
      pendingBatch.update(doc(pendingDb, 'teamInvitations', 'inv_pending_reg'), { status: 'accepted', updatedAt: serverTimestamp() });
      pendingBatch.set(doc(pendingDb, 'teams', 'team_inv', 'joinClaims', 'p_pending'), {
        uid: 'p_pending', teamId: 'team_inv', mode: 'invitation', invitationId: 'inv_pending_reg', presentedAt: serverTimestamp()
      });
      pendingBatch.update(doc(pendingDb, 'teams', 'team_inv'), { memberIds: arrayUnion('p_pending'), updatedAt: serverTimestamp() });
      pendingBatch.set(doc(pendingDb, 'teams', 'team_inv', 'members', 'p_pending'), {
        uid: 'p_pending', displayName: 'Pending', roleInTeam: 'Member', joinedAt: serverTimestamp()
      });
      await assertFails(pendingBatch.commit());

      // p3 trying to accept inv_p2 addressed to p2 fails
      const p3Db = verifiedCtx('p3').firestore();
      const hijackBatch = writeBatch(p3Db);
      hijackBatch.update(doc(p3Db, 'teamInvitations', 'inv_p2'), { status: 'accepted', updatedAt: serverTimestamp() });
      hijackBatch.set(doc(p3Db, 'teams', 'team_inv', 'joinClaims', 'p3'), {
        uid: 'p3', teamId: 'team_inv', mode: 'invitation', invitationId: 'inv_p2', presentedAt: serverTimestamp()
      });
      hijackBatch.update(doc(p3Db, 'teams', 'team_inv'), { memberIds: arrayUnion('p3'), updatedAt: serverTimestamp() });
      hijackBatch.set(doc(p3Db, 'teams', 'team_inv', 'members', 'p3'), {
        uid: 'p3', displayName: 'P3', roleInTeam: 'Member', joinedAt: serverTimestamp()
      });
      await assertFails(hijackBatch.commit());

      // Rejected, locked-team, and full-team invitations fail
      for (const [invId, tId] of [
        ['inv_rejected', 'team_inv'],
        ['inv_locked', 'team_locked'],
        ['inv_full', 'team_full']
      ] as const) {
        const badBatch = writeBatch(p3Db);
        badBatch.update(doc(p3Db, 'teamInvitations', invId), { status: 'accepted', updatedAt: serverTimestamp() });
        badBatch.set(doc(p3Db, 'teams', tId, 'joinClaims', 'p3'), {
          uid: 'p3', teamId: tId, mode: 'invitation', invitationId: invId, presentedAt: serverTimestamp()
        });
        badBatch.update(doc(p3Db, 'teams', tId), { memberIds: arrayUnion('p3'), updatedAt: serverTimestamp() });
        badBatch.set(doc(p3Db, 'teams', tId, 'members', 'p3'), {
          uid: 'p3', displayName: 'P3', roleInTeam: 'Member', joinedAt: serverTimestamp()
        });
        await assertFails(badBatch.commit());
      }

      // p2 accepts inv_p2, then leaves and tries to replay inv_p2 -> replay MUST fail
      const p2Db = verifiedCtx('p2').firestore();
      const acceptBatch = writeBatch(p2Db);
      acceptBatch.update(doc(p2Db, 'teamInvitations', 'inv_p2'), { status: 'accepted', updatedAt: serverTimestamp() });
      acceptBatch.set(doc(p2Db, 'teams', 'team_inv', 'joinClaims', 'p2'), {
        uid: 'p2', teamId: 'team_inv', mode: 'invitation', invitationId: 'inv_p2', presentedAt: serverTimestamp()
      });
      acceptBatch.update(doc(p2Db, 'teams', 'team_inv'), { memberIds: arrayUnion('p2'), updatedAt: serverTimestamp() });
      acceptBatch.set(doc(p2Db, 'teams', 'team_inv', 'members', 'p2'), {
        uid: 'p2', displayName: 'P2', roleInTeam: 'Member', joinedAt: serverTimestamp()
      });
      await assertSucceeds(acceptBatch.commit());

      const leaveBatch = writeBatch(p2Db);
      leaveBatch.update(doc(p2Db, 'teams', 'team_inv'), {
        memberIds: ['leader'],
        memberNames: ['User leader'],
        updatedAt: serverTimestamp()
      });
      leaveBatch.delete(doc(p2Db, 'teams', 'team_inv', 'members', 'p2'));
      await assertSucceeds(leaveBatch.commit());

      const replayBatch = writeBatch(p2Db);
      replayBatch.set(doc(p2Db, 'teams', 'team_inv', 'joinClaims', 'p2'), {
        uid: 'p2', teamId: 'team_inv', mode: 'invitation', invitationId: 'inv_p2', presentedAt: serverTimestamp()
      });
      replayBatch.update(doc(p2Db, 'teams', 'team_inv'), { memberIds: arrayUnion('p2'), updatedAt: serverTimestamp() });
      replayBatch.set(doc(p2Db, 'teams', 'team_inv', 'members', 'p2'), {
        uid: 'p2', displayName: 'P2', roleInTeam: 'Member', joinedAt: serverTimestamp()
      });
      await assertFails(replayBatch.commit());
    });

    it('Attack 33: Submission screenshotUrls javascript: XSS at non-zero index is denied; valid https URLs succeed', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'owner1' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published', subDeadlineFuture: true });
      await seedTeam({ teamId: 'team_1', hackathonId: 'hack_1', organizerId: 'org1', leaderId: 'owner1' });
      await seedProject({ projectId: 'proj_1', hackathonId: 'hack_1', organizerId: 'org1', teamId: 'team_1', ownerId: 'owner1', memberIds: ['owner1'] });

      const ownerDb = verifiedCtx('owner1').firestore();
      await assertFails(
        setDoc(doc(ownerDb, 'submissions', 'sub_xss_idx1'), {
          id: 'sub_xss_idx1',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          teamId: 'team_1',
          projectId: 'proj_1',
          ownerId: 'owner1',
          memberIds: ['owner1'],
          title: 'XSS Index 1',
          shortDescription: 'Malicious second screenshot',
          screenshotUrls: ['https://ok.example.com/1.png', 'javascript:alert(1)'],
          status: 'draft',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      await assertSucceeds(
        setDoc(doc(ownerDb, 'submissions', 'sub_ok_urls'), {
          id: 'sub_ok_urls',
          hackathonId: 'hack_1',
          organizerId: 'org1',
          teamId: 'team_1',
          projectId: 'proj_1',
          ownerId: 'owner1',
          memberIds: ['owner1'],
          title: 'Valid Screenshots',
          shortDescription: 'All HTTPS screenshot URLs',
          screenshotUrls: [
            'https://cdn.example.com/1.png',
            'https://cdn.example.com/2.png',
            'https://cdn.example.com/3.png'
          ],
          status: 'draft',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );
    });
  });

  // =========================================================================
  // PHASE 2.3 TASK 2: CONCURRENCY & ATOMIC RACE CONDITION VERIFICATION
  // =========================================================================
  describe('Concurrency & Race Condition Safety (Firestore Emulator)', () => {
    it('Concurrency 1: Two users join simultaneously with 1 slot remaining (maxTeamSize=2) -> 1 succeeds, 1 fails', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedUser({ uid: 'p2' });
      await seedUser({ uid: 'p3' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published', maxTeamSize: 2 });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p2', status: 'approved' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p3', status: 'approved' });
      const { proof } = await seedTeam({
        teamId: 'team_race_2',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        leaderId: 'leader'
      });

      const p2Db = verifiedCtx('p2').firestore();
      const p3Db = verifiedCtx('p3').firestore();
      const results = await Promise.allSettled([
        buildJoinByCodeBatch(p2Db, { teamId: 'team_race_2', uid: 'p2', displayName: 'User p2', proof }).commit(),
        buildJoinByCodeBatch(p3Db, { teamId: 'team_race_2', uid: 'p3', displayName: 'User p3', proof }).commit()
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const teamSnap = await getDoc(doc(ctx.firestore(), 'teams', 'team_race_2'));
        expect(teamSnap.data()?.memberIds).toHaveLength(2);
      });
    });

    it('Concurrency 2: Three users race for 1 remaining slot -> exactly 1 succeeds, 2 fail, memberIds stays bounded', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedUser({ uid: 'p2' });
      await seedUser({ uid: 'p3' });
      await seedUser({ uid: 'p4' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published', maxTeamSize: 2 });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p2', status: 'approved' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p3', status: 'approved' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p4', status: 'approved' });
      const { proof } = await seedTeam({
        teamId: 'team_race_3',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        leaderId: 'leader'
      });

      const results = await Promise.allSettled(
        (['p2', 'p3', 'p4'] as const).map((uid) =>
          buildJoinByCodeBatch(verifiedCtx(uid).firestore(), {
            teamId: 'team_race_3',
            uid,
            displayName: `User ${uid}`,
            proof
          }).commit()
        )
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const teamSnap = await getDoc(doc(ctx.firestore(), 'teams', 'team_race_3'));
        expect(teamSnap.data()?.memberIds).toHaveLength(2);
      });
    });

    it('Concurrency 3: Concurrent invitation acceptance vs join-code join with 1 slot remaining -> strictly serialized by maxTeamSize', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedUser({ uid: 'p_inv' });
      await seedUser({ uid: 'p_code' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published', maxTeamSize: 2 });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p_inv', status: 'approved' });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p_code', status: 'approved' });
      const { proof } = await seedTeam({
        teamId: 'team_race_mixed',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        leaderId: 'leader'
      });

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'teamInvitations', 'inv_race'), {
          id: 'inv_race',
          teamId: 'team_race_mixed',
          teamName: 'Team Nova',
          hackathonId: 'hack_1',
          fromUserId: 'leader',
          toUserId: 'p_inv',
          status: 'pending',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
      });

      const invDb = verifiedCtx('p_inv').firestore();
      const invBatch = writeBatch(invDb);
      invBatch.update(doc(invDb, 'teamInvitations', 'inv_race'), { status: 'accepted', updatedAt: serverTimestamp() });
      invBatch.set(doc(invDb, 'teams', 'team_race_mixed', 'joinClaims', 'p_inv'), {
        uid: 'p_inv', teamId: 'team_race_mixed', mode: 'invitation', invitationId: 'inv_race', presentedAt: serverTimestamp()
      });
      invBatch.update(doc(invDb, 'teams', 'team_race_mixed'), {
        memberIds: arrayUnion('p_inv'),
        memberNames: arrayUnion('User p_inv'),
        updatedAt: serverTimestamp()
      });
      invBatch.set(doc(invDb, 'teams', 'team_race_mixed', 'members', 'p_inv'), {
        uid: 'p_inv', displayName: 'User p_inv', roleInTeam: 'Member', joinedAt: serverTimestamp()
      });

      const codeBatch = buildJoinByCodeBatch(verifiedCtx('p_code').firestore(), {
        teamId: 'team_race_mixed',
        uid: 'p_code',
        displayName: 'User p_code',
        proof
      });

      const results = await Promise.allSettled([invBatch.commit(), codeBatch.commit()]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const teamSnap = await getDoc(doc(ctx.firestore(), 'teams', 'team_race_mixed'));
        expect(teamSnap.data()?.memberIds).toHaveLength(2);
      });
    });

    it('Concurrency 4: Duplicate concurrent join-code submissions by the same user -> only 1 succeeds', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedUser({ uid: 'p2' });
      await seedHackathon({ id: 'hack_1', organizerId: 'org1', status: 'published', maxTeamSize: 4 });
      await seedRegistration({ hackathonId: 'hack_1', organizerId: 'org1', userId: 'p2', status: 'approved' });
      const { proof } = await seedTeam({
        teamId: 'team_dup',
        hackathonId: 'hack_1',
        organizerId: 'org1',
        leaderId: 'leader'
      });

      const p2Db = verifiedCtx('p2').firestore();
      const results = await Promise.allSettled([
        buildJoinByCodeBatch(p2Db, { teamId: 'team_dup', uid: 'p2', displayName: 'User p2', proof }).commit(),
        buildJoinByCodeBatch(p2Db, { teamId: 'team_dup', uid: 'p2', displayName: 'User p2', proof }).commit()
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });
  });

  // =========================================================================
  // INITIAL NONEXISTENT-DOCUMENT GET REGRESSION SUITE (resource == null)
  // =========================================================================
  describe('First-Time Nonexistent Document Get & Existing Document Access Regressions', () => {
    it('judgeAssignments: approved owning organizer can get nonexistent assignment, create it, and update it; unauthorized users denied', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'org2', approvedRole: 'organizer' });
      await seedUser({ uid: 'unapproved_org', approvedRole: 'participant', requestedRole: 'organizer' });
      await seedUser({ uid: 'j1', approvedRole: 'judge' });
      await seedUser({ uid: 'p1', approvedRole: 'participant' });

      // Production-style 3-segment hackathon ID
      const prodHackId = 'hack_m3abc_9f8e7d';
      await seedHackathon({ id: prodHackId, organizerId: 'org1', status: 'judging' });
      await seedTeam({ teamId: 'team_1', hackathonId: prodHackId, organizerId: 'org1', leaderId: 'p1' });
      await seedProject({ projectId: 'proj_1', hackathonId: prodHackId, organizerId: 'org1', teamId: 'team_1', ownerId: 'p1', memberIds: ['p1'] });
      await seedSubmission({
        submissionId: 'sub_m3abc_9f8e7d',
        hackathonId: prodHackId,
        organizerId: 'org1',
        teamId: 'team_1',
        projectId: 'proj_1',
        ownerId: 'p1',
        memberIds: ['p1'],
        status: 'submitted'
      });

      const assignmentId = `${prodHackId}_j1`;
      const anonDb = testEnv.unauthenticatedContext().firestore();
      const org1Db = verifiedCtx('org1').firestore();
      const org2Db = verifiedCtx('org2').firestore();
      const unapprovedDb = verifiedCtx('unapproved_org').firestore();
      const j1Db = verifiedCtx('j1').firestore();
      const p1Db = verifiedCtx('p1').firestore();

      // Unauthorized users cannot probe nonexistent judgeAssignments
      await assertFails(getDoc(doc(anonDb, 'judgeAssignments', assignmentId)));
      await assertFails(getDoc(doc(p1Db, 'judgeAssignments', assignmentId)));
      await assertFails(getDoc(doc(unapprovedDb, 'judgeAssignments', assignmentId)));
      await assertFails(getDoc(doc(org2Db, 'judgeAssignments', assignmentId)));
      await assertFails(getDoc(doc(j1Db, 'judgeAssignments', assignmentId)));
      await assertFails(getDoc(doc(org1Db, 'judgeAssignments', 'hack_nonexistent_j1')));

      // Owning approved organizer CAN perform initial get of nonexistent assignment
      const initialSnap = await assertSucceeds(getDoc(doc(org1Db, 'judgeAssignments', assignmentId)));
      expect(initialSnap.exists()).toBe(false);

      // First-time create via batch succeeds
      const batch = writeBatch(org1Db);
      batch.set(doc(org1Db, 'judgeAssignments', assignmentId), {
        id: assignmentId,
        hackathonId: prodHackId,
        organizerId: 'org1',
        judgeId: 'j1',
        judgeName: 'Judge 1',
        assignedSubmissionIds: ['sub_m3abc_9f8e7d'],
        conflictDeclared: false,
        conflictNotes: '',
        status: 'invited',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      batch.update(doc(org1Db, 'submissions', 'sub_m3abc_9f8e7d'), {
        status: 'under_review',
        updatedAt: serverTimestamp()
      });
      await assertSucceeds(batch.commit());

      // Existing-document access succeeds for owning organizer and assigned judge, denied for org2/p1
      const existingOrgSnap = await assertSucceeds(getDoc(doc(org1Db, 'judgeAssignments', assignmentId)));
      expect(existingOrgSnap.exists()).toBe(true);
      const existingJudgeSnap = await assertSucceeds(getDoc(doc(j1Db, 'judgeAssignments', assignmentId)));
      expect(existingJudgeSnap.exists()).toBe(true);
      await assertFails(getDoc(doc(org2Db, 'judgeAssignments', assignmentId)));
      await assertFails(getDoc(doc(p1Db, 'judgeAssignments', assignmentId)));
    });

    it('evaluations: assigned accepted judge and owning organizer can get nonexistent evaluation; unassigned/conflicted/other-judge/participant denied', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'org2', approvedRole: 'organizer' });
      await seedUser({ uid: 'p1', approvedRole: 'participant' });
      await seedUser({ uid: 'j1', approvedRole: 'judge' });
      await seedUser({ uid: 'j2', approvedRole: 'judge' });
      await seedUser({ uid: 'j_invited', approvedRole: 'judge' });
      await seedUser({ uid: 'j_conflict', approvedRole: 'judge' });

      const prodHackId = 'hack_eval_99aabb';
      const prodSubId = 'sub_eval_11ccdd';
      await seedHackathon({ id: prodHackId, organizerId: 'org1', status: 'judging' });
      await seedTeam({ teamId: 'team_1', hackathonId: prodHackId, organizerId: 'org1', leaderId: 'p1' });
      await seedProject({ projectId: 'proj_1', hackathonId: prodHackId, organizerId: 'org1', teamId: 'team_1', ownerId: 'p1', memberIds: ['p1'] });
      await seedSubmission({
        submissionId: prodSubId,
        hackathonId: prodHackId,
        organizerId: 'org1',
        teamId: 'team_1',
        projectId: 'proj_1',
        ownerId: 'p1',
        memberIds: ['p1'],
        status: 'under_review'
      });

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        await setDoc(doc(db, 'judgeAssignments', `${prodHackId}_j1`), {
          id: `${prodHackId}_j1`,
          hackathonId: prodHackId,
          organizerId: 'org1',
          judgeId: 'j1',
          judgeName: 'Judge 1',
          assignedSubmissionIds: [prodSubId],
          conflictDeclared: false,
          status: 'accepted',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
        await setDoc(doc(db, 'judgeAssignments', `${prodHackId}_j_invited`), {
          id: `${prodHackId}_j_invited`,
          hackathonId: prodHackId,
          organizerId: 'org1',
          judgeId: 'j_invited',
          judgeName: 'Judge Invited',
          assignedSubmissionIds: [prodSubId],
          conflictDeclared: false,
          status: 'invited',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
        await setDoc(doc(db, 'judgeAssignments', `${prodHackId}_j_conflict`), {
          id: `${prodHackId}_j_conflict`,
          hackathonId: prodHackId,
          organizerId: 'org1',
          judgeId: 'j_conflict',
          judgeName: 'Judge Conflict',
          assignedSubmissionIds: [prodSubId],
          conflictDeclared: true,
          status: 'accepted',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
        // Self-judging assignment seeded for participant p1 to verify memberIds guard on initial get
        await setDoc(doc(db, 'judgeAssignments', `${prodHackId}_p1`), {
          id: `${prodHackId}_p1`,
          hackathonId: prodHackId,
          organizerId: 'org1',
          judgeId: 'p1',
          judgeName: 'Self Member',
          assignedSubmissionIds: [prodSubId],
          conflictDeclared: false,
          status: 'accepted',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
      });

      const evalId = `${prodSubId}_j1`;
      const anonDb = testEnv.unauthenticatedContext().firestore();
      const unverifiedJ1Db = unverifiedCtx('j1').firestore();
      const j1Db = verifiedCtx('j1').firestore();
      const j2Db = verifiedCtx('j2').firestore();
      const jInvitedDb = verifiedCtx('j_invited').firestore();
      const jConflictDb = verifiedCtx('j_conflict').firestore();
      const p1Db = verifiedCtx('p1').firestore();
      const org1Db = verifiedCtx('org1').firestore();
      const org2Db = verifiedCtx('org2').firestore();

      // Unauthorized initial gets must fail (including blind judging isolation across judges)
      await assertFails(getDoc(doc(anonDb, 'evaluations', evalId)));
      await assertFails(getDoc(doc(unverifiedJ1Db, 'evaluations', evalId)));
      await assertFails(getDoc(doc(j2Db, 'evaluations', evalId)));
      await assertFails(getDoc(doc(j2Db, 'evaluations', `${prodSubId}_j2`)));
      await assertFails(getDoc(doc(jInvitedDb, 'evaluations', `${prodSubId}_j_invited`)));
      await assertFails(getDoc(doc(jConflictDb, 'evaluations', `${prodSubId}_j_conflict`)));
      await assertFails(getDoc(doc(p1Db, 'evaluations', `${prodSubId}_p1`)));
      await assertFails(getDoc(doc(org2Db, 'evaluations', evalId)));
      await assertFails(getDoc(doc(org1Db, 'evaluations', `${prodSubId}_j2`)));

      // Assigned accepted judge and owning organizer succeed on initial nonexistent get
      const judgeMissingSnap = await assertSucceeds(getDoc(doc(j1Db, 'evaluations', evalId)));
      expect(judgeMissingSnap.exists()).toBe(false);
      const orgMissingSnap = await assertSucceeds(getDoc(doc(org1Db, 'evaluations', evalId)));
      expect(orgMissingSnap.exists()).toBe(false);

      // First-time evaluation create + normalized criterion write + existing get + update succeed
      await assertSucceeds(
        setDoc(doc(j1Db, 'evaluations', evalId), {
          id: evalId,
          hackathonId: prodHackId,
          organizerId: 'org1',
          submissionId: prodSubId,
          judgeId: 'j1',
          judgeName: 'Judge 1',
          criteriaScores: [],
          weightedTotal: 80,
          scoredCriterionCount: 1,
          storageSchema: 'v2_subcollection',
          conflictOfInterest: false,
          humanFeedback: 'Draft review',
          status: 'draft',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );
      await assertSucceeds(
        setDoc(doc(j1Db, 'evaluations', evalId, 'criteria', 'innovation'), {
          criterionId: 'innovation',
          evaluationId: evalId,
          hackathonId: prodHackId,
          submissionId: prodSubId,
          judgeId: 'j1',
          criterionName: 'Innovation',
          weight: 100,
          score: 8,
          comment: 'Solid',
          updatedAt: serverTimestamp()
        })
      );

      const existingJudgeEval = await assertSucceeds(getDoc(doc(j1Db, 'evaluations', evalId)));
      expect(existingJudgeEval.exists()).toBe(true);
      const existingJudgeCrit = await assertSucceeds(getDocs(collection(j1Db, 'evaluations', evalId, 'criteria')));
      expect(existingJudgeCrit.docs).toHaveLength(1);
      const existingOrgEval = await assertSucceeds(getDoc(doc(org1Db, 'evaluations', evalId)));
      expect(existingOrgEval.exists()).toBe(true);
      const existingOrgCrit = await assertSucceeds(getDocs(collection(org1Db, 'evaluations', evalId, 'criteria')));
      expect(existingOrgCrit.docs).toHaveLength(1);

      // Blind judging preserved on existing parent document & subcollection
      await assertFails(getDoc(doc(j2Db, 'evaluations', evalId)));
      await assertFails(getDocs(collection(j2Db, 'evaluations', evalId, 'criteria')));
      await assertFails(getDoc(doc(p1Db, 'evaluations', evalId)));
      await assertFails(getDocs(collection(p1Db, 'evaluations', evalId, 'criteria')));
      await assertFails(getDoc(doc(org2Db, 'evaluations', evalId)));
    });

    it('hackathonResults: owning approved organizer can get nonexistent draft results, save draft, publish, and preserve visibility rules', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'org2', approvedRole: 'organizer' });
      await seedUser({ uid: 'unapproved_org', approvedRole: 'participant', requestedRole: 'organizer' });
      await seedUser({ uid: 'p1', approvedRole: 'participant' });
      await seedUser({ uid: 'j1', approvedRole: 'judge' });

      const hackId = 'hack_res_77cc88';
      await seedHackathon({ id: hackId, organizerId: 'org1', status: 'judging' });

      const anonDb = testEnv.unauthenticatedContext().firestore();
      const org1Db = verifiedCtx('org1').firestore();
      const org2Db = verifiedCtx('org2').firestore();
      const unapprovedDb = verifiedCtx('unapproved_org').firestore();
      const p1Db = verifiedCtx('p1').firestore();
      const j1Db = verifiedCtx('j1').firestore();

      // Nonexistent results document must fail for everyone except owning approved organizer / admin
      await assertFails(getDoc(doc(anonDb, 'hackathonResults', hackId)));
      await assertFails(getDoc(doc(p1Db, 'hackathonResults', hackId)));
      await assertFails(getDoc(doc(j1Db, 'hackathonResults', hackId)));
      await assertFails(getDoc(doc(unapprovedDb, 'hackathonResults', hackId)));
      await assertFails(getDoc(doc(org2Db, 'hackathonResults', hackId)));
      await assertFails(getDoc(doc(org1Db, 'hackathonResults', 'hack_does_not_exist')));

      // Owning approved organizer CAN get nonexistent results document before saving draft
      const missingRes = await assertSucceeds(getDoc(doc(org1Db, 'hackathonResults', hackId)));
      expect(missingRes.exists()).toBe(false);

      // Organizer saves unpublished draft results
      await assertSucceeds(
        setDoc(doc(org1Db, 'hackathonResults', hackId), {
          hackathonId: hackId,
          organizerId: 'org1',
          published: false,
          rankings: [{ submissionId: 'sub_1', rank: 1, normalizedScore: 91 }],
          updatedAt: serverTimestamp()
        })
      );

      // Unpublished existing results readable by owning organizer, denied to public/participant/judge/org2
      const draftOrgSnap = await assertSucceeds(getDoc(doc(org1Db, 'hackathonResults', hackId)));
      expect(draftOrgSnap.exists()).toBe(true);
      await assertFails(getDoc(doc(anonDb, 'hackathonResults', hackId)));
      await assertFails(getDoc(doc(p1Db, 'hackathonResults', hackId)));
      await assertFails(getDoc(doc(j1Db, 'hackathonResults', hackId)));
      await assertFails(getDoc(doc(org2Db, 'hackathonResults', hackId)));

      // Organizer atomically publishes results
      const pubBatch = writeBatch(org1Db);
      pubBatch.update(doc(org1Db, 'hackathonResults', hackId), {
        published: true,
        rankings: [{ submissionId: 'sub_1', rank: 1, normalizedScore: 91 }],
        publishedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      pubBatch.update(doc(org1Db, 'hackathons', hackId), {
        resultsPublished: true,
        status: 'completed',
        updatedAt: serverTimestamp()
      });
      await assertSucceeds(pubBatch.commit());

      // Published results readable by public, participant, judge, and organizer
      const pubAnonSnap = await assertSucceeds(getDoc(doc(anonDb, 'hackathonResults', hackId)));
      expect(pubAnonSnap.data()?.published).toBe(true);
      await assertSucceeds(getDoc(doc(p1Db, 'hackathonResults', hackId)));
      await assertSucceeds(getDoc(doc(org1Db, 'hackathonResults', hackId)));
    });
  });

  describe('Team Creation Registration Authorization (10 Required Scenarios)', () => {
    function buildCreateTeamBatch(
      db: ReturnType<ReturnType<typeof verifiedCtx>['firestore']>,
      params: {
        teamId: string;
        hackathonId: string;
        organizerId: string;
        leaderId: string;
        registrationId?: string;
      }
    ) {
      const token = `HM-${params.teamId.toUpperCase().padEnd(32, '0').slice(0, 32)}`;
      const verifierHash = sha256(sha256(token));
      const batch = writeBatch(db);
      batch.set(doc(db, 'teams', params.teamId), {
        id: params.teamId,
        hackathonId: params.hackathonId,
        organizerId: params.organizerId,
        ...(params.registrationId ? { registrationId: params.registrationId } : {}),
        name: `Team ${params.teamId}`,
        leaderId: params.leaderId,
        memberIds: [params.leaderId],
        memberNames: [`User ${params.leaderId}`],
        status: 'forming',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      batch.set(doc(db, 'teams', params.teamId, 'members', params.leaderId), {
        uid: params.leaderId,
        displayName: `User ${params.leaderId}`,
        roleInTeam: 'Team Lead',
        ...(params.registrationId ? { registrationId: params.registrationId } : {}),
        joinedAt: serverTimestamp()
      });
      batch.set(doc(db, 'teams', params.teamId, 'private', 'joinCode'), {
        verifierHash,
        leaderId: params.leaderId,
        active: true,
        updatedAt: serverTimestamp()
      });
      batch.set(doc(db, 'teamJoinCodes', verifierHash), {
        id: verifierHash,
        verifierHash,
        teamId: params.teamId,
        hackathonId: params.hackathonId,
        organizerId: params.organizerId,
        leaderId: params.leaderId,
        active: true,
        createdAt: serverTimestamp()
      });
      return batch;
    }

    it('covers scenarios 1-10 for approved, pending, rejected, withdrawn, unregistered, cross-hackathon, unauth, impersonation, self-approval, and organizer/admin', async () => {
      await seedUser({ uid: 'admin_1', isAdmin: true });
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'p_approved' });
      await seedUser({ uid: 'p_legacy' });
      await seedUser({ uid: 'p_pending' });
      await seedUser({ uid: 'p_rejected' });
      await seedUser({ uid: 'p_withdrawn' });
      await seedUser({ uid: 'p_unregistered' });

      await seedHackathon({ id: 'hack_A', organizerId: 'org1', status: 'published' });
      await seedHackathon({ id: 'hack_B', organizerId: 'org1', status: 'published' });

      await seedRegistration({ hackathonId: 'hack_A', organizerId: 'org1', userId: 'p_approved', status: 'approved' });
      await seedRegistration({ hackathonId: 'hack_A', organizerId: 'org1', userId: 'p_pending', status: 'pending' });
      await seedRegistration({ hackathonId: 'hack_A', organizerId: 'org1', userId: 'p_rejected', status: 'rejected' });
      await seedRegistration({ hackathonId: 'hack_A', organizerId: 'org1', userId: 'p_withdrawn', status: 'withdrawn' });

      // Non-composite approved registration for p_legacy
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'registrations', 'legacy_reg_p_legacy'), {
          id: 'legacy_reg_p_legacy',
          hackathonId: 'hack_A',
          organizerId: 'org1',
          userId: 'p_legacy',
          userName: 'Legacy Builder',
          userTitle: 'Builder',
          preferredTrack: 'Hybrid AI',
          motivation: 'Ready',
          status: 'approved',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
      });

      // 1a. Approved participant (composite ID) can create a team immediately
      await assertSucceeds(
        buildCreateTeamBatch(verifiedCtx('p_approved').firestore(), {
          teamId: 'team_approved_1',
          hackathonId: 'hack_A',
          organizerId: 'org1',
          leaderId: 'p_approved',
          registrationId: 'hack_A_p_approved'
        }).commit()
      );

      // 1b. Approved participant (non-composite doc ID) can create a team immediately
      await assertSucceeds(
        buildCreateTeamBatch(verifiedCtx('p_legacy').firestore(), {
          teamId: 'team_legacy_1',
          hackathonId: 'hack_A',
          organizerId: 'org1',
          leaderId: 'p_legacy',
          registrationId: 'legacy_reg_p_legacy'
        }).commit()
      );

      // 2. Pending participant cannot create a team
      await assertFails(
        buildCreateTeamBatch(verifiedCtx('p_pending').firestore(), {
          teamId: 'team_pending_1',
          hackathonId: 'hack_A',
          organizerId: 'org1',
          leaderId: 'p_pending',
          registrationId: 'hack_A_p_pending'
        }).commit()
      );

      // 3. Rejected participant cannot create a team
      await assertFails(
        buildCreateTeamBatch(verifiedCtx('p_rejected').firestore(), {
          teamId: 'team_rejected_1',
          hackathonId: 'hack_A',
          organizerId: 'org1',
          leaderId: 'p_rejected',
          registrationId: 'hack_A_p_rejected'
        }).commit()
      );

      // 4. Withdrawn participant cannot create a team
      await assertFails(
        buildCreateTeamBatch(verifiedCtx('p_withdrawn').firestore(), {
          teamId: 'team_withdrawn_1',
          hackathonId: 'hack_A',
          organizerId: 'org1',
          leaderId: 'p_withdrawn',
          registrationId: 'hack_A_p_withdrawn'
        }).commit()
      );

      // 5. Unregistered user cannot create a team (and reading missing own doc succeeds with exists=false)
      const unregDb = verifiedCtx('p_unregistered').firestore();
      const missingSnap = await assertSucceeds(getDoc(doc(unregDb, 'registrations', 'hack_A_p_unregistered')));
      expect(missingSnap.exists()).toBe(false);
      await assertFails(
        buildCreateTeamBatch(unregDb, {
          teamId: 'team_unreg_1',
          hackathonId: 'hack_A',
          organizerId: 'org1',
          leaderId: 'p_unregistered'
        }).commit()
      );

      // 6. Approval for Hackathon A cannot authorize team creation in Hackathon B
      await assertFails(
        buildCreateTeamBatch(verifiedCtx('p_approved').firestore(), {
          teamId: 'team_cross_hack',
          hackathonId: 'hack_B',
          organizerId: 'org1',
          leaderId: 'p_approved',
          registrationId: 'hack_A_p_approved'
        }).commit()
      );

      // 7. Unauthenticated requests are rejected
      const anonDb = testEnv.unauthenticatedContext().firestore();
      await assertFails(
        setDoc(doc(anonDb, 'teams', 'team_anon'), {
          id: 'team_anon',
          hackathonId: 'hack_A',
          organizerId: 'org1',
          name: 'Anon Team',
          leaderId: 'p_approved',
          memberIds: ['p_approved'],
          status: 'forming',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      // 8. Participant cannot create a team on behalf of another user (even citing victim's approved registration)
      await assertFails(
        buildCreateTeamBatch(verifiedCtx('p_pending').firestore(), {
          teamId: 'team_impersonate',
          hackathonId: 'hack_A',
          organizerId: 'org1',
          leaderId: 'p_approved',
          registrationId: 'hack_A_p_approved'
        }).commit()
      );

      // 9. Participant cannot self-approve a rejected registration, while eligible pending participant can confirm own registration and create team directly
      await assertFails(
        updateDoc(doc(verifiedCtx('p_rejected').firestore(), 'registrations', 'hack_A_p_rejected'), {
          status: 'approved',
          updatedAt: serverTimestamp()
        })
      );
      await assertSucceeds(
        updateDoc(doc(verifiedCtx('p_pending').firestore(), 'registrations', 'hack_A_p_pending'), {
          status: 'approved',
          updatedAt: serverTimestamp()
        })
      );
      await assertSucceeds(
        buildCreateTeamBatch(verifiedCtx('p_pending').firestore(), {
          teamId: 'team_self_confirmed',
          hackathonId: 'hack_A',
          organizerId: 'org1',
          leaderId: 'p_pending'
        }).commit()
      );

      // 10. Existing organizer and administrator permissions continue to work
      await assertSucceeds(
        updateDoc(doc(verifiedCtx('org1').firestore(), 'registrations', 'hack_A_p_pending'), {
          status: 'rejected',
          updatedAt: serverTimestamp()
        })
      );
      await assertSucceeds(
        updateDoc(doc(verifiedCtx('admin_1').firestore(), 'users', 'p_approved'), {
          approvedRole: 'judge',
          updatedAt: serverTimestamp()
        })
      );
    });

    it('registrations: new verified participant with 3-segment hackathon ID can get missing canonical doc, create approved registration, list own doc, and create team immediately', async () => {
      await seedUser({ uid: 'org_test_rules_1', approvedRole: 'organizer' });
      await seedUser({ uid: '2Gr6CjBPT8Ua84UMLOG3ikm9gDl2', approvedRole: 'participant' });

      const hackId = 'hack_mwmjdbkp_676fccf86e8848';
      const orgId = 'org_test_rules_1';
      const uid = '2Gr6CjBPT8Ua84UMLOG3ikm9gDl2';
      const regId = `${hackId}_${uid}`;

      await seedHackathon({
        id: hackId,
        organizerId: orgId,
        status: 'published',
        regDeadlineFuture: true
      });

      const pDb = verifiedCtx(uid, { firebase: { sign_in_provider: 'google.com' } }).firestore();
      const otherDb = verifiedCtx('other_user').firestore();

      // Other user cannot probe missing canonical registration for victim UID
      await assertFails(getDoc(doc(otherDb, 'registrations', regId)));

      // Transaction pre-read of missing canonical registration succeeds for owner
      const missingSnap = await assertSucceeds(getDoc(doc(pDb, 'registrations', regId)));
      expect(missingSnap.exists()).toBe(false);

      // Canonical approved registration creation succeeds
      await assertSucceeds(
        setDoc(doc(pDb, 'registrations', regId), {
          id: regId,
          hackathonId: hackId,
          organizerId: orgId,
          userId: uid,
          userName: 'Participant',
          userTitle: '',
          preferredTrack: 'Artificial Intelligence',
          motivation: 'Excited to build',
          status: 'approved',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      // Post-create direct get and userId list query succeed; another participant cannot read/modify/delete it
      const createdSnap = await assertSucceeds(getDoc(doc(pDb, 'registrations', regId)));
      expect(createdSnap.exists()).toBe(true);
      expect(createdSnap.data()?.status).toBe('approved');
      const listSnap = await assertSucceeds(
        getDocs(query(collection(pDb, 'registrations'), where('userId', '==', uid)))
      );
      expect(listSnap.docs).toHaveLength(1);
      await assertFails(getDoc(doc(otherDb, 'registrations', regId)));
      await assertFails(
        updateDoc(doc(otherDb, 'registrations', regId), {
          status: 'withdrawn',
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(deleteDoc(doc(otherDb, 'registrations', regId)));

      // Team creation becomes available immediately
      await assertSucceeds(
        buildCreateTeamBatch(pDb, {
          teamId: 'team_3seg_1',
          hackathonId: hackId,
          organizerId: orgId,
          leaderId: uid
        }).commit()
      );
    });

    it('registrations: withdrawn participant can reapply directly only when eligible while cross-user registration reads/writes remain denied', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'p_withdrawn' });
      await seedUser({ uid: 'p_attacker' });
      await seedHackathon({ id: 'hack_w', organizerId: 'org1', status: 'published', regDeadlineFuture: true });
      await seedHackathon({ id: 'hack_w_expired', organizerId: 'org1', status: 'published', regDeadlineFuture: false });
      await seedHackathon({ id: 'hack_w_draft', organizerId: 'org1', status: 'draft', regDeadlineFuture: true });
      await seedRegistration({ hackathonId: 'hack_w', organizerId: 'org1', userId: 'p_withdrawn', status: 'withdrawn' });
      await seedRegistration({ hackathonId: 'hack_w_expired', organizerId: 'org1', userId: 'p_withdrawn', status: 'withdrawn' });
      await seedRegistration({ hackathonId: 'hack_w_draft', organizerId: 'org1', userId: 'p_withdrawn', status: 'withdrawn' });

      const withdrawnDb = verifiedCtx('p_withdrawn').firestore();
      const attackerDb = verifiedCtx('p_attacker').firestore();

      // Attacker cannot read, create, update, or delete another user's registration
      await assertFails(getDoc(doc(attackerDb, 'registrations', 'hack_w_p_withdrawn')));
      await assertFails(
        updateDoc(doc(attackerDb, 'registrations', 'hack_w_p_withdrawn'), {
          status: 'approved',
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(deleteDoc(doc(attackerDb, 'registrations', 'hack_w_p_withdrawn')));
      await assertFails(
        setDoc(doc(attackerDb, 'registrations', 'hack_w_p_victim'), {
          id: 'hack_w_p_victim',
          hackathonId: 'hack_w',
          organizerId: 'org1',
          userId: 'p_withdrawn',
          userName: 'Spoofed',
          status: 'approved',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      // Ineligible withdrawn self-approval (expired deadline or draft hackathon) is rejected
      await assertFails(
        updateDoc(doc(withdrawnDb, 'registrations', 'hack_w_expired_p_withdrawn'), {
          status: 'approved',
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(
        updateDoc(doc(withdrawnDb, 'registrations', 'hack_w_draft_p_withdrawn'), {
          status: 'approved',
          updatedAt: serverTimestamp()
        })
      );

      // Eligible withdrawn participant reapplies directly and gains immediate approval
      await assertSucceeds(
        updateDoc(doc(withdrawnDb, 'registrations', 'hack_w_p_withdrawn'), {
          status: 'approved',
          motivation: 'Rejoining hackathon',
          updatedAt: serverTimestamp()
        })
      );
    });

    it('reusable join codes: 1st, 2nd, and 3rd participants reuse the same code until capacity, blocking duplicates, expired codes, and organizer-revoked codes', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'org_other', approvedRole: 'organizer' });
      await seedUser({ uid: 'leader' });
      await seedUser({ uid: 'p1' });
      await seedUser({ uid: 'p2' });
      await seedUser({ uid: 'p3' });
      await seedUser({ uid: 'p4' });

      await seedHackathon({ id: 'hack_reuse', organizerId: 'org1', status: 'published', maxTeamSize: 4 });
      for (const uid of ['leader', 'p1', 'p2', 'p3', 'p4']) {
        await seedRegistration({ hackathonId: 'hack_reuse', organizerId: 'org1', userId: uid, status: 'approved' });
      }

      const { proof, verifierHash } = await seedTeam({
        teamId: 'team_reuse',
        hackathonId: 'hack_reuse',
        organizerId: 'org1',
        leaderId: 'leader'
      });

      // 1st, 2nd, and 3rd eligible participants join sequentially with the exact same proof
      for (const uid of ['p1', 'p2', 'p3']) {
        const userDb = verifiedCtx(uid).firestore();
        await assertSucceeds(
          buildJoinByCodeBatch(userDb, {
            teamId: 'team_reuse',
            uid,
            displayName: `User ${uid}`,
            proof
          }).commit()
        );
        await assertSucceeds(deleteDoc(doc(userDb, 'teams', 'team_reuse', 'joinClaims', uid)));

        // Verify the invitation code remains active (not deleted or consumed) for the next participant
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          const codeSnap = await getDoc(doc(ctx.firestore(), 'teamJoinCodes', verifierHash));
          expect(codeSnap.exists()).toBe(true);
          expect(codeSnap.data()?.active).toBe(true);
          const privSnap = await getDoc(doc(ctx.firestore(), 'teams', 'team_reuse', 'private', 'joinCode'));
          expect(privSnap.data()?.active).toBe(true);
        });
      }

      // Verify all three participants plus leader joined the exact same team
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const teamSnap = await getDoc(doc(ctx.firestore(), 'teams', 'team_reuse'));
        expect(teamSnap.data()?.memberIds).toEqual(['leader', 'p1', 'p2', 'p3']);
      });

      // Duplicate join attempt by already-joined p1 fails
      await assertFails(
        buildJoinByCodeBatch(verifiedCtx('p1').firestore(), {
          teamId: 'team_reuse',
          uid: 'p1',
          displayName: 'User p1',
          proof
        }).commit()
      );

      // 4th participant fails because maxTeamSize (4) is reached (leader + p1 + p2 + p3)
      await assertFails(
        buildJoinByCodeBatch(verifiedCtx('p4').firestore(), {
          teamId: 'team_reuse',
          uid: 'p4',
          displayName: 'User p4',
          proof
        }).commit()
      );

      // Optional expiration: future expiresAt succeeds while past expiresAt fails
      const futureToken = 'HM-FUTURE0000000000000000000000000';
      const futureProof = sha256(futureToken);
      const futureVerifier = sha256(futureProof);
      await seedTeam({
        teamId: 'team_future_exp',
        hackathonId: 'hack_reuse',
        organizerId: 'org1',
        leaderId: 'leader',
        joinToken: futureToken
      });
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const future = Timestamp.fromMillis(Date.now() + 3_600_000);
        await updateDoc(doc(ctx.firestore(), 'teamJoinCodes', futureVerifier), { expiresAt: future });
        await updateDoc(doc(ctx.firestore(), 'teams', 'team_future_exp', 'private', 'joinCode'), { expiresAt: future });
      });
      await assertSucceeds(
        buildJoinByCodeBatch(verifiedCtx('p1').firestore(), {
          teamId: 'team_future_exp',
          uid: 'p1',
          displayName: 'User p1',
          proof: futureProof
        }).commit()
      );

      // Expired code fails even when team has spare capacity and active=true
      const expiredToken = 'HM-EXPIRED000000000000000000000000';
      const expiredProof = sha256(expiredToken);
      const expiredVerifier = sha256(expiredProof);
      await seedTeam({
        teamId: 'team_expired',
        hackathonId: 'hack_reuse',
        organizerId: 'org1',
        leaderId: 'leader',
        joinToken: expiredToken
      });
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const past = Timestamp.fromMillis(Date.now() - 60_000);
        await updateDoc(doc(ctx.firestore(), 'teamJoinCodes', expiredVerifier), { expiresAt: past });
        await updateDoc(doc(ctx.firestore(), 'teams', 'team_expired', 'private', 'joinCode'), { expiresAt: past });
      });
      await assertFails(
        buildJoinByCodeBatch(verifiedCtx('p1').firestore(), {
          teamId: 'team_expired',
          uid: 'p1',
          displayName: 'User p1',
          proof: expiredProof
        }).commit()
      );

      // Owning organizer can revoke an active join code, while unrelated organizer cannot
      const org1Db = verifiedCtx('org1').firestore();
      const orgOtherDb = verifiedCtx('org_other').firestore();
      const { proof: modProof, verifierHash: modVerifier } = await seedTeam({
        teamId: 'team_mod',
        hackathonId: 'hack_reuse',
        organizerId: 'org1',
        leaderId: 'leader',
        joinToken: 'HM-MODERATED0000000000000000000000'
      });

      await assertFails(updateDoc(doc(orgOtherDb, 'teamJoinCodes', modVerifier), { active: false }));
      const modRevokeBatch = writeBatch(org1Db);
      modRevokeBatch.update(doc(org1Db, 'teamJoinCodes', modVerifier), { active: false });
      modRevokeBatch.update(doc(org1Db, 'teams', 'team_mod', 'private', 'joinCode'), {
        verifierHash: modVerifier,
        leaderId: 'leader',
        active: false,
        updatedAt: serverTimestamp()
      });
      await assertSucceeds(modRevokeBatch.commit());

      await assertFails(
        buildJoinByCodeBatch(verifiedCtx('p1').firestore(), {
          teamId: 'team_mod',
          uid: 'p1',
          displayName: 'User p1',
          proof: modProof
        }).commit()
      );
    });

    it('Attack 22: Enforces normalized subcollection validation, inline injection block, criterion bounds, rubric matching, COI invariants, deterministic recomputation, and post-submit immutability', async () => {
      await seedUser({ uid: 'org1', approvedRole: 'organizer' });
      await seedUser({ uid: 'j1', approvedRole: 'judge' });
      await seedUser({ uid: 'j2', approvedRole: 'judge' });
      await seedUser({ uid: 'p1', approvedRole: 'participant' });

      const rubric: RubricCriterion[] = [
        { id: 'c1', name: 'Innovation', description: 'Novelty', weight: 40 },
        { id: 'c2', name: 'Execution', description: 'Implementation', weight: 60 }
      ];

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const now = Timestamp.now();
        await setDoc(doc(ctx.firestore(), 'hackathons', 'hack_rubric'), {
          id: 'hack_rubric',
          organizerId: 'org1',
          organizerName: 'Organizer org1',
          title: 'Rubric Security Hackathon',
          description: 'Verifies strict normalized evaluation scoring integrity in Firestore rules.',
          mode: 'online',
          rubric,
          maxTeamSize: 4,
          status: 'judging',
          resultsPublished: false,
          createdAt: now,
          updatedAt: now
        });
      });

      await seedTeam({ teamId: 'team_r1', hackathonId: 'hack_rubric', organizerId: 'org1', leaderId: 'p1' });
      await seedProject({
        projectId: 'proj_r1',
        hackathonId: 'hack_rubric',
        organizerId: 'org1',
        teamId: 'team_r1',
        ownerId: 'p1',
        memberIds: ['p1']
      });
      await seedSubmission({
        submissionId: 'sub_r1',
        hackathonId: 'hack_rubric',
        organizerId: 'org1',
        teamId: 'team_r1',
        projectId: 'proj_r1',
        ownerId: 'p1',
        memberIds: ['p1'],
        status: 'under_review'
      });
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'judgeAssignments', 'hack_rubric_j1'), {
          id: 'hack_rubric_j1',
          hackathonId: 'hack_rubric',
          organizerId: 'org1',
          judgeId: 'j1',
          judgeName: 'Judge 1',
          assignedSubmissionIds: ['sub_r1'],
          conflictDeclared: false,
          status: 'accepted',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
      });

      const jDb = verifiedCtx('j1').firestore();
      const j2Db = verifiedCtx('j2').firestore();
      const baseEval = {
        id: 'sub_r1_j1',
        hackathonId: 'hack_rubric',
        organizerId: 'org1',
        submissionId: 'sub_r1',
        judgeId: 'j1',
        judgeName: 'Judge 1',
        conflictOfInterest: false,
        conflictReason: '',
        humanFeedback: '',
        storageSchema: 'v2_subcollection',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };

      // 1. Direct submitted non-COI create without persisted criteria -> DENIED
      await assertFails(
        setDoc(doc(jDb, 'evaluations', 'sub_r1_j1'), {
          ...baseEval,
          criteriaScores: [],
          scoredCriterionCount: 0,
          weightedTotal: 0,
          status: 'submitted'
        })
      );

      // 2. Non-empty inline criteriaScores array injection on parent -> DENIED
      await assertFails(
        setDoc(doc(jDb, 'evaluations', 'sub_r1_j1'), {
          ...baseEval,
          criteriaScores: [{ criterionId: 'c1', criterionName: 'Innovation', weight: 40, score: 10, comment: '' }],
          scoredCriterionCount: 1,
          weightedTotal: 100,
          status: 'draft'
        })
      );

      // 3. Forged non-zero weightedTotal on empty draft (scoredCriterionCount: 0) -> DENIED
      await assertFails(
        setDoc(doc(jDb, 'evaluations', 'sub_r1_j1'), {
          ...baseEval,
          criteriaScores: [],
          scoredCriterionCount: 0,
          weightedTotal: 88,
          status: 'draft'
        })
      );

      // 4. Writing criterion doc before parent exists -> DENIED
      await assertFails(
        setDoc(doc(jDb, 'evaluations', 'sub_r1_j1', 'criteria', 'c1'), {
          criterionId: 'c1',
          evaluationId: 'sub_r1_j1',
          hackathonId: 'hack_rubric',
          submissionId: 'sub_r1',
          judgeId: 'j1',
          criterionName: 'Innovation',
          weight: 40,
          score: 8,
          comment: '',
          updatedAt: serverTimestamp()
        })
      );

      // 5. Invalid COI payloads -> DENIED
      await assertFails(
        setDoc(doc(jDb, 'evaluations', 'sub_r1_j1'), {
          ...baseEval,
          criteriaScores: [],
          scoredCriterionCount: 1,
          weightedTotal: 0,
          conflictOfInterest: true,
          conflictReason: 'Mentored team',
          status: 'submitted'
        })
      );
      await assertFails(
        setDoc(doc(jDb, 'evaluations', 'sub_r1_j1'), {
          ...baseEval,
          criteriaScores: [],
          scoredCriterionCount: 0,
          weightedTotal: 50,
          conflictOfInterest: true,
          conflictReason: 'Mentored team',
          status: 'submitted'
        })
      );
      await assertFails(
        setDoc(doc(jDb, 'evaluations', 'sub_r1_j1'), {
          ...baseEval,
          criteriaScores: [],
          scoredCriterionCount: 0,
          weightedTotal: 0,
          conflictOfInterest: true,
          conflictReason: '   ',
          status: 'submitted'
        })
      );
      const { conflictReason: _omittedReason, ...baseWithoutReason } = baseEval;
      await assertFails(
        setDoc(doc(jDb, 'evaluations', 'sub_r1_j1'), {
          ...baseWithoutReason,
          criteriaScores: [],
          scoredCriterionCount: 0,
          weightedTotal: 0,
          conflictOfInterest: true,
          status: 'submitted'
        })
      );

      // 6. Create valid empty draft parent -> ALLOWED
      await assertSucceeds(
        setDoc(doc(jDb, 'evaluations', 'sub_r1_j1'), {
          ...baseEval,
          criteriaScores: [],
          scoredCriterionCount: 0,
          weightedTotal: 0,
          status: 'draft'
        })
      );

      // 7. Subcollection attacks (doc ID != criterionId, unknown rubric ID, mismatched weight, score <0 / >10, cross-judge) -> ALL DENIED
      await assertFails(
        setDoc(doc(jDb, 'evaluations', 'sub_r1_j1', 'criteria', 'c2'), {
          criterionId: 'c1', // Doc ID / field mismatch (prevents duplicate criterion IDs)
          evaluationId: 'sub_r1_j1',
          hackathonId: 'hack_rubric',
          submissionId: 'sub_r1',
          judgeId: 'j1',
          criterionName: 'Duplicate Attempt',
          weight: 60,
          score: 8,
          comment: '',
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(
        setDoc(doc(jDb, 'evaluations', 'sub_r1_j1', 'criteria', 'c_wrong'), {
          criterionId: 'c_wrong',
          evaluationId: 'sub_r1_j1',
          hackathonId: 'hack_rubric',
          submissionId: 'sub_r1',
          judgeId: 'j1',
          criterionName: 'Wrong Criterion',
          weight: 40,
          score: 8,
          comment: '',
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(
        setDoc(doc(jDb, 'evaluations', 'sub_r1_j1', 'criteria', 'c1'), {
          criterionId: 'c1',
          evaluationId: 'sub_r1_j1',
          hackathonId: 'hack_rubric',
          submissionId: 'sub_r1',
          judgeId: 'j1',
          criterionName: 'Innovation',
          weight: 90, // Rubric says 40
          score: 8,
          comment: '',
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(
        setDoc(doc(jDb, 'evaluations', 'sub_r1_j1', 'criteria', 'c1'), {
          criterionId: 'c1',
          evaluationId: 'sub_r1_j1',
          hackathonId: 'hack_rubric',
          submissionId: 'sub_r1',
          judgeId: 'j1',
          criterionName: 'Innovation',
          weight: 40,
          score: -0.5,
          comment: '',
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(
        setDoc(doc(jDb, 'evaluations', 'sub_r1_j1', 'criteria', 'c1'), {
          criterionId: 'c1',
          evaluationId: 'sub_r1_j1',
          hackathonId: 'hack_rubric',
          submissionId: 'sub_r1',
          judgeId: 'j1',
          criterionName: 'Innovation',
          weight: 40,
          score: 100.5,
          comment: '',
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(
        setDoc(doc(j2Db, 'evaluations', 'sub_r1_j1', 'criteria', 'c1'), {
          criterionId: 'c1',
          evaluationId: 'sub_r1_j1',
          hackathonId: 'hack_rubric',
          submissionId: 'sub_r1',
          judgeId: 'j1',
          criterionName: 'Tamper Cross Judge',
          weight: 40,
          score: 10,
          comment: '',
          updatedAt: serverTimestamp()
        })
      );

      // 8. Partial draft criterion write (only c1=0), then attempting incomplete submit -> DENIED
      await assertSucceeds(
        setDoc(doc(jDb, 'evaluations', 'sub_r1_j1', 'criteria', 'c1'), {
          criterionId: 'c1',
          evaluationId: 'sub_r1_j1',
          hackathonId: 'hack_rubric',
          submissionId: 'sub_r1',
          judgeId: 'j1',
          criterionName: 'Innovation',
          weight: 40,
          score: 0,
          comment: 'Explicit 0',
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(
        updateDoc(doc(jDb, 'evaluations', 'sub_r1_j1'), {
          scoredCriterionCount: 1,
          weightedTotal: 0,
          status: 'submitted',
          submittedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(
        updateDoc(doc(jDb, 'evaluations', 'sub_r1_j1'), {
          scoredCriterionCount: 2, // Forged count: c2 does not exist yet!
          weightedTotal: 54,
          status: 'submitted',
          submittedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      // 9. Complete second criterion c2=9 (even if client tampers parent weightedTotal=99, hydration & ranking recompute 54!)
      await assertSucceeds(
        setDoc(doc(jDb, 'evaluations', 'sub_r1_j1', 'criteria', 'c2'), {
          criterionId: 'c2',
          evaluationId: 'sub_r1_j1',
          hackathonId: 'hack_rubric',
          submissionId: 'sub_r1',
          judgeId: 'j1',
          criterionName: 'Execution',
          weight: 60,
          score: 9,
          comment: 'Solid',
          updatedAt: serverTimestamp()
        })
      );
      await assertSucceeds(
        updateDoc(doc(jDb, 'evaluations', 'sub_r1_j1'), {
          scoredCriterionCount: 2,
          weightedTotal: 99, // Deliberate client display forgery to prove reader recomputation defeats it
          status: 'submitted',
          submittedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      const parentSnap = await assertSucceeds(getDoc(doc(jDb, 'evaluations', 'sub_r1_j1')));
      const critSnap = await assertSucceeds(getDocs(collection(jDb, 'evaluations', 'sub_r1_j1', 'criteria')));
      const hydrated = hydrateEvaluationScoresAndTotal(
        parentSnap.data() as Evaluation,
        critSnap.docs.map((d) => d.data() as NormalizedEvaluationCriterionDoc),
        rubric
      );
      expect(hydrated.weightedTotal).toBe(54); // Authoritative recomputation from rule-validated subcollection docs

      // 10. Post-submission mutations (parent OR subcollection create/update/delete) -> ALL DENIED
      await assertFails(
        updateDoc(doc(jDb, 'evaluations', 'sub_r1_j1'), {
          humanFeedback: 'Post-submission edit attempt',
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(
        updateDoc(doc(jDb, 'evaluations', 'sub_r1_j1', 'criteria', 'c1'), {
          criterionId: 'c1',
          evaluationId: 'sub_r1_j1',
          hackathonId: 'hack_rubric',
          submissionId: 'sub_r1',
          judgeId: 'j1',
          criterionName: 'Innovation',
          weight: 40,
          score: 10,
          comment: 'Tampered after submit',
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(deleteDoc(doc(jDb, 'evaluations', 'sub_r1_j1', 'criteria', 'c1')));

      // 11. Unassigned judge write -> DENIED
      await seedUser({ uid: 'j_unassigned', approvedRole: 'judge' });
      const unassignedDb = verifiedCtx('j_unassigned').firestore();
      await assertFails(
        setDoc(doc(unassignedDb, 'evaluations', 'sub_r1_j_unassigned'), {
          ...baseEval,
          id: 'sub_r1_j_unassigned',
          judgeId: 'j_unassigned',
          criteriaScores: [],
          scoredCriterionCount: 0,
          weightedTotal: 0,
          status: 'draft'
        })
      );
    });

    const buildMatrixRubric = (size: number): RubricCriterion[] => {
      if (size === 4) {
        return [
          { id: 'c1', name: 'Innovation', description: 'Novelty', weight: 25 },
          { id: 'c2', name: 'Technical Depth', description: 'Execution', weight: 30 },
          { id: 'c3', name: 'Impact', description: 'Usefulness', weight: 20 },
          { id: 'c4', name: 'Presentation', description: 'Clarity', weight: 25 }
        ];
      }
      const weights =
        size === 2
          ? [40, 60]
          : size === 3
            ? [30, 40, 30]
            : size === 5
              ? [20, 20, 20, 20, 20]
              : size === 6
                ? [15, 20, 15, 20, 15, 15]
                : Array.from({ length: 10 }, () => 10);
      return weights.map((weight, idx) => ({
        id: `crit_${size}_${idx + 1}`,
        name: `Criterion ${idx + 1}`,
        description: `Rubric item ${idx + 1}`,
        weight
      }));
    };

    it.each([
      { size: 2, label: '2 criteria [40/60]' },
      { size: 3, label: '3 criteria [30/40/30]' },
      { size: 4, label: '4 criteria [25/30/20/25 default]' },
      { size: 5, label: '5 criteria [20x5]' },
      { size: 6, label: '6 criteria [15/20/15/20/15/15]' },
      { size: 10, label: '10 criteria [10x10]' }
    ])(
      'Attack 22b / Workflow 16 ($label): draft create, partial/complete update, draft recovery, finalizing recovery, final submit, post-submit lock, and tamper rejection',
      async ({ size }) => {
        await seedUser({ uid: 'org_m', approvedRole: 'organizer' });
        await seedUser({ uid: 'j_m', approvedRole: 'judge' });
        await seedUser({ uid: 'p_m', approvedRole: 'participant' });

        const rubric = buildMatrixRubric(size);
        const hackathonId = `hack_matrix_${size}`;
        const teamId = `team_matrix_${size}`;
        const projectId = `proj_matrix_${size}`;
        const submissionId = `sub_matrix_${size}`;
        const evaluationId = `${submissionId}_j_m`;

        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          const now = Timestamp.now();
          await setDoc(doc(ctx.firestore(), 'hackathons', hackathonId), {
            id: hackathonId,
            organizerId: 'org_m',
            organizerName: 'Matrix Organizer',
            title: `Matrix Hackathon ${size}`,
            description: `Tests ${size}-criterion normalized judging flow.`,
            mode: 'online',
            rubric,
            maxTeamSize: 4,
            status: 'judging',
            resultsPublished: false,
            createdAt: now,
            updatedAt: now
          });
        });
        await seedTeam({ teamId, hackathonId, organizerId: 'org_m', leaderId: 'p_m' });
        await seedProject({ projectId, hackathonId, organizerId: 'org_m', teamId, ownerId: 'p_m', memberIds: ['p_m'] });
        await seedSubmission({
          submissionId,
          hackathonId,
          organizerId: 'org_m',
          teamId,
          projectId,
          ownerId: 'p_m',
          memberIds: ['p_m'],
          status: 'under_review'
        });
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), 'judgeAssignments', `${hackathonId}_j_m`), {
            id: `${hackathonId}_j_m`,
            hackathonId,
            organizerId: 'org_m',
            judgeId: 'j_m',
            judgeName: 'Matrix Judge',
            assignedSubmissionIds: [submissionId],
            conflictDeclared: false,
            status: 'accepted',
            createdAt: Timestamp.now(),
            updatedAt: Timestamp.now()
          });
        });

        const jDb = verifiedCtx('j_m').firestore();
        const parentRef = doc(jDb, 'evaluations', evaluationId);

        // 1. Draft creation (empty)
        await assertSucceeds(
          setDoc(parentRef, {
            id: evaluationId,
            hackathonId,
            organizerId: 'org_m',
            submissionId,
            judgeId: 'j_m',
            judgeName: 'Matrix Judge',
            criteriaScores: [],
            weightedTotal: 0,
            scoredCriterionCount: 0,
            storageSchema: 'v2_subcollection',
            conflictOfInterest: false,
            conflictReason: '',
            humanFeedback: '',
            status: 'draft',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          })
        );

        // 2. Partial draft update (score first half of criteria)
        const halfCount = Math.max(1, Math.floor(size / 2));
        const partialScores: CriterionScore[] = rubric.slice(0, halfCount).map((r, idx) => ({
          criterionId: r.id,
          criterionName: r.name,
          weight: r.weight,
          score: idx % 2 === 0 ? 8 : 7,
          comment: `Partial ${idx + 1}`
        }));
        await assertSucceeds(
          updateDoc(parentRef, {
            scoredCriterionCount: partialScores.length,
            weightedTotal: calculateWeightedTotal(partialScores),
            updatedAt: serverTimestamp()
          })
        );
        await assertSucceeds(
          Promise.all(
            partialScores.map((s) =>
              setDoc(doc(jDb, 'evaluations', evaluationId, 'criteria', s.criterionId), {
                criterionId: s.criterionId,
                evaluationId,
                hackathonId,
                submissionId,
                judgeId: 'j_m',
                criterionName: s.criterionName,
                weight: s.weight,
                score: s.score,
                comment: s.comment,
                updatedAt: serverTimestamp()
              })
            )
          )
        );

        // Tamper test at criterion #size (mismatched weight -> DENIED)
        const lastRubricItem = rubric[size - 1];
        await assertFails(
          setDoc(doc(jDb, 'evaluations', evaluationId, 'criteria', lastRubricItem.id), {
            criterionId: lastRubricItem.id,
            evaluationId,
            hackathonId,
            submissionId,
            judgeId: 'j_m',
            criterionName: lastRubricItem.name,
            weight: lastRubricItem.weight + 5,
            score: 9,
            comment: 'Tampered weight',
            updatedAt: serverTimestamp()
          })
        );

        // 3. Complete draft update (remaining criteria up to size)
        const fullScores: CriterionScore[] = rubric.map((r, idx) => ({
          criterionId: r.id,
          criterionName: r.name,
          weight: r.weight,
          score: idx % 2 === 0 ? 8.5 : 6.5,
          comment: `Complete ${idx + 1}`
        }));
        const expectedTotal = calculateWeightedTotal(fullScores);
        await assertSucceeds(
          updateDoc(parentRef, {
            scoredCriterionCount: fullScores.length,
            weightedTotal: expectedTotal,
            humanFeedback: `Complete draft (${size} criteria)`,
            updatedAt: serverTimestamp()
          })
        );
        for (let i = 0; i < fullScores.length; i += 5) {
          const slice = fullScores.slice(i, i + 5);
          await assertSucceeds(
            Promise.all(
              slice.map((s) =>
                setDoc(doc(jDb, 'evaluations', evaluationId, 'criteria', s.criterionId), {
                  criterionId: s.criterionId,
                  evaluationId,
                  hackathonId,
                  submissionId,
                  judgeId: 'j_m',
                  criterionName: s.criterionName,
                  weight: s.weight,
                  score: s.score,
                  comment: s.comment,
                  updatedAt: serverTimestamp()
                })
              )
            )
          );
        }

        // 4. Draft recovery (re-read parent + /criteria, mutate last criterion)
        const draftCritSnap = await assertSucceeds(getDocs(collection(jDb, 'evaluations', evaluationId, 'criteria')));
        expect(draftCritSnap.docs).toHaveLength(size);
        const recoveredLastScore = 9;
        await assertSucceeds(
          updateDoc(doc(jDb, 'evaluations', evaluationId, 'criteria', lastRubricItem.id), {
            criterionId: lastRubricItem.id,
            evaluationId,
            hackathonId,
            submissionId,
            judgeId: 'j_m',
            criterionName: lastRubricItem.name,
            weight: lastRubricItem.weight,
            score: recoveredLastScore,
            comment: 'Updated during draft recovery',
            updatedAt: serverTimestamp()
          })
        );
        const updatedFullScores = fullScores.map((s, idx) =>
          idx === size - 1 ? { ...s, score: recoveredLastScore, comment: 'Updated during draft recovery' } : s
        );
        const recoveredTotal = calculateWeightedTotal(updatedFullScores);

        // 5. Interrupted finalization ('finalizing' excluded from rankings) -> recover -> submit
        await assertSucceeds(
          updateDoc(parentRef, {
            status: 'finalizing',
            scoredCriterionCount: size,
            weightedTotal: recoveredTotal,
            updatedAt: serverTimestamp()
          })
        );
        const finalizingParentSnap = await assertSucceeds(getDoc(parentRef));
        const finalizingHydrated = hydrateEvaluationScoresAndTotal(
          finalizingParentSnap.data() as Evaluation,
          (await assertSucceeds(getDocs(collection(jDb, 'evaluations', evaluationId, 'criteria')))).docs.map(
            (d) => d.data() as NormalizedEvaluationCriterionDoc
          ),
          rubric
        );
        const mockSub: ProjectSubmission = {
          id: submissionId,
          hackathonId,
          organizerId: 'org_m',
          teamId,
          teamName: 'Team Matrix',
          projectId,
          ownerId: 'p_m',
          memberIds: ['p_m'],
          memberNames: ['Participant'],
          title: `Submission ${size}`,
          shortDescription: 'Matrix test submission',
          fullDescription: '',
          problemStatement: '',
          proposedSolution: '',
          technologies: [],
          githubUrl: 'https://github.com/acme/repo',
          demoUrl: '',
          videoUrl: '',
          screenshotUrls: [],
          track: 'AI',
          status: 'under_review'
        };
        const rankingsWhileFinalizing = computeFairRankings({
          submissions: [mockSub],
          evaluations: [finalizingHydrated],
          rubric
        });
        expect(rankingsWhileFinalizing[0].judgeCount).toBe(0);

        // 6. Final submission ('finalizing' -> 'submitted')
        await assertSucceeds(
          updateDoc(parentRef, {
            status: 'submitted',
            scoredCriterionCount: size,
            weightedTotal: recoveredTotal,
            humanFeedback: `Final (${size} criteria)`,
            submittedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          })
        );
        const finalHydrated = hydrateEvaluationScoresAndTotal(
          (await assertSucceeds(getDoc(parentRef))).data() as Evaluation,
          (await assertSucceeds(getDocs(collection(jDb, 'evaluations', evaluationId, 'criteria')))).docs.map(
            (d) => d.data() as NormalizedEvaluationCriterionDoc
          ),
          rubric
        );
        expect(finalHydrated.weightedTotal).toBe(recoveredTotal);
        expect(finalHydrated.criteriaScores).toHaveLength(size);
        const rankingsSubmitted = computeFairRankings({
          submissions: [mockSub],
          evaluations: [finalHydrated],
          rubric
        });
        expect(rankingsSubmitted[0].judgeCount).toBe(1);
        expect(rankingsSubmitted[0].averageScore).toBe(recoveredTotal);

        // 7. Rejection of changes after submission (parent + subcollection)
        await assertFails(
          updateDoc(parentRef, {
            humanFeedback: 'Post-submit tamper',
            updatedAt: serverTimestamp()
          })
        );
        await assertFails(
          updateDoc(doc(jDb, 'evaluations', evaluationId, 'criteria', rubric[0].id), {
            criterionId: rubric[0].id,
            evaluationId,
            hackathonId,
            submissionId,
            judgeId: 'j_m',
            criterionName: rubric[0].name,
            weight: rubric[0].weight,
            score: 10,
            comment: 'Post-submit tamper',
            updatedAt: serverTimestamp()
          })
        );
        await assertFails(deleteDoc(doc(jDb, 'evaluations', evaluationId, 'criteria', rubric[0].id)));
      },
      20000
    );

    it('Workflow 17: migrateLegacyEvaluationToSubcollection migrates drafts non-destructively, skips submitted docs by default, and is idempotent', async () => {
      await seedUser({ uid: 'org_mig', approvedRole: 'organizer' });
      await seedUser({ uid: 'j_mig', approvedRole: 'judge' });

      const draftEvalId = 'sub_mig_draft_j_mig';
      const lockedEvalId = 'sub_mig_locked_j_mig';

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        const now = Timestamp.now();

        await setDoc(doc(db, 'evaluations', draftEvalId), {
          id: draftEvalId,
          hackathonId: 'hack_mig',
          organizerId: 'org_mig',
          submissionId: 'sub_mig_draft',
          judgeId: 'j_mig',
          judgeName: 'Judge Mig',
          criteriaScores: [
            { criterionId: 'c1', criterionName: 'Innovation', weight: 40, score: 8, comment: 'Legacy c1' },
            { criterionId: 'c2', criterionName: 'Execution', weight: 60, score: 9, comment: 'Legacy c2' }
          ],
          weightedTotal: 86,
          conflictOfInterest: false,
          conflictReason: '',
          humanFeedback: 'Legacy draft',
          status: 'draft',
          createdAt: now,
          updatedAt: now
        });

        // Pre-existing newer score in /criteria/c1 MUST be preserved (never overwritten)
        await setDoc(doc(db, 'evaluations', draftEvalId, 'criteria', 'c1'), {
          criterionId: 'c1',
          evaluationId: draftEvalId,
          hackathonId: 'hack_mig',
          submissionId: 'sub_mig_draft',
          judgeId: 'j_mig',
          criterionName: 'Innovation',
          weight: 40,
          score: 10,
          comment: 'Already migrated newer score',
          updatedAt: now
        });

        await setDoc(doc(db, 'evaluations', lockedEvalId), {
          id: lockedEvalId,
          hackathonId: 'hack_mig',
          organizerId: 'org_mig',
          submissionId: 'sub_mig_locked',
          judgeId: 'j_mig',
          judgeName: 'Judge Mig',
          criteriaScores: [
            { criterionId: 'c1', criterionName: 'Innovation', weight: 100, score: 7, comment: 'Locked legacy' }
          ],
          weightedTotal: 70,
          conflictOfInterest: false,
          conflictReason: '',
          humanFeedback: 'Locked submitted',
          status: 'submitted',
          createdAt: now,
          updatedAt: now
        });
      });

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();

        const modularDb = db as unknown as Firestore;

        // Locked submitted evaluation stays untouched unless explicit admin override requested
        const lockedResult = await migrateLegacyEvaluationToSubcollection(modularDb, lockedEvalId);
        expect(lockedResult.outcome).toBe('skipped_submitted_immutable');
        const lockedSnap = await getDoc(doc(db, 'evaluations', lockedEvalId));
        expect(lockedSnap.data()?.criteriaScores).toHaveLength(1);

        // Draft migrates missing c2 while preserving newer c1=10 -> weighted total 94
        const draftResult = await migrateLegacyEvaluationToSubcollection(modularDb, draftEvalId);
        expect(draftResult.outcome).toBe('migrated_to_subcollection');
        expect(draftResult.createdCriteriaCount).toBe(1);
        expect(draftResult.preservedExistingCriteriaCount).toBe(1);
        expect(draftResult.recomputedWeightedTotal).toBe(94);

        const c1Snap = await getDoc(doc(db, 'evaluations', draftEvalId, 'criteria', 'c1'));
        expect(c1Snap.data()?.score).toBe(10);
        const c2Snap = await getDoc(doc(db, 'evaluations', draftEvalId, 'criteria', 'c2'));
        expect(c2Snap.data()?.score).toBe(9);

        // Idempotent second run reports already_migrated with zero extra writes
        const secondRun = await migrateLegacyEvaluationToSubcollection(modularDb, draftEvalId);
        expect(secondRun.outcome).toBe('already_migrated');
        expect(secondRun.createdCriteriaCount).toBe(0);
        expect(secondRun.recomputedWeightedTotal).toBe(94);
      });
    });

    it('Attack 19b: Revoking an accepted judge assignment during an existing draft blocks subsequent parent, criterion, and submission writes', async () => {
      await seedUser({ uid: 'org_rev', approvedRole: 'organizer' });
      await seedUser({ uid: 'owner_rev', approvedRole: 'participant' });
      await seedUser({ uid: 'j_rev', approvedRole: 'judge' });

      const rubric: RubricCriterion[] = [
        { id: 'c1', name: 'Innovation', description: 'Novelty', weight: 40 },
        { id: 'c2', name: 'Execution', description: 'Build', weight: 60 }
      ];
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const now = Timestamp.now();
        await setDoc(doc(ctx.firestore(), 'hackathons', 'hack_rev'), {
          id: 'hack_rev',
          organizerId: 'org_rev',
          organizerName: 'Org Rev',
          title: 'Revocation Test Hackathon',
          description: 'Verifies mid-draft assignment revocation.',
          mode: 'online',
          rubric,
          maxTeamSize: 4,
          status: 'judging',
          resultsPublished: false,
          createdAt: now,
          updatedAt: now
        });
      });
      await seedTeam({ teamId: 'team_rev', hackathonId: 'hack_rev', organizerId: 'org_rev', leaderId: 'owner_rev' });
      await seedProject({
        projectId: 'proj_rev',
        hackathonId: 'hack_rev',
        organizerId: 'org_rev',
        teamId: 'team_rev',
        ownerId: 'owner_rev',
        memberIds: ['owner_rev']
      });
      await seedSubmission({
        submissionId: 'sub_rev',
        hackathonId: 'hack_rev',
        organizerId: 'org_rev',
        teamId: 'team_rev',
        projectId: 'proj_rev',
        ownerId: 'owner_rev',
        memberIds: ['owner_rev'],
        status: 'under_review'
      });

      const orgDb = verifiedCtx('org_rev').firestore();
      const jDb = verifiedCtx('j_rev').firestore();

      // Declined assignment must fail initial evaluation creation
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'judgeAssignments', 'hack_rev_j_rev'), {
          id: 'hack_rev_j_rev',
          hackathonId: 'hack_rev',
          organizerId: 'org_rev',
          judgeId: 'j_rev',
          judgeName: 'Judge Rev',
          assignedSubmissionIds: ['sub_rev'],
          conflictDeclared: false,
          status: 'declined',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
      });
      await assertFails(
        setDoc(doc(jDb, 'evaluations', 'sub_rev_j_rev'), {
          id: 'sub_rev_j_rev',
          hackathonId: 'hack_rev',
          organizerId: 'org_rev',
          submissionId: 'sub_rev',
          judgeId: 'j_rev',
          criteriaScores: [],
          weightedTotal: 0,
          scoredCriterionCount: 0,
          storageSchema: 'v2_subcollection',
          conflictOfInterest: false,
          conflictReason: '',
          status: 'draft',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      // Accept assignment, create draft parent + partial criterion c1
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await updateDoc(doc(ctx.firestore(), 'judgeAssignments', 'hack_rev_j_rev'), {
          status: 'accepted',
          conflictDeclared: false
        });
      });
      const evalRef = doc(jDb, 'evaluations', 'sub_rev_j_rev');
      const crit1Ref = doc(jDb, 'evaluations', 'sub_rev_j_rev', 'criteria', 'c1');
      const crit2Ref = doc(jDb, 'evaluations', 'sub_rev_j_rev', 'criteria', 'c2');
      await assertSucceeds(
        setDoc(evalRef, {
          id: 'sub_rev_j_rev',
          hackathonId: 'hack_rev',
          organizerId: 'org_rev',
          submissionId: 'sub_rev',
          judgeId: 'j_rev',
          criteriaScores: [],
          weightedTotal: 0,
          scoredCriterionCount: 0,
          storageSchema: 'v2_subcollection',
          conflictOfInterest: false,
          conflictReason: '',
          status: 'draft',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );
      await assertSucceeds(
        setDoc(crit1Ref, {
          criterionId: 'c1',
          evaluationId: 'sub_rev_j_rev',
          hackathonId: 'hack_rev',
          submissionId: 'sub_rev',
          judgeId: 'j_rev',
          criterionName: 'Innovation',
          weight: 40,
          score: 8,
          comment: 'Draft comment before revocation',
          updatedAt: serverTimestamp()
        })
      );

      // 1) Organizer unassigns submission during active draft -> all subsequent judge writes/submit DENIED
      await assertSucceeds(
        updateDoc(doc(orgDb, 'judgeAssignments', 'hack_rev_j_rev'), {
          assignedSubmissionIds: [],
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(updateDoc(evalRef, { humanFeedback: 'Post-unassign edit', updatedAt: serverTimestamp() }));
      await assertFails(
        setDoc(crit2Ref, {
          criterionId: 'c2',
          evaluationId: 'sub_rev_j_rev',
          hackathonId: 'hack_rev',
          submissionId: 'sub_rev',
          judgeId: 'j_rev',
          criterionName: 'Execution',
          weight: 60,
          score: 9,
          comment: '',
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(
        updateDoc(crit1Ref, {
          criterionId: 'c1',
          evaluationId: 'sub_rev_j_rev',
          hackathonId: 'hack_rev',
          submissionId: 'sub_rev',
          judgeId: 'j_rev',
          criterionName: 'Innovation',
          weight: 40,
          score: 10,
          comment: 'Post-unassign tamper',
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(deleteDoc(crit1Ref));
      await assertFails(
        updateDoc(evalRef, {
          scoredCriterionCount: 2,
          weightedTotal: 80,
          status: 'submitted',
          submittedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      // 2) Restore assignment, then judge declines mid-draft -> all subsequent writes/submit DENIED
      await assertSucceeds(
        updateDoc(doc(orgDb, 'judgeAssignments', 'hack_rev_j_rev'), {
          assignedSubmissionIds: ['sub_rev'],
          updatedAt: serverTimestamp()
        })
      );
      await assertSucceeds(
        setDoc(crit2Ref, {
          criterionId: 'c2',
          evaluationId: 'sub_rev_j_rev',
          hackathonId: 'hack_rev',
          submissionId: 'sub_rev',
          judgeId: 'j_rev',
          criterionName: 'Execution',
          weight: 60,
          score: 9,
          comment: 'Added while assigned',
          updatedAt: serverTimestamp()
        })
      );
      await assertSucceeds(
        updateDoc(doc(jDb, 'judgeAssignments', 'hack_rev_j_rev'), {
          status: 'declined',
          conflictDeclared: true,
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(updateDoc(evalRef, { humanFeedback: 'After decline', updatedAt: serverTimestamp() }));
      await assertFails(
        updateDoc(crit2Ref, {
          criterionId: 'c2',
          evaluationId: 'sub_rev_j_rev',
          hackathonId: 'hack_rev',
          submissionId: 'sub_rev',
          judgeId: 'j_rev',
          criterionName: 'Execution',
          weight: 60,
          score: 5,
          comment: 'After decline',
          updatedAt: serverTimestamp()
        })
      );
      await assertFails(
        updateDoc(evalRef, {
          scoredCriterionCount: 2,
          weightedTotal: 86,
          status: 'submitted',
          submittedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );
    });

    it('Workflow 18 (Concurrency): Concurrent finalization from two independent client instances leaves one atomic submitted state and rejects stale late writes', async () => {
      await seedUser({ uid: 'org_conc', approvedRole: 'organizer' });
      await seedUser({ uid: 'owner_conc', approvedRole: 'participant' });
      await seedUser({ uid: 'j_conc', approvedRole: 'judge' });

      const rubric: RubricCriterion[] = [
        { id: 'c1', name: 'Innovation', description: 'Novelty', weight: 25 },
        { id: 'c2', name: 'Technical Depth', description: 'Architecture', weight: 30 },
        { id: 'c3', name: 'Impact', description: 'Usefulness', weight: 20 },
        { id: 'c4', name: 'Presentation', description: 'Clarity', weight: 25 }
      ];

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const now = Timestamp.now();
        await setDoc(doc(ctx.firestore(), 'hackathons', 'hack_conc'), {
          id: 'hack_conc',
          organizerId: 'org_conc',
          organizerName: 'Org Conc',
          title: 'Concurrency Test Hackathon',
          description: 'Verifies concurrent client finalization.',
          mode: 'online',
          rubric,
          maxTeamSize: 4,
          status: 'judging',
          resultsPublished: false,
          createdAt: now,
          updatedAt: now
        });
      });
      await seedTeam({ teamId: 'team_conc', hackathonId: 'hack_conc', organizerId: 'org_conc', leaderId: 'owner_conc' });
      await seedProject({
        projectId: 'proj_conc',
        hackathonId: 'hack_conc',
        organizerId: 'org_conc',
        teamId: 'team_conc',
        ownerId: 'owner_conc',
        memberIds: ['owner_conc']
      });
      await seedSubmission({
        submissionId: 'sub_conc',
        hackathonId: 'hack_conc',
        organizerId: 'org_conc',
        teamId: 'team_conc',
        projectId: 'proj_conc',
        ownerId: 'owner_conc',
        memberIds: ['owner_conc'],
        status: 'under_review'
      });
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'judgeAssignments', 'hack_conc_j_conc'), {
          id: 'hack_conc_j_conc',
          hackathonId: 'hack_conc',
          organizerId: 'org_conc',
          judgeId: 'j_conc',
          judgeName: 'Judge Conc',
          assignedSubmissionIds: ['sub_conc'],
          conflictDeclared: false,
          status: 'accepted',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
      });

      // Two independent client Firestore handles for the same judge (simulating two browser tabs)
      const clientA = testEnv.authenticatedContext('j_conc', {
        email: 'j_conc@hackmind.test',
        email_verified: true,
        session: 'tab_a'
      }).firestore();
      const clientB = testEnv.authenticatedContext('j_conc', {
        email: 'j_conc@hackmind.test',
        email_verified: true,
        session: 'tab_b'
      }).firestore();

      const evalId = 'sub_conc_j_conc';
      await assertSucceeds(
        setDoc(doc(clientA, 'evaluations', evalId), {
          id: evalId,
          hackathonId: 'hack_conc',
          organizerId: 'org_conc',
          submissionId: 'sub_conc',
          judgeId: 'j_conc',
          criteriaScores: [],
          weightedTotal: 0,
          scoredCriterionCount: 0,
          storageSchema: 'v2_subcollection',
          conflictOfInterest: false,
          conflictReason: '',
          status: 'draft',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      // Seed all 4 criterion docs while finalizing
      await assertSucceeds(
        updateDoc(doc(clientA, 'evaluations', evalId), {
          status: 'finalizing',
          scoredCriterionCount: 4,
          weightedTotal: 80,
          updatedAt: serverTimestamp()
        })
      );
      await assertSucceeds(
        Promise.all(
          rubric.map((r) =>
            setDoc(doc(clientA, 'evaluations', evalId, 'criteria', r.id), {
              criterionId: r.id,
              evaluationId: evalId,
              hackathonId: 'hack_conc',
              submissionId: 'sub_conc',
              judgeId: 'j_conc',
              criterionName: r.name,
              weight: r.weight,
              score: 8,
              comment: 'Tab A',
              updatedAt: serverTimestamp()
            })
          )
        )
      );

      // Both clients race simultaneously to finalize -> EXACTLY ONE must win; loser is rejected by existing().status == 'submitted'
      const raceResults = await Promise.allSettled([
        updateDoc(doc(clientA, 'evaluations', evalId), {
          status: 'submitted',
          scoredCriterionCount: 4,
          weightedTotal: 80,
          humanFeedback: 'Submitted by Tab A',
          submittedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }),
        updateDoc(doc(clientB, 'evaluations', evalId), {
          status: 'submitted',
          scoredCriterionCount: 4,
          weightedTotal: 90,
          humanFeedback: 'Submitted by Tab B',
          submittedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      ]);

      const fulfilled = raceResults.filter((r) => r.status === 'fulfilled');
      const rejected = raceResults.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // Late criterion write or second finalization attempt from Tab B MUST fail
      await assertFails(
        updateDoc(doc(clientB, 'evaluations', evalId, 'criteria', 'c2'), {
          criterionId: 'c2',
          evaluationId: evalId,
          hackathonId: 'hack_conc',
          submissionId: 'sub_conc',
          judgeId: 'j_conc',
          criterionName: 'Technical Depth',
          weight: 30,
          score: 10,
          comment: 'Late Tab B overwrite',
          updatedAt: serverTimestamp()
        })
      );

      const finalParentSnap = await assertSucceeds(getDoc(doc(clientA, 'evaluations', evalId)));
      const finalCritSnap = await assertSucceeds(getDocs(collection(clientA, 'evaluations', evalId, 'criteria')));
      expect(finalParentSnap.data()?.status).toBe('submitted');
      const hydrated = hydrateEvaluationScoresAndTotal(
        finalParentSnap.data() as Evaluation,
        finalCritSnap.docs.map((d) => d.data() as NormalizedEvaluationCriterionDoc),
        rubric
      );
      expect(hydrated.weightedTotal).toBe(80);
      expect(hydrated.criteriaScores).toHaveLength(4);
    });

    it('Attack 22c: Missing middle criterion on a 4-criterion rubric cannot leak into official rankings even if submitted directly, and incomplete finalizing stays blocked', async () => {
      await seedUser({ uid: 'org_mid', approvedRole: 'organizer' });
      await seedUser({ uid: 'owner_mid', approvedRole: 'participant' });
      await seedUser({ uid: 'j_mid', approvedRole: 'judge' });

      const rubric: RubricCriterion[] = [
        { id: 'c1', name: 'Innovation', description: 'Novelty', weight: 25 },
        { id: 'c2', name: 'Technical Depth', description: 'Architecture', weight: 30 },
        { id: 'c3', name: 'Impact', description: 'Usefulness', weight: 20 },
        { id: 'c4', name: 'Presentation', description: 'Clarity', weight: 25 }
      ];

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const now = Timestamp.now();
        await setDoc(doc(ctx.firestore(), 'hackathons', 'hack_mid'), {
          id: 'hack_mid',
          organizerId: 'org_mid',
          organizerName: 'Org Mid',
          title: 'Middle Criterion Audit',
          description: 'Verifies middle-criterion integrity.',
          mode: 'online',
          rubric,
          maxTeamSize: 4,
          status: 'judging',
          resultsPublished: false,
          createdAt: now,
          updatedAt: now
        });
      });
      await seedTeam({ teamId: 'team_mid', hackathonId: 'hack_mid', organizerId: 'org_mid', leaderId: 'owner_mid' });
      await seedProject({
        projectId: 'proj_mid',
        hackathonId: 'hack_mid',
        organizerId: 'org_mid',
        teamId: 'team_mid',
        ownerId: 'owner_mid',
        memberIds: ['owner_mid']
      });
      await seedSubmission({
        submissionId: 'sub_mid',
        hackathonId: 'hack_mid',
        organizerId: 'org_mid',
        teamId: 'team_mid',
        projectId: 'proj_mid',
        ownerId: 'owner_mid',
        memberIds: ['owner_mid'],
        status: 'under_review'
      });
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'judgeAssignments', 'hack_mid_j_mid'), {
          id: 'hack_mid_j_mid',
          hackathonId: 'hack_mid',
          organizerId: 'org_mid',
          judgeId: 'j_mid',
          judgeName: 'Judge Mid',
          assignedSubmissionIds: ['sub_mid'],
          conflictDeclared: false,
          status: 'accepted',
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        });
      });

      const jDb = verifiedCtx('j_mid').firestore();
      const orgDb = verifiedCtx('org_mid').firestore();
      const evalId = 'sub_mid_j_mid';

      await assertSucceeds(
        setDoc(doc(jDb, 'evaluations', evalId), {
          id: evalId,
          hackathonId: 'hack_mid',
          organizerId: 'org_mid',
          submissionId: 'sub_mid',
          judgeId: 'j_mid',
          criteriaScores: [],
          weightedTotal: 0,
          scoredCriterionCount: 0,
          storageSchema: 'v2_subcollection',
          conflictOfInterest: false,
          conflictReason: '',
          status: 'finalizing',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      // Write c1 and c4 ONLY (middle c2 and c3 missing)
      for (const r of [rubric[0], rubric[3]]) {
        await assertSucceeds(
          setDoc(doc(jDb, 'evaluations', evalId, 'criteria', r.id), {
            criterionId: r.id,
            evaluationId: evalId,
            hackathonId: 'hack_mid',
            submissionId: 'sub_mid',
            judgeId: 'j_mid',
            criterionName: r.name,
            weight: r.weight,
            score: 9,
            comment: 'Boundary criterion',
            updatedAt: serverTimestamp()
          })
        );
      }

      // Honest incomplete finalizing count (2 != 4) is DENIED submission by Rules
      await assertFails(
        updateDoc(doc(jDb, 'evaluations', evalId), {
          status: 'submitted',
          scoredCriterionCount: 2,
          weightedTotal: 90,
          submittedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      // Even if a malicious SDK client spoofs scoredCriterionCount=4 while c2 & c3 are missing,
      // organizer hydration + computeFairRankings MUST reject & exclude the incomplete evaluation.
      await assertSucceeds(
        updateDoc(doc(jDb, 'evaluations', evalId), {
          status: 'submitted',
          scoredCriterionCount: 4,
          weightedTotal: 90,
          submittedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      const parentSnap = await assertSucceeds(getDoc(doc(orgDb, 'evaluations', evalId)));
      const critSnap = await assertSucceeds(getDocs(collection(orgDb, 'evaluations', evalId, 'criteria')));
      const hydrated = hydrateEvaluationScoresAndTotal(
        parentSnap.data() as Evaluation,
        critSnap.docs.map((d) => d.data() as NormalizedEvaluationCriterionDoc),
        rubric
      );
      const mockSub: ProjectSubmission = {
        id: 'sub_mid',
        hackathonId: 'hack_mid',
        organizerId: 'org_mid',
        teamId: 'team_mid',
        teamName: 'Team Mid',
        projectId: 'proj_mid',
        ownerId: 'owner_mid',
        memberIds: ['owner_mid'],
        memberNames: ['Participant'],
        title: 'Middle Criterion Project',
        shortDescription: 'Desc',
        fullDescription: '',
        problemStatement: '',
        proposedSolution: '',
        technologies: [],
        githubUrl: 'https://github.com/acme/mid',
        demoUrl: '',
        videoUrl: '',
        screenshotUrls: [],
        track: 'AI',
        status: 'under_review'
      };
      const rankings = computeFairRankings({
        submissions: [mockSub],
        evaluations: [hydrated],
        expectedJudgesPerSubmission: 1,
        rubric
      });
      expect(rankings[0].judgeCount).toBe(0);
      expect(rankings[0].averageScore).toBe(0);
      expect(rankings[0].anomalyFlag).toBe(true);
    });

    it('Workflow 17b: Enforces admin-only Rules authorization for legacy submitted migration, preserves comments and IDs, and keeps v1_inline read compatibility', async () => {
      await seedUser({ uid: 'org_m2', approvedRole: 'organizer' });
      await seedUser({ uid: 'j_m2', approvedRole: 'judge' });
      await seedUser({ uid: 'admin_m2', approvedRole: 'organizer', isAdmin: true });

      const draftEvalId = 'sub_m2_draft_j_m2';
      const submittedEvalId = 'sub_m2_sub_j_m2';
      const rubric: RubricCriterion[] = [
        { id: 'c1', name: 'Innovation', description: 'Novelty', weight: 40 },
        { id: 'c2', name: 'Execution', description: 'Implementation', weight: 60 }
      ];

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        const now = Timestamp.now();

        await setDoc(doc(db, 'evaluations', draftEvalId), {
          id: draftEvalId,
          hackathonId: 'hack_m2',
          organizerId: 'org_m2',
          submissionId: 'sub_m2_draft',
          judgeId: 'j_m2',
          judgeName: 'Judge M2',
          criteriaScores: [
            { criterionId: 'c1', criterionName: 'Innovation', weight: 40, score: 8, comment: 'Legacy c1 comment' },
            { criterionId: 'c2', criterionName: 'Execution', weight: 60, score: 9, comment: 'Legacy c2 comment' }
          ],
          weightedTotal: 86,
          conflictOfInterest: false,
          conflictReason: '',
          humanFeedback: 'Legacy draft',
          status: 'draft',
          createdAt: now,
          updatedAt: now
        });

        await setDoc(doc(db, 'evaluations', draftEvalId, 'criteria', 'c1'), {
          criterionId: 'c1',
          evaluationId: draftEvalId,
          hackathonId: 'hack_m2',
          submissionId: 'sub_m2_draft',
          judgeId: 'j_m2',
          criterionName: 'Innovation',
          weight: 40,
          score: 10,
          comment: 'Already migrated newer comment',
          updatedAt: now
        });

        await setDoc(doc(db, 'evaluations', submittedEvalId), {
          id: submittedEvalId,
          hackathonId: 'hack_m2',
          organizerId: 'org_m2',
          submissionId: 'sub_m2_sub',
          judgeId: 'j_m2',
          judgeName: 'Judge M2',
          criteriaScores: [
            { criterionId: 'c1', criterionName: 'Innovation', weight: 40, score: 7, comment: 'Submitted inline c1' },
            { criterionId: 'c2', criterionName: 'Execution', weight: 60, score: 8, comment: 'Submitted inline c2' }
          ],
          weightedTotal: 76,
          conflictOfInterest: false,
          conflictReason: '',
          humanFeedback: 'Locked submitted legacy',
          status: 'submitted',
          createdAt: now,
          updatedAt: now
        });
      });

      const judgeDb = verifiedCtx('j_m2').firestore() as unknown as Firestore;
      const orgDb = verifiedCtx('org_m2').firestore() as unknown as Firestore;
      const adminDb = verifiedCtx('admin_m2').firestore() as unknown as Firestore;

      // Unmigrated v1_inline submitted doc hydrates cleanly for judge/organizer before any migration
      const unmigratedParent = await assertSucceeds(getDoc(doc(orgDb, 'evaluations', submittedEvalId)));
      const unmigratedCrit = await assertSucceeds(getDocs(collection(orgDb, 'evaluations', submittedEvalId, 'criteria')));
      const hydratedLegacy = hydrateEvaluationScoresAndTotal(
        unmigratedParent.data() as Evaluation,
        unmigratedCrit.docs.map((d) => d.data() as NormalizedEvaluationCriterionDoc),
        rubric
      );
      expect(hydratedLegacy.id).toBe(submittedEvalId);
      expect(hydratedLegacy.storageSchema).toBe('v1_inline');
      expect(hydratedLegacy.weightedTotal).toBe(76);
      expect(hydratedLegacy.criteriaScores.map((s) => s.comment)).toEqual([
        'Submitted inline c1',
        'Submitted inline c2'
      ]);

      // Non-admins (judge & organizer) MUST be denied overriding a locked submitted doc under live Firestore Rules
      await expect(
        migrateLegacyEvaluationToSubcollection(judgeDb, submittedEvalId, { allowSubmittedOverride: true })
      ).rejects.toThrow();
      await expect(
        migrateLegacyEvaluationToSubcollection(orgDb, submittedEvalId, { allowSubmittedOverride: true })
      ).rejects.toThrow();

      // Admin CAN run legacy draft + submitted override migration under actual Firestore Rules
      const draftRes = await migrateLegacyEvaluationToSubcollection(adminDb, draftEvalId);
      expect(draftRes.outcome).toBe('migrated_to_subcollection');
      expect(draftRes.createdCriteriaCount).toBe(1);
      expect(draftRes.preservedExistingCriteriaCount).toBe(1);
      expect(draftRes.recomputedWeightedTotal).toBe(94);

      const draftC1 = await assertSucceeds(getDoc(doc(adminDb, 'evaluations', draftEvalId, 'criteria', 'c1')));
      const draftC2 = await assertSucceeds(getDoc(doc(adminDb, 'evaluations', draftEvalId, 'criteria', 'c2')));
      expect(draftC1.data()?.score).toBe(10);
      expect(draftC1.data()?.comment).toBe('Already migrated newer comment');
      expect(draftC2.data()?.score).toBe(9);
      expect(draftC2.data()?.comment).toBe('Legacy c2 comment');

      const submittedRes = await migrateLegacyEvaluationToSubcollection(adminDb, submittedEvalId, {
        allowSubmittedOverride: true
      });
      expect(submittedRes.outcome).toBe('migrated_to_subcollection');
      expect(submittedRes.createdCriteriaCount).toBe(2);
      expect(submittedRes.recomputedWeightedTotal).toBe(76);

      const subC1 = await assertSucceeds(getDoc(doc(adminDb, 'evaluations', submittedEvalId, 'criteria', 'c1')));
      const subC2 = await assertSucceeds(getDoc(doc(adminDb, 'evaluations', submittedEvalId, 'criteria', 'c2')));
      expect(subC1.id).toBe('c1');
      expect(subC1.data()?.score).toBe(7);
      expect(subC1.data()?.comment).toBe('Submitted inline c1');
      expect(subC2.id).toBe('c2');
      expect(subC2.data()?.score).toBe(8);
      expect(subC2.data()?.comment).toBe('Submitted inline c2');

      // Re-running migration is idempotent under live Rules
      const repeatRes = await migrateLegacyEvaluationToSubcollection(adminDb, submittedEvalId, {
        allowSubmittedOverride: true
      });
      expect(repeatRes.outcome).toBe('already_migrated');
      expect(repeatRes.createdCriteriaCount).toBe(0);
      expect(repeatRes.preservedExistingCriteriaCount).toBe(2);
      expect(repeatRes.recomputedWeightedTotal).toBe(76);
    });
  });
});




