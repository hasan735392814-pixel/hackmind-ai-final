import type { Hackathon, HackathonMode } from '../types/domain';

export interface DiscoveryFilterCriteria {
  searchQuery: string;
  modeFilter: 'all' | HackathonMode;
  techFilter: string;
  trackFilter?: string;
}

export type DiscoveryErrorKind = 'permission_denied' | 'network_failure' | 'invalid_data';

export type DiscoveryViewState =
  | 'loading'
  | 'permission_denied'
  | 'network_failure'
  | 'invalid_data'
  | 'no_published_hackathons'
  | 'filtered_out'
  | 'has_results';

export function classifyFirestoreQueryError(errorMessage: string): DiscoveryErrorKind {
  const lower = errorMessage.toLowerCase();
  if (
    lower.includes('permission-denied') ||
    lower.includes('missing or insufficient permissions') ||
    lower.includes('insufficient permissions')
  ) {
    return 'permission_denied';
  }
  if (
    lower.includes('network') ||
    lower.includes('offline') ||
    lower.includes('unavailable') ||
    lower.includes('failed to fetch') ||
    lower.includes('timeout')
  ) {
    return 'network_failure';
  }
  return 'invalid_data';
}

export function filterPublishedHackathons(
  hackathons: Hackathon[],
  criteria: DiscoveryFilterCriteria
): Hackathon[] {
  const normalizedQuery = criteria.searchQuery.trim().toLowerCase();
  const trackFilter = criteria.trackFilter || 'all';

  return hackathons.filter((h) => {
    if (criteria.modeFilter !== 'all' && h.mode !== criteria.modeFilter) {
      return false;
    }
    if (criteria.techFilter !== 'all' && !(h.technologies || []).includes(criteria.techFilter)) {
      return false;
    }
    if (trackFilter !== 'all' && !(h.tracks || []).includes(trackFilter)) {
      return false;
    }
    if (normalizedQuery) {
      const haystack = [
        h.title,
        h.tagline || '',
        h.description || '',
        h.organizerName || '',
        h.location || '',
        ...(h.tracks || []),
        ...(h.technologies || [])
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(normalizedQuery)) {
        return false;
      }
    }
    return true;
  });
}

export function classifyDiscoveryViewState(params: {
  loading: boolean;
  loadError: string | null | undefined;
  totalPublished: number;
  filteredCount: number;
}): DiscoveryViewState {
  if (params.loading) return 'loading';
  if (params.loadError && params.loadError.trim().length > 0) {
    return classifyFirestoreQueryError(params.loadError);
  }
  if (params.totalPublished === 0) return 'no_published_hackathons';
  if (params.filteredCount === 0) return 'filtered_out';
  return 'has_results';
}
