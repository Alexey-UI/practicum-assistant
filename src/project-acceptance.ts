import { allowedUrl, lessonId } from './browser.js';

export const PROJECT_ACCEPTED_MESSAGE = 'Задание принято — отличная работа!';
export interface Submission {
  commit: string;
  phase: 'requested' | 'accepted' | 'complete';
  lessonUrl: string;
  updatedAt?: string;
  acceptanceEvidence?: { message: string; observedAt: string; source: string };
}

export function hasProjectAcceptance(state: Submission | null, url: string): boolean {
  return !!state && (state.phase === 'accepted' || state.phase === 'complete')
    && allowedUrl(state.lessonUrl) && allowedUrl(url) && !!lessonId(state.lessonUrl) && lessonId(state.lessonUrl) === lessonId(url)
    && state.acceptanceEvidence?.message === PROJECT_ACCEPTED_MESSAGE
    && Number.isFinite(Date.parse(state.acceptanceEvidence.observedAt)) && !!state.acceptanceEvidence.source;
}
