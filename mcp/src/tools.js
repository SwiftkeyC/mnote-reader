// The MCP surface: tools over the library, the study coach, and prompts that run a session.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { COLORS } from './annotations.js';
import { pageRef } from './study.js';

export const SERVER_VERSION = '1.0.0';

const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="5" y="2" width="22" height="28" rx="4" fill="#6d3fc0"/><path d="M10 10h12M10 16h12M10 22h7" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>';
const ICON = { src: 'data:image/svg+xml;base64,' + Buffer.from(ICON_SVG).toString('base64'), mimeType: 'image/svg+xml', sizes: ['any'] };

const INSTRUCTIONS = `Mnote turns a person's Microsoft OneNote notebooks into files they own, with highlights and notes made in Mnote Reader. These tools read that library and coach the person through it.

- To find something, use search_notes, then read_page with the "path" it returns. Pages can also be named loosely by title ("the pricing page").
- list_highlights_and_notes shows what the person marked as important. add_note saves a note on a page, or on a passage (which becomes a highlight), straight into their files; Mnote Reader shows it next time the page is opened.
- Study coach: quiz_me asks a fill-in-the-blank question made from one of their own highlights. Read the "speech" text to them, wait for their answer, then call answer_quiz with their exact words and the questionId. answer_quiz grades it, schedules the next review (spaced repetition) and returns the next question. Missed questions come back sooner. Progress is saved across conversations; study_progress summarises it.
- Answers are spoken or typed by people: keep replies short and friendly, and never reveal the answer before they try. If they say something that means the same as the expected answer but in other words, pass judged_correct: true.`;

const PageRef = z.object({
  path: z.string().describe('Exact page path. Pass it back as "page" to other tools.'),
  title: z.string(),
  notebook: z.string(),
  section: z.string(),
  pageNumber: z.number().describe('Page number within its notebook, as Mnote Reader counts it'),
});
const Highlight = z.object({
  id: z.string(),
  quote: z.string(),
  note: z.string(),
  color: z.string(),
  created: z.string(),
});
const Color = z.enum(COLORS);

const hl = h => ({ id: String(h.id || ''), quote: h.quote, note: h.note || '', color: h.color || 'yellow', created: h.created || '' });

function result(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], structuredContent: data };
}

function ambiguous(ref, candidates) {
  if (!candidates.length) return `There is no page matching "${ref}". Use search_notes to find it, or list_notebooks to see what there is.`;
  return `More than one page matches "${ref}". Ask which one they mean, then pass its path:\n` +
    candidates.map(p => `- "${p.title}" (${p.notebook} > ${p.location}), path: ${p.path}`).join('\n');
}

/** One MCP server instance (one per client session) over a shared library and study coach. */
export function createMnoteServer({ library, coach, log = () => {} }) {
  const server = new McpServer(
    { name: 'mnote', title: 'Mnote', version: SERVER_VERSION, websiteUrl: 'https://swiftkeyc.github.io/mnote-reader/', icons: [ICON] },
    { instructions: INSTRUCTIONS, capabilities: { logging: {} } },
  );

  const tool = (name, config, fn) => server.registerTool(name, config, async (args, extra) => {
    const t0 = Date.now();
    try {
      const out = await fn(args || {}, extra);
      log(`${name} ok ${Date.now() - t0}ms`);
      return out;
    } catch (err) {
      log(`${name} error ${Date.now() - t0}ms: ${err.message}`);
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
  });

  const findPage = (ref, notebook) => {
    const r = library.resolvePage(ref, { notebook });
    if (!r.page) throw new Error(ambiguous(ref, r.candidates));
    return r.page;
  };

  // ------------------------------------------------------------ library

  tool('list_notebooks', {
    title: 'List notebooks',
    description: 'The notebooks in the Mnote library, with their sections and how many pages, highlights, notes and bookmarks each has. Give a notebook name (or include_pages) to list page titles too.',
    inputSchema: {
      notebook: z.string().optional().describe('Only this notebook (a rough name is fine)'),
      include_pages: z.boolean().optional().describe('List every page title. Default: only when a notebook is given'),
    },
    outputSchema: {
      library: z.string(),
      notebooks: z.array(z.object({
        name: z.string(), pages: z.number(), highlights: z.number(), notes: z.number(), bookmarks: z.number(),
        sections: z.array(z.object({
          name: z.string(), pages: z.number(), highlights: z.number(),
          pageList: z.array(z.object({ title: z.string(), pageNumber: z.number(), path: z.string(), highlights: z.number(), bookmark: z.boolean() })).optional(),
        })),
      })),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ notebook, include_pages }) => {
    const lib = library.snapshot();
    let nbs = lib.notebooks;
    if (notebook) {
      const nb = library.findNotebook(notebook, lib);
      if (!nb) throw new Error(`There is no notebook called "${notebook}". Notebooks: ${lib.notebooks.map(n => n.name).join(', ') || 'none'}.`);
      nbs = [nb];
    }
    const withPages = include_pages ?? !!notebook;
    return result({
      library: lib.root,
      notebooks: nbs.map(nb => {
        let highlights = 0, notes = 0, bookmarks = 0;
        const sections = nb.sections.map(sec => {
          let sh = 0;
          const pageList = sec.pages.map(p => {
            const a = library.annotations(p);
            sh += a.highlights.length;
            notes += a.highlights.filter(h => (h.note || '').trim()).length + (a.pageNote.trim() ? 1 : 0);
            if (a.bookmark) bookmarks++;
            return { title: p.title, pageNumber: p.pageNumber, path: p.path, highlights: a.highlights.length, bookmark: a.bookmark };
          });
          highlights += sh;
          return { name: sec.location, pages: sec.pages.length, highlights: sh, ...(withPages ? { pageList } : {}) };
        });
        return { name: nb.name, pages: nb.pages.length, highlights, notes, bookmarks, sections };
      }),
    });
  });

  tool('search_notes', {
    title: 'Search notes',
    description: 'Search every page\'s text and title, and the notes on highlights and pages, like the search box in Mnote Reader. Returns the best matching pages with a snippet. A phrase found nowhere falls back to pages that contain all of its words.',
    inputSchema: {
      query: z.string().min(1).describe('Words or a phrase to find'),
      notebook: z.string().optional().describe('Only search this notebook'),
      limit: z.number().int().min(1).max(50).optional().describe('Most results to return (default 10)'),
    },
    outputSchema: {
      query: z.string(),
      mode: z.string().describe('"phrase", or "all words" when the exact phrase was found nowhere'),
      total: z.number(),
      results: z.array(z.object({
        page: PageRef,
        matchedIn: z.array(z.string()),
        snippet: z.string(),
        highlights: z.array(Highlight),
        pageNote: z.string(),
      })),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ query, notebook, limit }) => {
    const r = library.search(query, { notebook, limit: limit ?? 10 });
    return result({
      query, mode: r.mode, total: r.total ?? 0,
      results: r.hits.map(h => ({ page: pageRef(h.page), matchedIn: h.where, snippet: h.snippet, highlights: h.highlights.map(hl), pageNote: h.pageNote })),
    });
  });

  tool('read_page', {
    title: 'Read a page',
    description: 'One page\'s text, with its highlights, notes and bookmark. "page" is a path from another tool, a page title (or part of it), or a page number with "notebook".',
    inputSchema: {
      page: z.string().min(1).describe('Page path, title, or page number'),
      notebook: z.string().optional().describe('The notebook, to narrow a title or page number down'),
      max_chars: z.number().int().min(200).max(100000).optional().describe('Longest text to return (default 12000)'),
    },
    outputSchema: {
      page: PageRef,
      created: z.string(), modified: z.string(),
      editedInReader: z.boolean(),
      images: z.number(),
      text: z.string(),
      truncated: z.boolean(),
      bookmark: z.boolean(),
      pageNote: z.string(),
      highlights: z.array(Highlight),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ page, notebook, max_chars }) => {
    const p = findPage(page, notebook);
    const a = library.annotations(p);
    const max = max_chars ?? 12000;
    const body = p.text.trim();
    return result({
      page: pageRef(p), created: p.created, modified: p.modified, editedInReader: !!p.edited, images: p.images,
      text: body.length > max ? body.slice(0, max) : body, truncated: body.length > max,
      bookmark: a.bookmark, pageNote: a.pageNote, highlights: [...a.highlights].sort((x, y) => x.start - y.start).map(hl),
    });
  });

  tool('list_highlights_and_notes', {
    title: 'List highlights and notes',
    description: 'What the person marked as important: highlighted passages with their notes, page notes and bookmarks, page by page in reading order. Narrow it to a notebook, section or page, a highlight colour, or only highlights that have a note.',
    inputSchema: {
      notebook: z.string().optional(),
      section: z.string().optional(),
      page: z.string().optional().describe('One page: path or title'),
      color: Color.optional(),
      only_with_notes: z.boolean().optional().describe('Only highlights that have a note, and page notes'),
      limit: z.number().int().min(1).max(500).optional().describe('Most highlights to return (default 100)'),
    },
    outputSchema: {
      pages: z.array(z.object({ page: PageRef, bookmark: z.boolean(), pageNote: z.string(), highlights: z.array(Highlight) })),
      totals: z.object({ highlights: z.number(), withNotes: z.number(), pageNotes: z.number(), bookmarks: z.number() }),
      truncated: z.boolean(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ notebook, section, page, color, only_with_notes, limit }) => {
    const pages = page ? [findPage(page, notebook)] : library.scope({ notebook, section });
    const max = limit ?? 100;
    const totals = { highlights: 0, withNotes: 0, pageNotes: 0, bookmarks: 0 };
    const out = [];
    let shown = 0, truncated = false;
    for (const p of pages) {
      const a = library.annotations(p);
      let hs = [...a.highlights].sort((x, y) => x.start - y.start);
      if (color) hs = hs.filter(h => (h.color || 'yellow') === color);
      if (only_with_notes) hs = hs.filter(h => (h.note || '').trim());
      const pageNote = color ? '' : a.pageNote;
      const bookmark = !only_with_notes && !color && a.bookmark;
      if (!hs.length && !pageNote.trim() && !bookmark) continue;
      totals.highlights += hs.length;
      totals.withNotes += hs.filter(h => (h.note || '').trim()).length;
      if (pageNote.trim()) totals.pageNotes++;
      if (bookmark) totals.bookmarks++;
      if (shown >= max) { truncated = true; continue; }
      const room = hs.slice(0, max - shown);
      if (room.length < hs.length) truncated = true;
      shown += room.length;
      out.push({ page: pageRef(p), bookmark, pageNote, highlights: room.map(hl) });
    }
    return result({ pages: out, totals, truncated });
  });

  tool('add_note', {
    title: 'Add a note',
    description: 'Saves a note into the person\'s Mnote files, in the same annotations.json that Mnote Reader uses. With "quote", the note goes on that passage of the page, which becomes a highlight (or the note is added to the highlight already there). Without "quote", it is added to the page note. If the page name is unclear, the person is asked to pick the page.',
    inputSchema: {
      page: z.string().min(1).describe('Page path, title, or page number'),
      notebook: z.string().optional(),
      note: z.string().min(1).max(5000).describe('The note text'),
      quote: z.string().max(2000).optional().describe('A passage of the page, word for word, to highlight and attach the note to'),
      color: Color.optional().describe('Highlight colour (default yellow)'),
      replace: z.boolean().optional().describe('Replace the existing note instead of adding to it'),
    },
    outputSchema: {
      saved: z.boolean(),
      action: z.string().describe('"new highlight", "updated highlight" or "page note"'),
      page: PageRef,
      highlight: Highlight.optional(),
      pageNote: z.string().optional(),
      speech: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ page, notebook, note, quote, color, replace }) => {
    let r = library.resolvePage(page, { notebook });
    let p = r.page;
    if (!p && r.candidates.length > 1 && server.server.getClientCapabilities()?.elicitation?.form) {
      // Writing to the wrong page is worse than asking: let the person choose (MCP elicitation).
      const answer = await server.server.elicitInput({
        mode: 'form',
        message: `More than one page matches "${page}". Which page should the note go on?`,
        requestedSchema: {
          type: 'object',
          properties: { page: { type: 'string', title: 'Page', oneOf: r.candidates.map(c => ({ const: c.path, title: `${c.title} (${c.notebook} > ${c.location})` })) } },
          required: ['page'],
        },
      });
      if (answer.action !== 'accept') {
        return result({ saved: false, action: 'cancelled', page: pageRef(r.candidates[0]), speech: 'OK, I did not save the note.' });
      }
      p = library.snapshot().pages.find(x => x.path === answer.content?.page);
    }
    if (!p) throw new Error(ambiguous(page, r.candidates));
    const done = library.addNote(p, { note, quote, color, replace });
    const fresh = library.snapshot().pages.find(x => x.path === p.path) || p;
    const where = done.action === 'page note' ? `to the page note on "${p.title}"` : `on "${clipQuote(done.highlight.quote)}" in "${p.title}"`;
    return result({
      saved: true, action: done.action, page: pageRef(fresh),
      ...(done.highlight ? { highlight: hl(done.highlight) } : {}),
      ...(done.pageNote != null ? { pageNote: done.pageNote } : {}),
      speech: `Saved your note ${where}.`,
    });
  });

  // ------------------------------------------------------------ study coach

  const QuizQuestion = {
    available: z.boolean().describe('false when there is nothing to ask'),
    questionId: z.string().optional().describe('Pass to answer_quiz'),
    kind: z.string().optional().describe('"term": name the highlighted term; "cloze": fill the blank in a highlight; "recall": recall the passage'),
    question: z.string().optional().describe('The question, with _____ for the blank'),
    hint: z.string().optional().describe('Only give this if they ask for a hint'),
    speech: z.string().describe('What to say to the person'),
    page: PageRef.optional(),
    card: z.object({ status: z.string(), box: z.number(), right: z.number(), wrong: z.number() }).optional(),
    remaining: z.object({ due: z.number(), new: z.number() }).optional(),
    caughtUp: z.boolean().optional(),
  };
  const Scope = {
    notebook: z.string().optional().describe('Only this notebook'),
    section: z.string().optional().describe('Only this section'),
    page: z.string().optional().describe('Only this page'),
  };

  tool('quiz_me', {
    title: 'Quiz me',
    description: 'Study coach: the next fill-in-the-blank question made from the person\'s own highlights, chosen by spaced repetition (questions they missed come back first, then reviews that are due, then highlights never quizzed). Read "speech" aloud, then send their reply to answer_quiz.',
    inputSchema: {
      ...Scope,
      focus: z.enum(['due', 'mistakes', 'new']).optional().describe('"due" (default): what is due, missed first. "mistakes": only questions they got wrong before. "new": only highlights never quizzed'),
    },
    outputSchema: QuizQuestion,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ notebook, section, page, focus }) => result(coach.quiz({ notebook, section, page }, focus || 'due')));

  tool('answer_quiz', {
    title: 'Answer the quiz',
    description: 'Study coach: checks the person\'s answer to a quiz_me question (forgiving about case, plurals, small typos and speech-recognition slips), moves the card along its spaced-repetition schedule, saves the result, and by default returns the next question in "next".',
    inputSchema: {
      question_id: z.string().describe('questionId from quiz_me (or from "next")'),
      answer: z.string().describe('What the person said, word for word. Empty or "I don\'t know" counts as a miss and reveals the answer'),
      judged_correct: z.boolean().optional().describe('Only if the answer means the same as the expected one in other words: true to count it right'),
      next: z.boolean().optional().describe('Also return the next question (default true)'),
    },
    outputSchema: {
      correct: z.boolean(),
      close: z.boolean().describe('Accepted with a small typo or slip'),
      skipped: z.boolean(),
      expected: z.string(),
      yourAnswer: z.string(),
      passage: z.string().describe('The whole highlighted passage'),
      note: z.string().describe('Their own note on that highlight'),
      page: PageRef,
      card: z.object({ status: z.string(), box: z.number(), right: z.number(), wrong: z.number(), nextReview: z.string() }),
      today: z.object({ right: z.number(), wrong: z.number() }),
      speech: z.string(),
      next: z.object(QuizQuestion).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ question_id, answer, judged_correct, next }) => {
    const { focus, ...scope } = coach.load().pending[question_id]?.scope || {};
    const r = coach.answer(question_id, answer, judged_correct);
    if (next !== false) {
      const q = coach.quiz(scope, focus || 'due');
      if (q.available) { r.next = q; r.speech += ` Next question. ${q.speech}`; }
      else r.speech += ' That was the last one for now.';
    }
    return result(r);
  });

  tool('study_progress', {
    title: 'Study progress',
    description: 'Study coach: how studying is going, kept across conversations. Cards are highlights; it counts new, learning, reviewing, mastered and due ones, today\'s score, the day streak, the passages missed most (weak spots), accuracy per section, and what to study next.',
    inputSchema: { notebook: z.string().optional(), section: z.string().optional() },
    outputSchema: {
      cards: z.number(), new: z.number(), learning: z.number(), reviewing: z.number(), mastered: z.number(), due: z.number(),
      accuracy: z.number().optional().describe('Percent right, all time (absent before the first answer)'),
      today: z.object({ right: z.number(), wrong: z.number() }),
      streakDays: z.number(),
      lastStudied: z.string().optional(),
      weakSpots: z.array(z.object({ passage: z.string(), page: PageRef, misses: z.number(), right: z.number(), lastResult: z.string() })),
      bySection: z.array(z.object({ notebook: z.string(), section: z.string(), cards: z.number(), right: z.number(), wrong: z.number(), mastered: z.number(), accuracy: z.number().optional() })),
      suggestion: z.string(),
      speech: z.string(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ notebook, section }) => result(coach.progress({ notebook, section })));

  // ------------------------------------------------------------ prompts

  server.registerPrompt('study_session', {
    title: 'Study session',
    description: 'A short spoken quiz from your own highlights, with spaced repetition.',
    argsSchema: {
      notebook: z.string().optional().describe('Notebook to study (default: all)'),
      questions: z.string().optional().describe('How many questions (default 5)'),
    },
  }, ({ notebook, questions }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Quiz me on my Mnote highlights${notebook ? ` in the notebook "${notebook}"` : ''}. ` +
          `Call quiz_me${notebook ? ` with notebook "${notebook}"` : ''}, read me its "speech", and wait for my answer. ` +
          'Send exactly what I say to answer_quiz, tell me in one short sentence whether I was right, then ask the next question it returns. ' +
          'If I ask for a hint, give the hint. ' +
          `After ${Number(questions) > 0 ? Number(questions) : 5} questions, or when I say stop, call study_progress and tell me how I did and what to review next, in two or three sentences.`,
      },
    }],
  }));

  server.registerPrompt('review_my_mistakes', {
    title: 'Review my mistakes',
    description: 'Go over the passages you keep getting wrong, then retest them.',
    argsSchema: { notebook: z.string().optional() },
  }, ({ notebook }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Call study_progress${notebook ? ` for the notebook "${notebook}"` : ''} and explain my weak spots simply, one at a time, using read_page for context. ` +
          'Then retest me with quiz_me using focus "mistakes", passing my answers to answer_quiz.',
      },
    }],
  }));

  return server;
}

function clipQuote(q) { const s = q.replace(/\s+/g, ' ').trim(); return s.length > 60 ? s.slice(0, 57) + '...' : s; }
