/** Additional modules remain in the catalog and solution bank, but are opt-in. */
export function courseInScope(course: string, includeAdditionalModules: boolean): boolean {
  return includeAdditionalModules || !/^Дополнительный\s+модуль(?:\.|\s|$)/iu.test(course.normalize('NFKC').trim());
}

/** Keep catalog order; an exact title wins over partial title matches. */
export function throughCourse<T extends { course: string }>(lessons: T[], title?: string): T[] {
  if (title === undefined) return lessons;
  const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru');
  const query = normalize(title);
  if (!query) throw new Error('Для --until-course нужно название конечного модуля');
  const courses = [...new Set(lessons.map(lesson => lesson.course))];
  const exact = courses.filter(course => normalize(course) === query);
  const matches = exact.length ? exact : courses.filter(course => normalize(course).includes(query));
  if (matches.length !== 1) throw new Error(matches.length
    ? `Неоднозначный --until-course. Уточните название: ${matches.join('; ')}`
    : `Модуль --until-course не найден среди выбранных модулей. Доступны: ${courses.join('; ')}`);
  const allowed = new Set(courses.slice(0, courses.indexOf(matches[0]) + 1));
  return lessons.filter(lesson => allowed.has(lesson.course));
}

export function untilCourseArgument(args: string[]): string | undefined {
  const occurrences = args.filter(arg => arg === '--until-course' || arg.startsWith('--until-course='));
  if (!occurrences.length) return undefined;
  if (occurrences.length !== 1) throw new Error('--until-course можно передать только один раз');
  const argument = occurrences[0];
  const title = argument === '--until-course' ? args[args.indexOf(argument) + 1] : argument.slice('--until-course='.length);
  if (!title?.trim() || title.startsWith('--')) throw new Error('Для --until-course нужно название конечного модуля');
  if (args.some(arg => ['--course', '--url'].some(flag => arg === flag || arg.startsWith(`${flag}=`)))) throw new Error('--until-course нельзя совмещать с --course или --url');
  return title;
}
