// Bundles the simulator's browser code (sim.js and the MCP SDK and ext-apps it imports) in memory.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildSim() {
  const out = await esbuild.build({
    entryPoints: [path.join(here, 'sim.js')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    write: false,
    logLevel: 'silent',
  });
  return out.outputFiles[0].text;
}
