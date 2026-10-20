import type { BrowserContext, Dialog, Page } from 'playwright';
import { isTrainerTaskUrl, lessonId } from './browser.js';
import { readJson } from './store.js';

interface ExercisePrompt { lessonId: string; message: string; response: string }

export async function answerExerciseDialog(dialog: Dialog): Promise<void> {
  const page = dialog.page();
  const url = page?.url();
  if (dialog.type() === 'prompt' && url && isTrainerTaskUrl(url)) {
    const taskId = new URL(url).pathname.match(/\/task\/([^/]+)\//)?.[1];
    const prompts = await readJson<Record<string, ExercisePrompt>>('data/exercise-prompts.json', {});
    const prompt = taskId ? prompts[taskId] : undefined;
    if (prompt && prompt.lessonId === lessonId(url) && prompt.message === dialog.message() && typeof prompt.response === 'string') {
      await dialog.accept(prompt.response);
      return;
    }
  }
  await dialog.dismiss();
}

export function handleExerciseDialogs(context: BrowserContext): void {
  const attach = (page: Page) => {
    page.on('dialog', dialog => { void answerExerciseDialog(dialog).catch(() => dialog.dismiss().catch(() => {})); });
  };
  for (const page of context.pages()) attach(page);
  context.on('page', attach);
}
