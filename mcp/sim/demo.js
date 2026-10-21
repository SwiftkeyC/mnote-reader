#!/usr/bin/env node
// One command to try Mnote's study coach on an Alexa-like screen, on Windows, macOS or Linux:
//   npm run demo [-- --fresh] [--no-open] [--port 47885] [--sim-port 47890]
// It copies the fictional sample library to a temporary folder, starts the Mnote MCP server on
// it and the simulator, and opens the simulator in your browser. Ctrl+C stops both.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const mcp = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    fresh: { type: 'boolean' }, 'no-open': { type: 'boolean' },
    port: { type: 'string' }, 'sim-port': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log('npm run demo -- [--fresh] [--no-open] [--port 47885] [--sim-port 47890]');
  console.log('  --fresh     start again from the original sample notes (forgets study progress)');
  console.log('  --no-open   do not open the browser');
  process.exit(0);
}

// The server saves notes and study progress into its library, so it works on a copy.
const library = path.join(os.tmpdir(), 'mnote-sample-library');
if (values.fresh) fs.rmSync(library, { recursive: true, force: true });
if (!fs.existsSync(path.join(library, 'library.json'))) fs.cpSync(path.join(mcp, 'sample', 'library'), library, { recursive: true });

const children = [];
function stopAll(code = 0) {
  for (const c of children) c.kill();
  process.exit(code);
}

/** Starts a Node script and waits for the line that says it is listening. */
function start(name, args, ready) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: mcp, stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    let out = '';
    const timer = setTimeout(() => reject(new Error(`${name} did not start in time.\n${out}`)), 60000);
    child.stdout.on('data', d => {
      out += d;
      const m = ready.exec(out);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`${name} stopped (exit code ${code}).\n${out}`));
      console.error(`${name} stopped.`);
      stopAll(code || 1);
    });
  });
}

try {
  const port = values.port || '47885';
  const mcpUrl = await start('The Mnote MCP server', [path.join('src', 'server.js'), '--library', library, '--port', port], /Endpoint: (http:\S+)/);
  const simUrl = await start('The simulator', [path.join('sim', 'serve.js'), '--port', values['sim-port'] || '47890', '--server', mcpUrl], /Open:\s+(http:\S+)/);
  console.log('Mnote demo: the study coach on an Alexa-like screen (a simulation, not Amazon software)');
  console.log(`  Notes:      the fictional sample library, copied to ${library}`);
  console.log(`  MCP server: ${mcpUrl}`);
  console.log(`  Simulator:  ${simUrl}`);
  console.log('  Say "quiz me". Tool calls are logged below. Press Ctrl+C to stop.');
  if (!values['no-open']) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', simUrl]]
      : process.platform === 'darwin' ? ['open', [simUrl]] : ['xdg-open', [simUrl]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
} catch (err) {
  console.error(err.message.trim());
  stopAll(1);
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
