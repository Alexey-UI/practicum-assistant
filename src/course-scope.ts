/** Additional modules remain in the catalog and solution bank, but are opt-in. */
export function courseInScope(course: string, includeAdditionalModules: boolean): boolean {
  return includeAdditionalModules || !/^Дополнительный\s+модуль(?:\.|\s|$)/iu.test(course.normalize('NFKC').trim());
}
