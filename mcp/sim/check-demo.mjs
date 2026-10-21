#!/usr/bin/env node
// Smoke test of `npm run demo` (used by CI on Windows, macOS and Linux):  npm run demo:check
// Starts the demo on fresh sample notes, then does what the simulator page and "Alexa" do: loads
// the page and its bundle, reads the flashcard over MCP, takes a quiz, answers it right, adds a
// note and reads it back from the rewritten notebook file. Stops the demo at the end.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const mcp = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP_PORT = 47985, SIM_PORT = 47990;
// Its own copy of the sample notes, so a check never touches your demo progress.
const library = path.join(os.tmpdir(), 'mnote-demo-check');
const demo = spawn(process.execPath, [path.join('sim', 'demo.js'), '--fresh', '--no-open', '--library', library, '--port', String(MCP_PORT), '--sim-port', String(SIM_PORT)], { cwd: mcp, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
demo.stdout.on('data', d => { log += d; });
demo.stderr.on('data', d => { log += d; });

function stop() {
  // On Windows, kill the whole tree: the demo's MCP server and simulator are its children.
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(demo.pid), '/T', '/F'], { stdio: 'ignore' });
  else demo.kill('SIGTERM');
}

async function up(url) {
  for (let i = 0; i < 240; i++) {
    if (demo.exitCode !== null) throw new Error('the demo stopped');
    try { const r = await fetch(url); if (r.ok) return r; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`no answer from ${url}`);
}

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

try {
  console.log(`Platform: ${process.platform} ${os.release()}, Node ${process.version}`);
  const page = await (await up(`http://127.0.0.1:${SIM_PORT}/`)).text();
  const server = /name="mnote-mcp-server" content="([^"]+)"/.exec(page)?.[1];
  check('simulator page names the demo MCP server', server === `http://127.0.0.1:${MCP_PORT}/mcp`, server);
  const bundle = await fetch(`http://127.0.0.1:${SIM_PORT}/sim.js`);
  check('simulator bundle is served', bundle.ok && (await bundle.text()).length > 100000);

  const client = new Client({ name: 'demo-check', version: '1.0.0' }, { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(server)));
  const { tools } = await client.listTools();
  const uri = tools.find(t => t.name === 'quiz_me')?._meta?.ui?.resourceUri;
  check('quiz_me links the flashcard', uri?.startsWith('ui://mnote/flashcard-'), uri);
  const card = (await client.readResource({ uri })).contents[0];
  check('the flashcard is an MCP App page', card.mimeType === 'text/html;profile=mcp-app' && /^<!doctype html>/i.test(card.text));

  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
    return r.structuredContent;
  };
  const q = await call('quiz_me', {});
  check('quiz_me asks a question', q.available && q.question.includes('_____'), q.question);
  const study = path.join(library, 'mnote-study.json');
  const expected = JSON.parse(fs.readFileSync(study, 'utf8')).pending[q.questionId].answer;
  const a = await call('answer_quiz', { question_id: q.questionId, answer: expected });
  check('answer_quiz grades a right answer', a.correct, `"${expected}"`);
  check('answer_quiz asks the next question', a.next?.available, a.next?.question);
  const n = await call('add_note', { page: 'Pricing models', quote: 'pay by the second', note: `Written on ${process.platform}.` });
  check('add_note saves into the notebook file', n.saved && n.action === 'new highlight');
  const p = await call('read_page', { page: 'Pricing models' });
  check('the note reads back', p.highlights.some(h => h.note === `Written on ${process.platform}.`));
  await client.close();
} catch (err) {
  check('demo runs', false, err.message);
} finally {
  stop();
}

const failed = checks.filter(c => !c.ok).length;
if (failed) console.log(`\nDemo output:\n${log}`);
console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
