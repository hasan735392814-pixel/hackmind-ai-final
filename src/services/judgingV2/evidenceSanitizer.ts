import type { ProjectSubmission } from '../../types/domain';
import type { SanitizedSubmissionWithoutVideo } from './types';

const VIDEO_HOST_OR_EXT_REGEX =
  /https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|vimeo\.com|loom\.com|dailymotion\.com|twitch\.tv|drive\.google\.com\/file)[^\s)"']*|https?:\/\/[^\s)"']+\.(?:mp4|mov|webm|mkv|avi)(?:\?[^\s)"']*)?/gi;

export function stripVideoUrlsFromText(text: string): string {
  if (!text) return '';
  return text
    .replace(VIDEO_HOST_OR_EXT_REGEX, '[video-link-excluded-from-judging]')
    .trim();
}

/**
 * Completely excludes demo videos from judging.
 * Strips submission.videoUrl and removes any embedded video links from text descriptions.
 */
export function sanitizeSubmissionWithoutVideo(
  submission: ProjectSubmission
): SanitizedSubmissionWithoutVideo {
  return {
    id: submission.id,
    hackathonId: submission.hackathonId,
    organizerId: submission.organizerId,
    teamId: submission.teamId,
    teamName: submission.teamName || '',
    projectId: submission.projectId,
    ownerId: submission.ownerId,
    memberIds: Array.isArray(submission.memberIds) ? [...submission.memberIds] : [],
    memberNames: Array.isArray(submission.memberNames) ? [...submission.memberNames] : [],
    title: stripVideoUrlsFromText(submission.title || ''),
    shortDescription: stripVideoUrlsFromText(submission.shortDescription || ''),
    fullDescription: stripVideoUrlsFromText(submission.fullDescription || ''),
    problemStatement: stripVideoUrlsFromText(submission.problemStatement || ''),
    proposedSolution: stripVideoUrlsFromText(submission.proposedSolution || ''),
    technologies: Array.isArray(submission.technologies) ? [...submission.technologies] : [],
    githubUrl: (submission.githubUrl || '').trim(),
    demoUrl: (submission.demoUrl || '').trim(),
    track: (submission.track || '').trim(),
    status: submission.status,
    submittedAt: submission.submittedAt,
    videoExcluded: true
  };
}

/**
 * Verification helper confirming no videoUrl key or unredacted video link appears in judging payloads.
 */
export function containsVideoJudgingReference(payload: unknown): boolean {
  if (payload == null) return false;
  if (typeof payload === 'string') {
    VIDEO_HOST_OR_EXT_REGEX.lastIndex = 0;
    return VIDEO_HOST_OR_EXT_REGEX.test(payload);
  }
  if (Array.isArray(payload)) {
    return payload.some((item) => containsVideoJudgingReference(item));
  }
  if (typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if ('videoUrl' in obj || 'videoTranscript' in obj || 'videoEvidence' in obj) {
      return true;
    }
    return Object.values(obj).some((val) => containsVideoJudgingReference(val));
  }
  return false;
}
