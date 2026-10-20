// A small OAuth 2.1 authorization server for one person's MCP server, so a remote client such as
// Alexa+ can link to it: authorization code with PKCE (S256) for the person, client credentials
// for the service, refresh tokens, and the discovery documents (RFC 9728 and RFC 8414).
// The person approves a link by typing their Mnote passphrase on the consent page. Secrets live
// in %LOCALAPPDATA%\Mnote\mcp-oauth.json, outside the notes folder; tokens are kept hashed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const USER_SCOPES = ['mcp:tools', 'mcp:resources'];
export const SERVICE_SCOPE = 'mcp:service';
const SCOPES = [...USER_SCOPES, SERVICE_SCOPE];
const ACCESS_TTL = 3600;
const REFRESH_TTL = 90 * 24 * 3600;
const CODE_TTL = 300;

const sha = s => createHash('sha256').update(String(s)).digest('base64url');
const rand = (n = 32) => randomBytes(n).toString('base64url');
const same = (a, b) => { const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? '')); return x.length === y.length && timingSafeEqual(x, y); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function defaultOAuthFile() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.config'), 'Mnote', 'mcp-oauth.json');
}

function okRedirect(uri, allowed) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  if (allowed.length) return allowed.includes(uri);
  return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
}

export class OAuthServer {
  constructor({ publicUrl, file = defaultOAuthFile(), clientId, clientSecret, password, redirectUris = [], log = () => {} }) {
    this.base = publicUrl.replace(/\/+$/, '');
    this.resource = this.base + '/mcp';
    this.file = file;
    this.allowedRedirects = redirectUris;
    this.log = log;
    let s = {};
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
    this.state = { clientId: s.clientId, clientSecret: s.clientSecret, password: s.password, tokens: s.tokens || {} };
    this.made = [];
    if (clientId) this.state.clientId = clientId; else if (!this.state.clientId) { this.state.clientId = 'mnote-' + rand(6); this.made.push('client ID'); }
    if (clientSecret) this.state.clientSecret = clientSecret; else if (!this.state.clientSecret) { this.state.clientSecret = rand(24); this.made.push('client secret'); }
    if (password) this.state.password = password; else if (!this.state.password) { this.state.password = rand(9); this.made.push('passphrase'); }
    this.codes = new Map();
    this.failed = { count: 0, until: 0 };
    this.prune();
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.saving';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  prune() {
    const now = Date.now() / 1000;
    for (const [k, t] of Object.entries(this.state.tokens)) if (t.exp < now) delete this.state.tokens[k];
  }

  get credentials() { return { clientId: this.state.clientId, clientSecret: this.state.clientSecret, passphrase: this.state.password }; }

  metadata() {
    return {
      resource: {
        resource: this.resource, authorization_servers: [this.base], scopes_supported: SCOPES,
        bearer_methods_supported: ['header'], resource_name: 'Mnote',
      },
      server: {
        issuer: this.base,
        authorization_endpoint: `${this.base}/oauth/authorize`,
        token_endpoint: `${this.base}/oauth/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: SCOPES,
      },
    };
  }

  /** The scopes of a valid access token in an Authorization header, or null. */
  verify(header) {
    const m = /^Bearer\s+(\S+)$/i.exec(header || '');
    if (!m) return null;
    const t = this.state.tokens[sha(m[1])];
    if (!t || t.type !== 'access' || t.exp < Date.now() / 1000) return null;
    return t.scope.split(' ');
  }

  issue(type, scope, ttl) {
    const token = rand();
    this.state.tokens[sha(token)] = { type, scope, client: this.state.clientId, exp: Math.floor(Date.now() / 1000) + ttl };
    return token;
  }

  /** Handles the OAuth routes; returns false for any other path. */
  async handle(req, res, url, readBody) {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache', ...headers });
      res.end(JSON.stringify(body));
    };
    const meta = this.metadata();
    switch (url.pathname) {
      case '/.well-known/oauth-protected-resource':
      case '/.well-known/oauth-protected-resource/mcp':
        send(200, meta.resource, { 'Access-Control-Allow-Origin': '*' });
        return true;
      case '/.well-known/oauth-authorization-server':
      case '/.well-known/oauth-authorization-server/mcp':
        send(200, meta.server, { 'Access-Control-Allow-Origin': '*' });
        return true;
      case '/oauth/authorize':
        await this.authorize(req, res, url, readBody);
        return true;
      case '/oauth/token':
        if (req.method !== 'POST') { send(405, { error: 'invalid_request', error_description: 'Use POST' }); return true; }
        await this.token(req, res, new URLSearchParams(await readBody(req, 64 * 1024)), send);
        return true;
      default:
        return false;
    }
  }

  async authorize(req, res, url, readBody) {
    const p = req.method === 'POST' ? new URLSearchParams(await readBody(req, 64 * 1024)) : url.searchParams;
    const get = k => p.get(k) || '';
    const redirectUri = get('redirect_uri');
    const page = (status, html, redirectOrigin) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${redirectOrigin ? ' ' + redirectOrigin : ''}; frame-ancestors 'none'`,
      });
      res.end(html);
    };
    // Bad client or redirect address: say so here, never redirect anywhere.
    if (!same(get('client_id'), this.state.clientId)) return page(400, consentPage({ error: 'This app is not registered with your Mnote server (unknown client_id).' }));
    if (!okRedirect(redirectUri, this.allowedRedirects)) return page(400, consentPage({ error: 'The redirect address is not allowed.' }));
    const back = new URL(redirectUri);
    const redirect = params => {
      for (const [k, v] of Object.entries(params)) back.searchParams.set(k, v);
      if (get('state')) back.searchParams.set('state', get('state'));
      res.writeHead(302, { Location: back.toString(), 'Cache-Control': 'no-store' }).end();
    };
    if (get('response_type') !== 'code') return redirect({ error: 'unsupported_response_type' });
    if (!get('code_challenge') || get('code_challenge_method') !== 'S256') return redirect({ error: 'invalid_request', error_description: 'PKCE with S256 is required' });
    const resource = get('resource');
    if (resource && resource !== this.resource && resource !== this.base) return redirect({ error: 'invalid_target' });
    const asked = get('scope').split(' ').filter(Boolean);
    if (asked.some(s => !USER_SCOPES.includes(s))) return redirect({ error: 'invalid_scope' });
    const scope = (asked.length ? asked : USER_SCOPES).join(' ');
    const hidden = Object.fromEntries(['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource', 'response_type'].map(k => [k, get(k)]));

    if (req.method !== 'POST') return page(200, consentPage({ hidden, to: back.host }), back.origin);
    if (get('decision') !== 'allow') return redirect({ error: 'access_denied' });
    if (Date.now() < this.failed.until) return page(429, consentPage({ hidden, to: back.host, error: 'Too many wrong passphrases. Wait 10 minutes and try again.' }), back.origin);
    if (!same(get('passphrase'), this.state.password)) {
      await new Promise(r => setTimeout(r, 1000));
      if (++this.failed.count >= 10) { this.failed = { count: 0, until: Date.now() + 10 * 60 * 1000 }; }
      this.log('oauth: wrong passphrase on the consent page');
      return page(401, consentPage({ hidden, to: back.host, error: 'That passphrase is not right.' }), back.origin);
    }
    this.failed.count = 0;
    const code = rand();
    this.codes.set(sha(code), { redirectUri, challenge: get('code_challenge'), scope, exp: Date.now() + CODE_TTL * 1000 });
    this.log(`oauth: link approved for ${back.host}`);
    redirect({ code });
  }

  async token(req, res, p, send) {
    // Client authentication: HTTP Basic (RFC 6749 2.3.1), or client_id / client_secret in the body.
    let id = p.get('client_id'), secret = p.get('client_secret'), basic = false;
    const m = /^Basic\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (m) {
      const [u, s] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
      id = decodeURIComponent((u || '').replace(/\+/g, ' ')); secret = decodeURIComponent((s || '').replace(/\+/g, ' ')); basic = true;
    }
    if (!same(id, this.state.clientId) || !same(secret, this.state.clientSecret)) {
      await new Promise(r => setTimeout(r, 500));
      return send(401, { error: 'invalid_client' }, basic ? { 'WWW-Authenticate': 'Basic realm="mnote"' } : {});
    }
    const grant = p.get('grant_type');
    const tokens = scope => {
      const out = { access_token: this.issue('access', scope, ACCESS_TTL), token_type: 'Bearer', expires_in: ACCESS_TTL, scope };
      if (scope !== SERVICE_SCOPE) out.refresh_token = this.issue('refresh', scope, REFRESH_TTL);
      this.prune(); this.save();
      return out;
    };
    if (grant === 'authorization_code') {
      const key = sha(p.get('code') || '');
      const c = this.codes.get(key);
      this.codes.delete(key);
      if (!c || c.exp < Date.now()) return send(400, { error: 'invalid_grant', error_description: 'The code is unknown, used or expired' });
      if (p.get('redirect_uri') && p.get('redirect_uri') !== c.redirectUri) return send(400, { error: 'invalid_grant', error_description: 'redirect_uri does not match' });
      const verifier = p.get('code_verifier') || '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !same(sha(verifier), c.challenge)) return send(400, { error: 'invalid_grant', error_description: 'PKCE check failed' });
      const resource = p.get('resource');
      if (resource && resource !== this.resource && resource !== this.base) return send(400, { error: 'invalid_target' });
      return send(200, tokens(c.scope));
    }
    if (grant === 'refresh_token') {
      const key = sha(p.get('refresh_token') || '');
      const t = this.state.tokens[key];
      if (!t || t.type !== 'refresh' || t.exp < Date.now() / 1000) return send(400, { error: 'invalid_grant' });
      delete this.state.tokens[key];   // refresh tokens are used once (rotation)
      return send(200, tokens(t.scope));
    }
    if (grant === 'client_credentials') {
      const asked = (p.get('scope') || SERVICE_SCOPE).split(' ').filter(Boolean);
      if (asked.some(s => s !== SERVICE_SCOPE)) return send(400, { error: 'invalid_scope', error_description: 'Client credentials only get mcp:service' });
      return send(200, tokens(SERVICE_SCOPE));
    }
    return send(400, { error: 'unsupported_grant_type' });
  }
}

function consentPage({ hidden, to, error }) {
  const fields = hidden ? Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('') : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link Mnote</title>
<style>
:root { --bg: #f6f4fa; --card: #fff; --fg: #1f1f1f; --muted: #6b6b6b; --accent: #6d3fc0; --err: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg: #17151c; --card: #221f29; --fg: #ece9f1; --muted: #a8a3b3; --accent: #a98be8; --err: #f2b8b5; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 16px/1.5 "Segoe UI", system-ui, sans-serif; }
main { width: min(420px, calc(100% - 32px)); background: var(--card); border-radius: 14px; padding: 28px; box-shadow: 0 6px 30px rgba(0,0,0,.12); }
h1 { font-size: 20px; margin: 0 0 8px; } p { margin: 0 0 16px; color: var(--muted); }
label { display: block; font-weight: 600; margin-bottom: 6px; }
input[type=password] { box-sizing: border-box; width: 100%; padding: 10px 12px; font: inherit; border: 1px solid var(--muted); border-radius: 8px; background: transparent; color: inherit; }
.row { display: flex; flex-direction: row-reverse; gap: 10px; margin-top: 18px; } button { flex: 1; padding: 10px; font: inherit; border-radius: 8px; border: 1px solid var(--accent); cursor: pointer; }
.allow { background: var(--accent); color: #fff; } .deny { background: transparent; color: var(--accent); }
.err { color: var(--err); font-weight: 600; } b { color: var(--fg); }
</style></head><body><main>
<h1>Link your Mnote library</h1>
${error ? `<p class="err">${esc(error)}</p>` : ''}
${hidden ? `<p><b>${esc(to)}</b> wants to read your notes, highlights and study progress, and add notes to them.</p>
<form method="post" action="/oauth/authorize">${fields}
<label for="pp">Your Mnote passphrase</label>
<input id="pp" name="passphrase" type="password" autocomplete="current-password" autofocus>
<div class="row"><button class="allow" name="decision" value="allow">Allow</button><button class="deny" name="decision" value="deny">Deny</button></div>
</form>` : ''}
</main></body></html>`;
}
