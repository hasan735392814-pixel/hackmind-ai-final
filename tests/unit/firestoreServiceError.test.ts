import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockGetDocs = vi.fn();

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => ({})),
  collection: vi.fn((_, path) => path),
  query: vi.fn((col) => col),
  where: vi.fn(() => ({})),
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

describe('Firestore Service Error Handling & Distinction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an empty array when published hackathons list is empty', async () => {
    mockGetDocs.mockResolvedValueOnce({ docs: [] });
    mockGetDocs.mockResolvedValueOnce({ docs: [] });
    mockGetDocs.mockResolvedValueOnce({ docs: [] });
    const result = await listPublishedHackathons();
    expect(result).toEqual([]);
  });

  it('throws a structured FirestoreErrorInfo error when a permission or index error occurs, distinguishing it from an empty list', async () => {
    mockGetDocs.mockRejectedValueOnce(new Error('Missing or insufficient permissions.'));
    
    let caughtError: unknown;
    try {
      await listPublishedHackathons();
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(Error);
    const parsed = JSON.parse((caughtError as Error).message);
    expect(parsed).toHaveProperty('error');
    expect(parsed).toHaveProperty('operationType', 'list');
    expect(parsed).toHaveProperty('path', 'hackathons');
    expect(parsed.error).toContain('Missing or insufficient permissions.');
  });
});
