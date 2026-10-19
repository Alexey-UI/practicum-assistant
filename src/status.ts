import { readdir } from 'node:fs/promises';
import type { Lesson } from './catalog.js';
import { readJson, atomicJson } from './store.js';
import { loadProjects } from './projects.js';

async function countFiles(dir: string): Promise<number> {
  try { return (await readdir(dir)).filter(name => name.endsWith('.json')).length; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
}

export async function status(): Promise<void> {
  const lessons = await readJson<Lesson[]>('.local/catalog.json', []);
  const index = await readJson<{ complete: boolean; updatedAt?: string }>('.local/catalog-index.json', { complete: false });
  const completed = await readJson<Record<string, string>>('.local/completed.json', {});
  const courses = [...new Set(lessons.map(lesson => lesson.course))].map(course => {
    const rows = lessons.filter(lesson => lesson.course === course);
    return { course, lessons: rows.length, solved: rows.filter(lesson => lesson.solved || completed[lesson.url]).length, locked: rows.filter(lesson => lesson.locked).length };
  });
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
    const submission = await readJson<{ phase: string } | null>(`.local/submissions/${project.id}.json`, null);
    if (submission?.phase === 'complete' || completed[project.lessonUrl] || lessons.some(lesson => lesson.url === project.lessonUrl && lesson.solved)) acceptedProjects++;
  }
  const result = {
    catalogComplete: index.complete, catalogUpdatedAt: index.updatedAt, courses,
    lessons: lessons.length, solved: courses.reduce((sum, course) => sum + course.solved, 0),
    locked: courses.reduce((sum, course) => sum + course.locked, 0),
    verifiedTextQuestions: await countFiles('data/text-questions'),
    verifiedTrainerTasks: await countFiles('data/trainers'), verifiedMatchingTasks: await countFiles('data/matching'),
    referenceProjects: projects.length, acceptedProjects, preparedManualProjects, selfCheckedProjects,
    deferredLessons: Object.keys(await readJson<Record<string, unknown>>('.local/deferred-lessons.json', {})).filter(url => !completed[url] && !lessons.some(lesson => lesson.url === url && lesson.solved)).length,
  };
  await atomicJson('.local/status.json', result);
  console.log(JSON.stringify(result, null, 2));
}
