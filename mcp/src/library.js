// The library: every page in an export folder (loose .mnote files and .mnotebook files), in the
// same order and with the same page paths as Mnote Reader (Resolve-Library and Get-LibraryJson
// in mnote.ps1). Files are re-read only when they change.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readZip, text, json, utf8, MNOTE_MIME, NOTEBOOK_MIME, updatePage, readPageEntry } from './mnotezip.js';
import { parseAnn, annotationsJson, readerText, findQuote, newHighlight, locate } from './annotations.js';
import { contentWords, matchScore } from './text.js';

// PowerShell's Sort-Object: culture-aware and case-insensitive.
const cmp = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' });
const unique = list => [...new Set(list)];

/** Documents\OneNote Export, also when Documents lives in OneDrive. */
export function defaultLibraryDir() {
  const home = os.homedir();
  const docs = [process.env.OneDrive && path.join(process.env.OneDrive, 'Documents'), path.join(home, 'OneDrive', 'Documents'), path.join(home, 'Documents')].filter(Boolean);
  for (const d of docs) { const p = path.join(d, 'OneNote Export'); if (fs.existsSync(p)) return p; }
  return path.join(docs[docs.length - 1], 'OneNote Export');
}

function zipMime(entries) { return text(entries.mimetype); }

/** What to serve: a folder of notebooks, or one .mnotebook file (like 'mnote.ps1 read'). */
export function resolveLibrary(target) {
  const full = path.resolve(target).replace(/[\\/]+$/, '');
  if (!fs.existsSync(full)) throw new Error(`Not found: ${full}`);
  if (fs.statSync(full).isDirectory()) return { root: full, only: null };
  const entries = readZip(fs.readFileSync(full), n => n === 'mimetype' || n === 'manifest.json');
  if (/\.mnotebook$/i.test(full)) {
    if (zipMime(entries) !== NOTEBOOK_MIME) throw new Error(`'${full}' is not an .mnotebook file.`);
    return { root: path.dirname(full), only: full };
  }
  if (zipMime(entries) !== MNOTE_MIME) throw new Error(`'${full}' is not an .mnote or .mnotebook file.`);
  // <root>\<notebook>\<section groups...>\<section>\<page>.mnote
  const man = json(entries['manifest.json']) || {};
  let dir = path.dirname(full);
  const up = asList(man.sectionGroups).length + 2;
  for (let i = 0; i < up && path.dirname(dir) !== dir; i++) dir = path.dirname(dir);
  return { root: dir, only: null };
}

const asList = v => (Array.isArray(v) ? v : v == null ? [] : [v]).filter(x => x !== '' && x != null).map(String);

function walk(dir, out) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of list) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (/\.mnote(book)?$/i.test(d.name)) out.push(p);
  }
  return out;
}

const PAGE_ENTRIES = new Set(['mimetype', 'manifest.json', 'page.txt', 'annotations.json']);

// Add-LibraryPage in mnote.ps1.
function pageFrom(entries, info) {
  if (zipMime(entries) !== MNOTE_MIME) return null;
  const man = json(entries['manifest.json']) || {};
  const groups = asList(man.sectionGroups);
  const section = String(man.section ?? '');
  return {
    ...info,
    id: String(man.source?.pageId ?? ''),
    notebook: String(man.notebook ?? ''),
    section,
    location: [...groups, section].join(' / '),
    title: String(man.title ?? ''),
    created: String(man.created ?? ''),
    modified: String(man.modified ?? ''),
    level: Number(man.pageLevel) || 1,
    images: asList(man.images).length,
    edited: String(man.editedInReader ?? ''),
    // The reader's search skips the five header lines of page.txt.
    text: (text(entries['page.txt']) || '').split(/\r?\n/).slice(5).join('\n'),
    annRaw: text(entries['annotations.json']),
  };
}

export class Library {
  constructor(target) {
    Object.assign(this, resolveLibrary(target));
    this.files = new Map();   // file -> { sig, pages, order }
    this.htmlText = new Map(); // page path -> { sig, text }
  }

  /** Where the study coach keeps its progress: next to the notebooks. */
  get studyFile() { return path.join(this.root, 'mnote-study.json'); }

  rel(file) { return path.relative(this.root, file).split(path.sep).join('/'); }

  loadFile(file) {
    let st;
    try { st = fs.statSync(file); } catch { this.files.delete(file); return null; }
    const sig = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    const hit = this.files.get(file);
    if (hit && hit.sig === sig) return hit;
    const entry = { sig, pages: [], order: null, bundle: /\.mnotebook$/i.test(file) };
    try {
      const bytes = fs.readFileSync(file);
      if (!entry.bundle) {
        const p = pageFrom(readZip(bytes, n => PAGE_ENTRIES.has(n)), { path: this.rel(file), file, inner: null, leaf: path.basename(file) });
        if (p) entry.pages.push(p);
      } else {
        const outer = readZip(bytes, n => n === 'mimetype' || n === 'notebook.json' || /^pages\/.+\.mnote$/i.test(n));
        if (zipMime(outer) === NOTEBOOK_MIME) {
          const nb = json(outer['notebook.json']);
          if (nb?.name && Array.isArray(nb.sections)) entry.order = { name: String(nb.name), sections: nb.sections.map(s => String(s.location)) };
          const rel = this.rel(file);
          for (const name of Object.keys(outer)) {
            if (!/^pages\/.+\.mnote$/i.test(name)) continue;
            const p = pageFrom(readZip(outer[name], n => PAGE_ENTRIES.has(n)), { path: `${rel}::${name}`, file, inner: name, leaf: name });
            if (p) entry.pages.push(p);
          }
        }
      }
    } catch { /* not a readable Mnote file: skipped, like the reader does */ }
    this.files.set(file, entry);
    return entry;
  }

  /** Notebooks -> sections -> pages, in Mnote Reader's order (Get-LibraryJson). */
  snapshot() {
    const order = new Map();
    const nbOrder = [];
    const orderFile = path.join(this.root, 'library.json');
    if (!this.only && fs.existsSync(orderFile)) {
      try {
        for (const nb of JSON.parse(fs.readFileSync(orderFile, 'utf8').replace(/^﻿/, '')).notebooks || []) {
          nbOrder.push(String(nb.name)); order.set(String(nb.name), asList(nb.sections));
        }
      } catch { /* no order: A-Z */ }
    }
    const files = this.only ? [this.only] : walk(this.root, []);
    const loose = files.filter(f => /\.mnote$/i.test(f)).sort(cmp);
    const bundles = files.filter(f => /\.mnotebook$/i.test(f)).sort(cmp);
    for (const f of this.files.keys()) if (!files.includes(f)) this.files.delete(f);
    const pages = [];
    for (const f of [...loose, ...bundles]) {
      const e = this.loadFile(f);
      if (!e) continue;
      if (e.order) order.set(e.order.name, e.order.sections);
      pages.push(...e.pages);
    }

    const names = unique(pages.map(p => p.notebook));
    const nbNames = [...nbOrder.filter(n => names.includes(n)), ...names.filter(n => !nbOrder.includes(n)).sort(cmp)];
    const notebooks = nbNames.map((name, ni) => {
      const mine = pages.filter(p => p.notebook === name);
      const locs = unique(mine.map(p => p.location));
      const known = (order.get(name) || []).filter(Boolean);
      const sorted = [...known.filter(l => locs.includes(l)), ...locs.filter(l => !known.includes(l)).sort(cmp)];
      const flat = [];
      const sections = sorted.map(loc => {
        const sp = mine.filter(p => p.location === loc).sort((a, b) => cmp(a.leaf, b.leaf));
        for (const p of sp) { p.nbIndex = ni; p.pageNumber = flat.length + 1; flat.push(p); }
        return { name: sp[0].section, location: loc, pages: sp };
      });
      return { name, sections, pages: flat };
    });
    return { root: this.root, notebooks, pages: notebooks.flatMap(n => n.pages) };
  }

  /** A notebook by (roughly) its name, or null. */
  findNotebook(name, lib = this.snapshot()) {
    if (!name) return null;
    const scored = lib.notebooks.map(nb => ({ nb, s: matchScore(name, nb.name) })).filter(x => x.s >= 40).sort((a, b) => b.s - a.s);
    return scored[0]?.nb ?? null;
  }

  /** Pages limited to a notebook / section, by rough names. Throws if a name matches nothing. */
  scope({ notebook, section } = {}, lib = this.snapshot()) {
    let pages = lib.pages;
    if (notebook) {
      const nb = this.findNotebook(notebook, lib);
      if (!nb) throw new Error(`There is no notebook called "${notebook}". Notebooks: ${lib.notebooks.map(n => n.name).join(', ') || 'none'}.`);
      pages = nb.pages;
    }
    if (section) {
      const locs = unique(pages.map(p => p.location));
      const best = locs.map(l => ({ l, s: Math.max(matchScore(section, l), matchScore(section, l.split(' / ').pop())) })).filter(x => x.s >= 40).sort((a, b) => b.s - a.s)[0];
      if (!best) throw new Error(`There is no section called "${section}"${notebook ? ` in ${notebook}` : ''}.`);
      pages = pages.filter(p => p.location === best.l);
    }
    return pages;
  }

  /**
   * A page from what a person or assistant would say: its exact path (as the tools return it),
   * its title or part of it, or its page number within a notebook. Returns { page } or
   * { page: null, candidates } when it is unclear.
   */
  resolvePage(ref, { notebook, section } = {}) {
    const lib = this.snapshot();
    const r = String(ref || '').trim();
    const exact = lib.pages.find(p => p.path === r);
    if (exact) return { page: exact, candidates: [] };
    const pool = this.scope({ notebook, section }, lib);
    if (!r) return { page: null, candidates: pool.slice(0, 5) };
    const scored = pool.map(p => ({
      p,
      s: Math.max(matchScore(r, p.title), matchScore(r, `${p.location} ${p.title}`) - 5, matchScore(r, `${p.notebook} ${p.location} ${p.title}`) - 10),
    })).filter(x => x.s >= 35).sort((a, b) => b.s - a.s);
    if (!scored.length && /^\d+$/.test(r)) {
      const nbs = unique(pool.map(p => p.notebook));
      if (nbs.length === 1) { const p = pool.find(x => x.pageNumber === Number(r)); if (p) return { page: p, candidates: [] }; }
    }
    if (!scored.length) return { page: null, candidates: [] };
    if (scored.length === 1 || scored[0].s - scored[1].s >= 10) return { page: scored[0].p, candidates: [] };
    return { page: null, candidates: scored.slice(0, 6).map(x => x.p) };
  }

  annotations(page) { return parseAnn(page.annRaw); }

  /** The text that highlight offsets count into (see readerText). */
  highlightText(page) {
    const sig = this.files.get(page.file)?.sig;
    const hit = this.htmlText.get(page.path);
    if (hit && hit.sig === sig) return hit.text;
    const t = readerText(text(readPageEntry(page, 'page.html')) || '');
    this.htmlText.set(page.path, { sig, text: t });
    return t;
  }

  /**
   * Search like the reader's search box: page text, titles and the notes on highlights, plus
   * page notes and highlighted passages. A phrase that is found nowhere falls back to pages
   * that have all of its words.
   */
  search(query, { notebook, limit = 10 } = {}) {
    const pages = this.scope({ notebook });
    const q = query.trim().replace(/\s+/g, ' ');
    if (!q) return { mode: 'phrase', hits: [] };
    const run = terms => {
      const hits = [];
      for (const p of pages) {
        const a = this.annotations(p);
        const body = p.text, bl = body.toLowerCase().replace(/\s+/g, ' ');
        let total = 0, first = -1;
        const where = new Set();
        for (const t of terms) {
          let count = 0, i = bl.indexOf(t);
          if (i >= 0 && (first < 0 || i < first)) first = i;
          while (i !== -1) { count++; i = bl.indexOf(t, i + t.length); }
          if (count) where.add('text');
          const inTitle = p.title.toLowerCase().includes(t);
          if (inTitle) where.add('title');
          const notes = a.highlights.filter(h => (h.note || '').toLowerCase().includes(t)).length + (a.pageNote.toLowerCase().includes(t) ? 1 : 0);
          if (notes) where.add('notes');
          const termHits = count + notes + (inTitle ? 3 : 0);
          if (!termHits) { total = 0; break; }   // every term must be there
          total += termHits;
        }
        if (!total) continue;
        const flatBody = body.replace(/\s+/g, ' ');
        const matching = a.highlights.filter(h => terms.some(t => (h.note || '').toLowerCase().includes(t) || h.quote.toLowerCase().includes(t)));
        hits.push({
          page: p, score: total, where: [...where],
          snippet: first >= 0 ? (first > 50 ? '...' : '') + flatBody.slice(Math.max(0, first - 50), first + terms[0].length + 80).trim() + '...' : '',
          highlights: matching.slice(0, 3),
          pageNote: terms.some(t => a.pageNote.toLowerCase().includes(t)) ? a.pageNote : '',
        });
      }
      return hits.sort((x, y) => y.score - x.score);
    };
    let mode = 'phrase';
    let hits = run([q.toLowerCase()]);
    const words = contentWords(q);
    if (!hits.length && words.length > 1) { mode = 'all words'; hits = run(words); }
    return { mode, total: hits.length, hits: hits.slice(0, limit) };
  }

  /**
   * Adds a note to a page, saved in its annotations.json the way the reader saves it. With
   * `quote`, the note goes on a highlight of that passage (a new one, or the one already there);
   * without, it goes in the page note.
   */
  addNote(page, { note, quote, color, replace = false }) {
    // Read annotations.json fresh, so nothing saved since the last look is lost.
    const a = parseAnn(text(readPageEntry(page, 'annotations.json')));
    const now = new Date().toISOString();
    const join = (old, add) => (replace || !old.trim() ? add : `${old.trimEnd()}\n${add}`);
    let result;
    if (quote && quote.trim()) {
      const t = this.highlightText(page);
      const at = findQuote(t, quote);
      if (!at) throw new Error(`That passage is not on the page "${page.title}". Quote a few words exactly as they appear on it (read_page shows the text).`);
      const existing = a.highlights.find(h => { const l = locate(t, h); return l && l[0] === at[0] && l[1] === at[1]; });
      if (existing) {
        existing.note = join(existing.note || '', note);
        if (color) existing.color = color;
        existing.updated = now;
        result = { action: 'updated highlight', highlight: existing };
      } else {
        const h = newHighlight(t, at[0], at[1], color || 'yellow', note);
        a.highlights.push(h);
        result = { action: 'new highlight', highlight: h };
      }
    } else {
      a.pageNote = join(a.pageNote, note);
      result = { action: 'page note', pageNote: a.pageNote };
    }
    a.updated = now;
    updatePage(page, new Map([['annotations.json', utf8(annotationsJson(a))]]));
    this.files.delete(page.file);
    return result;
  }
}
