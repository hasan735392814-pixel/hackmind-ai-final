import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hackathon } from '../../src/types/domain';
import { resolveOverviewStats } from '../../src/utils/dashboardMetrics';

const mockGetDocs = vi.fn();
const mockSetDoc = vi.fn();
const mockUpdateDoc = vi.fn();
const mockWhere = vi.fn((field: string, op: string, value: unknown) => ({ field, op, value }));

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  collection: vi.fn((_, path: string) => ({ path })),
  doc: vi.fn((_, col: string, id: string) => ({ col, id, path: `${col}/${id}` })),
  query: vi.fn((col, ...constraints) => ({ col, constraints })),
  where: (field: string, op: string, value: unknown) => mockWhere(field, op, value),
  getDocs: (...args: unknown[]) => mockGetDocs(...args),
  getDoc: vi.fn(),
  setDoc: (...args: unknown[]) => mockSetDoc(...args),
  updateDoc: (...args: unknown[]) => mockUpdateDoc(...args),
  deleteDoc: vi.fn(),
  serverTimestamp: vi.fn(() => 'SERVER_TIMESTAMP'),
  Timestamp: {
    fromDate: (d: Date) => ({ toDate: () => d, _seconds: Math.floor(d.getTime() / 1000) })
  }
}));

vi.mock('../../src/services/firebase/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/firebase/config')>();
  return {
    ...actual,
    db: {},
    auth: { currentUser: { uid: 'org_1', email: 'org@example.com' } }
  };
});

import {
  listPublishedHackathons,
  normalizeHackathonDoc,
  runHackathonsDiagnostics,
  saveHackathon
} from '../../src/services/firebase/firestoreService';

function buildDraftInput(overrides: Partial<Omit<Hackathon, 'createdAt' | 'updatedAt'>> = {}) {
  return {
    id: 'hack_m5xyz_123456',
    organizerId: 'org_1',
    organizerName: '   ',
    title: 'Global AI Agents Cup',
    tagline: 'Edge + Cloud Builders',
    description: 'Build production AI workflows with transparent judging.',
    coverImageUrl: '',
    startDate: '2026-12-10',
    endDate: '2026-12-12',
    registrationDeadline: '2026-12-09',
    submissionDeadline: '2026-12-12T18:00',
    mode: 'online' as const,
    location: 'Remote',
    tracks: ['AI Agents', 'Developer Tools'],
    technologies: ['TypeScript', 'Firebase'],
    eligibility: 'Open globally',
    rules: 'Original code only.',
    prizes: ['$10,000'],
    sponsors: [],
    rubric: [],
    maxTeamSize: 4,
    status: 'draft' as const,
    resultsPublished: false,
    ...overrides
  };
}

describe('Organizer Publishing Lifecycle, Doc Normalization & Diagnostics (Mocked Unit Tests)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetDoc.mockResolvedValue(undefined);
    mockUpdateDoc.mockResolvedValue(undefined);
  });

  it('creates a draft hackathon with organizerName fallback and transitions draft -> published via updateDoc', async () => {
    const draft = buildDraftInput();
    await saveHackathon(draft, true);

    expect(mockSetDoc).toHaveBeenCalledWith(
      expect.objectContaining({ col: 'hackathons', id: 'hack_m5xyz_123456' }),
      expect.objectContaining({
        id: 'hack_m5xyz_123456',
        organizerId: 'org_1',
        organizerName: 'Organizer',
        status: 'draft',
        resultsPublished: false,
        createdAt: 'SERVER_TIMESTAMP',
        updatedAt: 'SERVER_TIMESTAMP'
      })
    );

    // Publish the saved draft (must omit immutable id & organizerId on updateDoc)
    await saveHackathon({ ...draft, organizerName: 'Dr. Organizer', status: 'published' }, false);

    expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
    const updatePayload = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
    expect(updatePayload).toMatchObject({
      organizerName: 'Dr. Organizer',
      status: 'published',
      updatedAt: 'SERVER_TIMESTAMP'
    });
    expect(updatePayload).not.toHaveProperty('id');
    expect(updatePayload).not.toHaveProperty('organizerId');
  });

  it('propagates Firestore permission errors cleanly when an unauthorized user tries to publish', async () => {
    mockSetDoc.mockRejectedValueOnce(new Error('Missing or insufficient permissions.'));
    await expect(saveHackathon(buildDraftInput({ status: 'published' }), true)).rejects.toThrow(
      /Missing or insufficient permissions\./
    );
  });

  it('normalizes documents missing id or optional arrays so listPublishedHackathons never collapses Map entries or crashes filters', async () => {
    const normalized = normalizeHackathonDoc('doc_legacy_1', {
      title: 'Legacy Event',
      status: 'published'
    });
    expect(normalized.id).toBe('doc_legacy_1');
    expect(normalized.tracks).toEqual([]);
    expect(normalized.technologies).toEqual([]);
    expect(normalized.mode).toBe('online');

    mockGetDocs
      .mockResolvedValueOnce({
        docs: [
          { id: 'doc_a', data: () => ({ title: 'Event A', status: 'published' }) },
          { id: 'doc_b', data: () => ({ title: 'Event B', status: 'published' }) }
        ]
      })
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce({ docs: [] });

    const events = await listPublishedHackathons();
    expect(events.map((e) => e.id)).toEqual(['doc_a', 'doc_b']);
    expect(events.every((e) => Array.isArray(e.tracks) && Array.isArray(e.technologies))).toBe(true);
  });

  it('runHackathonsDiagnostics aggregates status counts and isolates per-status query errors', async () => {
    mockGetDocs
      .mockResolvedValueOnce({ docs: [{ id: 'p1' }, { id: 'p2' }] })
      .mockRejectedValueOnce(new Error('permission-denied'))
      .mockResolvedValueOnce({ docs: [{ id: 'c1' }] });

    const report = await runHackathonsDiagnostics();
    expect(report.collectionPath).toBe('hackathons');
    expect(report.statusDistribution).toEqual({ published: 2, judging: 0, completed: 1 });
    expect(report.retrievedCount).toBe(3);
    expect(report.queryErrors).toEqual(['status=judging: permission-denied']);
  });
});

describe('Overview Dashboard Statistics Resolution (Unit Tests)', () => {
  it('returns exact counts on fulfilled queries and 0 only when a query succeeds with zero documents', () => {
    const res = resolveOverviewStats({
      publishedHackathons: { status: 'fulfilled', value: [buildDraftInput({ status: 'published' })] },
      organizerHackathons: { status: 'fulfilled', value: [] },
      registrations: { status: 'fulfilled', value: [{ id: 'r1' } as never, { id: 'r2' } as never] },
      teams: { status: 'fulfilled', value: [{ id: 't1' } as never] },
      projects: { status: 'fulfilled', value: [] },
      submissions: { status: 'fulfilled', value: [{ id: 's1' } as never] },
      assignments: { status: 'fulfilled', value: [] },
      publishedResults: { status: 'fulfilled', value: [] }
    });

    expect(res.publishedHackathonsCount).toBe(1);
    expect(res.organizerHackathonsCount).toBe(0);
    expect(res.registrationsCount).toBe(2);
    expect(res.teamsCount).toBe(1);
    expect(res.projectsCount).toBe(0);
    expect(res.submissionsCount).toBe(1);
    expect(res.assignmentsCount).toBe(0);
    expect(res.queryErrors).toEqual([]);
  });

  it('never fakes 0 or masks rejected queries; sets failed counts to null and captures queryErrors', () => {
    const res = resolveOverviewStats({
      publishedHackathons: { status: 'rejected', reason: new Error('Missing or insufficient permissions.') },
      organizerHackathons: { status: 'fulfilled', value: [] },
      registrations: { status: 'rejected', reason: new Error('network timeout') },
      teams: { status: 'fulfilled', value: [{ id: 't1' } as never] },
      projects: { status: 'fulfilled', value: [] },
      submissions: { status: 'fulfilled', value: [] },
      assignments: { status: 'rejected', reason: 'unavailable' },
      publishedResults: { status: 'fulfilled', value: [] }
    });

    expect(res.publishedHackathonsCount).toBeNull();
    expect(res.registrationsCount).toBeNull();
    expect(res.assignmentsCount).toBeNull();
    expect(res.organizerHackathonsCount).toBe(0);
    expect(res.teamsCount).toBe(1);
    expect(res.queryErrors).toHaveLength(3);
    expect(res.queryErrors.map((e) => e.key)).toEqual([
      'publishedHackathons',
      'registrations',
      'assignments'
    ]);
    expect(res.queryErrors[0].message).toContain('Missing or insufficient permissions.');
  });
});
