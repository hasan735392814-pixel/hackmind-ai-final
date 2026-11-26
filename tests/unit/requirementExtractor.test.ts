import { describe, expect, it } from 'vitest';
import {
  evaluateEligibilityChecks,
  extractHackathonRequirements
} from '../../src/services/judging/requirementExtractor';
import type { Hackathon, ProjectSubmission } from '../../src/types/domain';

describe('Hackathon Requirement Discovery & Eligibility Checker', () => {
  const sampleHackathon: Hackathon = {
    id: 'hack_global_2026',
    organizerId: 'org_1',
    organizerName: 'HackMind Foundation',
    title: 'Global AI Innovation Hackathon 2026',
    tagline: 'Build verifiable real-world AI',
    description: 'Annual competition',
    coverImageUrl: '',
    startDate: '2026-11-01T00:00:00Z',
    endDate: '2026-11-30T23:59:59Z',
    registrationDeadline: '2026-11-15T23:59:59Z',
    submissionDeadline: '2026-11-25T23:59:59Z',
    mode: 'online',
    location: 'Global',
    tracks: ['AI Productivity', 'FinTech'],
    technologies: ['TypeScript', 'Gemini'],
    eligibility: 'Open to builders aged 18+.\nTeams must submit original code written during the event.',
    rules: 'All submissions must include a public GitHub repo.\nPre-built closed templates are prohibited.',
    prizes: ['$10,000'],
    sponsors: [],
    rubric: [
      { id: 'c1', name: 'Innovation & Originality', description: 'Novelty', weight: 25 },
      { id: 'c2', name: 'Technical Implementation', description: 'Code & reliability', weight: 30 },
      { id: 'c3', name: 'Real-World Impact', description: 'Measurable value', weight: 25 },
      { id: 'c4', name: 'User Experience & Completeness', description: 'Polish & usability', weight: 20 }
    ],
    maxTeamSize: 4,
    status: 'judging',
    resultsPublished: false
  };

  it('extracts exact mandatory requirements, prohibited practices, and dynamic rubric weights', () => {
    const bundle = extractHackathonRequirements(sampleHackathon);

    expect(bundle.hackathonTitle).toBe('Global AI Innovation Hackathon 2026');
    expect(bundle.rubricWeightsValid).toBe(true);
    expect(bundle.rubricWeightSum).toBe(100);
    expect(bundle.scoredCriteria).toHaveLength(4);
    expect(bundle.scoredCriteria.every((c) => c.mandatory === false)).toBe(true);

    expect(bundle.mandatoryRequirements.some((r) => r.kind === 'prohibited_practice' && r.exactWording.includes('prohibited'))).toBe(
      true
    );
    expect(bundle.mandatoryRequirements.some((r) => r.sourceField === 'hackathon.eligibility')).toBe(
      true
    );
    expect(bundle.mandatoryRequirements.some((r) => r.sourceField === 'hackathon.technologies')).toBe(
      true
    );
  });

  it('never invents missing rules when hackathon config is missing or incomplete', () => {
    const missingBundle = extractHackathonRequirements(null);
    expect(missingBundle.mandatoryRequirements).toHaveLength(0);
    expect(missingBundle.scoredCriteria).toHaveLength(0);
    expect(missingBundle.missingRequirementFields).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'hackathon', status: 'BLOCKED' })])
    );

    const partialHackathon: Hackathon = {
      ...sampleHackathon,
      eligibility: '',
      rules: '',
      rubric: []
    };
    const partialBundle = extractHackathonRequirements(partialHackathon);
    expect(partialBundle.missingRequirementFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'hackathon.eligibility', status: 'UNVERIFIED' }),
        expect.objectContaining({ field: 'hackathon.rules', status: 'UNVERIFIED' }),
        expect.objectContaining({ field: 'hackathon.rubric', status: 'BLOCKED' })
      ])
    );
  });

  it('detects track mismatches, oversized teams, and late submissions as CONTRADICTED', () => {
    const bundle = extractHackathonRequirements(sampleHackathon);
    const badSubmission: Partial<ProjectSubmission> = {
      hackathonId: sampleHackathon.id,
      track: 'Hardware Robotics',
      memberIds: ['u1', 'u2', 'u3', 'u4', 'u5'],
      submittedAt: '2026-11-28T12:00:00Z'
    };

    const res = evaluateEligibilityChecks({
      bundle,
      hackathon: sampleHackathon,
      submission: badSubmission,
      observedAt: '2026-11-29T00:00:00Z'
    });

    expect(res.overallStatus).toBe('CONTRADICTED');
    expect(res.checks.find((c) => c.id === 'check_team_size')?.status).toBe('CONTRADICTED');
    expect(res.checks.find((c) => c.id === 'check_track')?.status).toBe('CONTRADICTED');
    expect(res.checks.find((c) => c.id === 'check_deadline')?.status).toBe('CONTRADICTED');
  });

  it('discloses UNVERIFIED warning when eligibility/rules exceed clause budget instead of truncating silently', () => {
    const manyRules = Array.from({ length: 105 }, (_, i) => `Rule clause item number ${i + 1}.`).join(
      '\n'
    );
    const bundle = extractHackathonRequirements({
      ...sampleHackathon,
      rules: manyRules
    });
    expect(
      bundle.missingRequirementFields.some(
        (m) => m.field === 'hackathon.rules' && m.status === 'UNVERIFIED'
      )
    ).toBe(true);
  });
});
