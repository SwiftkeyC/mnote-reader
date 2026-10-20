// The study coach: quizzes you on your own highlights, with spaced repetition (Leitner boxes).
// Progress is kept in mnote-study.json next to your notebooks, so it carries over from one
// conversation (or device) to the next: which cards you got wrong, what is due, your streak.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { findQuote } from './annotations.js';
import { norm, levenshtein, STOPWORDS } from './text.js';

const DAY = 86400000;
// Days until the next review once a card reaches each box (box 0 = never answered right).
const INTERVAL_DAYS = [0, 1, 2, 4, 8, 16];
// A missed card comes back a few minutes later, so it is asked again in the same session.
const RETRY_MS = 3 * 60 * 1000;
const MASTERED_BOX = 4;
const BLANK = '_____';

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 3).trimEnd() + '...' : s);
const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();

function emptyState() {
  return { format: 'mnote-study', version: 1, updated: null, cards: {}, pending: {}, days: {}, lastCard: null };
}

// ---------------------------------------------------------------- questions

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/** Words of a passage worth blanking out, best first. */
function keyTerms(quote, title, note) {
  const titleWords = new Set(norm(title).split(' '));
  const noteWords = new Set(norm(note).split(' '));
  const terms = new Map();
  for (const m of quote.matchAll(WORD)) {
    const w = m[0].replace(/['’-]+$/, '');
    const n = norm(w);
    if (!n || STOPWORDS.has(n) || terms.has(n)) continue;
    const digits = /\p{N}/u.test(w);
    const acronym = /\p{Lu}.*\p{Lu}/u.test(w);
    const proper = /^\p{Lu}/u.test(w) && m.index > 0 && !/[.!?:]\s*$/.test(quote.slice(0, m.index));
    if (n.length < 4 && !(digits && n.length >= 2) && !acronym) continue;
    const score = Math.min(n.length, 12) * 0.35 + (digits ? 3 : 0) + (acronym ? 2.5 : 0) + (proper ? 1 : 0)
      + (w.includes('-') ? 1.5 : 0) + (noteWords.has(n) ? 2 : 0) - (titleWords.has(n) ? 2.5 : 0);
    terms.set(n, { word: w, score });
  }
  return [...terms.values()].sort((a, b) => b.score - a.score);
}

/** The line of the page text that holds the passage, without its bullet or number. */
function contextLine(pageText, quote) {
  for (const raw of pageText.split(/\r?\n/)) {
    const line = raw.trim().replace(/^(•|\d+\.|\[[ xX]\])\s*/, '');
    if (line && findQuote(line, quote)) return line;
  }
  return null;
}

function blankWord(text, word) {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'giu'), BLANK);
}

function hintFor(answer) {
  const words = answer.trim().split(/\s+/);
  const first = answer.trim()[0].toUpperCase();
  if (words.length > 1) return `${words.length} words, starting with "${first}"`;
  const n = answer.replace(/[^\p{L}\p{N}]/gu, '').length;
  if (/^\p{N}+$/u.test(answer)) return `a number with ${n} digit${n === 1 ? '' : 's'}`;
  return `starts with "${first}", ${n} letter${n === 1 ? '' : 's'}`;
}

/**
 * A fill-in-the-blank question from one highlight. Short highlights (a term) are blanked in the
 * line around them; longer ones lose their most telling word, a different one each time.
 */
export function makeQuestion(page, h, attempt = 0) {
  const quote = oneLine(h.quote);
  const words = quote.match(WORD) || [];
  if (words.length <= 4) {
    const line = contextLine(page.text, quote);
    const at = line && findQuote(line, quote);
    if (at && (line.slice(0, at[0]) + line.slice(at[1])).match(WORD)?.length >= 3) {
      const answer = line.slice(at[0], at[1]).trim();
      return { kind: 'term', question: oneLine(line.slice(0, at[0]) + BLANK + line.slice(at[1])), answer, hint: hintFor(answer) };
    }
    const around = oneLine(`${h.prefix || ''} ${BLANK} ${h.suffix || ''}`);
    if ((around.match(WORD) || []).length >= 3) return { kind: 'term', question: around, answer: quote, hint: hintFor(quote) };
  }
  const terms = keyTerms(quote, page.title, h.note);
  if (terms.length) {
    const pick = terms[attempt % Math.min(3, terms.length)];
    return { kind: 'cloze', question: blankWord(quote, pick.word), answer: pick.word, hint: hintFor(pick.word) };
  }
  return {
    kind: 'recall',
    question: h.note?.trim() ? `Your note on this page says "${oneLine(h.note)}". Which passage did you highlight with it?` : 'Which passage did you highlight on this page?',
    answer: quote, hint: `it starts with "${words.slice(0, 2).join(' ')}"`,
  };
}

// ---------------------------------------------------------------- grading

const NUMBERS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 };
const normAnswer = s => norm(s).split(' ').map(w => (w in NUMBERS ? String(NUMBERS[w]) : w)).join(' ');
const singular = s => s.split(' ').map(w => (w.length > 3 ? w.replace(/(ies)$/, 'y').replace(/(?<!s)(es|s)$/, '') : w)).join(' ');
const GIVE_UP = /^(i dont know|dont know|no idea|not sure|skip|pass|idk|no clue|i give up|give up|tell me)$/;

/**
 * Is a typed or spoken answer right? Forgiving about case, plurals, a typo or two (or a speech
 * recognition slip) and extra words around the answer ("I think it's spot pricing").
 */
export function grade(answer, expected, kind) {
  const a = normAnswer(answer), e = normAnswer(expected);
  if (!a || GIVE_UP.test(a)) return { correct: false, skipped: true };
  if (a === e || singular(a) === singular(e)) return { correct: true, close: false };
  if (` ${singular(a)} `.includes(` ${singular(e)} `)) return { correct: true, close: false };
  const target = e.replace(/ /g, '');
  const tol = target.length <= 4 ? 0 : target.length <= 8 ? 1 : 2;
  const aw = a.split(' '), n = e.split(' ').length;
  for (let size = Math.max(1, n - 1); size <= n + 1; size++) {
    for (let i = 0; i + size <= aw.length; i++) {
      if (levenshtein(aw.slice(i, i + size).join(''), target) <= tol) return { correct: true, close: true };
    }
  }
  if (kind === 'recall') {
    const want = e.split(' ').filter(w => !STOPWORDS.has(w));
    const got = new Set(a.split(' '));
    if (want.length && want.filter(w => got.has(w)).length / want.length >= 0.6) return { correct: true, close: true };
  }
  return { correct: false, skipped: false };
}

// ---------------------------------------------------------------- the coach

export class StudyCoach {
  constructor(library) { this.lib = library; }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.lib.studyFile, 'utf8'));
      if (s && s.format === 'mnote-study') return Object.assign(emptyState(), s);
    } catch { /* no progress yet */ }
    return emptyState();
  }

  save(s) {
    s.updated = new Date().toISOString();
    const file = this.lib.studyFile, tmp = file + '.saving';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, file);
  }

  /** Every highlight in scope, as a card. */
  cards(scope = {}) {
    let pages;
    if (scope.page) {
      const r = this.lib.resolvePage(scope.page, scope);
      if (!r.page) throw new Error(r.candidates.length ? `Which page? ${r.candidates.map(p => `"${p.title}"`).join(', ')}` : `There is no page called "${scope.page}".`);
      pages = [r.page];
    } else pages = this.lib.scope(scope);
    const out = [];
    for (const p of pages) {
      for (const h of this.lib.annotations(p).highlights) {
        if (oneLine(h.quote).length < 3) continue;
        out.push({ key: `${p.id || p.path}#${h.id || norm(h.quote).slice(0, 40)}`, page: p, h });
      }
    }
    return out;
  }

  /** Which card to ask next: missed cards first, then the rest that are due, then new ones. */
  pick(cards, s, focus) {
    const now = Date.now();
    const info = c => s.cards[c.key];
    const dueAt = c => Date.parse(info(c).due) || 0;
    const missed = c => (info(c).lastResult === 'wrong' ? 1 : 0);
    const seen = cards.filter(info), fresh = cards.filter(c => !info(c));
    const due = seen.filter(c => dueAt(c) <= now).sort((a, b) => missed(b) - missed(a) || dueAt(a) - dueAt(b));
    let list;
    if (focus === 'mistakes') list = seen.filter(c => info(c).wrong > 0).sort((a, b) => missed(b) - missed(a) || info(b).wrong - info(a).wrong || dueAt(a) - dueAt(b));
    else if (focus === 'new') list = fresh;
    else list = [...due, ...fresh];
    let caughtUp = false;
    if (!list.length) { caughtUp = true; list = [...seen].sort((a, b) => dueAt(a) - dueAt(b)); }
    if (list.length > 1 && list[0].key === s.lastCard) list = [list[1], list[0], ...list.slice(2)];
    return { card: list[0] || null, caughtUp, due: due.length, fresh: fresh.length };
  }

  status(c) {
    if (!c) return 'new';
    if (c.lastResult === 'wrong' || c.box <= 2) return 'learning';
    return c.box >= MASTERED_BOX ? 'mastered' : 'reviewing';
  }

  /** The next question, saved as pending so it can be answered in a later request. */
  quiz(scope = {}, focus = 'due') {
    const cards = this.cards(scope);
    if (!cards.length) {
      return {
        available: false,
        speech: 'There are no highlights to quiz you on yet. Highlight key sentences in Mnote Reader, or ask me to add a note on a passage, and I can turn them into questions.',
      };
    }
    const s = this.load();
    const { card, caughtUp, due, fresh } = this.pick(cards, s, focus);
    if (!card) {
      return { available: false, speech: focus === 'mistakes' ? 'You have no missed answers on record. Nice work!' : 'There is nothing new to learn here.' };
    }
    const c = s.cards[card.key];
    const q = makeQuestion(card.page, card.h, c ? c.right + c.wrong : 0);
    const id = 'q-' + randomUUID().slice(0, 8);
    // The scope goes with the question, so answer_quiz asks the next one from the same place.
    const keep = Object.fromEntries(Object.entries({ ...scope, focus }).filter(([, v]) => v));
    s.pending[id] = { card: card.key, path: card.page.path, highlightId: card.h.id, kind: q.kind, answer: q.answer, asked: new Date().toISOString(), scope: keep };
    const ids = Object.keys(s.pending);
    for (const old of ids.slice(0, Math.max(0, ids.length - 30))) delete s.pending[old];
    s.lastCard = card.key;
    this.save(s);
    // "_____: growing and shrinking with demand." reads better aloud as a question.
    const definition = q.kind === 'term' && q.question.startsWith(BLANK + ':') && !q.question.slice(BLANK.length).includes(BLANK);
    let spoken = definition ? `Which term means: ${q.question.slice(BLANK.length + 1).trim().replace(/[.!?]$/, '')}?` : q.question.replace(new RegExp(BLANK, 'g'), 'blank');
    if (!/[.!?]$/.test(spoken)) spoken += '.';
    const lead = c?.lastResult === 'wrong' ? 'Let\'s try one you missed before. ' : caughtUp ? 'You\'re all caught up, so here is a bonus review. ' : '';
    return {
      available: true,
      questionId: id,
      kind: q.kind,
      question: q.question,
      hint: q.hint,
      speech: `${lead}From your page "${card.page.title}": ${spoken}${q.kind === 'recall' || definition ? '' : ' What fills the blank?'}`,
      page: pageRef(card.page),
      card: { status: this.status(c), box: c?.box ?? 0, right: c?.right ?? 0, wrong: c?.wrong ?? 0 },
      remaining: { due, new: fresh },
      caughtUp,
    };
  }

  /** Checks an answer, moves the card between boxes and records the result. */
  answer(questionId, answer, judgedCorrect) {
    const s = this.load();
    const q = s.pending[questionId];
    if (!q) throw new Error('That question has expired or was already answered. Call quiz_me for a new one.');
    delete s.pending[questionId];
    const g = grade(answer, q.answer, q.kind);
    const correct = typeof judgedCorrect === 'boolean' ? judgedCorrect : g.correct;
    const now = new Date();
    const c = s.cards[q.card] || (s.cards[q.card] = { box: 0, right: 0, wrong: 0 });
    // A bonus review before the card is due (when everything is caught up) doesn't move it on.
    const early = correct && c.lastResult === 'right' && Date.parse(c.due) > now.getTime();
    if (early) c.right++;
    else if (correct) {
      c.box = Math.min(5, (c.box || 0) + 1);
      c.right++;
      c.due = new Date(now.getTime() + INTERVAL_DAYS[c.box] * DAY).toISOString();
    } else {
      c.box = 1;
      c.wrong++;
      c.due = new Date(now.getTime() + RETRY_MS).toISOString();
      c.lastWrongAnswer = String(answer || '');
    }
    c.lastResult = correct ? 'right' : 'wrong';
    c.last = now.toISOString();
    const day = (s.days[localDay(now)] ||= { right: 0, wrong: 0 });
    day[correct ? 'right' : 'wrong']++;
    this.save(s);

    const page = this.lib.snapshot().pages.find(p => p.path === q.path);
    const h = page && this.lib.annotations(page).highlights.find(x => x.id === q.highlightId);
    const passage = h ? oneLine(h.quote) : '';
    const days = Math.max(1, Math.round((Date.parse(c.due) - now.getTime()) / DAY));
    const next = correct ? `Next review in ${days} day${days === 1 ? '' : 's'}.` : 'I\'ll ask it again soon.';
    let speech;
    if (correct) speech = `${g.close && typeof judgedCorrect !== 'boolean' ? 'Close enough, ' : 'Correct! '}It's "${q.answer}". ${next}`;
    else if (g.skipped) speech = `The answer is "${q.answer}". ${next}`;
    else speech = `Not quite: it's "${q.answer}"${c.wrong > 1 ? `, and that's ${c.wrong} misses on this one` : ''}. ${next}`;
    if (!correct && passage && q.kind !== 'recall') speech += ` The passage reads: "${clip(passage, 200)}".`;
    return {
      correct,
      close: !!g.close,
      skipped: !!g.skipped,
      expected: q.answer,
      yourAnswer: String(answer || ''),
      passage,
      note: h?.note || '',
      page: page ? pageRef(page) : { path: q.path, title: '', notebook: '', section: '', pageNumber: 0 },
      card: { status: this.status(c), box: c.box, right: c.right, wrong: c.wrong, nextReview: c.due },
      today: { right: day.right, wrong: day.wrong },
      speech,
    };
  }

  /** How studying is going: totals, streak, weak spots and what to do next. */
  progress(scope = {}) {
    const cards = this.cards(scope);
    const s = this.load();
    const now = Date.now();
    const counts = { cards: cards.length, new: 0, learning: 0, reviewing: 0, mastered: 0, due: 0 };
    let right = 0, wrong = 0, lastStudied = null;
    const sections = new Map();
    for (const card of cards) {
      const c = s.cards[card.key];
      counts[this.status(c)]++;
      if (c && (Date.parse(c.due) || 0) <= now) counts.due++;
      if (c) { right += c.right; wrong += c.wrong; if (!lastStudied || c.last > lastStudied) lastStudied = c.last; }
      const key = `${card.page.notebook} / ${card.page.location}`;
      const sec = sections.get(key) || { notebook: card.page.notebook, section: card.page.location, cards: 0, right: 0, wrong: 0, mastered: 0 };
      sec.cards++;
      if (c) { sec.right += c.right; sec.wrong += c.wrong; if (this.status(c) === 'mastered') sec.mastered++; }
      sections.set(key, sec);
    }
    const weakSpots = cards.filter(card => s.cards[card.key]?.wrong > 0)
      .sort((a, b) => (s.cards[b.key].lastResult === 'wrong') - (s.cards[a.key].lastResult === 'wrong') || s.cards[b.key].wrong - s.cards[a.key].wrong)
      .slice(0, 5)
      .map(card => ({ passage: clip(oneLine(card.h.quote), 160), page: pageRef(card.page), misses: s.cards[card.key].wrong, right: s.cards[card.key].right, lastResult: s.cards[card.key].lastResult }));
    const bySection = [...sections.values()].map(x => (x.right + x.wrong ? { ...x, accuracy: Math.round(100 * x.right / (x.right + x.wrong)) } : x))
      .sort((a, b) => (a.accuracy ?? 101) - (b.accuracy ?? 101));

    let streak = 0;
    const d = new Date();
    if (!s.days[localDay(d)]) d.setDate(d.getDate() - 1);
    while (s.days[localDay(d)]) { streak++; d.setDate(d.getDate() - 1); }
    const today = s.days[localDay()] || { right: 0, wrong: 0 };
    const accuracy = right + wrong ? Math.round(100 * right / (right + wrong)) : undefined;

    let suggestion;
    if (!cards.length) suggestion = 'Highlight a few key sentences in Mnote Reader, then ask for a quiz.';
    else if (weakSpots[0]?.lastResult === 'wrong') suggestion = `Go over "${weakSpots[0].page.title}" again: you missed "${clip(weakSpots[0].passage, 80)}".`;
    else if (counts.due) suggestion = `${counts.due} card${counts.due === 1 ? ' is' : 's are'} due for review. Say "quiz me" to start.`;
    else if (counts.new) suggestion = `${counts.new} highlight${counts.new === 1 ? ' has' : 's have'} not been quizzed yet.`;
    else suggestion = 'You are all caught up. Come back tomorrow for your next reviews.';

    const parts = [];
    if (today.right + today.wrong) parts.push(`Today you answered ${today.right + today.wrong} question${today.right + today.wrong === 1 ? '' : 's'} and got ${today.right} right.`);
    if (streak > 1) parts.push(`That's a ${streak}-day streak.`);
    if (cards.length) parts.push(`${counts.mastered} of ${cards.length} highlights are mastered${counts.due ? `, ${counts.due} due now` : ''}.`);
    parts.push(suggestion);

    return { ...counts, ...(accuracy != null ? { accuracy } : {}), today, streakDays: streak, ...(lastStudied ? { lastStudied } : {}), weakSpots, bySection, suggestion, speech: parts.join(' ') };
  }
}

export function pageRef(p) {
  return { path: p.path, title: p.title, notebook: p.notebook, section: p.location, pageNumber: p.pageNumber || 0 };
}
