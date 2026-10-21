#!/usr/bin/env node
// Serves the Alexa-like simulator on this PC:  npm run sim [-- --port 47890 --server <MCP URL>]
// Start the Mnote MCP server first; the page connects to it from your browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildSim } from './build.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { port: { type: 'string' }, server: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
if (values.help) {
  console.log('npm run sim -- [--port 47890] [--server http://127.0.0.1:47880/mcp]');
  process.exit(0);
}
const port = Number(values.port || 47890);
const server = values.server || 'http://127.0.0.1:47880/mcp';

let bundle;
try { bundle = await buildSim(); } catch (err) { console.error(`Could not build the simulator: ${err.message}`); process.exit(1); }
const page = fs.readFileSync(path.join(here, 'index.html'));

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (type, body) => { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
  if (url.pathname === '/' || url.pathname === '/index.html') return send('text/html; charset=utf-8', page);
  if (url.pathname === '/sim.js') return send('text/javascript; charset=utf-8', bundle);
  res.writeHead(404).end();
}).on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use. Pick another with --port.` : err.message);
  process.exit(1);
}).listen(port, '127.0.0.1', () => {
  const open = `http://127.0.0.1:${port}/` + (values.server ? `?server=${encodeURIComponent(server)}` : '');
  console.log('Mnote Alexa-like simulator (not Amazon software)');
  console.log(`  MCP server: ${server}`);
  console.log(`  Open:       ${open}`);
  console.log('  Press Ctrl+C to stop.');
});
