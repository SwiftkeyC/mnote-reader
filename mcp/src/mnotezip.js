// Reading and rewriting .mnote / .mnotebook ZIP files, the same way mnote.ps1 does
// (Get-RebuiltEntries, Save-ZipFile and Update-Page): every entry is kept in order, changed
// entries are replaced, new ones go at the end, and the file is swapped in atomically with its
// modified date (the page's own date) kept.
import fs from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

export const MNOTE_MIME = 'application/vnd.mnote+zip';
export const NOTEBOOK_MIME = 'application/vnd.mnotebook+zip';

// Already-compressed content (images, whole pages inside a notebook file) is not compressed again.
const isStored = name => name === 'mimetype' || name.startsWith('images/') || name.endsWith('.mnote');

/** Entries of a ZIP (bytes) as an ordered object name -> Uint8Array; `only` limits which are read. */
export function readZip(bytes, only) {
  const filter = only ? f => only(f.name) : undefined;
  return unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), filter ? { filter } : undefined);
}

export function text(bytes) {
  if (!bytes) return null;
  const s = strFromU8(bytes);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export const utf8 = s => strToU8(s);

export function json(bytes) {
  const s = text(bytes);
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/** Every entry of `entries` in order, with `changes` (name -> bytes, or null to drop) applied. */
export function rebuildZip(entries, changes) {
  const out = {};
  const done = new Set();
  for (const [name, data] of Object.entries(entries)) {
    let bytes = data;
    if (changes.has(name)) { done.add(name); bytes = changes.get(name); }
    if (bytes != null) out[name] = [bytes, { level: isStored(name) ? 0 : 6 }];
  }
  for (const [name, bytes] of changes) {
    if (!done.has(name) && bytes != null) out[name] = [bytes, { level: isStored(name) ? 0 : 6 }];
  }
  return zipSync(out);
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Writes a temporary copy, then swaps it in, so a crash mid-save never leaves a half-written
// file. Mnote Reader may have the file open for a moment, so a busy file is retried briefly.
export function saveFileAtomic(file, bytes) {
  const st = fs.statSync(file);
  const tmp = file + '.saving';
  try {
    fs.writeFileSync(tmp, bytes);
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, file); break; }
      catch (err) {
        if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
        sleep(100);
      }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already moved */ }
  }
  fs.utimesSync(file, st.atime, st.mtime);
}

/**
 * Replaces entries of one page ($changes: name -> bytes), in its own .mnote file or inside a
 * .mnotebook file. ref = { file, inner } where inner is "pages/<section>/<page>.mnote" or null.
 */
export function updatePage(ref, changes) {
  const outerBytes = fs.readFileSync(ref.file);
  if (!ref.inner) {
    saveFileAtomic(ref.file, rebuildZip(readZip(outerBytes), changes));
    return;
  }
  const outer = readZip(outerBytes);
  const pageBytes = outer[ref.inner];
  if (!pageBytes) throw new Error(`Page not found in the notebook file: ${ref.inner}`);
  const page = rebuildZip(readZip(pageBytes), changes);
  saveFileAtomic(ref.file, rebuildZip(outer, new Map([[ref.inner, page]])));
}

/** One entry of a page (or null), from its own file or from inside a notebook file. */
export function readPageEntry(ref, name) {
  const bytes = fs.readFileSync(ref.file);
  if (!ref.inner) return readZip(bytes, n => n === name)[name] ?? null;
  const inner = readZip(bytes, n => n === ref.inner)[ref.inner];
  if (!inner) return null;
  return readZip(inner, n => n === name)[name] ?? null;
}
