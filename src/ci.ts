import type { Project } from './projects.js';

// These are Git blob IDs of the files inspected when the upstream incompatibility
// was reproduced. A changed workflow or checker requires a new investigation.
export const closingChecker = {
  sourceCommit: '344f41e2f5e233cdbe3296a4684a0a4fcb712669',
  workflow: 'eb0632d445653e81c2acc95e35351211b2fb8617',
  tests: '75ff45368cfeb5b49aba417e6b764262c17c5c7c',
  dependencies: '639e8768d2ac2e819f3046d249004cd3f97aa336',
  message: 'Ошибка во время выполнения тестов: Убедитесь, что страница не перезагружается при взаимодействии с кнопками: Сохранить на память, ОК.',
} as const;

export interface PublishedProject {
  commit: string;
  destination: string;
  destinationCommit: string;
  verifiedAt?: string;
  checks?: Project['checks'];
}

export function closingReferenceVerified(project: Project, commit: string, published: PublishedProject | null): boolean {
  const check = [{ program: 'node', args: ['--import', 'tsx', '../../scripts/check-closing.ts', '.'] }];
  return project.id === 'zakrivayuschiy-teg-ad'
    && project.source === 'Alexey-UI/practicum-frontend-solutions'
    && project.sourcePath === 'projects/zakrivayuschiy-teg-ad'
    && project.commit === closingChecker.sourceCommit
    && !!published?.verifiedAt && Number.isFinite(Date.parse(published.verifiedAt))
    && published.commit === project.commit && published.destination === project.destination
    && published.destinationCommit === commit
    && JSON.stringify(published.checks) === JSON.stringify(check)
    && JSON.stringify(project.checks) === JSON.stringify(check);
}

export function knownClosingCheckerFailure(log: string, versions: { workflow: string; tests: string; dependencies: string }): boolean {
  if (versions.workflow !== closingChecker.workflow || versions.tests !== closingChecker.tests || versions.dependencies !== closingChecker.dependencies) return false;
  const plain = log.replace(/(?:\u001b|\^\[)\[[0-9;]*m/g, '');
  const errors = [...plain.matchAll(/(?:^|\s)(\d+)\.\s+([^\r\n]+)/gm)];
  return errors.length === 1 && errors[0][1] === '1' && errors[0][2].trim() === closingChecker.message
    && plain.includes('start testing') && plain.includes('Тесты завершились с ошибкой');
}
