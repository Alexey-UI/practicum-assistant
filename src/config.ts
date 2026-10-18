import { readJson } from './store.js';
import { START_URL } from './browser.js';

export interface Config {
  startUrl: string;
  continueButtons: string[];
  nextButtons: string[];
  questionSelector: string;
  successSelector: string;
  failureSelector: string;
  submitButtons: string[];
  retryButtons: string[];
  retryableLessons: string[];
  maxSteps: number;
  maxAttempts: number;
  feedbackPolicy: 'defer' | 'neutral';
}
export const DEFAULTS: Config = {
  startUrl: START_URL,
  continueButtons: ['Продолжить', 'Дальше', 'Понятно', 'Поехали', 'Начать урок'],
  nextButtons: ['Следующий урок', 'К следующему уроку'],
  questionSelector: '.quiz',
  successSelector: '[data-testid="quiz-success"]',
  failureSelector: '[data-testid="quiz-error"]',
  submitButtons: ['Проверить', 'Ответить', 'Узнать ответ'], retryButtons: ['Попробовать ещё раз', 'Попробовать еще раз'],
  retryableLessons: [], maxSteps: 500, maxAttempts: 16,
  feedbackPolicy: 'defer',
};
export async function loadConfig(): Promise<Config> {
  const custom = await readJson<Partial<Config>>('practicum.config.json', {});
  const cfg = { ...DEFAULTS, ...custom };
  if (!['defer', 'neutral'].includes(cfg.feedbackPolicy)) throw new Error('Неверный config.feedbackPolicy');
  for (const key of ['continueButtons', 'nextButtons', 'submitButtons', 'retryButtons', 'retryableLessons'] as const) {
    if (!Array.isArray(cfg[key]) || !cfg[key].every(x => typeof x === 'string' && x.trim())) throw new Error(`Неверный config.${key}`);
  }
  for (const key of ['maxSteps', 'maxAttempts'] as const) if (!Number.isInteger(cfg[key]) || cfg[key] < 1) throw new Error(`Неверный config.${key}`);
  return cfg;
}
