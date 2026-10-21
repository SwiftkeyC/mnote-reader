// End to end: builds the fictional sample library, starts the server, and talks to it with the
// official MCP client over Streamable HTTP. Needs Windows (the sample is packed by mnote.ps1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readerText } from '../src/annotations.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const lib = path.join(os.tmpdir(), `mnote-mcp-e2e-${process.pid}`);
const ps = (...args) => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ...args], { encoding: 'utf8' });

function startServer(extra = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(here, '..', 'src', 'server.js'), '--library', lib, '--port', '0', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', d => {
      out += d;
      const m = /Endpoint: (http:\S+)/.exec(out);
      if (m) resolve({ proc, url: m[1], out });
    });
    proc.stderr.on('data', () => {});
    proc.on('exit', code => reject(new Error(`server exited (${code}): ${out}`)));
  });
}
const stop = s => new Promise(r => { s.proc.removeAllListeners('exit'); s.proc.once('exit', r); s.proc.kill(); });

async function connect(url, { elicit } = {}) {
  const client = new Client({ name: 'mnote-e2e', version: '1.0.0' }, { capabilities: elicit ? { elicitation: { form: {} } } : {} });
  if (elicit) client.setRequestHandler(ElicitRequestSchema, elicit);
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}
async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, `${name} failed: ${r.content?.[0]?.text}`);
  return r.structuredContent;
}
function rawRequest(url, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });

/** Entries of one page inside a .mnotebook file. */
function pageEntries(notebookFile, inner) {
  const outer = unzipSync(fs.readFileSync(notebookFile));
  return unzipSync(outer[inner]);
}

let server, client;
before(async () => {
  ps(path.join(repo, 'mcp', 'sample', 'make-sample-library.ps1'), '-Out', lib);
  server = await startServer();
  client = await connect(server.url);
});
after(async () => {
  await client?.close();
  if (server) await stop(server);
  fs.rmSync(lib, { recursive: true, force: true });
});

test('speaks MCP 2025-11-25 over Streamable HTTP', async () => {
  const r = await rawRequest(server.url, { body: INIT });
  assert.equal(r.status, 200);
  assert.ok(r.headers['mcp-session-id'], 'stateful session id');
  const msg = JSON.parse(/data: (.*)/.exec(r.body)[1]);
  assert.equal(msg.result.protocolVersion, '2025-11-25');
  assert.equal(msg.result.serverInfo.name, 'mnote');
  assert.ok(msg.result.serverInfo.icons?.length, 'server icon');
  assert.match(msg.result.instructions, /quiz_me/);
});

test('lists the tools, each with an output schema and hints', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ['add_note', 'answer_quiz', 'list_highlights_and_notes', 'list_notebooks', 'quiz_me', 'read_page', 'search_notes', 'study_progress']);
  for (const t of tools) { assert.ok(t.outputSchema, t.name); assert.ok(t.annotations, t.name); assert.ok(t.title, t.name); }
  assert.equal(tools.find(t => t.name === 'read_page').annotations.readOnlyHint, true);
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map(p => p.name).sort(), ['review_my_mistakes', 'study_session']);
});

test('list_notebooks keeps OneNote\'s order', async () => {
  const r = await call(client, 'list_notebooks');
  assert.deepEqual(r.notebooks.map(n => n.name), ['Study notebook', 'Economics']);
  assert.deepEqual(r.notebooks[0].sections.map(s => s.name), ['Getting started', 'Cloud basics', 'Security', 'Revision']);
  assert.equal(r.notebooks[0].pages, 12);
  assert.ok(r.notebooks[0].highlights >= 10);
  const one = await call(client, 'list_notebooks', { notebook: 'economics' });
  assert.equal(one.notebooks.length, 1);
  assert.deepEqual(one.notebooks[0].sections[0].pageList.map(p => p.title), ['Pricing strategies', 'Supply and demand']);
});

test('search_notes finds text, titles and notes', async () => {
  const r = await call(client, 'search_notes', { query: 'availability zones' });
  assert.ok(r.results.some(x => x.page.title === 'Regions and zones'));
  const note = await call(client, 'search_notes', { query: 'least privilege' });
  assert.equal(note.results[0].page.title, 'Identity and access');
  assert.ok(note.results[0].matchedIn.includes('notes'));
  const words = await call(client, 'search_notes', { query: 'outage zones' });
  assert.equal(words.mode, 'all words');
  assert.equal(words.results[0].page.title, 'Regions and zones');
});

test('read_page by title, and ambiguous titles are reported', async () => {
  const r = await call(client, 'read_page', { page: 'regions and zones' });
  assert.equal(r.page.title, 'Regions and zones');
  assert.match(r.text, /geographic area/);
  assert.equal(r.highlights.length, 2);
  const byNumber = await call(client, 'read_page', { page: '2', notebook: 'Economics' });
  assert.equal(byNumber.page.title, 'Supply and demand');
  const amb = await client.callTool({ name: 'read_page', arguments: { page: 'pricing' } });
  assert.ok(amb.isError);
  assert.match(amb.content[0].text, /Pricing models/);
  assert.match(amb.content[0].text, /Pricing strategies/);
});

test('add_note writes annotations.json the way the reader does, and PowerShell reads it back', async () => {
  const r = await call(client, 'add_note', { page: 'Pricing models', quote: 'pay by the second', note: 'On-demand is billed per second.', color: 'blue' });
  assert.equal(r.action, 'new highlight');
  const [file, inner] = r.page.path.split('::');
  const entries = pageEntries(path.join(lib, file), inner);
  const ann = JSON.parse(strFromU8(entries['annotations.json']));
  assert.deepEqual(Object.keys(ann), ['format', 'version', 'updated', 'bookmark', 'pageNote', 'highlights']);
  assert.equal(ann.format, 'mnote-annotations');
  assert.equal(ann.version, 1);
  const h = ann.highlights.find(x => x.id === r.highlight.id);
  const text = readerText(strFromU8(entries['page.html']));
  assert.equal(text.slice(h.start, h.end), 'pay by the second');
  assert.equal(h.prefix, text.slice(h.start - 32, h.start));
  assert.equal(h.color, 'blue');
  assert.equal(Object.keys(entries)[0], 'mimetype');

  // The same passage again adds to that highlight's note instead of making another highlight.
  const again = await call(client, 'add_note', { page: r.page.path, quote: 'pay  by the SECOND', note: 'Minimum one minute.' });
  assert.equal(again.action, 'updated highlight');
  assert.equal(again.highlight.note, 'On-demand is billed per second.\nMinimum one minute.');

  const pn = await call(client, 'add_note', { page: 'Course plan', note: 'Exam covers weeks 1 to 6.' });
  assert.equal(pn.action, 'page note');

  // mnote.ps1 opens every page of the rewritten notebook file and counts annotated pages.
  const info = ps(path.join(repo, 'mnote.ps1'), 'info', path.join(lib, file));
  assert.match(info, /11 with highlights or notes/);
});

test('add_note asks which page when the name is unclear (elicitation)', async () => {
  const plain = await client.callTool({ name: 'add_note', arguments: { page: 'pricing', note: 'x' } });
  assert.ok(plain.isError, 'without elicitation it lists the choices');
  let asked;
  const ask = await connect(server.url, {
    elicit: req => {
      asked = req.params;
      const strategies = req.params.requestedSchema.properties.page.oneOf.find(o => o.title.startsWith('Pricing strategies'));
      return { action: 'accept', content: { page: strategies.const } };
    },
  });
  try {
    const r = await call(ask, 'add_note', { page: 'pricing', note: 'Compare with price discrimination.' });
    assert.equal(asked.mode, 'form');
    assert.equal(r.page.title, 'Pricing strategies');
    assert.equal(r.action, 'page note');
  } finally { await ask.close(); }
});

test('study coach: quiz, grade, and remember mistakes across sessions and restarts', async () => {
  const q = await call(client, 'quiz_me', { notebook: 'Economics' });
  assert.equal(q.available, true);
  assert.match(q.question, /_____/);
  assert.ok(!q.speech.includes(q.hint), 'the hint is not given away');
  const wrong = await call(client, 'answer_quiz', { question_id: q.questionId, answer: 'bananas' });
  assert.equal(wrong.correct, false);
  assert.equal(wrong.card.wrong, 1);
  assert.ok(wrong.next?.questionId, 'returns the next question');
  assert.equal(wrong.next.page.notebook, 'Economics', 'the next question stays in the same notebook');
  const right = await call(client, 'answer_quiz', { question_id: wrong.next.questionId, answer: `I think it's ${expectedOf(wrong.next)}`, next: false });
  assert.equal(right.correct, true);
  assert.equal(right.next, undefined);
  const reused = await client.callTool({ name: 'answer_quiz', arguments: { question_id: q.questionId, answer: 'x' } });
  assert.ok(reused.isError, 'a question is answered once');

  // A new server process and a new MCP session still know what was missed.
  await client.close();
  await stop(server);
  server = await startServer();
  client = await connect(server.url);
  const p = await call(client, 'study_progress', { notebook: 'Economics' });
  assert.equal(p.cards, 2);
  assert.equal(p.weakSpots.length, 1);
  assert.equal(p.weakSpots[0].misses, 1);
  assert.deepEqual(p.today, { right: 1, wrong: 1 });
  assert.equal(p.streakDays, 1);
  const retry = await call(client, 'quiz_me', { notebook: 'Economics', focus: 'mistakes' });
  assert.equal(retry.page.title, p.weakSpots[0].page.title);
  assert.ok(fs.existsSync(path.join(lib, 'mnote-study.json')));
});

test('answers clients that send each request on its own, without a session', async () => {
  const list = await rawRequest(server.url, { body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  assert.equal(list.status, 200);
  assert.equal(list.headers['mcp-session-id'], undefined);
  assert.equal(JSON.parse(list.body).result.tools.length, 8);
  const callBody = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_page', arguments: { page: 'Key terms' } } });
  const r = JSON.parse((await rawRequest(server.url, { body: callBody })).body);
  assert.equal(r.result.structuredContent.page.title, 'Key terms');
  assert.equal((await rawRequest(server.url, { method: 'GET' })).status, 405);
});

// The answer to a question, read from the study file (the test plays a student who knows it).
function expectedOf(q) {
  return JSON.parse(fs.readFileSync(path.join(lib, 'mnote-study.json'), 'utf8')).pending[q.questionId].answer;
}

test('refuses other websites, other host names, and missing tokens', async () => {
  const evil = await rawRequest(server.url, { headers: { Origin: 'https://evil.example' }, body: INIT });
  assert.equal(evil.status, 403);
  const local = await rawRequest(server.url, { headers: { Origin: 'http://localhost:6274' }, body: INIT });
  assert.equal(local.status, 200);
  const rebind = await rawRequest(server.url, { headers: { Host: 'evil.example' }, body: INIT });
  assert.equal(rebind.status, 403);
  const unknown = await rawRequest(server.url, { headers: { 'Mcp-Session-Id': 'no-such-session' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  assert.equal(unknown.status, 404);

  const locked = await startServer(['--token', 's3cret-token']);
  try {
    assert.equal((await rawRequest(locked.url, { body: INIT })).status, 401);
    assert.equal((await rawRequest(locked.url, { headers: { Authorization: 'Bearer wrong' }, body: INIT })).status, 401);
    assert.equal((await rawRequest(locked.url, { headers: { Authorization: 'Bearer s3cret-token', Host: 'my-tunnel.example' }, body: INIT })).status, 200);
  } finally { await stop(locked); }
});

test('OAuth 2.1 for remote clients such as Alexa+: PKCE, refresh, client credentials', async () => {
  const { createHash, randomBytes } = await import('node:crypto');
  const oauthFile = path.join(lib, 'oauth-test.json');
  process.env.MNOTE_MCP_PASSWORD = 'correct horse';
  const remote = await startServer(['--public-url', 'https://mnote.example', '--oauth-file', oauthFile]);
  delete process.env.MNOTE_MCP_PASSWORD;
  const base = remote.url.replace(/\/mcp$/, '');
  const form = (url, fields, headers = {}) => rawRequest(url, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() });
  try {
    const prm = JSON.parse((await rawRequest(`${base}/.well-known/oauth-protected-resource`, { method: 'GET' })).body);
    assert.equal(prm.resource, 'https://mnote.example/mcp');
    assert.deepEqual(prm.authorization_servers, ['https://mnote.example']);
    const as = JSON.parse((await rawRequest(`${base}/.well-known/oauth-authorization-server`, { method: 'GET' })).body);
    assert.ok(as.code_challenge_methods_supported.includes('S256'));
    assert.ok(as.grant_types_supported.includes('client_credentials'));

    const anon = await rawRequest(remote.url, { body: INIT });
    assert.equal(anon.status, 401);
    assert.equal(anon.headers['www-authenticate'], undefined, 'Alexa+ wants no WWW-Authenticate header');

    const { clientId, clientSecret } = JSON.parse(fs.readFileSync(oauthFile, 'utf8'));
    const basic = { Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64') };
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const ask = { response_type: 'code', client_id: clientId, redirect_uri: 'https://alexa.example/link', state: 'st8', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp:tools mcp:resources', resource: 'https://mnote.example/mcp' };
    const consent = await rawRequest(`${base}/oauth/authorize?${new URLSearchParams(ask)}`, { method: 'GET' });
    assert.equal(consent.status, 200);
    assert.match(consent.body, /alexa\.example/);
    assert.equal((await form(`${base}/oauth/authorize`, { ...ask, decision: 'allow', passphrase: 'wrong' })).status, 401);
    const ok = await form(`${base}/oauth/authorize`, { ...ask, decision: 'allow', passphrase: 'correct horse' });
    assert.equal(ok.status, 302);
    const back = new URL(ok.headers.location);
    assert.equal(back.origin + back.pathname, 'https://alexa.example/link');
    assert.equal(back.searchParams.get('state'), 'st8');
    const code = back.searchParams.get('code');

    const swap = { grant_type: 'authorization_code', code, redirect_uri: ask.redirect_uri, code_verifier: verifier, resource: ask.resource };
    assert.equal((await form(`${base}/oauth/token`, { ...swap, code_verifier: 'x'.repeat(43) }, basic)).status, 400, 'wrong PKCE verifier');
    // That failed try used up the code, as codes are single-use: get a new one.
    const again = new URL((await form(`${base}/oauth/authorize`, { ...ask, decision: 'allow', passphrase: 'correct horse' })).headers.location).searchParams.get('code');
    const tok = await form(`${base}/oauth/token`, { ...swap, code: again }, basic);
    assert.equal(tok.status, 200);
    const t = JSON.parse(tok.body);
    assert.equal(t.token_type, 'Bearer');
    assert.ok(t.expires_in <= 3600);
    assert.equal((await form(`${base}/oauth/token`, { ...swap, code: again }, basic)).status, 400, 'a code works once');
    assert.equal((await form(`${base}/oauth/token`, { ...swap, code: again }, { Authorization: 'Basic ' + Buffer.from(`${clientId}:nope`).toString('base64') })).status, 401);

    const linked = new Client({ name: 'alexa-like', version: '1' });
    await linked.connect(new StreamableHTTPClientTransport(new URL(remote.url), { requestInit: { headers: { Authorization: `Bearer ${t.access_token}` } } }));
    try {
      const r = await call(linked, 'study_progress', {});
      assert.ok(r.cards >= 10);
    } finally { await linked.close(); }

    const refreshed = JSON.parse((await form(`${base}/oauth/token`, { grant_type: 'refresh_token', refresh_token: t.refresh_token }, basic)).body);
    assert.ok(refreshed.access_token && refreshed.refresh_token);
    assert.equal((await form(`${base}/oauth/token`, { grant_type: 'refresh_token', refresh_token: t.refresh_token }, basic)).status, 400, 'refresh tokens rotate');

    const svc = JSON.parse((await form(`${base}/oauth/token`, { grant_type: 'client_credentials' }, basic)).body);
    assert.equal(svc.scope, 'mcp:service');
    assert.equal(svc.refresh_token, undefined);
    const auth = { Authorization: `Bearer ${svc.access_token}` };
    assert.equal((await rawRequest(remote.url, { headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status, 200);
    const denied = await rawRequest(remote.url, { headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_notebooks', arguments: {} } }) });
    assert.equal(denied.status, 403, 'a service token cannot read notes');
  } finally { await stop(remote); }
});

test('MCP Apps: quiz_me and answer_quiz link the flashcard, a self-contained ui:// page', async () => {
  const { resources } = await client.listResources();
  const card = resources.find(r => r.uri.startsWith('ui://mnote/flashcard-'));
  assert.ok(card, 'the flashcard resource is listed');
  assert.equal(card.mimeType, 'text/html;profile=mcp-app');
  const { tools } = await client.listTools();
  for (const name of ['quiz_me', 'answer_quiz']) {
    const t = tools.find(x => x.name === name);
    assert.equal(t._meta?.ui?.resourceUri, card.uri, name);
    assert.equal(t._meta['ui/resourceUri'], card.uri, `${name} (older hosts)`);
  }
  assert.ok(!tools.find(t => t.name === 'read_page')._meta?.ui, 'other tools stay plain');
  const { contents: [c] } = await client.readResource({ uri: card.uri });
  assert.equal(c.mimeType, 'text/html;profile=mcp-app');
  assert.deepEqual(c._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
  assert.match(c.text, /^<!doctype html>/i);
  assert.doesNotMatch(c.text, /<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!www\.w3\.org)/i, 'no external scripts, styles or addresses');
  const { parse } = await import('parse5');
  const errors = [];
  parse(c.text, { onParseError: e => errors.push(e.code) });
  assert.deepEqual(errors, [], 'well-formed HTML');
  const vm = await import('node:vm');
  const script = /<script>([\s\S]*?)<\/script>/.exec(c.text)[1];
  assert.doesNotThrow(() => new vm.Script(script), 'the inline script compiles');
  for (const m of ['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/tool-result', 'tools/call', 'answer_quiz', 'ui/update-model-context']) assert.ok(script.includes(m), m);
  // Hosts may sandbox the card without allow-forms, where a <form> never submits.
  assert.ok(!script.includes("h('form'") && !/<form/i.test(c.text.replace(script, '')), 'answers are sent without a <form>');
  assert.match(script, /onkeydown: e => \{ if \(e\.key === 'Enter'/, 'Enter sends the answer');
  // Text-only clients get the same answers as before, plus the question that was asked.
  const q = await call(client, 'quiz_me', {});
  const r = await call(client, 'answer_quiz', { question_id: q.questionId, answer: 'x', next: false });
  assert.equal(r.question, q.question);
});
