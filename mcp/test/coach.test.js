// The study coach on the committed sample library, without a server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library } from '../src/library.js';
import { StudyCoach } from '../src/study.js';

test('a quiz on a page without highlights says so, instead of "no highlights at all"', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnote-coach-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(fileURLToPath(new URL('../sample/library', import.meta.url)), dir, { recursive: true });
  const coach = new StudyCoach(new Library(dir));
  const empty = coach.quiz({ page: 'exam' });
  assert.equal(empty.available, false);
  assert.match(empty.speech, /^"Exam checklist" has no highlights yet/);
  assert.equal(coach.quiz({ page: 'Pricing models' }).available, true);
});
