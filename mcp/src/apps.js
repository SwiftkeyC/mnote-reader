// MCP Apps (the io.modelcontextprotocol/ui extension): an interactive flashcard that hosts with a
// screen (Alexa+ on Echo Show, Claude, the MCP Inspector) show for quiz_me and answer_quiz. The
// card asks the question, gives the hint, takes a typed answer (answer_quiz through the host) and
// shows the highlighted passage. Clients without MCP Apps ignore it and use the tools' text.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';

export const FLASHCARD_HTML = fs.readFileSync(new URL('./flashcard.html', import.meta.url), 'utf8');
// The address carries a hash of the page, so hosts that cache it pick up a changed card.
export const FLASHCARD_URI = `ui://mnote/flashcard-${createHash('sha256').update(FLASHCARD_HTML).digest('hex').slice(0, 8)}.html`;
// The card needs no network at all: nothing is allowed beyond the page itself.
const UI = { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true };

export function registerFlashcard(server) {
  registerAppResource(server, 'flashcard', FLASHCARD_URI, {
    title: 'Mnote flashcard',
    description: 'Interactive flashcard for quiz_me and answer_quiz: the question with its blank, a hint, an answer box, right or wrong with the highlighted passage, and the next question.',
    _meta: { ui: UI },
  }, async () => ({ contents: [{ uri: FLASHCARD_URI, mimeType: RESOURCE_MIME_TYPE, text: FLASHCARD_HTML, _meta: { ui: UI } }] }));
}
