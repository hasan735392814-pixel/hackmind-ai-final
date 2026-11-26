import type { Team, UserProfile } from '../../types/domain';

export interface TeammateMatchRecommendation {
  candidate: UserProfile;
  score: number;
  reasons: string[];
  complementarySkills: string[];
}

export function computeFairTeammateMatches(
  currentUser: UserProfile,
  candidates: UserProfile[],
  team?: Team | null
): TeammateMatchRecommendation[] {
  const mySkills = new Set((currentUser.skills || []).map((s) => s.toLowerCase()));
  const myInterests = new Set((currentUser.interests || []).map((s) => s.toLowerCase()));
  const myRoles = new Set((currentUser.preferredRoles || []).map((s) => s.toLowerCase()));
  const neededRoles = new Set((team?.lookingForRoles || []).map((s) => s.toLowerCase()));
  const existingTeamMembers = new Set(team?.memberIds || []);

  const results: TeammateMatchRecommendation[] = [];

  for (const candidate of candidates) {
    if (candidate.uid === currentUser.uid) continue;
    if (existingTeamMembers.has(candidate.uid)) continue;
    if (candidate.teamPreference === 'solo' || candidate.teamPreference === 'already_have_team') {
      continue;
    }

    let score = 20;
    const reasons: string[] = [];
    const complementarySkills: string[] = [];

    const candSkills = candidate.skills || [];
    const sharedSkills: string[] = [];
    for (const sk of candSkills) {
      if (mySkills.has(sk.toLowerCase())) {
        sharedSkills.push(sk);
      } else {
        complementarySkills.push(sk);
      }
    }

    if (complementarySkills.length > 0) {
      score += Math.min(25, complementarySkills.length * 8);
      reasons.push(`Brings complementary skills: ${complementarySkills.slice(0, 3).join(', ')}`);
    }
    if (sharedSkills.length > 0) {
      score += Math.min(15, sharedSkills.length * 5);
      reasons.push(`Shared technical stack: ${sharedSkills.slice(0, 3).join(', ')}`);
    }

    // Role complementarity or team role match
    const candRoles = candidate.preferredRoles || [];
    const matchedNeededRole = candRoles.find((r) => neededRoles.has(r.toLowerCase()));
    const distinctRole = candRoles.find((r) => !myRoles.has(r.toLowerCase()));

    if (matchedNeededRole) {
      score += 25;
      reasons.push(`Matches open team role: ${matchedNeededRole}`);
    } else if (distinctRole) {
      score += 15;
      reasons.push(`Covers distinct role: ${distinctRole}`);
    }

    // Shared domain interests
    const sharedInterests = (candidate.interests || []).filter((i) =>
      myInterests.has(i.toLowerCase())
    );
    if (sharedInterests.length > 0) {
      score += Math.min(15, sharedInterests.length * 6);
      reasons.push(`Aligned interests: ${sharedInterests.slice(0, 2).join(', ')}`);
    }

    // Availability alignment
    if (candidate.availability === currentUser.availability) {
      score += 10;
      reasons.push(`Matching availability (${candidate.availability.replace('_', ' ')})`);
    }

    // Preferred language overlap
    const sharedLangs = (candidate.preferredLanguages || []).filter((l) =>
      (currentUser.preferredLanguages || []).some((m) => m.toLowerCase() === l.toLowerCase())
    );
    if (sharedLangs.length > 0) {
      score += 5;
      reasons.push(`Common language: ${sharedLangs[0]}`);
    }

    results.push({
      candidate,
      score: Math.min(100, score),
      reasons: reasons.length > 0 ? reasons : ['Available for team formation'],
      complementarySkills: complementarySkills.slice(0, 5)
    });
  }

  return results.sort((a, b) => b.score - a.score);
}
