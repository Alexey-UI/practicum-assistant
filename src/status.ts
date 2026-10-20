import { readdir } from 'node:fs/promises';
import type { Lesson } from './catalog.js';
import { readJson, atomicJson } from './store.js';
import { loadProjects } from './projects.js';
import { loadConfig } from './config.js';
import { courseInScope } from './course-scope.js';
import { hasProjectAcceptance, type Submission } from './project-acceptance.js';

async function countFiles(dir: string): Promise<number> {
  try { return (await readdir(dir)).filter(name => name.endsWith('.json')).length; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
}

async function countPendingChecks(directory: string): Promise<number> {
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  const states = await Promise.all(names.filter(name => name.endsWith('.json')).map(name => readJson<{ phase?: string } | null>(`${directory}/${name}`, null)));
  return states.filter(state => state?.phase === 'requested').length;
}

export async function status(): Promise<void> {
  const cfg = await loadConfig();
  const lessons = await readJson<Lesson[]>('.local/catalog.json', []);
  const index = await readJson<{ complete: boolean; updatedAt?: string }>('.local/catalog-index.json', { complete: false });
  const completed = await readJson<Record<string, string>>('.local/completed.json', {});
  const courses = [...new Set(lessons.map(lesson => lesson.course))].map(course => {
    const rows = lessons.filter(lesson => lesson.course === course);
    return { course, excluded: !courseInScope(course, cfg.includeAdditionalModules), lessons: rows.length, solved: rows.filter(lesson => lesson.solved || completed[lesson.url]).length, locked: rows.filter(lesson => lesson.locked).length };
  });
  const included = courses.filter(course => !course.excluded);
  const excluded = courses.filter(course => course.excluded);
  const projects = await loadProjects();
  let acceptedProjects = 0;
  let preparedManualProjects = 0;
  let selfCheckedProjects = 0;
  for (const project of projects) {
    if (project.review === 'self') {
      const record = await readJson<{ phase: string } | null>(`.local/hand-ins/${project.id}.json`, null);
      if (record?.phase === 'self-checked') selfCheckedProjects++;
      continue;
    }
    if (project.review === 'teacher') {
      const draft = await readJson<{ phase: string } | null>(`.local/hand-ins/${project.id}.json`, null);
      if (draft?.phase === 'draft') preparedManualProjects++;
      continue;
    }
    const submission = await readJson<Submission | null>(`.local/submissions/${project.id}.json`, null);
    if (hasProjectAcceptance(submission, project.lessonUrl)) acceptedProjects++;
  }
  const result = {
    catalogComplete: index.complete, catalogUpdatedAt: index.updatedAt, courses,
    lessons: included.reduce((sum, course) => sum + course.lessons, 0), solved: included.reduce((sum, course) => sum + course.solved, 0),
    catalogLessons: lessons.length, excludedLessons: excluded.reduce((sum, course) => sum + course.lessons, 0),
    excludedSolved: excluded.reduce((sum, course) => sum + course.solved, 0),
    locked: included.reduce((sum, course) => sum + course.locked, 0),
    verifiedTextQuestions: await countFiles('data/text-questions'),
    verifiedInlineExercises: await countFiles('data/inline'), auditedInlineLessons: await countFiles('.local/inline-audits'),
    verifiedTrainerTasks: await countFiles('data/trainers'), verifiedMatchingTasks: await countFiles('data/matching'),
    optionalTrainerTasks: await countFiles('data/trainer-optional'),
    pendingTrainerChecks: await countPendingChecks('.local/trainers'), pendingInlineChecks: await countPendingChecks('.local/inline'),
    selfCheckedPracticeTasks: await countFiles('data/practice'),
    referenceProjects: projects.length, acceptedProjects, preparedManualProjects, selfCheckedProjects,
    mockApiReferences: projects.filter(project => project.verification === 'mock-api').length,
    deferredLessons: Object.keys(await readJson<Record<string, unknown>>('.local/deferred-lessons.json', {})).filter(url => !completed[url] && !lessons.some(lesson => lesson.url === url && lesson.solved)).length,
    unavailableLessons: Object.keys(await readJson<Record<string, unknown>>('.local/unavailable-lessons.json', {})).filter(url => !completed[url] && !lessons.some(lesson => lesson.url === url && lesson.solved)).length,
  };
  await atomicJson('.local/status.json', result);
  console.log(JSON.stringify(result, null, 2));
}
