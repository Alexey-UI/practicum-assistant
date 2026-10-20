export class UnexpectedBrowserClosure extends Error {
  constructor(readonly url: string | undefined, cause: unknown) {
    super('Браузер неожиданно закрылся; состояние проверок сохранено.', { cause });
    this.name = 'UnexpectedBrowserClosure';
  }
}

export async function withBrowserRecovery(operation: () => Promise<void>, onRetry: (error: UnexpectedBrowserClosure, attempt: number) => Promise<void>): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { await operation(); return; }
    catch (error) {
      if (!(error instanceof UnexpectedBrowserClosure) || attempt === 3) throw error;
      await onRetry(error, attempt);
    }
  }
}
