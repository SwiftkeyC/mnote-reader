// Unit tests for the parts that need no files: grading, questions, and finding passages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grade, makeQuestion } from '../src/study.js';
import { readerText, findQuote, locate, newHighlight } from '../src/annotations.js';
import { matchScore } from '../src/text.js';

test('grading forgives what people type and say', () => {
  assert.equal(grade('Spot', 'Spot').correct, true);
  assert.equal(grade("I think it's spot", 'Spot').correct, true);
  assert.equal(grade('availabilty zones', 'Availability zone').correct, true, 'typo and plural');
  assert.equal(grade('pay as you go', 'pay-as-you-go').correct, true);
  assert.equal(grade('twelve', '12').correct, true, 'spoken number');
  assert.equal(grade('reserved', 'Spot').correct, false);
  assert.equal(grade('TLS', 'SSL').correct, false, 'short answers must be exact');
  assert.deepEqual(grade("I don't know", 'Spot'), { correct: false, skipped: true });
  assert.deepEqual(grade('', 'Spot'), { correct: false, skipped: true });
});

test('questions blank a term in its line, or a key word of a longer passage', () => {
  const page = { title: 'Pricing models', text: 'Four pricing models:\n• Spot: spare capacity at a big discount\n• Reserved: commit for 1 or 3 years, pay less' };
  const term = makeQuestion(page, { quote: 'Spot', note: '' });
  assert.equal(term.kind, 'term');
  assert.equal(term.question, '_____: spare capacity at a big discount');
  assert.equal(term.answer, 'Spot');
  const cloze = makeQuestion({ title: 'Cloud', text: '' }, { quote: 'Cloud computing is the on-demand delivery of IT resources with pay-as-you-go pricing', note: '' });
  assert.equal(cloze.kind, 'cloze');
  assert.equal(cloze.answer, 'pay-as-you-go');
  assert.ok(cloze.question.includes('_____') && !cloze.question.includes('pay-as-you-go'));
  const other = makeQuestion({ title: 'Cloud', text: '' }, { quote: 'Cloud computing is the on-demand delivery of IT resources with pay-as-you-go pricing', note: '' }, 1);
  assert.notEqual(other.answer, cloze.answer, 'a different word the next time');
  assert.doesNotMatch(makeQuestion({ title: 'x', text: '' }, { quote: 'commit for 1 or 3 years, pay less', note: '' }).answer, /^\d$/, 'no single digits');
});

test('page text matches what the reader highlights into', () => {
  const html = '<!DOCTYPE html><html><body><main>\n<div class="crumbs">Nb &rsaquo; Sec</div>\n<h1>Title</h1>\n<div class="meta">Created</div>\n'
    + '<section class="outline"><div class="oe"><div class="line"><span class="marker">•</span>Fish &amp; chips</div></div>'
    + '<div class="oe"><div class="line">Second&nbsp;line</div></div><script>no()</script></section>\n</main></body></html>';
  const text = readerText(html);
  assert.equal(text, '•Fish & chipsSecond line');
  assert.deepEqual(findQuote(text, 'Fish & chips'), [1, 13]);
  // From page.txt, with a bullet, a line break and different case.
  assert.deepEqual(findQuote(text, '• fish & chips\r\n  second line'.replace('second line', 'Second line')), [1, 24]);
  assert.equal(findQuote(text, 'not there'), null);
  const h = newHighlight(text, 1, 13, 'yellow', 'n');
  assert.equal(h.quote, 'Fish & chips');
  assert.deepEqual(locate('Intro. ' + text, h), [8, 20], 'still found when the text shifts');
});

test('page names match loosely', () => {
  assert.equal(matchScore('what is cloud computing', 'What is cloud computing?'), 100);
  assert.ok(matchScore('the regions page', 'Regions and zones') >= 40);
  assert.ok(matchScore('pricing', 'Pricing models') > matchScore('pricing', 'Course plan'));
  assert.equal(matchScore('bananas', 'Regions and zones'), 0);
});
