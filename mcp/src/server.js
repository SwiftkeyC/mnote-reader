#!/usr/bin/env node
// Mnote MCP server: a self-hosted Model Context Protocol server (spec 2025-11-25, Streamable
// HTTP) over your Mnote library. Run it with:  node src/server.js --library "<export folder>"
import http from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseArgs } from 'node:util';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { Library, defaultLibraryDir } from './library.js';
import { StudyCoach } from './study.js';
import { createMnoteServer, SERVER_VERSION } from './tools.js';
import { OAuthServer, defaultOAuthFile, USER_SCOPES } from './oauth.js';

const HELP = `Mnote MCP server ${SERVER_VERSION} (MCP ${LATEST_PROTOCOL_VERSION}, Streamable HTTP)

  node src/server.js [--library <folder or .mnotebook>] [--port 47880] [--host 127.0.0.1]

  --library     Your Mnote export folder, or one .mnotebook file.
                Default: $MNOTE_LIBRARY, else Documents\\OneNote Export.
  --port        Default: $MNOTE_MCP_PORT, else 47880.
  --host        Address to listen on. Default 127.0.0.1 (this PC only).
  --token       Require "Authorization: Bearer <token>". Default: $MNOTE_MCP_TOKEN.
  --public-url  The https address the server is reached at from the internet (for example
                a cloudflared tunnel). Turns on OAuth 2.1 sign-in for remote clients such as
                Alexa+. Default: $MNOTE_MCP_PUBLIC_URL.
  --allow-origin <origin>   Also accept browser requests from this origin (repeatable).

Listening on any address other than this PC always needs a token or OAuth; a token is made
up for you if you give neither. The MCP endpoint is http://<host>:<port>/mcp`;

const { values, positionals } = parseArgs({
  options: {
    library: { type: 'string', short: 'l' },
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    token: { type: 'string' },
    'public-url': { type: 'string' },
    'oauth-file': { type: 'string' },
    'allow-origin': { type: 'string', multiple: true },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
});
if (values.help) { console.log(HELP); process.exit(0); }

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const host = values.host || process.env.MNOTE_MCP_HOST || '127.0.0.1';
const port = Number(values.port || process.env.MNOTE_MCP_PORT || 47880);
const publicUrl = values['public-url'] || process.env.MNOTE_MCP_PUBLIC_URL || '';
let token = values.token || process.env.MNOTE_MCP_TOKEN || '';
let madeToken = false;
if (!LOOPBACK.has(host) && !token && !publicUrl) { token = randomBytes(24).toString('base64url'); madeToken = true; }
const allowOrigins = new Set(values['allow-origin'] || []);

const log = msg => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${msg}\n`);

let library, oauth = null;
try {
  library = new Library(values.library || positionals[0] || process.env.MNOTE_LIBRARY || defaultLibraryDir());
  if (publicUrl) {
    if (!/^https:\/\//i.test(publicUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(publicUrl)) throw new Error('--public-url must be an https:// address.');
    oauth = new OAuthServer({
      publicUrl, file: values['oauth-file'] || process.env.MNOTE_OAUTH_FILE || defaultOAuthFile(),
      clientId: process.env.MNOTE_OAUTH_CLIENT_ID, clientSecret: process.env.MNOTE_OAUTH_CLIENT_SECRET, password: process.env.MNOTE_MCP_PASSWORD,
      redirectUris: (process.env.MNOTE_OAUTH_REDIRECT_URIS || '').split(',').map(s => s.trim()).filter(Boolean),
      log,
    });
  }
} catch (err) { console.error(`Mnote MCP server could not start: ${err.message}`); process.exit(1); }
const coach = new StudyCoach(library);
const authOn = !!(token || oauth);

// ---------------------------------------------------------------- request checks

const hostName = h => {
  if (!h) return '';
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0].toLowerCase();
};

/** The scopes the request may use, or null when it is not signed in. */
function authorize(req) {
  if (!authOn) return USER_SCOPES;
  const header = req.headers.authorization || '';
  if (token) {
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (m) { const a = Buffer.from(m[1].trim()), b = Buffer.from(token); if (a.length === b.length && timingSafeEqual(a, b)) return USER_SCOPES; }
  }
  return oauth?.verify(header) || null;
}

// A service token (OAuth client credentials) may look at the server, and fetch the flashcard UI
// (hosts may load ui:// pages ahead of time), but not at the notes.
const SERVICE_METHODS = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list', 'prompts/list', 'resources/list', 'resources/templates/list']);
const serviceOk = m => SERVICE_METHODS.has(m?.method) || (m?.method === 'resources/read' && String(m.params?.uri || '').startsWith('ui://'));

// Browsers send Origin; MCP clients outside a browser don't. A web page from anywhere else must
// not reach your notes (the spec requires this check against DNS rebinding).
function originOk(origin) {
  if (!origin) return true;
  if (allowOrigins.has(origin)) return true;
  try { return LOOPBACK.has(new URL(origin).hostname); } catch { return false; }
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
const rpcError = (res, status, code, message) => sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- sessions
// A client that initializes gets a session (Mcp-Session-Id), which elicitation needs. Requests
// without one are answered statelessly, for clients that send every call on its own. Nothing a
// tool does depends on the session: notes and study progress are saved in files.

const sessions = new Map(); // session id -> { transport, seen }
const IDLE_MS = 60 * 60 * 1000;
const serverLog = m => log(`  ${m}`);

async function newSession() {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: id => { sessions.set(id, { transport, seen: Date.now() }); log(`session ${id.slice(0, 8)} started`); },
  });
  transport.onclose = () => {
    if (transport.sessionId && sessions.delete(transport.sessionId)) log(`session ${transport.sessionId.slice(0, 8)} closed`);
  };
  await createMnoteServer({ library, coach, log: serverLog }).connect(transport);
  return transport;
}

async function handleStateless(req, res, body) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = createMnoteServer({ library, coach, log: serverLog });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

setInterval(() => {
  const now = Date.now();
  for (const [, s] of sessions) if (now - s.seen > IDLE_MS) s.transport.close().catch(() => {});
}, 5 * 60 * 1000).unref();

async function handleMcp(req, res, scopes) {
  const sid = req.headers['mcp-session-id'];
  const known = sid ? sessions.get(sid) : null;
  if (known) known.seen = Date.now();

  if (req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (err) { return err.status === 413 ? rpcError(res, 413, -32600, 'Request too large') : rpcError(res, 400, -32700, 'Parse error'); }
    const messages = Array.isArray(body) ? body : [body];
    if (!scopes.includes('mcp:tools') && messages.some(m => !serviceOk(m))) {
      return rpcError(res, 403, -32001, 'This token can only list what the server offers. Link your account to use the tools.');
    }
    if (known) return known.transport.handleRequest(req, res, body);
    if (sid) return rpcError(res, 404, -32001, 'Session not found. Start a new session.');
    if (messages.some(m => isInitializeRequest(m))) return (await newSession()).handleRequest(req, res, body);
    return handleStateless(req, res, body);
  }
  if (req.method === 'GET') {
    if (known) return known.transport.handleRequest(req, res);
    if (sid) return rpcError(res, 404, -32001, 'Session not found.');
    return res.writeHead(405, { Allow: 'POST, DELETE' }).end();   // no stream without a session
  }
  if (req.method === 'DELETE') {
    if (!known) return rpcError(res, sid ? 404 : 400, sid ? -32001 : -32000, sid ? 'Session not found.' : 'Missing Mcp-Session-Id header.');
    return known.transport.handleRequest(req, res);
  }
  res.writeHead(405, { Allow: 'GET, POST, DELETE' }).end();
}

const httpServer = http.createServer(async (req, res) => {
  const t0 = Date.now();
  try {
    const url = new URL(req.url, 'http://localhost');
    // Without sign-in, only requests addressed to this PC by name are answered (DNS rebinding).
    if (!authOn && !LOOPBACK.has(hostName(req.headers.host))) return sendJson(res, 403, { error: 'Forbidden host' });
    if (!originOk(req.headers.origin)) return sendJson(res, 403, { error: 'Forbidden origin' });
    cors(req, res);
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`Mnote MCP server ${SERVER_VERSION}\nMCP ${LATEST_PROTOCOL_VERSION} over Streamable HTTP at /mcp\n`);
    }
    if (oauth && await oauth.handle(req, res, url, readBody)) return;
    if (url.pathname !== '/mcp') return sendJson(res, 404, { error: 'Not found. The MCP endpoint is /mcp' });
    const scopes = authorize(req);
    // No WWW-Authenticate header: Alexa+ asks for that. Clients find the sign-in server through
    // /.well-known/oauth-protected-resource instead (RFC 9728), which the MCP spec allows.
    if (!scopes) return sendJson(res, 401, { error: 'Unauthorized' });
    // Alexa+ expects an answer within 500 ms.
    if (req.method === 'POST') res.on('finish', () => { const ms = Date.now() - t0; if (ms > 500) log(`slow request: ${ms}ms`); });
    await handleMcp(req, res, scopes);
  } catch (err) {
    log(`error: ${err.stack || err.message}`);
    if (!res.headersSent) rpcError(res, 500, -32603, 'Internal error');
    else res.end();
  }
});

httpServer.on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use. Pick another with --port.` : err.message);
  process.exit(1);
});

httpServer.listen(port, host, () => {
  const lib = library.snapshot();   // also warms the cache, so the first call is fast
  const shown = host.includes(':') ? `[${host}]` : host;
  console.log(`Mnote MCP server ${SERVER_VERSION} (MCP ${LATEST_PROTOCOL_VERSION}, Streamable HTTP)`);
  console.log(`  Library:  ${library.only || library.root}`);
  console.log(`            ${lib.notebooks.length} notebook(s), ${lib.pages.length} page(s)`);
  console.log(`  Endpoint: http://${shown}:${httpServer.address().port}/mcp`);
  if (oauth) {
    const c = oauth.credentials;
    console.log(`  Public:   ${oauth.resource}  (OAuth 2.1 sign-in)`);
    console.log(`            authorization: ${oauth.base}/oauth/authorize`);
    console.log(`            token:         ${oauth.base}/oauth/token`);
    console.log(`            client ID:     ${c.clientId}`);
    console.log(`            client secret: ${c.clientSecret}`);
    console.log(`            passphrase:    ${c.passphrase}   (you type this when you link an app)`);
    console.log(`            saved in ${oauth.file}`);
  }
  if (token) console.log(madeToken ? `  Token:    ${token}   (send "Authorization: Bearer <token>")` : '  Token:    required (Authorization: Bearer ...)');
  if (!authOn) console.log('  Only this PC can connect. Press Ctrl+C to stop.');
});

async function shutdown() {
  for (const [, s] of sessions) await s.transport.close().catch(() => {});
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
