// annotations.json, exactly as Mnote Reader reads and writes it (parseAnn, annJson and
// addHighlight in mnote-reader.html), and the page text that highlight offsets point into.
import { parse } from 'parse5';

export const COLORS = ['yellow', 'green', 'blue', 'pink'];

export function parseAnn(raw) {
  let a = {};
  if (raw) { try { a = JSON.parse(raw); } catch { a = {}; } }
  if (!a || typeof a !== 'object') a = {};
  return {
    bookmark: !!a.bookmark,
    pageNote: typeof a.pageNote === 'string' ? a.pageNote : '',
    highlights: Array.isArray(a.highlights) ? a.highlights.filter(h => h && typeof h.quote === 'string') : [],
    updated: a.updated || null,
  };
}

// Same keys, in the same order, as the reader's annJson().
export function annotationsJson(a) {
  return JSON.stringify({ format: 'mnote-annotations', version: 1, updated: a.updated, bookmark: a.bookmark, pageNote: a.pageNote, highlights: a.highlights });
}

// The reader's uid().
export const uid = () => 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const DROPPED = new Set(['script', 'style', 'link', 'meta', 'iframe', 'object', 'embed', 'form', 'base']);
const hasClass = (n, c) => (n.attrs || []).some(a => a.name === 'class' && a.value.split(/\s+/).includes(c));

function findElement(node, tag) {
  if (node.tagName === tag) return node;
  for (const c of node.childNodes || []) { const f = findElement(c, tag); if (f) return f; }
  return null;
}

function collect(node, out) {
  if (node.nodeName === '#text') { out.push(node.value); return; }
  if (DROPPED.has(node.tagName)) return;
  for (const c of node.childNodes || []) collect(c, out);
}

/**
 * The text a highlight's start / end count into: the reader's cleanPage() keeps <main> without
 * its .crumbs, h1 and .meta, drops scripts and the like, trims the HTML, and the page body's
 * textContent is what is left.
 */
export function readerText(html) {
  const doc = parse(html || '');
  const main = findElement(doc, 'main') || findElement(doc, 'body');
  if (!main) return '';
  const kept = main.childNodes.filter(c => !(c.tagName && (c.tagName === 'h1' || hasClass(c, 'crumbs') || hasClass(c, 'meta'))));
  const parts = kept.map(c => { const o = []; collect(c, o); return { text: c.nodeName === '#text', s: o.join('') }; });
  // innerHTML.trim(): only the whitespace of text directly at the start and end of <main> goes.
  // (A non-breaking space is written as &nbsp; in innerHTML, so trim() leaves it.)
  for (let i = 0; i < parts.length && parts[i].text; i++) {
    parts[i].s = parts[i].s.replace(/^[^\S ]+/, '');
    if (parts[i].s) break;
  }
  for (let i = parts.length - 1; i >= 0 && parts[i].text; i--) {
    parts[i].s = parts[i].s.replace(/[^\S ]+$/, '');
    if (parts[i].s) break;
  }
  return parts.map(p => p.s).join('');
}

// Characters that differ between page.txt, what people type or say, and page.html.
const FOLD = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '•': '', '☐': '', '☑': '' };
const foldChar = ch => {
  if (ch in FOLD) return FOLD[ch];
  const l = ch.toLowerCase();
  return l.length === ch.length ? l : ch;
};

/**
 * Where `quote` is in `text`: exactly, or else ignoring whitespace, case, bullets and curly
 * quotes (the page text puts spaces and line breaks where the HTML has none). Returns
 * [start, end] into `text`, or null.
 */
export function findQuote(text, quote) {
  const q0 = quote.trim();
  if (!q0) return null;
  const exact = text.indexOf(q0);
  if (exact >= 0) return [exact, exact + q0.length];
  const map = [];
  let norm = '';
  for (let k = 0; k < text.length; k++) {
    const f = /\s/.test(text[k]) ? '' : foldChar(text[k]);
    for (const c of f) { norm += c; map.push(k); }
  }
  let q = '';
  for (const ch of q0.replace(/\[[ xX]\]/g, '')) if (!/\s/.test(ch)) q += foldChar(ch);
  if (!q) return null;
  const i = norm.indexOf(q);
  if (i < 0) return null;
  return [map[i], map[i + q.length - 1] + 1];
}

/** A new highlight in the reader's own shape (see addHighlight in mnote-reader.html). */
export function newHighlight(text, start, end, color, note) {
  const now = new Date().toISOString();
  return {
    id: uid(), color, start, end, quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(end, end + 32),
    note: note || '', created: now, updated: now,
  };
}

/** The reader's locate(): where a stored highlight sits in the page text now, or null. */
export function locate(text, h) {
  if (text.slice(h.start, h.end) === h.quote) return [h.start, h.end];
  let best = -1, bestScore = -Infinity, i = text.indexOf(h.quote);
  while (i !== -1) {
    const score = (h.prefix && text.slice(i - h.prefix.length, i) === h.prefix ? 2 : 0)
      + (h.suffix && text.slice(i + h.quote.length, i + h.quote.length + h.suffix.length) === h.suffix ? 2 : 0) - Math.abs(i - h.start) / 1e6;
    if (score > bestScore) { best = i; bestScore = score; }
    i = text.indexOf(h.quote, i + 1);
  }
  return best < 0 ? null : [best, best + h.quote.length];
}
