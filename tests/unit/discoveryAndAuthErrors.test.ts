import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hackathon } from '../../src/types/domain';
import {
  classifyDiscoveryViewState,
  filterPublishedHackathons
} from '../../src/utils/discoveryUtils';
import { formatFirebaseAuthError } from '../../src/utils/firebaseErrors';

const mockGetDocs = vi.fn();
const mockWhere = vi.fn((field: string, op: string, value: unknown) => ({ field, op, value }));

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  collection: vi.fn((_, path) => path),
  query: vi.fn((col, ...constraints) => ({ col, constraints })),
  where: (field: string, op: string, value: unknown) => mockWhere(field, op, value),
  getDocs: (...args: unknown[]) => mockGetDocs(...args)
}));

vi.mock('../../src/services/firebase/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/firebase/config')>();
  return {
    ...actual,
    db: {}
  };
});

import { listPublishedHackathons } from '../../src/services/firebase/firestoreService';

function makeHackathon(overrides: Partial<Hackathon> = {}): Hackathon {
  return {
    id: 'hack_1',
    organizerId: 'org_1',
    organizerName: 'Organizer One',
    title: 'AI Systems Hackathon',
    tagline: 'Build edge + cloud agents',
    description: 'End-to-end engineering competition.',
    coverImageUrl: '',
    startDate: '2026-12-01',
    endDate: '2026-12-03',
    registrationDeadline: '2026-11-30',
    submissionDeadline: '2026-12-03T18:00',
    mode: 'online',
    location: 'Remote',
    tracks: ['Edge AI', 'DevTools'],
    technologies: ['TypeScript', 'Firebase'],
    eligibility: 'Open',
    rules: 'Original work only.',
    prizes: ['$5,000'],
    sponsors: [],
    rubric: [],
    maxTeamSize: 4,
    status: 'published',
    resultsPublished: false,
    ...overrides
  };
}

describe('Hackathon Discovery Queries, Filters & Empty/Error States (Mocked Unit Tests)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries published, judging, and completed hackathons (never drafts) and returns all matching events', async () => {
    const published = makeHackathon({ id: 'hack_pub', title: 'Published Event', status: 'published' });
    const judging = makeHackathon({ id: 'hack_jdg', title: 'Judging Event', status: 'judging' });
    const completed = makeHackathon({ id: 'hack_cmp', title: 'Completed Event', status: 'completed' });

    mockGetDocs
      .mockResolvedValueOnce({ docs: [{ data: () => published }] })
      .mockResolvedValueOnce({ docs: [{ data: () => judging }] })
      .mockResolvedValueOnce({ docs: [{ data: () => completed }] });

    const list = await listPublishedHackathons();

    expect(mockWhere).toHaveBeenNthCalledWith(1, 'status', '==', 'published');
    expect(mockWhere).toHaveBeenNthCalledWith(2, 'status', '==', 'judging');
    expect(mockWhere).toHaveBeenNthCalledWith(3, 'status', '==', 'completed');
    expect(mockWhere).not.toHaveBeenCalledWith('status', '==', 'draft');
    expect(list.map((h) => h.id)).toEqual(['hack_pub', 'hack_jdg', 'hack_cmp']);
  });

  it('keeps all published hackathons visible under default discovery filters and filters accurately when criteria are applied', () => {
    const h1 = makeHackathon({
      id: 'h1',
      title: 'Edge Vision Cup',
      mode: 'online',
      technologies: ['TypeScript', 'Gemini']
    });
    const h2 = makeHackathon({
      id: 'h2',
      title: 'Civic Bio Sprint',
      mode: 'hybrid',
      tracks: ['Health'],
      technologies: ['Python', 'React']
    });

    const defaultResults = filterPublishedHackathons([h1, h2], {
      searchQuery: '',
      modeFilter: 'all',
      techFilter: 'all'
    });
    expect(defaultResults).toHaveLength(2);

    const byMode = filterPublishedHackathons([h1, h2], {
      searchQuery: '',
      modeFilter: 'hybrid',
      techFilter: 'all'
    });
    expect(byMode.map((h) => h.id)).toEqual(['h2']);

    const byTech = filterPublishedHackathons([h1, h2], {
      searchQuery: '',
      modeFilter: 'all',
      techFilter: 'Gemini'
    });
    expect(byTech.map((h) => h.id)).toEqual(['h1']);

    const byTrack = filterPublishedHackathons([h1, h2], {
      searchQuery: '',
      modeFilter: 'all',
      techFilter: 'all',
      trackFilter: 'Health'
    });
    expect(byTrack.map((h) => h.id)).toEqual(['h2']);

    const byTrackOrTechSearch = filterPublishedHackathons([h1, h2], {
      searchQuery: 'edge ai',
      modeFilter: 'all',
      techFilter: 'all'
    });
    expect(byTrackOrTechSearch.map((h) => h.id)).toEqual(['h1']);

    const bySearchNone = filterPublishedHackathons([h1, h2], {
      searchQuery: 'nonexistent-query-xyz',
      modeFilter: 'all',
      techFilter: 'all'
    });
    expect(bySearchNone).toHaveLength(0);
  });

  it('accurately separates loading, permission_denied, network_failure, invalid_data, zero published hackathons, and filtered-out empty states', () => {
    expect(
      classifyDiscoveryViewState({
        loading: true,
        loadError: '',
        totalPublished: 0,
        filteredCount: 0
      })
    ).toBe('loading');

    expect(
      classifyDiscoveryViewState({
        loading: false,
        loadError: '{"error":"Missing or insufficient permissions."}',
        totalPublished: 0,
        filteredCount: 0
      })
    ).toBe('permission_denied');

    expect(
      classifyDiscoveryViewState({
        loading: false,
        loadError: 'Firestore network error: failed to fetch',
        totalPublished: 0,
        filteredCount: 0
      })
    ).toBe('network_failure');

    expect(
      classifyDiscoveryViewState({
        loading: false,
        loadError: 'Malformed document payload',
        totalPublished: 0,
        filteredCount: 0
      })
    ).toBe('invalid_data');

    expect(
      classifyDiscoveryViewState({
        loading: false,
        loadError: '',
        totalPublished: 0,
        filteredCount: 0
      })
    ).toBe('no_published_hackathons');

    expect(
      classifyDiscoveryViewState({
        loading: false,
        loadError: '',
        totalPublished: 3,
        filteredCount: 0
      })
    ).toBe('filtered_out');

    expect(
      classifyDiscoveryViewState({
        loading: false,
        loadError: '',
        totalPublished: 3,
        filteredCount: 2
      })
    ).toBe('has_results');
  });
});

describe('Google & Firebase Auth Error Formatting (Unit Tests)', () => {
  it('formats auth/unauthorized-domain with the active hostname for EN and AR', () => {
    const err = { code: 'auth/unauthorized-domain', message: 'Firebase: Error (auth/unauthorized-domain).' };
    const en = formatFirebaseAuthError(err, 'en', {
      currentHostname: 'ais-dev-example.europe-west1.run.app'
    });
    const ar = formatFirebaseAuthError(err, 'ar', {
      currentHostname: 'ais-dev-example.europe-west1.run.app'
    });

    expect(en).toContain('ais-dev-example.europe-west1.run.app');
    expect(en).toContain('Authorized domains');
    expect(ar).toContain('ais-dev-example.europe-west1.run.app');
    expect(ar).toContain('Authorized domains');
  });

  it('formats auth/popup-blocked, auth/operation-not-allowed, and auth/account-exists-with-different-credential', () => {
    const popupBlocked = formatFirebaseAuthError({ code: 'auth/popup-blocked' }, 'en');
    expect(popupBlocked.toLowerCase()).toContain('popup');
    expect(popupBlocked.toLowerCase()).toContain('blocked');

    const opNotAllowed = formatFirebaseAuthError({ code: 'auth/operation-not-allowed' }, 'en');
    expect(opNotAllowed).toContain('Sign-in method');
    expect(opNotAllowed).toContain('Google');

    const accountConflict = formatFirebaseAuthError(
      { code: 'auth/account-exists-with-different-credential' },
      'en'
    );
    expect(accountConflict).toContain('Email & Password');

    const accountConflictAr = formatFirebaseAuthError(
      { code: 'auth/account-exists-with-different-credential' },
      'ar'
    );
    expect(accountConflictAr).toContain('البريد');
  });
});
