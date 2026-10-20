// Loose text matching for things people say rather than type exactly: page titles, notebook
// names and quiz answers.

export const STOPWORDS = new Set(('a an and are as at be been but by can did do does for from had has have he her his how i if in ' +
  'into is it its me my no not of on or our she so than that the their them then there these they this those to too up us ' +
  'was we were what when where which who why will with you your about after again all also any because before being both ' +
  'each few more most other over same some such only own just very once under until while off out down here').split(' '));

// Words people add when they name a page ("my page about pricing").
const FILLER = new Set(['page', 'pages', 'note', 'notes', 'notebook', 'notebooks', 'section', 'called', 'titled', 'named', 'read', 'open', 'show']);

/** Lower case, no accents, no punctuation, single spaces. */
export function norm(s) {
  return String(s ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** The words of a search worth looking for. */
export function contentWords(s) {
  return [...new Set(String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2 && !STOPWORDS.has(w) && !FILLER.has(w)))];
}

const stemOf = w => w.slice(0, Math.max(4, w.length - 3));

/** 0-100: how well `query` names `target`. */
export function matchScore(query, target) {
  const q = norm(query), t = norm(target);
  if (!q || !t) return 0;
  if (q === t) return 100;
  if (t.startsWith(q)) return 85;
  if (t.includes(q)) return 75;
  if (t.length >= 4 && ` ${q} `.includes(` ${t} `)) return 70;
  const qw = q.split(' ').filter(w => !STOPWORDS.has(w) && !FILLER.has(w));
  const tw = t.split(' ');
  if (!qw.length) return 0;
  let hit = 0;
  for (const w of qw) {
    if (tw.includes(w)) hit++;
    else if (w.length >= 4 && tw.some(x => x.length >= 4 && (x.startsWith(stemOf(w)) || w.startsWith(stemOf(x))))) hit += 0.8;
  }
  return Math.round(60 * hit / qw.length);
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
