// Alexa-like MCP Apps host: try Mnote's study coach the way Alexa+ on an Echo Show runs it,
// without a device. It is a simulation for demos, not Amazon's software.
//
// Real: the MCP connection to the Mnote server, the MCP Apps bridge (AppBridge from
// @modelcontextprotocol/ext-apps), and the flashcard, rendered the way Amazon's docs describe:
// a sandboxed iframe with an opaque origin, the card's CSP enforced, touch input, a fixed device
// canvas, and a host that accepts ui/update-model-context.
// Simulated: Alexa's model (a few phrases matched by rules), speech (the browser's speech APIs),
// and device sizes (from Amazon's design guide).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AppBridge, PostMessageTransport, getToolUiResourceUri } from '@modelcontextprotocol/ext-apps/app-bridge';
import { intentOf } from './intent.js';

const params = new URLSearchParams(location.search);
const SERVER = params.get('server') || document.querySelector('meta[name="mnote-mcp-server"]')?.content || 'http://127.0.0.1:47880/mcp';

// Amazon: Alexa+ UI is authored on a 768x480 base canvas and scaled per device class (root scale
// 1.667 for the 1280x800 Echo Show 8 and 15). h 0 means the frame grows with the card (web chat).
const DEVICES = {
  show8: { label: 'Echo Show 8 / 15 (1280x800)', w: 768, h: 480, scale: 1.667, touch: true, platform: 'mobile' },
  show5: { label: 'Echo Show 5 (960x480)', w: 960, h: 480, scale: 1, touch: true, platform: 'mobile' },
  phone: { label: 'Alexa app on a phone', w: 390, h: 844, scale: 1, touch: true, platform: 'mobile' },
  web: { label: 'Alexa on the web', w: 720, h: 0, scale: 1, touch: false, platform: 'web' },
};

const $ = id => document.getElementById(id);
const state = {
  client: null, tools: [],
  device: DEVICES[params.get('device')] ? params.get('device') : 'show8',
  theme: params.get('theme') === 'light' ? 'light' : 'dark',
  bridge: null, iframe: null, cards: 0,
  asked: null,         // the question the model itself last saw (quiz_me, or answer_quiz's "next")
  cardContext: '',     // what the card on screen last told the model
  voice: params.get('voice') !== 'off',
  busy: false,
  choosing: null,      // page names, after "which one?"
};
window.sim = { state, hear };   // for poking at it from the console

// ---------------------------------------------------------------- log and conversation

function log(dir, what, detail) {
  const li = document.createElement('li');
  li.textContent = `${new Date().toISOString().slice(11, 19)} ${dir} ${what}${detail ? ' ' + JSON.stringify(detail).slice(0, 400) : ''}`;
  $('log').prepend(li);
}

function turn(who, text) {
  const li = document.createElement('li');
  li.className = who;
  const b = document.createElement('b');
  b.textContent = who === 'you' ? 'You' : 'Alexa';
  li.append(b, ' ', text);
  $('chat').append(li);
  li.scrollIntoView({ block: 'nearest' });
}

function say(text) {
  turn('alexa', text);
  if (state.voice && 'speechSynthesis' in window) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    speechSynthesis.speak(u);
  }
}

// ---------------------------------------------------------------- the model (simulated)

const textOf = r => (r?.content || []).find(c => c.type === 'text')?.text || '';
// A spoken answer goes to the question on screen: the card says which one through the model
// context; otherwise it is the question the model asked itself.
const pendingId = () => /question_id "([^"]+)"/.exec(state.cardContext)?.[1] || state.asked?.questionId || null;

// What the card on screen said about its question (see tellModel in the flashcard).
const cardQuestion = id => new RegExp(`question ${id}: "(.*?)"\\.`).exec(state.cardContext)?.[1] || null;
const cardHint = () => /Hint \(only if they ask\): (.+?)\.(?:\s|$)/.exec(state.cardContext)?.[1] || null;
const ORDINAL = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, last: -1 };

/** One thing the person says to Alexa. */
async function hear(utterance) {
  const said = String(utterance || '').trim();
  if (!said || state.busy) return;
  turn('you', said);
  state.busy = true;
  try {
    // Requests are told apart from answers first (intent.js): "test my knowledge" mid-quiz asks
    // for a quiz; it is not a wrong answer.
    const it = intentOf(said, { pending: !!pendingId() });
    const choosing = state.choosing;
    state.choosing = null;
    if (choosing && it.kind === 'answer') {
      const n = ORDINAL[/\b(first|second|third|last|1st|2nd|3rd)\b/i.exec(said)?.[1]?.toLowerCase()];
      await quizOn(n === undefined ? said : choosing.at(n), true);
    } else if (it.kind === 'quiz') await quizOn(it.topic);
    else if (it.kind === 'hint') hint();
    else if (it.kind === 'repeat') repeat();
    else if (it.kind === 'progress') await progress();
    else if (it.kind === 'stop') say('Good work. Your progress is saved, so we can pick up where you left off.');
    else if (pendingId()) await answer(said);
    else say('Say "quiz me" to start a quiz from your highlights.');
  } catch (err) {
    say(`Sorry, something went wrong: ${err.message}`);
  } finally { state.busy = false; }
}

async function callTool(name, args) {
  log('Alexa → server', `tools/call ${name}`, args);
  const r = await state.client.callTool({ name, arguments: args });
  log('server → Alexa', `${name} result`, { isError: !!r.isError, ...pick(r.structuredContent, ['questionId', 'correct', 'expected']) });
  return r;
}
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && k in o).map(k => [k, o[k]]));

/**
 * A quiz on what was asked for, scoped the way an assistant would: a notebook, else a section,
 * else a page. When the name fits several pages, it asks which one.
 */
async function quizOn(topic, pageOnly = false) {
  if (!topic) return quiz({});
  for (const key of pageOnly ? ['page'] : ['notebook', 'section', 'page']) {
    const args = { [key]: topic };
    const r = await callTool('quiz_me', args);
    // Found, but nothing highlighted there: an assistant would offer the rest of the notes.
    const there = r.structuredContent;
    if (!r.isError && there?.available === false && /has no highlights yet/.test(there.speech || '')) {
      return quiz({}, `${there.speech.replace(/ Your other notes.*$/, '')} Here's one from all your notes instead. `);
    }
    if (!r.isError) return present(args, r);
    const which = /^Which page\? (.+)$/s.exec(textOf(r));
    if (which) {
      state.choosing = [...which[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
      const names = state.choosing.map(n => `"${n}"`);
      return say(`"${topic}" fits ${names.length} pages: ${names.slice(0, -1).join(', ')} and ${names.at(-1)}. Which one?`);
    }
  }
  return quiz({}, `I couldn't find "${topic}" in your notes, so here's a question from all of them. `);
}

async function quiz(args, lead = '') {
  return present(args, await callTool('quiz_me', args), lead);
}

async function present(args, r, lead = '') {
  if (r.isError) return say(lead + textOf(r));
  const q = r.structuredContent;
  state.asked = q?.available ? q : null;
  say(lead + (q?.speech || textOf(r)));
  await show('quiz_me', args, r);
}

async function answer(words) {
  const args = { question_id: pendingId(), answer: words };
  const r = await callTool('answer_quiz', args);
  if (r.isError) return say(textOf(r));
  const a = r.structuredContent;
  state.asked = a?.next?.available ? a.next : null;
  say(a?.speech || textOf(r));
  await show('answer_quiz', args, r);
}

function hint() {
  const id = pendingId();
  // The model knows hints from tool results it saw itself, and from what the card told it.
  const h = id && (state.asked?.questionId === id ? state.asked.hint : cardHint());
  if (h) say(`Here's a hint: ${h}.`);
  else if (id) say('Tap Hint on the screen for that one.');
  else say('There is no question yet. Say "quiz me" to start.');
}

function repeat() {
  const id = pendingId();
  if (id && state.asked?.questionId === id) return say(state.asked.speech);
  const q = id && cardQuestion(id);
  if (q) return say(`The question on the screen is: ${q.replace(/_____/g, 'blank')}. What fills the blank?`);
  say('There is no question yet. Say "quiz me" to start.');
}

async function progress() {
  const r = await callTool('study_progress', {});
  say(r.structuredContent?.speech || textOf(r));
}

// ---------------------------------------------------------------- rendering the card

function cspFor(ui) {
  const c = ui?.csp || {};
  const extra = list => (list || []).join(' ');
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${extra(c.resourceDomains)}`,
    `style-src 'unsafe-inline' ${extra(c.resourceDomains)}`,
    `img-src data: ${extra(c.resourceDomains)}`,
    `font-src data: ${extra(c.resourceDomains)}`,
    `media-src data: ${extra(c.resourceDomains)}`,
    `connect-src ${extra(c.connectDomains) || "'none'"}`,
    "frame-src 'none'",
    "base-uri 'none'",
  ].map(s => s.trim()).join('; ');
}

function hostContext(tool) {
  const d = DEVICES[state.device];
  return {
    ...(tool ? { toolInfo: { tool } } : {}),
    theme: state.theme,
    displayMode: 'inline',
    availableDisplayModes: ['inline'],
    containerDimensions: d.h ? { width: d.w, height: d.h } : { width: d.w, maxHeight: 2000 },
    platform: d.platform,
    deviceCapabilities: { touch: d.touch, hover: !d.touch },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    locale: 'en-US',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: 'mnote-alexa-sim',
  };
}

function layoutFrame(height) {
  const d = DEVICES[state.device];
  const h = d.h || height || 300;
  // Room for the screen: the page minus its padding, the bezel, and (side by side) the talk column.
  const room = Math.max(260, window.innerWidth >= 1000 ? window.innerWidth - 470 : window.innerWidth - 64);
  const fit = Math.min(1, room / (d.w * d.scale));
  const frame = $('frame');
  frame.style.width = `${d.w}px`;
  frame.style.height = `${h}px`;
  const s = d.scale * fit;
  frame.style.transform = s === 1 ? 'none' : `scale(${s})`;
  frame.parentElement.style.width = `${Math.round(d.w * d.scale * fit)}px`;
  frame.parentElement.style.height = `${Math.round(h * d.scale * fit)}px`;
  $('device-label').textContent = d.label;
}

/** A new card for a tool result, as Alexa+ renders one for each tool call that has a UI. */
async function show(toolName, args, result) {
  const tool = state.tools.find(t => t.name === toolName);
  const uri = tool && getToolUiResourceUri(tool);
  if (!uri) return;
  const res = await state.client.readResource({ uri });
  const content = res.contents[0];
  const html = content.text.replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="${cspFor(content._meta?.ui)}">`);

  // The host may only message a card once it has initialized; then ask the old one to wrap up.
  if (state.bridge) {
    const old = state.bridge;
    await Promise.race([old.ready, sleep(3000)]);
    await Promise.race([old.teardownResource({ reason: 'replaced' }).catch(() => {}), sleep(2000)]);
    old.close().catch(() => {});
  }
  state.cardContext = '';
  $('context').textContent = '(nothing yet)';

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');   // opaque origin: no storage, no access to this page
  iframe.setAttribute('title', 'Mnote flashcard');
  $('frame').replaceChildren(iframe);
  state.iframe = iframe;
  layoutFrame();

  const n = ++state.cards;
  const bridge = new AppBridge(state.client, { name: 'mnote-alexa-sim', version: '1.0.0' }, {
    serverTools: {}, serverResources: {}, logging: {}, updateModelContext: { text: {} },
    sandbox: { csp: content._meta?.ui?.csp || {} },
  }, { hostContext: hostContext(tool) });
  let ready;
  bridge.ready = new Promise(r => { ready = r; });
  bridge.oninitialized = async () => {
    ready();
    log('card → Alexa', `#${n} initialized`);
    await bridge.sendToolInput({ arguments: args });
    await bridge.sendToolResult(result);
  };
  bridge.onupdatemodelcontext = async p => {
    state.cardContext = (p.content || []).filter(c => c.type === 'text').map(c => c.text).join(' ');
    $('context').textContent = state.cardContext;
    log('card → Alexa', `#${n} ui/update-model-context`, { text: state.cardContext });
    return {};
  };
  bridge.onsizechange = p => { if (!DEVICES[state.device].h) layoutFrame(p.height); };
  bridge.onloggingmessage = p => log('card → Alexa', `#${n} log`, p);
  bridge.onrequestdisplaymode = async () => ({ mode: 'inline' });
  state.bridge = bridge;
  await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
  // connect() wires tools/call straight to the client; wrap it so the card's calls show in the log.
  bridge.oncalltool = async p => {
    log('card → server', `#${n} tools/call ${p.name}`, p.arguments);
    const r = await state.client.callTool(p);
    log('server → card', `#${n} ${p.name} result`, { isError: !!r.isError, ...pick(r.structuredContent, ['correct', 'expected']) });
    return r;
  };
  iframe.srcdoc = html;
  log('Alexa', `#${n} shows ${uri} for ${toolName}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- controls

async function setDevice(key) {
  state.device = key;
  layoutFrame();
  // Like a rotation or a move to another screen: same card, new host context.
  await state.bridge?.sendHostContextChange(hostContext());
}

async function setTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  $('theme').textContent = theme === 'dark' ? 'Light theme' : 'Dark theme';
  await state.bridge?.sendHostContextChange({ theme });
}

function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $('mic').hidden = true; return; }
  $('mic').onclick = () => {
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.onresult = e => hear(e.results[0][0].transcript);
    rec.onerror = e => log('Alexa', 'speech recognition', { error: e.error });
    rec.onend = () => $('mic').classList.remove('on');
    $('mic').classList.add('on');
    rec.start();
  };
}

async function main() {
  for (const [key, d] of Object.entries(DEVICES)) $('device').add(new Option(d.label, key, false, key === state.device));
  $('device').onchange = e => setDevice(e.target.value);
  $('theme').onclick = () => setTheme(state.theme === 'dark' ? 'light' : 'dark');
  $('voice').checked = state.voice;
  $('voice').onchange = e => { state.voice = e.target.checked; if (!state.voice) speechSynthesis?.cancel(); };
  $('say').onsubmit = e => { e.preventDefault(); const v = $('words').value; $('words').value = ''; hear(v); };
  for (const b of document.querySelectorAll('[data-say]')) b.onclick = () => hear(b.dataset.say);
  window.addEventListener('resize', () => layoutFrame(state.iframe?.offsetHeight));
  await setTheme(state.theme);
  setupMic();
  layoutFrame();

  state.client = new Client({ name: 'mnote-alexa-sim', version: '1.0.0' }, {
    capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
  });
  await state.client.connect(new StreamableHTTPClientTransport(new URL(SERVER)));
  state.tools = (await state.client.listTools()).tools;
  const ui = state.tools.filter(t => getToolUiResourceUri(t)).map(t => t.name);
  log('Alexa', 'connected', { server: SERVER, protocol: state.client.transport?.protocolVersion, toolsWithUi: ui });
  $('status').textContent = `Connected to ${SERVER}`;
  $('status').className = 'ok';
}

main().catch(err => {
  $('status').textContent = `Can't reach the Mnote MCP server at ${SERVER}: ${err.message}. Start it first (see the README).`;
  $('status').className = 'bad';
});
